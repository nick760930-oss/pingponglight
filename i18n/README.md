# Languages

The game is written in Traditional Chinese (Taiwan). English and Japanese are translations. Simplified Chinese is not planned.

## How it works

- The Chinese text in the code is the key. In Chinese nothing is looked up, so the Chinese game is exactly what the code says.
- `i18n.js` picks the language once per page load (`?lang=en`, then the saved choice, then the browser language; someone who
  already has save data stays in Chinese until they choose). Changing the language reloads the page.
- Players change it in the settings (the row 語言 Language, `#langSeg` in index.html, built in game.js from `PPLI18N.langs`):
  one button per finished language plus the one on screen, each named in its own language and never translated.
  `PPLI18N.set(id)` saves the choice and loads the page again; game.js leaves `ppl-reopen` in sessionStorage so the
  page comes back to the settings. With fewer than two languages to offer the row is hidden.
- `lang-en.js` / `lang-ja.js` are generated from `i18n/<lang>/*.json` by `node tools/i18n.mjs build`. Never edit them by hand.
- `node tools/i18n.mjs check` fails when a translation is missing, stale, or its placeholders do not match.
  It runs before every server deploy (`predeploy` in server/package.json), and the server goes out before the web page.
- `?i18n=debug` shows every string that has no translation inside ⟦ ⟧.

| file | holds | keyed by |
| --- | --- | --- |
| `ui.json` | interface text | the Chinese text (the first argument of `TX`, or a text node of index.html) |
| `songs.json` | `name`, `composer`, `tip`, and `year` when the Chinese year has Chinese characters; optional `sky`: a short name for the star map when `name` is too long there (over 18 Latin letters or 10 kana) | song key |
| `ach.json` | `name`, `desc`, and `reward` when the reward is more than points | achievement id (Chinese, never changes) |
| `cos.json` | `name`, `desc` (emote packs: `name`, `list`) | item id |
| `docs.json` | the text of credits.html and privacy.html | the Chinese text of a paragraph, list item, heading or table cell, with its HTML tags |

`i18n/keys.json` (written by `node tools/i18n.mjs keys`) lists everything that needs a translation, with the Chinese text.

## The two documents

`credits.html` and `privacy.html` are the Chinese source. `node tools/i18n.mjs build` writes `credits.en.html`, `privacy.en.html`,
`credits.ja.html` and `privacy.ja.html` next to them (never edit those by hand); the game opens the one in the player's language.

- Song names, composers and years in the credits table come from `songs.json`: they are not in `docs.json`.
- Everything else is listed in `i18n/docs-keys.json` (written by `keys`). A key is a whole block; a table cell that has no
  translation as a whole is cut at " · " and `<br>`, and each piece is looked up by itself.
- In these pages a text is Chinese when it has Chinese characters or only Chinese punctuation (`Open Hymnal Project（ABC）`):
  such a piece is a key too, and `check` fails when an English translation or page still has either.
- A translation keeps the HTML tags and every link of the Chinese text: `check` fails when they differ.
- `<!-- i18n-only: <p>…</p> -->` in a Chinese page is a block that only the translated pages show; its Chinese text is the key,
  like any other block. The policy uses it for "this page is a translation; the Chinese version prevails". A link to the
  Chinese page from such a block is written `./privacy.html` (`href="privacy.html"` is turned into the reader's own language).
- After the Chinese page changes (a new song's row, a new sentence in the policy): run `keys`, translate what `check` lists as
  `missing doc`, remove what it lists as no longer in the documents, run `build`.
- The four generated pages are in the service worker's list (sw.js) and in the app's file list (app/build.mjs).

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

### 日本語

- です・ます体で簡潔に。「あなた」は基本的に省く。ボタン・タブ・見出しは体言止め（「設定」「フレンドを招待」）。
- 外来語はカタカナ、判定名とランクは英字のまま（Perfect / Great / Good / OK / Miss、S・SS・SSS）。
- 記号：曲名は『　』、引用やボタン名は「　」。数字と単位は半角（3 曲、10 ms）、数字の前後に半角スペースは入れない（「3曲」「第3位」）。⋯ は「…」。
- 中国語の漢字をそのまま流用しない（通關→クリア、暱稱→ニックネーム）。日本で通じる漢語だけ残す。

| 中文 | 日本語 |
| --- | --- |
| 光球 | 光球 |
| 框線 | フレーム（光っている側：「光っているライン」） |
| 尾跡 | 軌跡 |
| 打擊特效 | ヒットエフェクト |
| 背景 | 背景 |
| 名牌框 | ネームプレート |
| 頭像 | アイコン |
| 稱號 | 称号 |
| 對戰表情 | エモート |
| 分享圖外框 | シェア画像フレーム |
| 主題套組 | テーマセット |
| 單件外觀 | 単品 |
| 外觀 | スキン |
| 完整版 | 完全版 |
| 商城 | ショップ |
| 收藏 | コレクション |
| 成就 / 成就點數 | 実績 / 実績ポイント |
| 銅 銀 金 傳說 | ブロンズ、シルバー、ゴールド、レジェンド |
| 限定 | 限定 |
| 星空 | 星空 |
| 星座 | 星座（テーマ名は「座」を付けない：古典座→古典派、巴洛克座→バロック） |
| 獎勵星座 / 獎勵曲 | ボーナス星座 / ボーナス曲 |
| 音符座 | 音符座 |
| 入門 簡單 普通 困難 專家 | ビギナー、イージー、ノーマル、ハード、エキスパート |
| 教學 / 新手教學 | チュートリアル |
| 完美 極佳 良好 尚可 失誤 | Perfect、Great、Good、OK、Miss |
| 連擊 / 最高連擊 / 全連擊 | コンボ / 最大コンボ / フルコンボ |
| 精準度 | 精度 |
| 完成度 | 達成度 |
| 生命值 | ライフ |
| 護盾 | シールド |
| 評級 | ランク |
| 名次 | 順位（「3位」） |
| 通關 / 失敗 | クリア / 失敗 |
| 第 N 關 | ステージN |
| 拍 | 拍 |
| 曲目 | 曲 |
| 線上對戰 / 對戰 | オンライン対戦 / 対戦 |
| 快速配對 | クイックマッチ |
| 房間 / 房號 / 房主 | ルーム / ルームコード / ホスト |
| 公開 / 私人 | 公開 / 非公開 |
| 準備 | 準備完了 |
| 投票選曲 | 投票で選曲 |
| 牽制 | 妨害 |
| 最後衝刺 | ラストスパート |
| 星星時間 | スタータイム |
| 觀戰 | 観戦 |
| 出局 / 離線 | 脱落 / オフライン |
| 好友 / 好友碼 | フレンド / フレンドコード |
| 暱稱 | ニックネーム |
| 排行榜 | ランキング |
| 檢舉 / 封鎖 / 隱藏 | 通報 / ブロック / 非表示 |
| 延遲補償 / 校準 | 遅延補正 / 調整 |
| 音樂層次：微光 明亮 輝映 星耀 | ともしび、ひかり、かがやき、きらめき |
| 恢復購買 | 購入を復元 |
| 回報問題 | 不具合を報告 |
| 社群規範 | コミュニティガイドライン |

曲名は日本で通っている邦題（エリーゼのために、きらきら星、アイネ・クライネ・ナハトムジーク、パッヘルベルのカノン）。作曲者は姓のカタカナ（ベートーヴェン、J.S.バッハ）。
約1761 → 1761年頃。傳統 → 伝承。
