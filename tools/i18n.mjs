// Languages (see i18n.js). Chinese text in the code is the key; the translations live in i18n/<lang>/*.json and are
// packed into lang-<lang>.js, which the game loads.
//
//   node tools/i18n.mjs keys        writes i18n/keys.json: everything that needs a translation, with the Chinese text
//   node tools/i18n.mjs build       writes lang-en.js and lang-ja.js from i18n/<lang>/{ui,songs,ach,cos}.json
//   node tools/i18n.mjs check       fails (exit 1) on a missing or stale translation, a placeholder that does not match,
//                                   or a lang-*.js that is not what the json files give now
//   node tools/i18n.mjs check --soft   the same report, but missing translations do not fail (while translating)
//   node tools/i18n.mjs unwrapped   lists Chinese string literals in the game code that are not inside TX()/TXA()/TXO()
//                                   (ids and source data are expected there; read the list, it is not an error by itself)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['en', 'ja'];
const JS = ['game.js', 'shop.js', 'ach.js', 'cosmetics.js', 'iap.js', 'ai_bg.js'];
const HTML = ['index.html'];
const ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const rd = f => readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
const lineOf = (s, i) => s.slice(0, i).split('\n').length;
const bare = id => { const at = id.lastIndexOf('@@'); return at >= 0 ? id.slice(0, at) : id; };
const holes = s => [...new Set([...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort();

// ---------------------------------------------------------------- JavaScript: string literals and the TX calls
function readStr(src, i) {   // src[i] is ' or " : returns [value, index after the closing quote]
  const q = src[i]; let v = '', j = i + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === q) return [v, j + 1];
    if (c === '\n') break;
    if (c !== '\\') { v += c; continue; }
    const n = src[++j];
    if (n === 'n') v += '\n'; else if (n === 't') v += '\t'; else if (n === 'r') v += '\r';
    else if (n === 'u') { if (src[j + 1] === '{') { const e = src.indexOf('}', j); v += String.fromCodePoint(parseInt(src.slice(j + 2, e), 16)); j = e; } else { v += String.fromCharCode(parseInt(src.slice(j + 1, j + 5), 16)); j += 4; } }
    else if (n === 'x') { v += String.fromCharCode(parseInt(src.slice(j + 1, j + 3), 16)); j += 2; }
    else if (n === '\n') { /* line continuation */ } else v += n;
  }
  throw new Error('unterminated string');
}
const ws = (src, i) => { while (/\s/.test(src[i] || '')) i++; return i; };

// tokens of a JS file, good enough for this code base: comments, strings, template literals and regex literals are skipped as units
function* strings(src) {
  let i = 0, prev = '';   // prev: the last significant character (decides whether a slash starts a regex)
  let word = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"') { const [v, e] = readStr(src, i); yield { v, at: i, end: e }; i = e; prev = 'x'; word = ''; continue; }
    if (c === '`') {   // template literal: reported whole (placeholders included), never a key
      let j = i + 1, depth = 0;
      for (; j < src.length; j++) { const t = src[j]; if (t === '\\') { j++; continue; } if (t === '$' && src[j + 1] === '{') { depth++; j++; continue; } if (t === '}' && depth) { depth--; continue; } if (t === '`' && !depth) break; }
      yield { v: src.slice(i + 1, j), at: i, end: j + 1, tpl: true }; i = j + 1; prev = 'x'; word = ''; continue;
    }
    if (c === '/') {
      const re = !prev || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /^(return|typeof|case|in|of|do|else|void|delete)$/.test(word);
      if (re) { let j = i + 1, cls = false; for (; j < src.length; j++) { const t = src[j]; if (t === '\\') { j++; continue; } if (t === '\n') break; if (t === '[') cls = true; else if (t === ']') cls = false; else if (t === '/' && !cls) break; } i = j + 1; while (/[a-z]/.test(src[i] || '')) i++; prev = 'x'; word = ''; continue; }
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[\w$]/.test(c)) { let j = i; while (/[\w$]/.test(src[j] || '')) j++; word = src.slice(i, j); prev = 'x'; i = j; continue; }
    prev = c; word = ''; i++;
  }
}

