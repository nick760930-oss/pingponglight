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
  "midi": { … }  或  "tune": { … }  或  "score": { … }
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

## 來源三：樂譜檔（ABC／LilyPond 片段／MusicXML）

```json
"score": { "file": "tools/src2/dannyboy/danny-boy.abc", "part": 0, "crop": [0, 64], "transpose": 0, "bpm": 80, "style": "arp", "chords": "F:4 Bb:4 …" }
```

旋律由樂譜解析而來，伴奏自動配上（沿用 tune 的 `style`）。副檔名決定解析器：`.abc`、`.ly`／`.ily`、`.xml`／`.musicxml`／`.mxl`（zip，用 Node 內建 zlib 解開）。Mutopia 的完整 `.ly` 太複雜，同目錄有 `.mid` 就以 `midi` 來源為主，`.ly` 只拿來交叉比對。

- `part`：ABC 的聲部（依 `V:` 出現順序，0＝第一聲部）；LilyPond 的第 N 條有音符的聲部（同時發聲的 `<< >>` 只取外層指定的那條，內層取第一條）；MusicXML 的第 N 個 `<part>`（取最高聲部）。預設 0。
- 反覆記號會先展開（ABC `|: :| [1 [2`、LilyPond `epeat volta` 與 `alternative`、MusicXML repeat/ending）；`"repeats": false` 不展開。
- `crop`：[開始拍, 結束拍]，單位是四分音符拍，從旋律第一個音（弱起也算）起算，展開反覆之後的拍數；`cropBars`：[第一小節, 最後一小節]（1 起算，弱起小節算第 0 小節）。切在樂句結尾。
- `bpm`：每分鐘四分音符數，覆寫樂譜裡的速度（沒給就用樂譜速度；樂譜沒寫速度時預設 100）。複拍子（6/8、9/8）的拍子是附點四分，`Q:3/8=50` 等於 bpm 75。
- `transpose`／`melShift`：同 midi 來源。
- `style`：同 tune（預設依拍號：3 拍子 waltz、6/8 與 9/8 arp、其他 block）；`pulse`：伴奏一拍等於幾個四分音符（預設 1，複拍子 1.5）。
- 和弦：`chords` 寫了就用（格式同 tune，但拍數是四分音符拍，從裁切起點算）；沒寫就用樂譜裡的和弦記號（ABC 的 `"Am"`、MusicXML 的 `<harmony>`，數量夠才採用）；再沒有就依旋律每小節挑一個三和弦（`chordEvery`：每幾個四分音符拍換一次和弦，例如 6/4 的聖詩用 3）。
- 跑 `node tools/build-songs.mjs --dir songs-new --only <key>` 會印出推出來的和弦（`chords`）、速度、拍號與樂譜解析的警告；推得不對就把那串和弦改過後貼回 `chords`。

### 試做資料夾與工具

- `tools/songs-new/`：試做用，`node tools/build-songs.mjs --dir songs-new [--only key]` 只印統計，不寫 songs.js；確認後再搬進 `tools/songs/` 並加入星座。
- `node tools/scorelib.mjs <檔> [--part N] [--norepeat] [--json]`：看樂譜解析出幾個音、長度、速度、拍號、調號、警告（`--json` 輸出 [{b,db,p,t,d}]：拍、拍長、MIDI 音高、秒、秒長）。
- `node tools/melcheck.mjs <A> <B> [--limit N] [--all] [--json]`：同一首的兩份來源交叉比對（任意格式；MIDI 用 `file.mid#track=1`；可加 `#part=N`、`#norepeat`、`#crop=起拍:止拍`、`#skip=N`）。B 會自動移調（-24～+24 半音）與縮放拍長（x1/4～x4），用 Needleman-Wunsch 對齊，輸出音高一致率、節奏一致率與每一處不一致（小節、拍、兩邊的音）。一首曲子的兩份來源音高應 ≥ 95%；節奏偏低常是版本不同（例如 6/4 與 4/4 記譜），要看清單判斷。

## 驗收標準

- 長度 40～120 秒，在樂句結尾收；旋律音每秒 1～4.5 個為佳。
- 旋律音域約 55～88（G3～E6），不得超出 48～96。
- 手寫旋律以最通行的版本為準，音高與節奏要正確；拿不準的地方寫在回報裡。
- 只用公有領域作品；MIDI 只從 mutopiaproject.org 下載，授權為 Public Domain 或 CC（BY、BY-SA）。
