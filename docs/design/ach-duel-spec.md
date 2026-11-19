# 對戰與社交成就：實作規格（第二批）

設計依據：`docs/design/ach-duel-design.md`（第 5 節的修訂優先於第 3 節）。本檔是給實作者的具體規格。

## 0. 範圍與限制

- 可改：`server/src/arena.js`、`server/src/ach.js`、`server/src/achdata.js`、`server/src/friends.js`、`server/src/lb.js`（只加管理指令與共用函式的匯出）、`server/src/index.js`（只在需要轉送時）、新檔 `server/src/duel.js`、`server/migrations/0011_duels.sql`、`server/test/`、`game.js`、`ach.js`（根目錄，僅在需要顯示時）、`docs/design/cosmetics-catalog.html`、`docs/multiplayer-protocol.md`、`privacy.html`、由腳本產生的 `ach-data.js`。
- 不可動：`server/wrangler.toml`、`tools/songs-new/`、`app/www/`、`sw.js`、`.dev.vars` 等機密檔（也不可讀）。不 commit、不 push、不 deploy、不對正式 D1 下指令。
- 已開放的成就、單人排行榜、現有對戰畫面流程不能改變。舊版玩家端（不送紀錄）必須照常能玩。
- Durable Object 的 WebSocket attachment 上限約 2KB：逐拍紀錄不能放進 attachment，只能放 `ctx.storage` 或直接算完丟掉。

## 1. 資料表（migration 0011，只新增）

```sql
CREATE TABLE duels (
  id TEXT PRIMARY KEY,          -- 開局時產生的隨機 id
  ts INTEGER NOT NULL,          -- 結算時間
  day INTEGER NOT NULL,         -- 台灣時間的日序：floor((ts + 8h) / 86400000)
  song TEXT NOT NULL, d INTEGER NOT NULL,
  kind TEXT NOT NULL,           -- 'qm' 快速配對 / 'room' 私人房
  host INTEGER,                 -- 開局當下的房主 pid（未認證為 NULL）
  seats INTEGER NOT NULL,       -- 開局座位數
  valid INTEGER NOT NULL,       -- 有效座位數
  void INTEGER NOT NULL DEFAULT 0,
  log1 TEXT                     -- 第 1 名的逐拍紀錄（供人工檢查）
);
CREATE TABLE duelp (
  did TEXT NOT NULL, pid INTEGER NOT NULL,
  place INTEGER NOT NULL,       -- 畫面上的名次（1 起算）
  acc INTEGER NOT NULL, score INTEGER NOT NULL,
  ok INTEGER NOT NULL,          -- 完整通關
  fc INTEGER NOT NULL,          -- 全連擊
  q INTEGER NOT NULL,           -- 每拍分數正規化後的平均 ×100（見 3.3）
  sus INTEGER NOT NULL DEFAULT 0,
  cg INTEGER NOT NULL,          -- 這場計入場次
  cw INTEGER NOT NULL,          -- 這場計入勝場
  fr INTEGER NOT NULL,          -- 有效對手中的好友數（結算當下）
  eq INTEGER NOT NULL,          -- 知音成立
  cb INTEGER NOT NULL,          -- 終章逆轉成立
  s8 INTEGER NOT NULL,          -- 開局 8 人且有效對手 ≥ 6
  f8 INTEGER NOT NULL,          -- 開局 8 人、其他 7 位開局時都是好友、且有效對手 ≥ 6
  PRIMARY KEY (did, pid)
);
CREATE INDEX duelp_pid ON duelp (pid);
ALTER TABLE fships ADD COLUMN by INTEGER;      -- 發出好友請求的一方；舊資料 NULL
ALTER TABLE fships ADD COLUMN fresh INTEGER;   -- 1 = 成立當下「另一方」沒有任何成績
```

刪除帳號（`wipe`）：刪該玩家的 `duelp` 列（拆出主 batch、包 try，表不存在也要成功）。`duels` 保留。

## 2. 玩家端（game.js）

1. 對戰模式也記逐拍紀錄：格式同單人（`[誤差, base]`、`null`、`0`），加 `star` 區段與 `seq`。重用單人那套函式，不要複製一份。
2. 結束時（通關、倒下、出局）在送 `fin` 之前，先送一則 `{"t":"lg", "log":…, "star":…, "seq":…}`（`t` 必須是第一個鍵）。每局每座位最多一次。倒下或出局時送到目前為止的部分紀錄。
3. 收到 `{t:'ach'}` 時呼叫現有的成就同步（同開機同步那條路），把新成就交給 `PPLA.fresh`。
4. `res` 每列多一個 `v`（1＝這局對該座位有效）；本人 `v` 為 0 時，結算畫面顯示一行小字「這一局不計入對戰成就」。先做最簡單的文字，不改版面。

