// Nickname and message word rules (no server needed): node test/names.mjs
import { cleanName, nameProblem, cleanMsg, msgProblem } from '../src/names.js';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const name = v => nameProblem(cleanName(v)), msg = v => msgProblem(cleanMsg(v));
const all = (f, want, list) => { for (const v of list) { const r = f(v); ok(r === want, JSON.stringify(v) + ' -> ' + r + ', expected ' + want); } };

// Chinese and English
all(name, 'blocked', ['fuck', 'f.u c k', 'ＦＵＣＫ', 'sh1t', '幹你', '官方', 'admin', 'gm', 'a dick']);
all(name, null, ['classic', '小明', 'Mozart', '光球', '麻煩']);
all(msg, 'blocked', ['幹你', 'fuck you', 'fück', 'f.u.c.k', 'fu‍ck', '你去死', 'kys']);
all(msg, null, ['大麻煩', 'classic', 'this hit was great', '官方譜面', 'grape', '再來一局', '精準度 98.5%', '反射精準度很高', '去買春聯', '湖泊池沼', '汙穢多年', '數學公式']);
all(msg, 'link', ['加我line', 'abc.com', 'line id: abc', '0912345678']);
all(msg, null, ['nice. gg', 'ok. me too', '1234567']);
ok(nameProblem('') === 'empty' && nameProblem('!!!') === 'empty' && msgProblem('') === 'empty', 'empty');
// a kana voicing mark (combining, or the half-width one an input method types) on a letter or a digit hides nothing
all(msg, 'blocked', ['fu゙ck', 'fuﾞck', 'sh゚it']);
all(msg, 'link', ['abc.co゙m', '0912ﾞ345678', 'li゙ne id: abc']);

// Japanese names: both scripts, half-width kana, spacing and symbols
all(name, 'blocked', ['死ね', 'タヒね', 'くたばれ', 'ぶっ殺す', 'ぶっころす', '殺すぞ', '馬鹿', 'バカ', 'ﾊﾞｶ', 'バ・カ', 'バ カ', 'アホ', 'クズ', 'ザコ', 'コロス',
  'セックス', 'せっくす', 'ｾｯｸｽ', 'セ ッ ク ス', 'ちんこ', 'チンコ', 'ちんぽ', 'マンコ', 'おっぱい', 'ポルノ', 'レイプ', 'オナニー', '売春', '中出し', '陰茎',
  'ナチス', 'ヒトラー', 'ヘロイン', 'コカイン', '麻薬', '覚醒剤', '覚せい剤', '雑魚', '気違い', '知恵遅れ']);
all(name, 'blocked', ['運営', '公式', '管理者', '管理人', '開発者', 'うんえい', 'ウンエイ', 'サポート', 'スタッフ', '公式アカ']);   // impersonation
all(name, null, ['さくら', 'たなか', 'ミク', 'ヒロイン', 'バカンス', 'やばかった', 'ヤバかった', 'パチンコ', 'ぱちんこ', 'ハカ', 'シネマ', 'カスタム', 'イエロー',
  '初見殺し', 'モーツァルト', 'ひかりのたま', 'ガイジン', 'すまんこれ', 'ポルノグラフィティ', 'ロマンコース', 'アホウドリ', 'コロスケ', 'みなちす']);

// Japanese messages
all(msg, 'blocked', ['死ね', 'お前死ねよ', '死ねなw', 'バカじゃないの', 'ﾊﾞｶ', 'バ カ', 'ぶっころすぞ', '殺してやる', 'マンコ', 'マンコ見せて', 'マンコー', 'ﾏﾝｺｰ', 'レイプ', 'レイプする', 'セックスしよう', 'この雑魚',
  'クズが', 'ザコw', 'くたばれ', 'ポルノ見た', 'ナチス']);