function jsKeys(file) {   // [{id, at:'file:line'}] and the [start,end) ranges of every literal that is a key
  const src = rd(file), out = [], used = [];
  const add = (v, at, end) => { out.push({ id: v, at: file + ':' + lineOf(src, at) }); used.push([at, end]); };
  const fail = (i, why) => { throw new Error(file + ':' + lineOf(src, i) + ' ' + why); };
  for (const m of src.matchAll(/(?<![\w$.])TX(A|O)?\(/g)) {
    let i = ws(src, m.index + m[0].length);
    if (!m[1]) {
      if (src[i] !== "'" && src[i] !== '"') fail(i, 'TX( must be followed by a plain string literal');
      const [v, e] = readStr(src, i); add(v, i, e);
      const n = ws(src, e); if (src[n] !== ',' && src[n] !== ')') fail(i, 'TX(\'...\' must be followed by , or ) (no concatenation inside the key)');
    } else if (m[1] === 'A') {
      if (src[i] !== '[') fail(i, 'TXA( must be followed by an array literal');
      for (i = ws(src, i + 1); src[i] !== ']'; i = ws(src, i)) {
        if (src[i] === ',') { i++; continue; }
        if (src[i] !== "'" && src[i] !== '"') fail(i, 'TXA([...]) may only hold plain string literals');
        const [v, e] = readStr(src, i); add(v, i, e); i = e;
      }
    } else {
      if (src[i] !== '{') fail(i, 'TXO( must be followed by an object literal');
      for (i = ws(src, i + 1); src[i] !== '}'; i = ws(src, i)) {
        if (src[i] === ',') { i++; continue; }
        if (src[i] === "'" || src[i] === '"') i = readStr(src, i)[1]; else { const k = /^[\w$]+/.exec(src.slice(i)); if (!k) fail(i, 'TXO({...}): unexpected key'); i += k[0].length; }
        i = ws(src, i); if (src[i] !== ':') fail(i, 'TXO({...}): expected :'); i = ws(src, i + 1);
        if (src[i] !== "'" && src[i] !== '"') fail(i, 'TXO({...}) values must be plain string literals');
        const [v, e] = readStr(src, i); add(v, i, e); i = e;
      }
    }
  }
  return { src, keys: out, used };
}

// ---------------------------------------------------------------- index.html: text nodes and a few attributes
const ENT = { nbsp: '\u00a0', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unent = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (e in ENT ? ENT[e] : m));
function htmlKeys(file) {
  const src = rd(file), out = [];
  const add = (raw, at) => { const k = unent(raw).trim(); if (k && CJK.test(k)) out.push({ id: k, at: file + ':' + lineOf(src, at) }); };
  let i = 0, skip = '';
  while (i < src.length) {
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i); i = e < 0 ? src.length : e + 3; continue; }
    if (src[i] === '<' && /[a-zA-Z\/!]/.test(src[i + 1] || '')) {
      let j = i + 1, q = '';
      for (; j < src.length; j++) { const c = src[j]; if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
      const tag = src.slice(i, j + 1), name = (/^<\/?([a-zA-Z0-9]+)/.exec(tag) || [])[1];
      if (name && tag[1] !== '/') {
        for (const a of ATTRS) { const m = new RegExp('\\s' + a + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')').exec(tag); if (m) add(m[2] != null ? m[2] : m[3], i); }
        const low = name.toLowerCase();
        if (low === 'script' || low === 'style') { const e = src.toLowerCase().indexOf('</' + low, j); i = e < 0 ? src.length : e; continue; }
      }
      i = j + 1; continue;
    }
    const e = src.indexOf('<', i + 1), end = e < 0 ? src.length : e;
    add(src.slice(i, end), i); i = end;
  }
  return out;
}

// ---------------------------------------------------------------- data: songs, achievements, cosmetics
function data() {
  const sb = { window: {} }; vm.createContext(sb);
  vm.runInContext(rd('songs.js'), sb); vm.runInContext(rd('ach-data.js'), sb);
  const cb = { console }; vm.createContext(cb); vm.runInContext(rd('cosmetics.js'), cb);
  const W = sb.window, C = cb.PPLC, ACH = W.PPLACH;
  const songs = {};
  for (const k of W.SONGORDER) { const s = W.SONGDATA[k]; if (s) songs[k] = { name: s.name, composer: s.composer, year: String(s.year), tip: s.tip || '' }; }
  const ach = {}, achById = {};
  for (const a of ACH.list) { ach[a.id] = { name: a.name, desc: a.desc }; if (a.reward !== '成就點數') ach[a.id].reward = a.reward; achById[a.id] = a; }
  const cos = {};
  for (const it of C.items) {
    const o = { name: it.name, desc: it.desc };
    if (it.cat === 'emote') { delete o.desc; o.list = it.list.slice(); }   // an emote pack's description is its phrases joined
    if (it.cat === 'title' && typeof it.how === 'string' && it.how.indexOf('ach:') === 0) {   // a title named after its achievement follows the achievement
      const a = achById[it.how.slice(4)];
      if (a && a.name === it.name && a.desc === it.desc) continue;
      if (a && a.name === it.name) delete o.name;
    }
    cos[it.id] = o;
  }
  // strings that reach TX() through a variable, straight from the data
  const dyn = [];
  ACH.tabs.forEach(t => dyn.push({ id: t, at: 'ach-data.js:tabs' }));
  dyn.push({ id: '成就點數', at: 'ach-data.js:reward' });
  W.SONGCONS.forEach(c => dyn.push({ id: c[0], at: 'songs.js:SONGCONS' }));
  return { songs, ach, cos, dyn };
}

function collect() {
  const ui = new Map();
  const put = k => { if (!ui.has(k.id)) ui.set(k.id, []); ui.get(k.id).push(k.at); };
  for (const f of JS) jsKeys(f).keys.forEach(put);
  for (const f of HTML) htmlKeys(f).forEach(put);
  const d = data(); d.dyn.forEach(put);
  return { ui, ...d };
}

