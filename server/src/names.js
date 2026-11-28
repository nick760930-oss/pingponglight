// Nickname rules for the public leaderboard (App Store guideline 1.2: user content needs filtering,
// reporting and removal). Names are normalised before matching so spacing, symbols, full-width letters
// and simple digit swaps cannot hide a blocked word.
// Chinese words and long English words match anywhere in the name; short English words only as a whole
// word, so names like "classic" or "Scunthorpe" are not caught by accident. Japanese: see JA below.
const ZH = ['幹你', '幹妳', '操你', '肏', '屌', '靠北', '靠杯', '機掰', '雞掰', '機八', '雞巴', '鸡巴', '屄', '婊', '賤人', '贱人',
  '妓', '援交', '約炮', '约炮', '做愛', '做爱', '性交', '強姦', '强奸', '輪姦', '陰莖', '阴茎', '陰道', '阴道', '奶子', '色情',
  '去死', '殺了你', '杀了你', '自殺', '自杀', '王八蛋', '混蛋', '智障', '白痴', '白癡', '腦殘', '脑残', '低能', '廢物', '废物',
  '垃圾人', '畜生', '狗娘', '他媽', '他妈', '你媽', '你妈', '尼瑪', '尼玛', '媽的', '妈的', '傻逼', '傻b', '煞筆', '支那',
  '黑鬼', '納粹', '纳粹', '希特勒', '毒品', '大麻', '海洛因', '賭場', '博彩'];
const ZH_NAME = ['官方', '管理員', '管理员', '客服', '開發者', '开发者'];     // impersonation: names only, fine inside a chat message
const EN_ANY = ['fuck', 'shit', 'bitch', 'cunt', 'pussy', 'whore', 'slut', 'nigger', 'nigga', 'faggot', 'retard', 'rape', 'porn',
  'penis', 'vagina', 'dildo', 'hitler', 'nazi', 'asshole', 'bastard', 'motherf', 'cocaine', 'heroin', 'casino'];
const EN_NAME = ['admin', 'moderator', 'official', 'support'];
const EN_WORD = ['ass', 'dick', 'cock', 'fag', 'sex', 'cum', 'gay', 'kkk', 'kys', 'wtf', 'stfu'];
const EN_WORD_NAME = ['gm', 'dev', 'staff', 'apple'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', '$': 's', '!': 'i' };
// Japanese: a first draft, to be read by a native speaker before the Japanese version goes live.
// JA is matched after katakana is folded to hiragana, so one spelling covers both scripts. Japanese has no spaces, so a kana
// word is only in JA when it does not turn up inside everyday phrases (ばか is in やばかった, あほ in まあほんと, まんこ in すまんこれ,
// なちす in みなちす); JA_KATA has those, matched as typed in katakana only, with what may not follow (バカンス, ロマンコース,
// ポルノグラフィティ). Threats are the direct forms, as in Chinese (殺すぞ, not 殺: 初見殺し is how players talk about a hard chart).
// Kanji words are left out when they sit inside everyday Chinese (射精 in 反射精準, 買春 in 買春聯, 穢多 in 汙穢多年).
// What this misses is left to reports and the AI review (moderate.js).
const JA = ['死ね', 'たひね', 'くたばれ', 'ぶっ殺', 'ぶっころ', '殺すぞ', '殺してや', '馬鹿', '雑魚', '気違い', '知恵遅れ',
  '売春', '中出し', '陰茎', '膣', 'せっくす', 'ちんこ', 'ちんぽ', 'おっぱい', 'れいぷ', 'おなにー',
  'くろんぼ', 'ひとらー', '覚醒剤', '覚せい剤', '麻薬', 'へろいん', 'こかいん'];
const JA_KATA = /バカ(?!ンス)|アホ(?!ウドリ)|クズ|ザコ|マンコ(?!ース|[\u30a1-\u30f6])|コロス(?!ケ)|ポルノ(?!グラフィ)|ナチス/;
const JA_NAME = ['運営', '公式', '管理者', '管理人', '開発者', 'うんえい', 'さぽーと', 'すたっふ'];   // impersonation: names only
// everyday words that contain a JA word, after folding: 死ねない / 死ねる (cannot die), パチンコ, and レイプ across two words (プレイ プロ, オーバーレイ プラグイン)
const JA_OK = ['死ねない', '死ねなか', '死ねなく', '死ねる', 'ぱちんこ', 'れいぷら', 'れいぷり', 'れいぷる', 'れいぷれ', 'れいぷろ'];
const kana = s => s.replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));   // katakana -> hiragana
function jaBad(flat, name) {   // flat: lower case, letters and digits only
  let h = kana(flat);
  for (const w of JA_OK) h = h.split(w).join(' ');
  return JA_KATA.test(flat) || JA.some(w => h.includes(w)) || (name && JA_NAME.some(w => h.includes(w)));
}

