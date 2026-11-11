# 製作曲目

一首曲目＝ `tools/songs/<key>.json` 一個檔案。組裝：`node tools/build-songs.mjs`（寫出 songs.js）；只看一首：`node tools/build-songs.mjs --only <key>`。曲目要放進 `tools/constellations.json` 的某個星座才會出現在遊戲裡。

## 共同欄位

```json
{
  "key": "raindrop",                 // 2～16 個小寫英數字，等於檔名
  "name": "雨滴前奏曲",               // 遊戲顯示的曲名（台灣用語）
  "composer": "蕭邦",
  "year": "1839",                    // 發表年；約略寫「約1839」
  "inst": { "lead": "piano", "bk": "piano" },   // 旋律、伴奏；可加 bass（E3 以下的伴奏）、ctr（副旋律）
  "credit": { "source": "Mutopia Project", "url": "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=…", "licence": "Public Domain", "by": "排版者名稱" },
  "midi": { … }  或  "tune": { … }
}
```

可用樂器：piano violin viola cello strings flute recorder guitar organ choir trumpet clarinet pizz。

## 來源一：MIDI（Mutopia Project）

```json
"midi": { "file": "tools/midi/xxx.mid", "mel": 1, "ctr": 3, "drop": [5], "crop": [0, 95.5], "transpose": 0, "melShift": 12, "speed": 1 }
```

- `mel`：旋律所在音軌編號（可為陣列）；同一音軌同時發聲時取最高音當旋律，其餘當伴奏。
- `ctr`：副旋律音軌（可省略）；`drop`：不要的音軌；鼓（channel 10）自動略過。
- `crop`：只取這段秒數（原 MIDI 時間）；要切在樂句結束處。
- `transpose`：整首移調；`melShift`：只移旋律（旋律太低時用 12）。
- 查看音軌：`node -e "import('./tools/songlib.mjs').then(L=>{for(const t of L.readMidi('tools/midi/xxx.mid').tracks)console.log(t.i,t.name,t.notes.length,t.ch)})"`

## 來源二：手寫旋律

```json
"tune": { "bpm": 120, "meter": 4, "style": "block", "transpose": 0, "swing": 0,
  "parts": { "A": { "mel": "C5:1 D5 E5:2 | …", "chords": "C:4 G7:4 …" } },
  "form": ["A", "A", "B", "A"] }
```

- 旋律：`音名:拍數`，例如 `F#4:1.5`、`Bb3:0.5`，休止符 `r:1`；拍數省略＝沿用上一個；`|` 只是方便閱讀。
- 和弦：`名稱:拍數`，例如 `C`、`Am`、`G7`、`Fmaj7`、`Bdim`、`Dsus4`、`C/E`；和弦總拍數必須等於旋律總拍數。
- 每段要是整數小節；弱起或特殊長度的段落加 `"free": true`。
- `style`：block（每拍和弦）、waltz（3/4 圓舞曲：低音＋兩拍和弦）、march（低音／和弦交替）、arp（八分音符分解和弦）、pad（長音）、none（無伴奏）。

## 驗收標準

- 長度 40～120 秒，在樂句結尾收；旋律音每秒 1～4.5 個為佳。
- 旋律音域約 55～88（G3～E6），不得超出 48～96。
- 手寫旋律以最通行的版本為準，音高與節奏要正確；拿不準的地方寫在回報裡。
- 只用公有領域作品；MIDI 只從 mutopiaproject.org 下載，授權為 Public Domain 或 CC（BY、BY-SA）。
