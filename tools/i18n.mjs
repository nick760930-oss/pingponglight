// Languages (see i18n.js). Chinese text in the code is the key; the translations live in i18n/<lang>/*.json and are
// packed into lang-<lang>.js, which the game loads.
//
//   node tools/i18n.mjs keys        writes i18n/keys.json: everything that needs a translation, with the Chinese text
//   node tools/i18n.mjs build       writes lang-en.js and lang-ja.js from i18n/<lang>/{ui,songs,ach,cos}.json
//                                   and credits.<lang>.html, privacy.<lang>.html from the Chinese pages and i18n/<lang>/docs.json
//   node tools/i18n.mjs check       fails (exit 1) on a missing or stale translation, a placeholder that does not match,
//                                   or a lang-*.js that is not what the json files give now
//   node tools/i18n.mjs check --soft   the same report, but missing translations do not fail (while translating)
//   node tools/i18n.mjs dynamic     lists the TX(variable) calls: their possible values must be keys some other way
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
  const src = rd(file), out = [], used = [], dyn = [];
  const add = (v, at, end) => { if (v !== '') out.push({ id: v, at: file + ':' + lineOf(src, at) }); used.push([at, end]); };   // '' (an empty slot of an array) is not a key
  const fail = (i, why) => { throw new Error(file + ':' + lineOf(src, i) + ' ' + why); };
  for (const m of src.matchAll(/(?<![\w$.])TX(A|O)?\(/g)) {
    let i = ws(src, m.index + m[0].length);
    if (!m[1]) {
      if (src[i] !== "'" && src[i] !== '"') { dyn.push(file + ':' + lineOf(src, i) + '  TX(' + src.slice(i, i + 40).split('\n')[0]); continue; }   // TX(variable): the possible values must reach the list another way (data, TXA)
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
  return { src, keys: out, used, dyn };
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
  // the friends' quick phrases stay Chinese in the code (they are what is sent); they are shown through TX(FSAY[k])
  const fsay = /const FSAY=(\[[^\]]*\])/.exec(rd('game.js'));
  if (!fsay) throw new Error('game.js: const FSAY=[...] not found');
  vm.runInNewContext(fsay[1]).forEach(t => dyn.push({ id: t, at: 'game.js:FSAY' }));
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
// what a language still lacks. A pack with nothing missing is marked ok: i18n.js offers only those to players
// (an unfinished one can still be opened with ?lang=xx for testing).
const missingOf = (c, p) => {
  const out = [];
  for (const [id, at] of c.ui) { const v = p.ui[id]; if (v == null || v === '') out.push('ui "' + id + '"  (' + at[0] + ')'); }
  const fields = (kind, src, tr, req) => { for (const k in src) for (const f of req(src[k])) { const v = tr[k] && tr[k][f]; if (v == null || v === '' || Array.isArray(src[k][f]) && (!Array.isArray(v) || v.length !== src[k][f].length)) out.push(kind + ' ' + k + '.' + f); } };
  fields('song', c.songs, p.song, s => ['name', 'composer', 'tip'].concat(CJK.test(s.year) ? ['year'] : []));
  fields('ach', c.ach, p.ach, a => Object.keys(a));
  fields('cos', c.cos, p.cos, o => Object.keys(o));
  return out;
};
const packJs = (lang, p, ok) => '/* GENERATED by tools/i18n.mjs from i18n/' + lang + '/*.json. Do not edit by hand: change the json files and run `node tools/i18n.mjs build`. */\n'
  + '(window.PPLLANG=window.PPLLANG||{}).' + lang + '=' + JSON.stringify({ ok, ...p }) + ';\n';

// ---------------------------------------------------------------- documents: credits.html, privacy.html
// The Chinese page is the source; `build` writes <name>.<lang>.html next to it. Song names, composers and years come
// from the language's songs.json; everything else from i18n/<lang>/docs.json (Chinese HTML -> translated HTML).
// A block (<p>, <li>, a heading, a table cell) is looked up whole. A table cell not found whole is cut at " · " and
// <br>, and each piece looked up by itself; a piece that is one element around plain text is looked up by that text.
const DOCS = ['credits.html', 'privacy.html', 'terms.html'];
const docName = (f, l) => f.replace(/\.html$/, '.' + l + '.html');
const DOC_FONT_ZH = 'font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif';
const DOC_FONT = {   // keep in step with the html[lang] rules in index.html
  en: 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"Noto Sans TC",sans-serif',
  ja: 'font-family:"Noto Sans JP","Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic UI","Yu Gothic","Meiryo",system-ui,sans-serif',
};
// In the documents a text is Chinese when it has Chinese characters or only Chinese punctuation ("Open Hymnal Project（ABC）").
// (Not in the game: i18n.js looks up the texts that have Chinese characters, and the keys have to be the same ones.)
const ZHP = /[\u3000-\u303f\uff00-\uffef]/, isZh = s => CJK.test(s) || ZHP.test(s);
const DOC_BLOCK = /<(title|h[1-6]|p|li|th|td)((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/g;
const VOID = new Set(['br', 'img', 'hr', 'wbr']);
// <!-- i18n-only: <p>…</p> --> in a Chinese page is a block that only the translated pages show (privacy.html: "this page is
// a translation"). Its link to the Chinese page is written ./privacy.html: href="privacy.html" would become the page of the
// reader's own language (docPage).
const DOC_ONLY = /<!-- i18n-only: ([\s\S]*?) -->/g, docSrc = f => rd(f).replace(DOC_ONLY, '$1');
function cutTop(s) {   // [piece, separator, piece, …]: the separators are " · " and <br>, never one inside an element
  const out = []; let depth = 0, from = 0, i = 0;
  while (i < s.length) {
    if (s[i] === '<') {
      const e = s.indexOf('>', i); if (e < 0) break;
      const tag = s.slice(i + 1, e), name = ((/^\/?([a-zA-Z0-9]+)/.exec(tag) || [])[1] || '').toLowerCase();
      if (depth === 0 && name === 'br') { out.push(s.slice(from, i), s.slice(i, e + 1)); from = e + 1; }
      else if (tag[0] === '/') depth = Math.max(0, depth - 1);
      else if (!VOID.has(name) && !tag.endsWith('/')) depth++;
      i = e + 1; continue;
    }
    if (depth === 0 && s.startsWith(' · ', i)) { out.push(s.slice(from, i), ' · '); from = i + 3; i += 3; continue; }
    i++;
  }
  out.push(s.slice(from));
  return out;
}
const docsJson = l => readJson(join(ROOT, 'i18n', l, 'docs.json'));
function docTranslator(c, p, d) {
  const auto = new Map(), clash = new Set(), sq = s => String(s).replace(/\s+/g, '');
  // the table shows one translation per Chinese name: two songs that give the same name two translations is a mistake
  const give = (zh, v) => { if (auto.has(zh) && auto.get(zh) !== v) clash.add(zh); auto.set(zh, v); };
  for (const k in c.songs) {
    const s = c.songs[k], t = p.song[k]; if (!t) continue;
    if (t.name) give(s.name, t.name);
    if (t.composer) give(s.composer, t.composer);
    if (CJK.test(s.year) && t.year) give(sq(s.year), t.year);
  }
  const used = new Set(), missing = new Map();   // missing: Chinese text -> where it was first met
  const piece = (s, at) => {
    const t = s.trim();
    if (!t || !isZh(t)) return s;
    const put = v => s.replace(t, () => v);
    if (d[t] != null && d[t] !== '') { used.add(t); return put(d[t]); }
    if (auto.has(t)) return put(auto.get(t));
    if (auto.has(sq(t))) return put(auto.get(sq(t)));
    const m = /^<([a-zA-Z0-9]+)((?:\s[^>]*)?)>([^<]*)<\/\1>$/.exec(t);
    if (m && isZh(m[3])) return put('<' + m[1] + m[2] + '>' + piece(m[3], at) + '</' + m[1] + '>');
    if (!missing.has(t)) missing.set(t, at);
    return s;
  };
  const block = (inner, at, cell) => {
    const t = inner.trim();
    if (!t || !isZh(t)) return inner;
    if (d[t] != null && d[t] !== '') { used.add(t); return inner.replace(t, () => d[t]); }
    return cell ? cutTop(inner).map((x, i) => i % 2 ? x : piece(x, at)).join('') : piece(inner, at);
  };
  return { piece, block, used, missing, clash };
}
// Chinese text of a page that nothing above translates: outside every block, the back link and the three attributes
function docStray(f) {
  const s = docSrc(f).replace(/<!--[\s\S]*?-->|<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(DOC_BLOCK, '').replace(/<a class="back"[^>]*>[^<]*<\/a>/g, '').replace(/\b(aria-label|title|alt)="[^"]*"/g, '');
  return s.split(/[<>\n]/).map(x => x.trim()).filter(x => isZh(x));
}
function docPage(f, l, tr) {
  const src = docSrc(f);
  let h = src.replace(DOC_BLOCK, (m, tag, attr, inner, off) => '<' + tag + attr + '>' + tr.block(inner, f + ':' + lineOf(src, off) + ' <' + tag + '>', tag === 'td') + '</' + tag + '>');
  h = h.replace(/(<a class="back"[^>]*>)([^<]*)(<\/a>)/g, (m, a, t, z) => a + tr.piece(t, f + ' back link') + z);
  h = h.replace(/\b(aria-label|title|alt)="([^"]*)"/g, (m, a, v) => a + '="' + tr.piece(v, f + ' ' + a) + '"');
  if (!h.includes('<html lang="zh-Hant">') || !h.includes(DOC_FONT_ZH)) throw new Error(f + ': <html lang="zh-Hant"> or the body font was not found');
  h = h.replace('<html lang="zh-Hant">', '<html lang="' + l + '">').split(DOC_FONT_ZH).join(DOC_FONT[l]).replace(/deed\.zh_TW/g, 'deed.' + l);
  for (const g of DOCS) h = h.split('href="' + g + '"').join('href="' + docName(g, l) + '"');
  return h.replace(/^<!doctype html>\n/i, m => m + '<!-- GENERATED by tools/i18n.mjs build from ' + f + ' and i18n/' + l + '/docs.json. Do not edit by hand. -->\n');
}
// every page of one language: the pages, what is still Chinese in them, and the keys of docs.json nothing asked for
function docsOf(c, l, d) {
  const tr = docTranslator(c, pack(l), d), pages = {};
  for (const f of DOCS) pages[docName(f, l)] = docPage(f, l, tr);
  // an empty translation is "missing", not "unused"
  return { pages, missing: tr.missing, used: tr.used, clash: tr.clash, unused: Object.keys(d).filter(k => !tr.used.has(k) && !tr.missing.has(k)) };
}
// what the documents need translated, the same list for every language (the names that songs.json gives are not in it)
function docKeys(c) {
  const names = { song: {} };
  for (const k in c.songs) names.song[k] = { name: '-', composer: '-', year: '-' };
  const tr = docTranslator(c, names, {});
  for (const f of DOCS) docPage(f, LANGS[0], tr);
  return [...tr.missing].map(([id, at]) => ({ id, at }));
}
// A translation keeps every link exactly (deed.zh_TW too: docPage is what changes it to the page's language) and every tag
// with its attributes (target, rel, class …); the three attributes that hold text may differ.
const hrefsOf = s => [...String(s).matchAll(/href="([^"]*)"/g)].map(m => m[1]).sort().join(' ');
const tagsOf = s => [...String(s).matchAll(/<\/?[a-zA-Z0-9]+(?:\s[^>]*)?>/g)].map(m => m[0].replace(/\s(?:href|aria-label|title|alt)="[^"]*"/g, '').replace(/\s+/g, ' ')).sort().join(' ');

const cmd = process.argv[2], soft = process.argv.includes('--soft');
if (cmd === 'keys') {
  const c = collect();
  mkdirSync(join(ROOT, 'i18n'), { recursive: true });
  const ui = [...c.ui].map(([id, at]) => ({ id, at: [...new Set(at)].slice(0, 4) }));
  writeFileSync(join(ROOT, 'i18n', 'keys.json'), JSON.stringify({ ui, songs: c.songs, ach: c.ach, cos: c.cos }, null, 1) + '\n');
  console.log('i18n/keys.json:', ui.length, 'interface strings,', Object.keys(c.songs).length, 'songs,', Object.keys(c.ach).length, 'achievements,', Object.keys(c.cos).length, 'cosmetic items');
  const dk = docKeys(c);
  writeFileSync(join(ROOT, 'i18n', 'docs-keys.json'), JSON.stringify(dk, null, 1) + '\n');
  console.log('i18n/docs-keys.json:', dk.length, 'texts in', DOCS.join(' and '));
} else if (cmd === 'build') {
  const c = collect();
  for (const l of LANGS) {
    const p = pack(l), n = missingOf(c, p).length; writeFileSync(join(ROOT, 'lang-' + l + '.js'), packJs(l, p, n === 0));
    console.log('lang-' + l + '.js:', Object.keys(p.ui).length, 'interface strings ·', n ? n + ' missing: not offered to players yet' : 'complete');
    const dp = docsOf(c, l, docsJson(l));
    for (const f in dp.pages) writeFileSync(join(ROOT, f), dp.pages[f]);
    console.log(Object.keys(dp.pages).join(', ') + ':', dp.missing.size ? dp.missing.size + ' text(s) still in Chinese' : 'complete');
  }
} else if (cmd === 'check') {
  const c = collect(); let bad = 0, missing = 0;
  const err = m => { bad++; console.log('  ERROR ' + m); }, miss = m => { missing++; if (missing <= 60) console.log('  missing ' + m); };
  for (const f of DOCS) for (const t of docStray(f)) err(f + ': "' + t.slice(0, 60) + '" is outside every translated block (put it in a <p>, <li>, a heading or a table cell)');
  for (const l of LANGS) {
    console.log('== ' + l); const p = pack(l), m0 = missing, lacks = missingOf(c, p);
    lacks.forEach(miss);
    for (const [id, at] of c.ui) {
      const v = p.ui[id];
      if (v == null || v === '') continue;
      const forms = typeof v === 'object' ? Object.values(v) : [v], need = holes(bare(id)).join();
      if (typeof v === 'object' && !('other' in v)) err('ui "' + id + '": a plural needs an "other" form');
      for (const f of forms) {
        if (typeof f !== 'string') { err('ui "' + id + '": not a string'); continue; }
        const got = holes(f); if (got.some(h => !need.split(',').includes(h))) err('ui "' + id + '": unknown placeholder in "' + f + '"');
        if (typeof v !== 'object' && got.join() !== need) err('ui "' + id + '": placeholders differ: {' + need + '} vs {' + got.join() + '}');
      }
    }
    for (const id of Object.keys(p.ui)) if (!c.ui.has(id)) err('ui "' + id + '" is no longer used (remove it or fix the key)');
    for (const [kind, src, tr] of [['song', c.songs, p.song], ['ach', c.ach, p.ach], ['cos', c.cos, p.cos]]) for (const k in tr) if (!(k in src)) err(kind + ' ' + k + ' does not exist');
    for (const k in p.song) for (const f in p.song[k]) if (CJK.test(p.song[k][f]) && l === 'en') err('song ' + k + '.' + f + ' still has Chinese characters');
    const js = join(ROOT, 'lang-' + l + '.js');
    if (!existsSync(js) || readFileSync(js, 'utf8').replace(/\r\n/g, '\n') !== packJs(l, p, lacks.length === 0)) err('lang-' + l + '.js is stale: run `node tools/i18n.mjs build`');
    const dj = docsJson(l), dp = docsOf(c, l, dj), short = k => k.slice(0, 60) + (k.length > 60 ? '…' : '');
    for (const [id, at] of dp.missing) miss('doc "' + short(id) + '"  (' + at + ')');
    for (const k of dp.unused) err('doc "' + short(k) + '" is no longer in the documents (remove it or fix the key)');
    for (const k of dp.clash) err('doc: "' + short(k) + '" has two different translations in songs.json (the credits table shows only one)');
    for (const k of dp.used) {
      if (hrefsOf(k) !== hrefsOf(dj[k])) err('doc "' + short(k) + '": the links differ from the Chinese text');
      if (tagsOf(k) !== tagsOf(dj[k])) err('doc "' + short(k) + '": the HTML tags differ from the Chinese text');
      if (l === 'en' && isZh(dj[k])) err('doc "' + short(k) + '" still has Chinese characters or punctuation');
    }
    for (const f in dp.pages) if (!existsSync(join(ROOT, f)) || readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n') !== dp.pages[f]) err(f + ' is stale: run `node tools/i18n.mjs build`');
    // nothing is missing and the English page still has Chinese in it: text the page writer does not reach
    if (l === 'en' && !dp.missing.size) for (const f in dp.pages) if (isZh(dp.pages[f].replace(/<!--[\s\S]*?-->|<style[\s\S]*?<\/style>/gi, ''))) err(f + ' still has Chinese characters or punctuation');
    console.log('  ' + (missing - m0) + ' missing');
  }
  if (missing > 60) console.log('  (' + (missing - 60) + ' more missing lines not shown)');
  console.log(bad ? bad + ' error(s)' : 'no errors', '·', missing, 'missing');
  process.exit(bad || (missing && !soft) ? 1 : 0);
} else if (cmd === 'dynamic') {
  for (const f of JS) jsKeys(f).dyn.forEach(d => console.log(d));
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
  console.log('usage: node tools/i18n.mjs keys | build | check [--soft] | unwrapped | dynamic'); process.exit(2);
}