all(msg, null, ['やばかった！', 'ヤバかったね', 'すまんこれ無理', 'この曲初見殺しだね', 'まだ死ねない', '死ねなかった', 'これは死ねる', 'プレイ プロ級だね', 'リプレイ プレイヤー', 'バカンス行きたい',
  'もう一回やろう', 'フルコンボおめでとう', 'ことばかけ', 'そればかり', 'そばから見てた', 'まあほんと', '運営に報告した', '公式譜面', 'パチンコ行ってくる', 'がんばって', 'シネマ', 'ヒロイン',
  'スタッフロール', 'カスタム譜面', 'イエロー', 'ガイジン', 'くずれた', 'ありがとう', 'おつかれさま', 'ナイス！', 'ドンマイ',
  'ポルノグラフィティの曲', 'オーバーレイプラグイン', 'トレイプレート', 'ヒューマンコメディ', 'ロマンコース', 'アンパンマンコラボ', 'そうだな ちす', 'みなちす', '佐藤氏ね、上手いよ']);
// voicing marks survive the accent step (バ is not ハ), composed or not
ok(msg('バカ') === 'blocked' && msg('ハカ') === null, 'combining dakuten');
ok(msg('ばかり') === null && msg('ぱちんこ') === null, 'allowed kana');

// v65 nickname length: width units (full-width 2, half-width 1), at most 16, cut at grapheme boundaries
const cut = (v, want) => ok(cleanName(v) === want, 'cleanName ' + JSON.stringify(v) + ' -> ' + JSON.stringify(cleanName(v)) + ', expected ' + JSON.stringify(want));
cut('大遲大遲大遲大遲', '大遲大遲大遲大遲'); cut('大遲大遲大遲大遲大', '大遲大遲大遲大遲');
cut('W'.repeat(16), 'W'.repeat(16)); cut('W'.repeat(17), 'W'.repeat(16));
cut('ひらがなカタカナ', 'ひらがなカタカナ'); cut('ひらがなカタカナか', 'ひらがなカタカナ');
cut('大遲大遲大遲大WW', '大遲大遲大遲大WW'); cut('大遲大遲大遲大WWW', '大遲大遲大遲大WW');
cut('1️⃣'.repeat(16), '1️⃣'.repeat(16));
cut('\u{1f44d}\u{1f3fd}'.repeat(9), '\u{1f44d}\u{1f3fd}'.repeat(8));
cut('\u{1f1f9}\u{1f1fc}'.repeat(9), '\u{1f1f9}\u{1f1fc}'.repeat(8));
cut('\u{1f441}️‍\u{1f5e8}️'.repeat(5), '\u{1f441}️‍\u{1f5e8}️'.repeat(4));
cut('a‍b', 'ab'); cut('‍大遲‍', '大遲'); cut('ＡＢＣ', 'ABC');
// zero-width parts cannot be stacked (v65 review): the result stays short whatever is appended
for (const z of ['\ufe0f', '\u20e3', '\u{1f3fd}', '\u200d']) { const r = cleanName('a' + z.repeat(1000)); ok(Array.from(r).length <= 13 && r.startsWith('a'), 'stacked ' + z.codePointAt(0).toString(16) + ' -> ' + r.length); }
cut('\u{1f3fd}'.repeat(20), '');   // a skin tone that does not follow an emoji is dropped
{ const r = cleanName(('a' + '\u{1f3fd}'.repeat(11)).repeat(16)); ok(/^a{1,16}$/.test(r), 'tones after letters are dropped (input capped at 256 code units) -> ' + JSON.stringify(r)); }
cut('\u{1f44d}' + '️'.repeat(5), '\u{1f44d}️');
cut('Zq' + '\ufe0f'.repeat(3000), 'Zq\ufe0f');   // a repeated variation selector becomes one
ok(cleanName('a'.repeat(100000)).length === 16, 'very long input is capped');
ok(cleanName('大遲'.repeat(6), 32) === '大遲'.repeat(6), 'rooms keep an old 12-character nickname');
ok(name('f‍uck') === 'blocked', 'joiner between letters is removed before the word check');

console.log(fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'names: ' + pass + ' checks passed');
process.exit(fail ? 1 : 0);