## 3. Arena

### 3.1 開局快照（startRound）

`round` 改存 `{ at, song, di, id, kind, host, seats: [{ i, pid }] }`：
- `id`：16 位元組隨機十六進位。
- `host`：開局當下 `hostOf()` 那個座位的 pid。
- `seats`：開局當下所有座位與其 pid（未認證為 null）。同一個 pid 出現在多個座位時，這些座位全部標成無效（pid 記 null、另記 `dup:1`）。
- 開局之後才 `auth` 的座位不回填快照。
- `gone` 名單的項目加上 `pid`、最後一次 `st` 的已結算拍數、以及 `vr`（見 3.2）。

### 3.2 紀錄通道（lg）

仿 `relayV`：在一般 token bucket 之前處理，以字串開頭 `{"t":"lg"` 辨識。
- 上限 16KB（字元與位元組都檢查），超過照「bad message」處理。
- 只在 `phase==='play'`、座位在快照內且有 pid、該座位本局還沒送過時接受；其餘情況靜默丟棄。
- 收到後立刻用 `duel.js` 的 `duelJudge` 重算，把小結果存進 attachment：`a.vr = { s, acc, mc, fc, ok, n, hit, q, t90 }`。
  - `ok`：紀錄長度等於 N 且沒有因生命值歸零中斷（對戰的倒下由玩家端 `fin.ok` 宣告；此處 `ok` 只表示「完整紀錄」）。
  - `n`：已結算拍數；`hit`：命中拍數；`t90`：照索引算到第 `floor(0.9N)` 拍為止的分數。
- 原始紀錄存 `ctx.storage` 的 `lg:<座位>`，結算後刪除（只留第 1 名的寫進 `duels.log1`）。
- 紀錄不合規：不存 `vr`，該座位本局無效；不踢人。

### 3.3 duelJudge（新檔 server/src/duel.js，純函式，可單獨測）

以 `lb.js` 的 `judge` 為基礎（共用常數與每拍檢查，必要時從 lb.js 匯出，不要複製貼上）：
- 接受部分紀錄（長度 1..N）。
- 衝刺：玩家端在「已結算拍數 ≥ 0.8N」後 base ×2（game.js:1099、838）。伺服器對索引 ≥ `floor(0.8N) − nb` 的拍，base 上限放寬 2 倍；其餘拍不放寬。下限不變。
- 星星區段規則同單人的 strict 模式。
- `q`：每個命中拍把 base 除以 `100 × TIER_M[tier] ×（星星 ? 2 : 1）×（衝刺區 ? 2 : 1）`，取平均再 ×100 取整。衝刺區邊界附近的拍（`floor(0.8N) ± nb`）不計入平均。
- 分數、連擊、準確率的算法與 `judge` 相同。

### 3.4 結算（finishRound）

名次排序維持現行規則（完成 → 失敗 → 在線未完成 → 離線未完成，同組比分數），但座位有 `vr` 時，分數、準確率、最大連擊、評級一律用 `vr` 的值，`ok` 取 `fin.ok && vr.ok`。沒有 `vr` 的座位照舊用自報值顯示。

有效座位＝快照內、有 pid、非重複，且符合其一：
- 有 `vr` 且 `vr.n ≥ 0.3N`；
- 沒有 `vr`、已離線，且最後一次 `st` 的已結算拍數 ≥ 0.3N（只能當敗方）。

沒有 `vr` 但有 `fin` 的座位（舊版玩家端）＝無效。

有效場＝有效座位 ≥ 2，且 `now − round.at ≥ dur / spd[di] × 900 ms`。不是有效場就不寫 D1，`res` 每列 `v:0`。

對每個有效座位算旗標（寫入 `duelp`）：
- `cg`：這位玩家今天（台灣時間）已計入的場數 < 30。
- `sus`：`vr.q > 300` 且 `vr.q > 2 ×` 其他有效座位 `q` 的中位數。門檻是暫定值：請先讀 game.js 確認球速 `b.v` 的正常範圍，推算正常玩家的 q 大約落在哪裡，不合理就調整並回報。
- `cw`：`cg`、畫面名次第 1、`ok`、非 `sus`、有效座位 ≥ 2，且至少有一位「合格對手」今天被這位玩家計勝的次數 < 3。合格對手＝有效座位、`vr.hit ≥ 0.3N`、且在 `scores` 有 ≥ 3 首不同歌的成績。
- `fr`：有效對手中，結算當下是好友的人數（用 `relations()` 或直接查 `fships`）。
- `eq`：本人 `ok`，且有另一位 `ok` 的有效對手準確率（萬分位）相同。
- `cb`：有 `vr` 的有效座位 ≥ 3、本人在 `t90` 排最後（同分不算）、畫面名次第 1。
- `s8`：開局座位數 = 8 且有效對手 ≥ 6。
- `f8`：`s8` 成立，且快照中其他 7 個座位都有 pid、開局時都是本人的好友。