// Nickname length (v65): counted in width units, at most NAME_MAX. Full-width characters (Chinese, Japanese, full-width symbols,
// emoji) count 2, half-width ones 1, so 8 CJK characters or 16 letters/digits. Cut at grapheme boundaries, never inside an emoji
// sequence (keycaps, skin tones, flags, ZWJ sequences). Same rule as game.js (nameW / nameClip).
// Zero-width parts (variation selector, keycap mark, skin tone, joiner) cannot be stacked: a grapheme of more than G_MAX code points
// keeps only its first one, a grapheme that starts with a zero-width part is dropped; a skin tone stays only right after an emoji, and a variation selector or keycap mark is not repeated.
export const NAME_MAX = 16;
const G_MAX = 12;
const NAME_WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u231a-\u23ff\u25a0-\u27bf\u2b00-\u2bff]|\p{Extended_Pictographic}/u;
const ZW = /[\u200d\ufe0f\u20e3]/u, TONE = /[\u{1f3fb}-\u{1f3ff}]/u;
const charW = c => ZW.test(c) || TONE.test(c) ? 0 : NAME_WIDE.test(c) ? 2 : 1;
export const nameWidth = s => { let w = 0; for (const c of String(s == null ? '' : s)) w += charW(c); return w; };
const SEG = (() => { try { return typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null; } catch (e) { return null; } })();
const graphemes = s => SEG ? Array.from(SEG.segment(s), x => x.segment) : Array.from(s);
function fixG(g) {   // a skin tone stays only right after an emoji; a variation selector or keycap mark is not repeated
  g = g.replace(/(?<!\p{Extended_Pictographic})[\u{1f3fb}-\u{1f3ff}]/gu, '').replace(/([\ufe0f\u20e3])\1+/gu, '$1');
  const cp = Array.from(g); if (cp.length > G_MAX) g = cp[0]; const f = Array.from(g)[0] || ''; if (!f || ZW.test(f) || TONE.test(f)) return ['', 0]; return [g, nameWidth(g)];
}
export function clipName(s, max = NAME_MAX) { let w = 0, o = ''; for (const g0 of graphemes(String(s))) { const [g, n] = fixG(g0); if (!g) continue; if (w + n > max) break; w += n; o += g; } return o; }

