# PingPongLight 資安防禦規劃（上架版）

更新日期：2026-11-11。本檔不公開部署（已列入 `.vercelignore`）。

## 設計原則

1. **單人模式完全不依賴網路。** 曲目、音色、存檔都在玩家裝置上。伺服器就算被攻擊或停擺，也只影響線上對戰。
2. **不設帳號、客戶端不放金鑰。** 玩家裝置產生 128 位元隨機識別碼，伺服器只存其 SHA-256。D1 資料庫（`pingponglight-lb`）存暱稱、每板最佳成績與逐拍紀錄、好友碼／好友／邀請／封鎖、最後上線時間、檢舉者 IP 雜湊。上架填 Google Play「資料安全性」和 Apple 隱私標籤時要據實揭露：暱稱（公開）、遊戲內容（成績）、使用者 ID（識別碼雜湊），用途是 App 功能，不用於追蹤，可在 App 內刪除（Apple 5.1.1(v)）。伺服器秘密 `LB_SECRET`（場次票簽章）與 `LB_ADMIN`（管理員）只存在 Cloudflare secret。
3. **伺服器不信任任何輸入。** 每則訊息都限制大小、頻率、格式和數值範圍；對手送來的資料一律重新消毒後才顯示。
4. **Origin 檢查只是過濾，不是驗證。** 非瀏覽器程式可以偽造 Origin，所以真正的防線是頻率限制和資源上限。

## 威脅與現況

| # | 攻擊 | 目前防禦 | 剩餘風險 | 待辦 |
|---|---|---|---|---|
| 1 | 大量請求灌爆對戰伺服器（DDoS） | Cloudflare 網路層吸收；每 IP 每分鐘建立房間 30 次、連線 30 次（分開計算）；IPv6 依 /64 合併計算。頻率限制是各資料中心分開計數的近似值，限制服務出錯時會放行 | 被擋下的請求仍會執行 Worker 並計入用量；單一 IP 不超限也能每天送約 8.6 萬次 | A2 |
| 2 | 用量攻擊拖垮**同帳號其他專案**（舒時） | 無隔離：Worker 請求數和 Durable Objects 額度（請求數、寫入列數）都是全帳號共用；WebSocket 每則訊息（含被丟棄的）都算 DO 請求 | **高**：免費方案下兩個 IP 就能用完 Worker 每日額度，連帶讓舒時停擺；付費方案則變成費用暴增 | A1、A2 |
| 3 | 洗房間、占房號 | 只能占用空房；預約 30 分鐘到期；房號空間有限 | 分散式機器人可短暫占滿房號 | A2 |
| 4 | WebSocket 訊息洪水、巨大訊息 | 每連線 token bucket（容量 30、每秒補 8）；單則超過 512 字元，或累計違規 60 次就斷線；閒置 75 秒踢除（每 30 秒巡一次，最晚約 105 秒） | 低 | — |
| 5 | XSS（惡意暱稱、評級字串） | 伺服器清洗名稱；客戶端顯示前一律以 `esc()` 跳脫或用 textContent，評級以白名單驗證；CSP `script-src 'self'`（樣式仍允許 inline） | 低 | — |
| 6 | 點擊劫持、內嵌、降級攻擊 | `frame-ancestors 'none'`、X-Frame-Options、HSTS 兩年、COOP | 低 | — |
| 7 | 排行榜作弊（假成績、自動點擊） | 伺服器從逐拍紀錄重算精準度與分數（每拍分數不得超過該拍上限）；場次票（HMAC 簽章，必須經過約整首歌的時間、3 小時內有效）擋直接送假成績；程式產生的點擊（isTrusted=false）不上傳；拍子異常穩定標記 sus=1 供人工檢查（不拒收）；保存最佳那次的逐拍紀錄；三個不同網路檢舉自動隱藏；管理員可隱藏、刪除 | 中：裝置端的自動點擊程式（特別是 Android 無障礙服務）產生的是真實觸控，JS 偵測不到；改過的客戶端可以宣稱每拍都拿最高分 | B1 |
| 8 | 帳號被盜後推送惡意更新 | — | **高**：這是上架後最實際的風險 | A3 |
| 9 | App 內載入外部程式碼或被導向外站 | （App 尚未建立） | — | A4 |
| 10 | 供應鏈（套件被植入） | 網頁端零第三方套件；伺服器只依賴 wrangler，且有 lock 檔 | 低 | 部署前 `npm audit` |
| 11 | 靜態網站被灌流量、方案違規 | Vercel 內建 DDoS 防護 | Hobby 方案超量會暫停服務（不收費）；Hobby **禁止商業用途**，收費、放廣告、用網站推廣付費 App 都算 | 有任何營利前升級 Pro |
| 12 | 對戰雙方版本不同 | 網頁採網路優先快取，重新開啟即更新 | 低：舊版玩家和新版對戰時拍數不同，衝刺門檻不一致 | 之後在 hello 訊息加版本檢查 |

