# PingPongLight

音樂同步的節奏遊戲：曲目全程播放，光球抵達亮起的框線時於節拍上觸碰光球，主旋律即隨之演奏。

- 靜態網站，無需建置：`index.html`、`game.js`、`songs.js`、`manifest.webmanifest`、`sw.js`（離線快取）、圖示。
- 功能：新手教學、生命值、暫停、延遲校準、音量與特效設定、成績分享圖。
- 建議橫向使用；iPhone 請「分享 → 加入主畫面」以全螢幕開啟。
- 曲目來源：[Mutopia Project](https://www.mutopiaproject.org/) 公共領域 MIDI，完整清單見 `credits.html`；最後 3 關為原創。
- 樂器音色：`inst/` 內為 Salamander 鋼琴與 FluidR3 GM 單音取樣（CC BY 3.0），依曲目載入。
- 線上對戰：`server/` 為 Cloudflare Worker + Durable Object（房號、對時、同步開始、事件轉送）；`cd server && npx wrangler deploy` 部署後，把 game.js 的 DUEL_URL 換成 Worker 網址；本機開發先建立 `server/.dev.vars`（內容 `ALLOW_LOCAL=1`，允許 localhost 連線），再執行 `npx wrangler dev`。
- 實機測試清單：`TESTING.md`。

## 本機預覽

```
python3 -m http.server 8000
```

開啟 http://localhost:8000/
