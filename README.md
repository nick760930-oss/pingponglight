# PingPongLight

音樂同步的節奏遊戲：曲目全程播放，光球抵達亮起的框線時於節拍上觸碰光球，主旋律即隨之演奏。

- 靜態網站，無需建置：`index.html`、`songs.js`、`manifest.webmanifest`、圖示。
- 建議橫向使用；iPhone 請「分享 → 加入主畫面」以全螢幕開啟。
- 曲目來源：[Mutopia Project](https://www.mutopiaproject.org/) 公共領域 MIDI
  （莫札特 K.265、K.331；貝多芬〈歡樂頌〉、〈給愛麗絲〉；蕭邦 Op. 64 No. 1；葛魯伯〈平安夜〉；傳統〈綠袖子〉）。

## 本機預覽

```
python3 -m http.server 8000
```

開啟 http://localhost:8000/
