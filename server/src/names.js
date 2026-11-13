// Nickname rules for the public leaderboard (App Store guideline 1.2: user content needs filtering,
// reporting and removal). Names are normalised before matching so spacing, symbols, full-width letters
// and simple digit swaps cannot hide a blocked word.
// Chinese words and long English words match anywhere in the name; short English words only as a whole
// word, so names like "classic" or "Scunthorpe" are not caught by accident.
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

// same character rules as the duel lobby: no control characters, no markup characters, at most 12 characters
export const cleanName = v => Array.from(String(v == null ? '' : v).normalize('NFKC')
  .replace(/[\u00ad\u115f\u1160\u3164\uffa0\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿<>&"'`\\]/g, '')
  .replace(/\s+/g, ' ').trim()).slice(0, 12).join('').trim();

function badWords(text, zh, any, word) {
  const low = text.toLowerCase();
  const flat = low.replace(/[0134578@$!]/g, c => LEET[c]).replace(/[^\p{L}\p{N}]/gu, '');   // "f.u c k" -> "fuck"
  if (zh.some(w => flat.includes(w)) || any.some(w => flat.includes(w))) return true;
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
  // full-width letters match like plain ones; accents are dropped ("fück")
  let n = text.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFKC')
    .replace(/[\p{Cf}\u180e\u115f\u1160\u3164\uffa0]/gu, '');   // invisible characters (ZWJ, tags...) only for matching: "fu\u200dck" is "fuck"
  for (const w of MSG_OK) n = n.split(w).join(' ');
  const low = n.toLowerCase();
  // Chinese words anywhere; English inside one word only (a whole sentence squashed together makes "this hit" into "shit")
  const flat = low.replace(/[^\p{L}\p{N}]/gu, '');
  if (ZH.some(w => flat.includes(w))) return 'blocked';
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
