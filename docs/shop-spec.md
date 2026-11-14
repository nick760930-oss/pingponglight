# 商城、外觀、成就、內購：實作規格（2026-11-14 定稿）

使用者已核准設計稿：
- `docs/design/cosmetics-catalog.html`：外觀型錄第 15 版。內含所有品項、價格、說明，以及每款的 canvas 繪圖程式（`BG`、`ORB`、`TRAIL`、`HIT`、`FRAME`、頭像、名牌框、稱號、表情、分享圖外框），還有 103 個成就（`ACH` 陣列）。
- `docs/design/shop-mockup.html`：商城畫面對照稿（A～J）。
- `docs/design/room-nameplate-mockup.html`：房間名牌對照稿。

**畫面以設計稿為準**，不要自己改設計。設計稿裡的繪圖程式盡量原樣搬過來。

## 目標

1. **網頁版先上線測試（現在）**：
   - 商城、全部外觀、成就都可以用。
   - 所有付費品項「測試期間免費」，按「取得」直接擁有。
   - 完整版的 30% 鎖不啟用。
2. **iOS App（下一個 TestFlight 版本起）**：
   - 走 Apple 內購（StoreKit），伺服器驗證交易後發放。
   - 完整版的 30% 鎖啟用。
   - 送審過了就直接收費，不用再改程式。
3. **正式上架後的網頁版**：
   - 商城只顯示說明，引導去 App（對照稿 B）。
   - 30% 鎖啟用。
   - 在 App 用同一個帳號買的東西，網頁版也看得到。

## 模式設定

`SHOP_MODE` 有三個值：
- `test`：網頁測試，全部免費。
- `iap`：iOS App，走內購。
- `web`：上架後的網頁版。

決定方式：
- App 內（`APP` 為真）一律是 `iap`。
- 網頁版讀伺服器 `/shop/state` 回傳的 `mode`。伺服器環境變數 `SHOP_TEST=1` 時回 `test`，否則回 `web`。

上架時只要把伺服器的 `SHOP_TEST` 改成 0，不必重新發版。

伺服器端規則：
- `SHOP_TEST=1` 時，`/shop/claim` 可以免費取得任何付費品項，取得的紀錄標 `src='test'`。
- 改成 0 時：
  - `src='test'` 的擁有權全部失效。
  - 已裝備的「別人看得到」的品項（頭像、名牌框）自動退回預設。
  - 本機外觀照常顯示（只有自己看得到），但下次啟動會依伺服器同步。

## 品項資料

新增 `cosmetics.js`，作為單一資料來源，內容包括：
- 所有品項：`id`、分類、名稱、說明、價格（台幣）、取得方式（預設／購買／成就 id／贊助）。
- 每款的繪圖函式。

規則：
- 分類：`theme`、`orb`、`trail`、`hit`、`frame`、`bg`、`plate`、`avatar`、`emote`、`share`、`title`。稱號不能買。
- 內購產品 ID：`com.nocticat.pingponglight.<分類>.<id>`。例如：
  - `…full`（完整版）
  - `…theme.aurora`
  - `…orb.star`
  - `…sponsor.30`、`…sponsor.90`、`…sponsor.300`
- 完整版與外觀是非消耗型（non-consumable）。贊助是消耗型（consumable），購買紀錄送伺服器累計，用來發放稱號「點燈人」和名牌框「燈塔」。
- 主題套組：買了等於擁有套組內 5 件，加一個分享圖外框。
- 伺服器也需要同一份品項清單（id、分類、是否別人看得到、取得方式）。放在 `server/src/catalog.js`，由 `cosmetics.js` 產生或手動同步，並加一個檢查腳本確保兩邊一致。

## 遊戲內套用

套用到遊戲裡的規則：
- **光球、尾跡、打擊特效、框線、背景**換成玩家裝備的款式。預設款就是現在遊戲的樣子，畫面不能有任何改變。
- **連擊變色**：照型錄第 0 節規則。每件買來的外觀在收藏頁有自己的「連擊變色」開關。關掉時用造型本身的顏色，但連擊的階級資訊照樣表現（光暈大小、環繞光點、呼吸光圈、星星時間的金色十字一定保留）。
- **提示框線**：下一拍那一條的閃藍光提示一律畫在最上層。
- **「減少特效」**（`SET.lowFx`）開著時，所有新外觀都要降級：粒子減到約 3 成，背景動畫停止。
- **效能**：低階手機要能維持 60fps。背景像現在一樣先畫到離屏 canvas，只有少量動態元素每幀重畫。

