# Languages

The game is written in Traditional Chinese (Taiwan). English and Japanese are translations. Simplified Chinese is not planned.

## How it works

- The Chinese text in the code is the key. In Chinese nothing is looked up, so the Chinese game is exactly what the code says.
- `i18n.js` picks the language once per page load (`?lang=en`, then the saved choice, then the browser language; someone who
  already has save data stays in Chinese until they choose). Changing the language reloads the page.
- `lang-en.js` / `lang-ja.js` are generated from `i18n/<lang>/*.json` by `node tools/i18n.mjs build`. Never edit them by hand.
- `node tools/i18n.mjs check` fails when a translation is missing, stale, or its placeholders do not match.
- `?i18n=debug` shows every string that has no translation inside ⟦ ⟧.

| file | holds | keyed by |
| --- | --- | --- |
| `ui.json` | interface text | the Chinese text (the first argument of `TX`, or a text node of index.html) |
| `songs.json` | `name`, `composer`, `tip`, and `year` when the Chinese year has Chinese characters | song key |
| `ach.json` | `name`, `desc`, and `reward` when the reward is more than points | achievement id (Chinese, never changes) |
| `cos.json` | `name`, `desc` (emote packs: `name`, `list`) | item id |

`i18n/keys.json` (written by `node tools/i18n.mjs keys`) lists everything that needs a translation, with the Chinese text.

## Writing code

```js
TX('開始')                                  // one string
TX('第 {n} 關', {n: si + 1})                // variables go in as named placeholders, never by concatenation
TX('排行榜 <b>第 {r} 名</b>／共 {n} 人', {r, n})   // HTML inside a sentence stays inside the key
TXA(['簡單', '普通', '困難'])                // an array of display strings, translated where it is defined
TXO({bump: '障礙', fog: '迷霧'})             // an object of display strings
TX('離線@@status')                          // "@@note" tells two uses of the same words apart; it is never shown
```

Rules:

1. The first argument is a plain single-quoted literal (the tool reads the keys from the source text). No concatenation, no template literal.
2. One sentence = one key. Do not cut a sentence where a variable or a tag happens to be: word order differs between languages.
   A clause that is only sometimes added is its own key and must be a complete clause.
3. The number that decides singular/plural is the placeholder `{n}` (one per key). Other placeholders get descriptive names.
4. In Chinese the result must be character for character what it was before (spaces and full-width punctuation included).
5. Ids stay Chinese and unwrapped: achievement ids (`grant('入門完成')`), constellation names used as keys, anything stored,
   compared, or sent to the server. Translate where the text is shown: `TX(c.name)`. No logic may depend on a shown string.
6. The language never changes while the page is open, so translating at definition time (module level) is fine.
7. Canvas text uses `PPLI18N.font` as its font family (Japanese needs Japanese glyph shapes).
8. Song, achievement and cosmetic texts come from `PPLI18N.song(key)`, `.ach(id)`, `.cos(id)`: an object with the fields to show, or
   `undefined` in Chinese (and for anything not translated yet: then show the Chinese).

## Translating

General:

- Translate meaning and tone, not word by word. The Chinese is polite and plain; so are the translations. No slang unless the Chinese has it
  (the quick-chat lines do: make them sound like what players of that language really type).
- Keep every `{placeholder}` and every HTML tag exactly; the order may change. Keep emoji and symbols (✦ ★ ⋯ ‹ ⚑).
- Short labels must stay short: buttons, tabs and table headers have little room. Prefer the shortest natural wording.
- Never add facts. Never drop a condition or a number.
- A translation may be `{"one": "...", "other": "..."}` when the wording depends on `{n}` (English: 1 vote / 2 votes).

### English

- Buttons, tabs, headings, item and achievement names: Title Case. Sentences (messages, descriptions, hints): sentence case with a full stop.
- "You", never "the player". Contractions are fine. American spelling.
- Punctuation: ASCII quotes are fine; song titles in running text go in “curly quotes”; use " · " where the Chinese does; "…" for ⋯ in "Loading…".
- Numbers: "3rd place" / "#3" for ranks, "{n} players", "1:05" style only where the Chinese does that.

| 中文 | English |
| --- | --- |
| 光球 | orb |
| 框線 | frame (the lit side: "the glowing edge") |
| 尾跡 | trail |
| 打擊特效 | hit effect |
| 背景 | background |
| 名牌框 | nameplate |
| 頭像 | avatar |
| 稱號 | title |
| 對戰表情 | emotes |
| 分享圖外框 | share card frame |
| 主題套組 | theme set |
| 單件外觀 | single items |
| 外觀 | cosmetics (one: "item") |
| 完整版 | Full Version |
| 商城 | Shop |
| 收藏 | Collection |
| 成就 / 成就點數 | Achievements / achievement points |
| 銅 銀 金 傳說 | Bronze, Silver, Gold, Legendary |
| 限定 | Limited |
| 星空 | Night Sky |
| 星座 | constellation (theme names such as 古典座 drop the word: "Classical") |
| 獎勵星座 / 獎勵曲 | bonus constellation / bonus song |
| 音符座 | the Musical Note |
| 入門 簡單 普通 困難 專家 | Beginner, Easy, Normal, Hard, Expert |
| 教學 / 新手教學 | Tutorial |
| 完美 極佳 良好 尚可 失誤 | Perfect, Great, Good, OK, Miss |
| 連擊 / 最高連擊 / 全連擊 | combo / max combo / full combo |
| 精準度 | accuracy |
| 完成度 | progress |
| 生命值 | life |
| 護盾 | shield |
| 評級 | rank (S, SS, SSS stay as they are) |
| 名次 | place ("3rd place") |
| 通關 / 失敗 | clear (Cleared) / Failed |
| 第 N 關 | Stage N |
| 拍 | beat |
| 曲目 | song |
| 線上對戰 / 對戰 | Online Match / match |
| 快速配對 | Quick Match |
| 房間 / 房號 / 房主 | room / room code / host |
| 公開 / 私人 | Public / Private |
| 準備 | Ready |
| 投票選曲 | Vote on Song |
| 牽制 | disruption (verb: disrupt) |
| 最後衝刺 | Final Sprint |
| 星星時間 | Star Time |
| 觀戰 | spectate |
| 出局 / 離線 | Out / Offline |
| 好友 / 好友碼 | friends / friend code |
| 暱稱 | nickname |
| 排行榜 | leaderboard |
| 檢舉 / 封鎖 / 隱藏 | report / block / hide |
| 延遲補償 / 校準 | latency offset / calibrate |
| 音樂層次：微光 明亮 輝映 星耀 | music layers: Glimmer, Bright, Radiant, Stellar |
| 恢復購買 | Restore Purchases |
| 回報問題 | Report a Problem |
| 社群規範 | community guidelines |
| 您 / 你 | you |

Songs: use the title English-speaking listeners know (Für Elise; Twinkle, Twinkle, Little Star; Eine kleine Nachtmusik; Canon in D).
Composers by surname as the Chinese does (Beethoven, J. S. Bach when needed to tell the Bachs apart). 約1761 → c. 1761. 傳統 → Traditional.
