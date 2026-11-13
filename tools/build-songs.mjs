// Builds songs.js from the existing pieces plus the song specs in tools/songs/*.json, ordered by tools/constellations.json.
//   node tools/build-songs.mjs            write songs.js
//   node tools/build-songs.mjs --check    only report (no write)
//   node tools/build-songs.mjs --only k   build one spec and print its stats (for working on a single song)
//   node tools/build-songs.mjs --dir songs-new [--only k]   read the specs from another folder under tools/ (try-out; prints stats, never writes songs.js)
// A spec: { key, name, composer, year, inst: {lead, bk, bass?, ctr?}, credit: {source, url, licence, by?},
//           midi: {...} | tune: {...} | score: {...} }  (see songlib.mjs). Pieces already in songs.js without a spec are kept as they are.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { fromMidi, fromTune, fromScore, finish } from './songlib.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url)), ROOT = join(TOOLS, '..');
const args = process.argv.slice(2), check = args.includes('--check'), only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const altDir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;
const INST = ['piano', 'violin', 'viola', 'cello', 'strings', 'flute', 'recorder', 'guitar', 'organ', 'choir', 'trumpet', 'clarinet', 'pizz'];

const box = { window: {} };
vm.runInNewContext(readFileSync(join(ROOT, 'songs.js'), 'utf8'), box);
const DATA = { ...box.window.SONGDATA };
const head = readFileSync(join(ROOT, 'songs.js'), 'utf8').match(/^\/\*[\s\S]*?\*\//)[0];

const dir = join(TOOLS, altDir || 'songs'), specs = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
const problems = [], stats = [];
for (const f of specs) {
  const sp = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  if (only && sp.key !== only) continue;
  const where = 'tools/' + (altDir || 'songs') + '/' + f;
  try {
    for (const k of ['key', 'name', 'composer', 'year', 'inst', 'credit']) if (!sp[k]) throw new Error('missing "' + k + '"');
    if (!/^[a-z][a-z0-9]{1,15}$/.test(sp.key)) throw new Error('key must be 2-16 lowercase letters/digits');
    if (sp.key + '.json' !== f) throw new Error('file name must be <key>.json');
    for (const [r, v] of Object.entries(sp.inst)) if (!['lead', 'bk', 'bass', 'ctr'].includes(r) || !INST.includes(v)) throw new Error('bad inst ' + r + '=' + v);
    if (!sp.inst.lead || !sp.inst.bk) throw new Error('inst needs lead and bk');
    const raw = sp.midi ? fromMidi(sp, ROOT) : sp.tune ? fromTune(sp) : sp.score ? fromScore(sp, ROOT) : null;
    if (!raw) throw new Error('needs "midi", "tune" or "score"');
    const { n, dur } = finish(raw), tune = n.filter(x => x[3] === 1);
    if (tune.length < 20) throw new Error('only ' + tune.length + ' tune notes');
    const rate = tune.length / dur, lo = Math.min(...tune.map(x => x[2])), hi = Math.max(...tune.map(x => x[2]));
    if (raw.info && (only || altDir)) console.log(sp.key + ': ' + JSON.stringify({ ...raw.info, key: undefined, sourceWarnings: undefined }) + (raw.info.sourceWarnings.length ? ' | source warnings: ' + raw.info.sourceWarnings.join(' | ') : ''));
    stats.push({ key: sp.key, name: sp.name, dur, tune: tune.length, rate: +rate.toFixed(2), range: lo + '-' + hi, all: n.length });
    if (dur > 150) problems.push(where + ': ' + dur + ' s is long (aim for 40-120 s; crop it)');
    if (rate > 6) problems.push(where + ': ' + rate.toFixed(1) + ' tune notes per second is very dense');
    if (lo < 48 || hi > 96) problems.push(where + ': tune range ' + lo + '-' + hi + ' (keep it within 48-96; use melShift)');
    DATA[sp.key] = { n, dur, name: sp.name, composer: sp.composer, year: String(sp.year), inst: sp.inst, credit: sp.credit, ...(sp.lead ? { lead: sp.lead } : {}) };
  } catch (e) { problems.push(where + ': ' + e.message) }
}
if (only || altDir) { console.table(stats); if (problems.length) console.log(problems.join('\n')); process.exit(problems.length ? 1 : 0) }

// songs parked in tools/songs-hold/ (pulled until fixed) are dropped from songs.js even if an older build had them
const HOLD = join(TOOLS, 'songs-hold');
if (existsSync(HOLD)) for (const f of readdirSync(HOLD)) if (f.endsWith('.json')) delete DATA[f.slice(0, -5)];
const CONS = JSON.parse(readFileSync(join(TOOLS, 'constellations.json'), 'utf8'));
const seen = new Set();
for (const [name, keys] of CONS) for (const k of keys) {
  if (!DATA[k]) problems.push('constellations.json: "' + k + '" in ' + name + ' has no song');
  if (seen.has(k)) problems.push('constellations.json: "' + k + '" listed twice'); seen.add(k);
}
for (const k of Object.keys(DATA)) if (!seen.has(k)) problems.push('song "' + k + '" is in no constellation');
const ORDER = CONS.flatMap(c => c[1]).filter(k => DATA[k]);
// one-line facts shown on the song page (tools/trivia.json, checked against sources); every piece needs one
const TRIV = existsSync(join(TOOLS, 'trivia.json')) ? JSON.parse(readFileSync(join(TOOLS, 'trivia.json'), 'utf8')) : {};
for (const k of ORDER) { if (TRIV[k]) DATA[k].tip = TRIV[k]; else problems.push('tools/trivia.json: no entry for "' + k + '"') }

if (stats.length) console.table(stats);
console.log(ORDER.length + ' songs in ' + CONS.length + ' constellations');
if (problems.length) { console.error('\n' + problems.join('\n')); process.exit(1) }
if (check) process.exit(0);
const out = head + '\nwindow.SONGCONS=' + JSON.stringify(CONS) + ';\nwindow.SONGORDER=' + JSON.stringify(ORDER)
  + ';\nwindow.SONGDATA={' + ORDER.map(k => JSON.stringify(k) + ':' + JSON.stringify(DATA[k])).join(',\n') + '};\n';
writeFileSync(join(ROOT, 'songs.js'), out);
console.log('songs.js written, ' + Math.round(out.length / 1024) + ' KB');

// credits.html: one row per piece built from a spec, between the markers (the hand-kept rows above stay as they are)
const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cp = join(ROOT, 'credits.html');
let html = readFileSync(cp, 'utf8');
const A = '<!-- songs from tools/songs (generated) -->', B = '<!-- /songs from tools/songs -->';
if (!html.includes(A)) html = html.replace('</tbody>', A + '\n' + B + '\n</tbody>');
const kept = (html.match(/<tr><td class="no">/g) || []).length - (html.split(A)[1].split(B)[0].match(/<tr>/g) || []).length;
// a licence with a public deed gets a link to it (CC0); public-domain pieces need none
const LIC_URL = { 'CC0': 'https://creativecommons.org/publicdomain/zero/1.0/deed.zh_TW' };
const licHtml = l => esc(l).replace(/CC0/, m => '<a href="' + LIC_URL[m] + '" target="_blank" rel="noopener noreferrer">' + m + '</a>');
const rows = ORDER.filter(k => DATA[k].credit).map((k, i) => {
  const d = DATA[k], c = d.credit;
  const src = c.url ? '<a href="' + esc(c.url) + '" target="_blank" rel="noopener noreferrer">' + esc(c.source) + '</a>' : '<span class="muted">' + esc(c.source) + '</span>';
  return '<tr><td class="no">' + (kept + i + 1) + '</td><td>' + esc(d.name) + '</td><td>' + esc(d.composer) + '</td><td>' + esc(d.year) + '</td><td>' + src
    + ' · ' + licHtml(c.licence) + (c.by ? ' · ' + esc(c.by) : '') + (c.note ? '<br><span class="muted">' + esc(c.note) + '</span>' : '') + '</td></tr>';
});
html = html.split(A)[0] + A + '\n' + rows.join('\n') + (rows.length ? '\n' : '') + B + html.split(B)[1];
writeFileSync(cp, html);
// the shop text counts the classic pieces
const classics = ORDER.filter(k => DATA[k].composer !== '原創').length, ip = join(ROOT, 'index.html');
writeFileSync(ip, readFileSync(ip, 'utf8').replace(/等 \d+ 首經典名曲/g, '等 ' + classics + ' 首經典名曲'));
console.log('credits.html: ' + rows.length + ' generated rows; index.html: ' + classics + ' classics');