## 商城畫面

照對照稿 A～J 做：
- 首頁第二排加「商城」按鈕。
- 商城頁：左邊分類，中間商品，右邊預覽與購買。右上角有「恢復購買」。
- 每個商品標示：價格／已擁有／使用中／成就取得。
- 預覽區播放型錄那種動態小場景。
- 「試玩一首」：用該外觀玩一首，不記成績。
- 另有「收藏」頁：裝備、卸下、各件的連擊變色開關。
- 測試模式的價格位置顯示「測試期間免費」，按鈕是「取得」。

## 頭像、名牌框、稱號（別人看得到）

- 伺服器存每位玩家的裝備：`avatar`、`plate`、`title`。
- 排行榜、好友名單、房間座位、對戰結算頒獎台的回應要附上這三個欄位，前端照型錄第 7～9 節顯示。尺寸：22px、24px、28px、56px、96px。
- 裝備時，伺服器檢查玩家是否擁有（購買、成就、測試取得）。沒有就拒絕。
- 預設頭像免費，顏色依伺服器驗證過的生涯最高連擊。

## 成就

- 103 個成就，照型錄 `ACH` 陣列和第 12 節的分頁、點數、獎勵、驗證規則。
- **伺服器判定**（沒有標記的成就）：從已驗證的 `scores` 表計算，例如通關、難度、評級、全連擊、100%、星座。伺服器回傳已達成清單，獎勵由伺服器發放。
- **本機判定**：只給點數或自己看得到的東西，存在 localStorage。
- **需補驗證**（對戰相關）：先顯示「即將開放」，不發放。
- 成就頁：10 個分頁加「全部」、成就點數、進度條、已拿到的稱號。
- 達成時在結算畫面跳出通知。

## iOS 內購

- 使用 StoreKit 2。可以用現成、維護中的 Capacitor 外掛（例如 `@capgo/native-purchases`），或在 `app/ios` 自己寫一個小 Swift 外掛。**不要用 RevenueCat 這類第三方服務**（避免多一個資料處理方）。
- 購買成功後，把 StoreKit 的 `jwsRepresentation`（signedTransaction）送到伺服器 `/iap/verify`。伺服器自行驗證：
  - x5c 憑證鏈追溯到 Apple Root CA G3（根憑證寫死在程式裡）。
  - ES256 簽章。
  - `bundleId`、`productId`。
  - `environment`（Sandbox 或 Production 都接受，但要記錄是哪一個）。
  - 以 `transactionId` 去重。
  
  驗證過才發放，然後才呼叫 `finish()`。
- 「恢復購買」：用 `Transaction.currentEntitlements` 把全部 JWS 重送給伺服器。
- 退款：處理 `revocationDate`（交易已撤銷就收回）。
- 不需要 App Store Server API 金鑰，只用 JWS 自行驗證，金鑰的事交給使用者。

## 伺服器（Cloudflare Worker `pingponglight-duel`，D1 binding `LB`）

- 新 migration `0008_shop.sql`，包含以下資料表：
  - `ents(pid, item, src, ref, ts)`：擁有權。`src` 為 `iap`、`ach`、`test` 或 `sponsor`。
  - `iaptx(txid PRIMARY KEY, pid, product, env, ts, revoked)`
  - `equip`：存在 `players` 表加欄位，或另開一張表。
  - `achs(pid, ach, ts)`
- 新 API（沿用現有的身分驗證 `pk` 與限流 `limited`）：
  - `/shop/state`：回傳 `mode`、擁有清單、裝備、成就。
  - `/shop/claim`：只在測試模式有效。
  - `/shop/equip`
  - `/iap/verify`
  - `/ach/sync`
- 排行榜、好友、房間（`lb.js`、`friends.js`、`arena.js`）的輸出加上 `avatar`、`plate`、`title`。
- 玩家刪除資料時，這些資料一起刪除（參考 `bugWipe`）。
- 要有測試：JWS 驗證用自己產生的測試憑證鏈，加上 Apple 真實根憑證的指紋檢查。

## 限制

- 不要動 D1 `massage-booking-test`。不要執行 `wrangler login`／`logout`。不要部署。部署由主 session 做。
- 不要顯示或讀取 `.dev.vars`、`.prod-secrets.json`、`.prod-admin`。
- 不要 commit，主 session 會統一 commit。
- 新增的前端檔要加進 `sw.js` 的 PRECACHE 和 `app/build.mjs` 的 FILES。CSP 不變：不能用外部腳本，也不能用 inline script。