寫入流程：
1. 把要寫的資料存進 `ctx.storage` 的 `pend`（陣列，可累積多局）。
2. 廣播 `res`（加 `v`），照舊收尾。
3. `db.batch` 用 `INSERT OR IGNORE` 寫 `duels`、`duelp`；成功就從 `pend` 移除，並對每個有效座位送 `{t:'ach'}`。
4. 失敗：留在 `pend`，下次 alarm 重試；重試 5 次仍失敗就丟棄。
5. Arena 不呼叫 `achRecalc`。

### 3.5 邀約

`/fr/invite` 成功推送後，Worker 另外通知該房的 Arena（內部路徑，例如 `/inv`，帶 `from`、`to`）。Arena 把它存進 `ctx.storage`（附到期時間，最多 20 筆）。之後有座位 `auth` 成功且 pid＝`to`、同時 `from` 的 pid 也在房內時，直接替 `from` 記下成就「邀約」（沿用現有記成就的函式與獎勵流程）。不建資料表。

## 4. 好友（friends.js）

`becomeFriends` 是兩條成立路徑的共同出口：加參數 `by`（發出請求的一方），寫入 `fships.by`；同時查另一方在 `scores` 是否有任何列，沒有就寫 `fresh=1`。

## 5. 成就判定（ach.js）

`achRecalc` 多讀一次彙總（表不存在時容錯，全部當 0）。只算 `duels.void = 0` 的列：

| id | 條件 |
| --- | --- |
| 初次交手／熱身賽／擂台常駐／百戰 | `cg` 的場數 ≥ 1／10／50／200 |
| 首勝 | `cw` 的場數 ≥ 1 |
| 初露鋒芒／凱旋曲／常勝樂章 | `cw` ≥ 10／50／200，且計勝場次中勝過的不同對手 ≥ 3／10／20 |
| 同台 | 有一場 `cg` 且該局 `valid ≥ 4` |
| 再會 | 和同一位玩家同場的 `cg` 場數 ≥ 3 |
| 知音 | 有一場 `cg` 且 `eq` |
| 最終樂章 | 有一場 `cg` 且 `cb` |
| 八方之冠 | 有一場 `cw` 且 `s8` |
| 全場最佳 | 有一場 `cw`、`s8` 且 `fc` |
| 開張／指揮家 | `kind='room'`、`host`＝本人、本人該場 `cg`，場數 ≥ 1／30 |
| 引路人 | 有一筆 `fships`：`by`＝本人、`fresh=1`，且另一方現在有成績 |
| 好夥伴 | `cg` 且 `fr ≥ 1` 的場數 ≥ 20 |
| 合奏團 | `cg`、該局 `valid ≥ 4` 且 `fr ≥ 2` 的場數 ≥ 10 |
| 八音和鳴 | 有一場 `cg` 且 `f8` |
| 邀約 | 由 3.5 直接記錄 |

這 21 個 id 在 `achdata.js` 的 chk 由 `v` 改成 `s`；`cosmetics-catalog.html` 對應列移除「需補驗證」，條件文字依本表更新（8 人房、不同對手數、每日上限寫進說明段落即可，不必塞進每一列）。重新產生 `ach-data.js`，「即將開放」應該變成 0。

## 6. 管理指令（lb.js 的 /lb/admin）

- `duels`：列最近 200 場（id、時間、歌、有效人數、第 1 名的 pid／名稱／q／sus）。
- `duel`：看一場的 `duelp` 與 `log1`。
- `duelvoid` `{ did }`：把該場 `void` 設 1，然後對該場每位玩家重算這 21 個成就；不再成立的，刪掉 `achs` 的列與它給的獎勵（`ents` 中 src='ach' 且來源是該成就的項目；若玩家正裝備著被收回的稱號，改回預設）。只處理這 21 個 id，其他成就一律不動。
- `ach.js` 開頭「永不收回」的註解補上這個例外。

## 7. 其他文件

- `docs/multiplayer-protocol.md`：補 `lg`、`ach`、`res.v`。
- `privacy.html`：在保存資料的清單補一句「線上對戰的結果（名次、準確率、同場玩家）」，現有的每個語言版本都要補。