// same character rules as the duel lobby: no control characters, no markup characters, no invisible characters; the zero-width
// joiner is kept only between two emoji (inside a ZWJ sequence); at most `max` width units (NAME_MAX for a nickname that is set;
// the rooms pass a wider cap so a nickname kept from the old 12-character rule is not cut). The input is capped first, so the work stays small.
export const cleanName = (v, max = NAME_MAX) => clipName(String(v == null ? '' : v).slice(0, 256).replace(/[\ud800-\udbff]$/, '').normalize('NFKC')
  .replace(/[\u00ad\u115f\u1160\u3164\uffa0\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff<>&"'`\\]/g, '')
  .replace(/\u200d+/gu, (m, i, str) => /\p{Extended_Pictographic}[\ufe0f\u{1f3fb}-\u{1f3ff}]*$/u.test(str.slice(Math.max(0, i - 8), i)) && /^\p{Extended_Pictographic}/u.test(str.slice(i + m.length)) ? '\u200d' : '')
  .replace(/\s+/g, ' ').trim(), max).trim();

function badWords(text, zh, any, word) {
  const low = text.toLowerCase();
  const flat = low.replace(/[0134578@$!]/g, c => LEET[c]).replace(/[^\p{L}\p{N}]/gu, '');   // "f.u c k" -> "fuck"
  if (zh.some(w => flat.includes(w)) || any.some(w => flat.includes(w)) || jaBad(flat, true)) return true;
  const words = low.replace(/[0134578@$!]/g, c => LEET[c]).split(/[^a-z]+/).filter(Boolean);
  return words.some(w => word.includes(w));
}

export function nameProblem(name) {
  if (!name) return 'empty';
  if (!/[\p{L}\p{N}]/u.test(name)) return 'empty';
  return badWords(name, [...ZH, ...ZH_NAME], [...EN_ANY, ...EN_NAME], [...EN_WORD, ...EN_WORD_NAME]) ? 'blocked' : null;
}

// Friend messages (free text): same word lists without the impersonation words, plus no links, e-mail
// addresses or long digit runs (phone numbers, IDs), so the chat cannot be used to move players elsewhere.
export const MSG_MAX = 60;
export const cleanMsg = v => Array.from(String(v == null ? '' : v).normalize('NFC')   // keep full-width punctuation as typed
  .replace(/\s+/g, ' ')   // new lines become spaces before control characters go
  .replace(/[\u00ad\u115f\u1160\u3164\uffa0\u0000-\u001f\u007f-\u009f​‌‎‏‪-‮⁠-⁯﻿]/g, '')   // ZWJ stays (emoji sequences)
  .trim()).slice(0, MSG_MAX).join('').trim();
const EN_OK = ['grape', 'grapes', 'scrape', 'scraped', 'scrapes', 'drape', 'drapes', 'heroine', 'heroines', 'shitake', 'shiitake', 'therapist', 'cockpit', 'cocktail', 'peacock', 'hancock', 'dickens', 'assassin', 'class', 'classic', 'pass', 'bass', 'grass', 'glass', 'mass', 'massive', 'assist', 'assume'];
const MSG_OK = ['大麻煩', '媽媽', '我媽的', '賴床', '信賴', '依賴', '還不賴', '不賴'];   // everyday words that contain a blocked one
export function msgProblem(text) {
  if (!text) return 'empty';
  // full-width letters match like plain ones; accents are dropped ("fück"); a kana voicing mark stays on its kana (バ is not ハ)
  // and goes when it is on anything else (left in, it would split "fuck", a link or a phone number)
  let n = text.normalize('NFKD').replace(/(?![\u3099\u309a])\p{M}/gu, '').normalize('NFKC').replace(/[\u3099\u309a]/g, '')
    .replace(/[\p{Cf}\u180e\u115f\u1160\u3164\uffa0]/gu, '');   // invisible characters (ZWJ, tags...) only for matching: "fu\u200dck" is "fuck"
  for (const w of MSG_OK) n = n.split(w).join(' ');
  const low = n.toLowerCase();
  // Chinese words anywhere; English inside one word only (a whole sentence squashed together makes "this hit" into "shit")
  const flat = low.replace(/[^\p{L}\p{N}]/gu, '');
  if (ZH.some(w => flat.includes(w)) || jaBad(flat, false)) return 'blocked';
  const raw = low.split(/[^a-z0-9@$!]+/).filter(Boolean), toks = [];
  for (const t of raw) { const one = /^[a-z@$!]$/.test(t); if (one && toks.length && toks[toks.length - 1].one) toks[toks.length - 1].t += t; else toks.push({ t, one }); }   // "f.u.c.k" -> "fuck" (letters only: "4 5 5" stays numbers)
  const words = toks.map(x => x.t.replace(/[0134578@$!]/g, c => LEET[c])).filter(t => !EN_OK.includes(t));
  if (words.some(t => EN_ANY.some(w => t.includes(w)) || EN_WORD.includes(t))) return 'blocked';
  const plain = low.replace(/[。．｡]/g, '.');
  // "abc.com" or "abc dot com", but not "nice. gg" / "ok. me too"
  if (/https?:|www\.|[a-z0-9-]+(\.|\s*\bdot\b\s*)(com|net|org|io|gg|tw|cn|me|ly|link|app|xyz|c0m)\b|@[a-z0-9-]+\./.test(plain)) return 'link';
  const H = "(?<![a-z])(line|ig|wechat|discord|dc|tg|telegram|fb)";
  if (new RegExp("(加我|加個|加一下|加\\s|add|私我|私訊|密我).{0,3}(" + H + "(?![a-z])|賴|微信|臉書)|(" + H + "|賴|微信)\\s*(id(?![a-z])|[:：])|加(賴|微信)|[a-z]#\\d{4}\\b").test(plain)) return 'link';
  const digits = plain.replace(/[零〇一二三四五六七八九]/g, c => '零一二三四五六七八九'.indexOf(c) >= 0 ? String('零一二三四五六七八九'.indexOf(c)) : '0');
  if (digits.replace(/[\s\-()+./／]/g, '').match(/\d{9,}/)) return 'link';   // phone numbers (a score has at most 7 digits)
  return null;
}

// what makes two names "the same" for uniqueness: case, width, spaces and symbols do not count
export const nameKey = name => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
