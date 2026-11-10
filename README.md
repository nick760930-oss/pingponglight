# PingPongLight

音樂同步的節奏遊戲：曲目全程播放，光球抵達亮起的框線時於節拍上觸碰光球，主旋律即隨之演奏。

- 靜態網站，無需建置：`index.html`、`songs.js`、`manifest.webmanifest`、`sw.js`（離線快取）、圖示。
- 功能：新手教學、生命值、暫停、延遲校準、音量與特效設定、成績分享圖。
- 建議橫向使用；iPhone 請「分享 → 加入主畫面」以全螢幕開啟。
- 曲目來源：[Mutopia Project](https://www.mutopiaproject.org/) 公共領域 MIDI，完整清單見 `credits.html`；最後 3 關為原創。
- 實機測試清單：`TESTING.md`。

## 本機預覽

```
python3 -m http.server 8000
```

開啟 http://localhost:8000/