## 8. 測試

- 新增 `server/test/duel.mjs`（比照 `runs.mjs` 用 node:sqlite 模擬 D1，不需啟動 wrangler）。把結算的計算做成可直接呼叫的純函式（輸入：快照、各座位的 vr／fin／st、查詢結果；輸出：要寫的列），Arena 只負責接線。至少涵蓋：
  - duelJudge：衝刺區上限、非衝刺區高分被拒、部分紀錄、q 的計算。
  - 有效座位：重複 pid、開局後才認證、舊版（無 vr）、離線但打過 30%、未滿 30%。
  - 名次用重算值；`cw` 的每個條件各一個反例；同對手每日 3 勝；每日 30 場；台灣時間換日。
  - `sus`、`eq`、`cb`、`s8`、`f8`、`fr`。
  - `achRecalc`：21 個成就各有給與不給；`void` 之後不成立的被收回、其他成就不受影響。
  - 好友 `by`／`fresh` 兩條成立路徑；引路人。
  - 表不存在時 `achRecalc`、`wipe` 不壞。
- 現有測試全部要過：`shop.mjs`、`rank.mjs`、`iap.mjs`、`runs.mjs`；`arena.js`、`attack.js`、`friends.js`、`spectate.js` 若能在本機 Worker 上跑（看 TESTING.md），也跑並回報；跑不了就說明原因。
- 四個 `--check` 與 `node --check game.js`。
- 瀏覽器實測：本機 Worker＋兩個分頁打一場完整對戰（一方通關、一方中途關掉分頁各一次），記錄 `lg` 大小、`res.v`、`duelp` 寫入的列、收到的 `ach`。

## 9. 回報

改了哪些檔、migration 內容、每個測試的原文數字、`sus` 門檻的依據、瀏覽器實測數據、偏離規格的地方、你不確定的地方。

## 10. 實作補記（與上文不同或上文沒寫清楚之處，以此為準）

- **cb**（最終樂章）另外要求本人 `ok`（通關）。
- **合格對手**＝有效座位，在 `scores` 有 ≥ 3 首不同歌的成績，且符合其一：有 `vr` 且 `vr.hit ≥ 0.3N`；或沒有 `vr`、沒有 `fin`、已離線、最後一次 `st` 的已結算拍數 ≥ 0.3N 且該次分數 > 0。有 `vr` 但命中不足 30% 的掛機對手不合格；斷線時分數為 0 的也不合格。
- **duelp.qual**：`duelp` 多一欄 `qual INTEGER NOT NULL DEFAULT 0`，結算時寫入該座位在該局是否為合格對手。「勝過的不同對手數」（初露鋒芒 3、凱旋曲 10、常勝樂章 20）只算 `qual = 1` 的對手。
- **start 的 lg:1**：Arena 的 `start` 訊息帶 `lg:1`；玩家端只有本局 `start` 帶此旗標才送 `lg`，否則完全不送，避免新版玩家端連舊伺服器時，超過 512 字元的訊息讓舊 Arena 踢人。
- **lg 的處理順序**：長度檢查（超過 16KB 為 bad message）→ token bucket（超量踢除）→ 才是階段、pid、是否已送過等判斷。
- **log1 的保留與清除**：每局第 1 名的原始紀錄保留在 `duels.log1`，其他人的結算後刪除（全員中途離開時一併刪 `lg:*`）。玩家刪除帳號時，`wipe` 先把該玩家拿第 1 名的那些局的 `log1` 設為 NULL，再刪 `duelp`。隱私權政策與協定文件照此說法。
- **duelvoid 只重算 19 個**：`DUEL_CALC` 不含「邀約」（Arena 直接記錄）與「引路人」（只看好友表，與對局無關），這兩個作廢時不收回。
- **欄位名 `by`** 在 migration 與所有 SQL 中加雙引號（`"by"`）。
- **沒套 0011 時**：`becomeFriends` 寫入失敗會退回不含 `by`／`fresh` 的舊寫法；`duelAdmin` 回 `{error:'nodb'}`；`achRecalc` 的對戰事實回零；刪帳號不受影響；Arena 結算失敗留在 `pend`，重試 5 次後丟棄。
- **/inv**：Arena 房內沒有連線座位時直接回 `{ok:false}`，不寫 storage、不設 alarm；過期的邀請在 alarm 時清除。
- 其他：對戰玩家端另外加 `PPLA.sync`；`res.v` 在玩家端為三態（-1 表示伺服器沒給）；`duels` 多一個 `ts` 索引。