// ---------------------------------------------------------------- commands
const readJson = p => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
const pack = lang => { const d = join(ROOT, 'i18n', lang); return { ui: readJson(join(d, 'ui.json')), song: readJson(join(d, 'songs.json')), ach: readJson(join(d, 'ach.json')), cos: readJson(join(d, 'cos.json')) }; };
const packJs = (lang, p) => '/* GENERATED by tools/i18n.mjs from i18n/' + lang + '/*.json. Do not edit by hand: change the json files and run `node tools/i18n.mjs build`. */\n'
  + '(window.PPLLANG=window.PPLLANG||{}).' + lang + '=' + JSON.stringify(p) + ';\n';

const cmd = process.argv[2], soft = process.argv.includes('--soft');
if (cmd === 'keys') {
  const c = collect();
  mkdirSync(join(ROOT, 'i18n'), { recursive: true });
  const ui = [...c.ui].map(([id, at]) => ({ id, at: [...new Set(at)].slice(0, 4) }));
  writeFileSync(join(ROOT, 'i18n', 'keys.json'), JSON.stringify({ ui, songs: c.songs, ach: c.ach, cos: c.cos }, null, 1) + '\n');
  console.log('i18n/keys.json:', ui.length, 'interface strings,', Object.keys(c.songs).length, 'songs,', Object.keys(c.ach).length, 'achievements,', Object.keys(c.cos).length, 'cosmetic items');
} else if (cmd === 'build') {
  for (const l of LANGS) { const p = pack(l); writeFileSync(join(ROOT, 'lang-' + l + '.js'), packJs(l, p)); console.log('lang-' + l + '.js:', Object.keys(p.ui).length, 'interface strings'); }
} else if (cmd === 'check') {
  const c = collect(); let bad = 0, missing = 0;
  const err = m => { bad++; console.log('  ERROR ' + m); }, miss = m => { missing++; if (missing <= 60) console.log('  missing ' + m); };
  for (const l of LANGS) {
    console.log('== ' + l); const p = pack(l), m0 = missing;
    for (const [id, at] of c.ui) {
      const v = p.ui[id];
      if (v == null || v === '') { miss('ui "' + id + '"  (' + at[0] + ')'); continue; }
      const forms = typeof v === 'object' ? Object.values(v) : [v], need = holes(bare(id)).join();
      if (typeof v === 'object' && !('other' in v)) err('ui "' + id + '": a plural needs an "other" form');
      for (const f of forms) {
        if (typeof f !== 'string') { err('ui "' + id + '": not a string'); continue; }
        const got = holes(f); if (got.some(h => !need.split(',').includes(h))) err('ui "' + id + '": unknown placeholder in "' + f + '"');
        if (typeof v !== 'object' && got.join() !== need) err('ui "' + id + '": placeholders differ: {' + need + '} vs {' + got.join() + '}');
      }
    }
    for (const id of Object.keys(p.ui)) if (!c.ui.has(id)) err('ui "' + id + '" is no longer used (remove it or fix the key)');
    const fields = (kind, src, tr, req) => { for (const k in src) for (const f of req(src[k])) { const v = tr[k] && tr[k][f]; if (v == null || v === '' || Array.isArray(src[k][f]) && (!Array.isArray(v) || v.length !== src[k][f].length)) miss(kind + ' ' + k + '.' + f); } for (const k in tr) if (!(k in src)) err(kind + ' ' + k + ' does not exist'); };
    fields('song', c.songs, p.song, s => ['name', 'composer', 'tip'].concat(CJK.test(s.year) ? ['year'] : []));
    fields('ach', c.ach, p.ach, a => Object.keys(a));
    fields('cos', c.cos, p.cos, o => Object.keys(o));
    for (const k in p.song) for (const f in p.song[k]) if (CJK.test(p.song[k][f]) && l === 'en') err('song ' + k + '.' + f + ' still has Chinese characters');
    const js = join(ROOT, 'lang-' + l + '.js');
    if (!existsSync(js) || readFileSync(js, 'utf8').replace(/\r\n/g, '\n') !== packJs(l, p)) err('lang-' + l + '.js is stale: run `node tools/i18n.mjs build`');
    console.log('  ' + (missing - m0) + ' missing');
  }
  if (missing > 60) console.log('  (' + (missing - 60) + ' more missing lines not shown)');
  console.log(bad ? bad + ' error(s)' : 'no errors', '·', missing, 'missing');
  process.exit(bad || (missing && !soft) ? 1 : 0);
} else if (cmd === 'unwrapped') {
  let n = 0;
  for (const f of JS) {
    const { src, used } = jsKeys(f);
    for (const s of strings(src)) {
      if (!CJK.test(s.v) || used.some(([a, b]) => s.at >= a && s.at < b)) continue;
      n++; console.log(f + ':' + lineOf(src, s.at) + '  ' + (s.tpl ? '`' : "'") + s.v.replace(/\n/g, '\\n').slice(0, 90));
    }
  }
  console.log(n, 'Chinese string literal(s) outside TX()/TXA()/TXO()');
} else {
  console.log('usage: node tools/i18n.mjs keys | build | check [--soft] | unwrapped'); process.exit(2);
}
