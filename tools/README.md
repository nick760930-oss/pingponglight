# 製作曲目

一首曲目＝ `tools/songs/<key>.json` 一個檔案。組裝：`node tools/build-songs.mjs`（寫出 songs.js）；只看一首：`node tools/build-songs.mjs --only <key>`。曲目要放進 `tools/constellations.json` 的某個星座才會出現在遊戲裡。

星級與星座內順序：組裝後執行 `node tools/stars.mjs`，它用遊戲本身的選球程式算出每首在困難、專家實際出的球（平均密度 40%、最密 8 秒 25%、節奏變化 20%、球數 15%），寫出 `tools/stars.json`，並把每座星座的曲目由易到難重新排序；接著再跑一次 `node tools/build-songs.mjs`。評分基準固定，新增曲目不會改變其他曲目的星級。`node tools/stars.mjs --check` 可檢查是否過期。

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
- `speed`：播放速度倍率（1.5＝快 1.5 倍）；`minMel`：旋律音軌裡短於這個秒數（原 MIDI 時間）的音留在伴奏。
- `minGap`：倚音、迴音這類緊貼下一個音的旋律音（距下一個旋律音不到這個秒數，遊戲時間，一般用 0.08）不當旋律，只留每組最後一個音，避免球落在裝飾音上。`gapTo`：`"bk"`（預設，改當伴奏；旋律和伴奏同一種樂器時用）或 `"drop"`（不發聲；旋律和伴奏樂器不同時用，否則裝飾音會換成伴奏樂器的音色）。原曲本來就很快的音群（例如觸技曲開頭）不要用。
- `cut`：`[[開始秒, 結束秒], …]`（原 MIDI 時間）把這幾段整段剪掉、後面往前接，用來拿掉反覆時重複的第一反覆房；有 `cut` 時 `crop` 以剪掉之後的時間計算。
- `melFrom`：`[[音軌, 開始秒, 結束秒], …]`（原 MIDI 時間）這幾段改由別的音軌當旋律，用在旋律中途換到另一個聲部、`mel` 音軌在休息的地方。
- `fix`：`[[秒, 音高, 新音高], …]`（原 MIDI 時間、MIDI 音高）改掉檔案裡的錯音，要先對過公有領域原譜；每一筆必須剛好對到一個音，否則組裝會報錯。出處說明（credit.note）要寫明改了哪個音、依據哪份譜。
- 主奏樂器的音域要包住整條旋律（game.js 的 `INST` 的 lo～hi），超出的音遊戲會自動移八度，旋律輪廓會錯。
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
- 只用公有領域作品；音符只取自本身標示 Public Domain 或 CC0 的檔案（例如 Mutopia 標 Public Domain 的版本），或依公有領域原作手寫。CC BY、BY-SA、NC 或沒標授權的檔案只能拿來比對，不可複製音符。