## 待辦（依優先順序）

**A1. 把對戰伺服器移到遊戲專用的 Cloudflare 帳號**（要你本人操作）
- 原因：隔離。對戰伺服器被攻擊或設定出錯時，不會連帶影響舒時專案（威脅 2）。費用不是考量。
- 時機：可以等需要時再搬。伺服器不存玩家資料，搬遷只要重新部署、改網址；只要先做 A2 綁好網域，搬家時玩家連 App 都不用更新。
- 做法：用遊戲專用信箱開新的 Cloudflare 帳號 → 開啟雙重驗證 → 建立「只能編輯 Workers」的 API Token → 我用環境變數 `CLOUDFLARE_API_TOKEN` 部署。這樣不需要執行 `wrangler login`，這台電腦的共用登入不受影響。
- 新網址部署好之後，再更新 `game.js` 的 `DUEL_URL` 和 `vercel.json` 的 CSP。

**A2. 綁自訂網域並開 WAF 頻率限制**（要有網域，約每年 10 美元）
- 原因：WAF 規則在 Worker 執行**之前**就擋下請求，不會計入用量（威脅 1、3）。
- 做法：網域放到 Cloudflare → 對戰伺服器改走 `duel.你的網域` → 關閉 `workers.dev` 網址 → 免費方案有 1 條頻率限制規則，設為「同 IP 10 秒內超過 20 次就封鎖 10 秒」。
- 要同時關閉 `workers.dev` 和預覽網址（`wrangler.toml` 設 `workers_dev = false`、`preview_urls = false`），否則攻擊者可以繞過 WAF。
- WAF 只看得到 WebSocket 建立連線的那一次請求，連線後的訊息仍靠伺服器的 token bucket 限制。
- 網域也讓日後搬伺服器不必更新 App（見 A1）。

**A3. 所有相關帳號都開雙重驗證**（要你本人操作）
- 帳號：Google（Play Console）、Apple ID、GitHub、Vercel、Cloudflare、遊戲專用信箱。
- Android 使用 Play App Signing，上傳金鑰（keystore）和密碼要離線備份兩份。
- 不要把金鑰放進 Git，也不要放在雲端同步資料夾。

**A4. App 外殼的安全設定**（我負責，建立 App 時一起做）
- 所有資源打包進 App，不從網路載入程式碼。這同時符合 Apple 2.5.2 規定。
- 禁止 WebView 導向外部網站，只允許連線到對戰伺服器。
- 正式版關閉 WebView 除錯，禁止明文 HTTP。
- 伺服器白名單（`server/src/index.js` 的 `PROD`）加入 App 的來源：Android `https://localhost`（Capacitor 6 起的預設）、iOS `capacitor://localhost`。
- App 內不會套用 `vercel.json` 的標頭，要在 `index.html` 加 `<meta http-equiv="Content-Security-Policy">`（meta 寫法不支援 `frame-ancestors`，App 內也不需要）。

**B1. App Attest／Play Integrity**（上架原生 App 後）
- 只接受真的 App、真的裝置送來的成績；網頁版成績另列或降權。需要原生外掛與伺服器端驗證。

**B2. 排行榜管理**
- 管理指令：`POST /lb/admin {token, op}`，op 有 `reports`、`flagged`、`run`（看逐拍紀錄）、`hide`、`unhide`、`delete`。token 為 `LB_ADMIN`。
- 資料庫可隨時搬：`npx wrangler d1 export pingponglight-lb --remote --output lb.sql` 匯出成 SQL，任何 SQLite 都能匯入。

**A5. 監控與應變**（要你本人操作，我可以一步步帶）
- Cloudflare 設定用量通知；Vercel 設定流量通知。
- 遭受攻擊時，最快的止血方式是暫時停用對戰：把 `DUEL_URL` 改回占位字串，對戰按鈕就會隱藏。單人模式不受影響。

## 回歸測試

伺服器改動後要跑三組測試（攻擊 24 項、排行榜 66 項、好友 93 項），測試前清空本機資料表：

```
node server/test/attack.js http://127.0.0.1:8788
node server/test/lb.js http://127.0.0.1:8788
node server/test/friends.js http://127.0.0.1:8788
```

測試前先在 `server/` 執行 `npx wrangler dev --port 8788`（`.dev.vars` 已設定 `ALLOW_LOCAL=1`）。

## 部署順序（排行榜與好友）

順序錯了會讓暱稱和對戰全部失效（沒有密鑰時 `/lb/*` 回 503，而對戰需要暱稱）：

1. 密鑰（第一次才需要）：`npx wrangler secret bulk .prod-secrets.json`（檔案在 `server/`，已列入 .gitignore；`LB_ADMIN` 另存在 `server/.prod-admin`）
2. 資料庫：`npx wrangler d1 migrations apply pingponglight-lb --remote`（`wrangler deploy` 不會自動套）
3. 伺服器：`npm run deploy`
4. 最後推送網站（Vercel 從 main 自動部署）
