// Nickname rules for the public leaderboard (App Store guideline 1.2: user content needs filtering,
// reporting and removal). Names are normalised before matching so spacing, symbols, full-width letters
// and simple digit swaps cannot hide a blocked word.
// Chinese words and long English words match anywhere in the name; short English words only as a whole
// word, so names like "classic" or "Scunthorpe" are not caught by accident.
const ZH = ['幹你', '幹妳', '操你', '肏', '屌', '靠北', '靠杯', '機掰', '雞掰', '機八', '雞巴', '鸡巴', '屄', '婊', '賤人', '贱人',
  '妓', '援交', '約炮', '约炮', '做愛', '做爱', '性交', '強姦', '强奸', '輪姦', '陰莖', '阴茎', '陰道', '阴道', '奶子', '色情',
  '去死', '殺了你', '杀了你', '自殺', '自杀', '王八蛋', '混蛋', '智障', '白痴', '白癡', '腦殘', '脑残', '低能', '廢物', '废物',
  '垃圾人', '畜生', '狗娘', '他媽', '他妈', '你媽', '你妈', '尼瑪', '尼玛', '媽的', '妈的', '傻逼', '傻b', '煞筆', '支那',
  '黑鬼', '納粹', '纳粹', '希特勒', '毒品', '大麻', '海洛因', '賭場', '博彩', '官方', '管理員', '管理员', '客服', '開發者', '开发者'];
const EN_ANY = ['fuck', 'shit', 'bitch', 'cunt', 'pussy', 'whore', 'slut', 'nigger', 'nigga', 'faggot', 'retard', 'rape', 'porn',
  'penis', 'vagina', 'dildo', 'hitler', 'nazi', 'asshole', 'bastard', 'motherf', 'cocaine', 'heroin', 'casino', 'admin',
  'moderator', 'official', 'support'];
const EN_WORD = ['ass', 'dick', 'cock', 'fag', 'sex', 'cum', 'gay', 'kkk', 'kys', 'wtf', 'stfu', 'gm', 'dev', 'staff', 'apple'];
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', '$': 's', '!': 'i' };

// same character rules as the duel lobby: no control characters, no markup characters, at most 12 characters
export const cleanName = v => Array.from(String(v == null ? '' : v).normalize('NFKC')
  .replace(/[\u00ad\u115f\u1160\u3164\uffa0\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿<>&"'`\\]/g, '')
  .replace(/\s+/g, ' ').trim()).slice(0, 12).join('').trim();

export function nameProblem(name) {
  if (!name) return 'empty';
  if (!/[\p{L}\p{N}]/u.test(name)) return 'empty';
  const low = name.toLowerCase();
  const flat = low.replace(/[0134578@$!]/g, c => LEET[c]).replace(/[^\p{L}\p{N}]/gu, '');   // "f.u c k" -> "fuck"
  if (ZH.some(w => flat.includes(w))) return 'blocked';
  if (EN_ANY.some(w => flat.includes(w))) return 'blocked';
  const words = low.replace(/[0134578@$!]/g, c => LEET[c]).split(/[^a-z]+/).filter(Boolean);
  if (words.some(w => EN_WORD.includes(w))) return 'blocked';
  return null;
}

// what makes two names "the same" for uniqueness: case, width, spaces and symbols do not count
export const nameKey = name => name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
