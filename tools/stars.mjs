// Song difficulty stars and the order of songs inside each constellation, from what the game actually throws.
// For every song it runs the game's own beat picking (copied out of game.js, like server/scripts/charts.mjs) at
// 困難 and 專家, and scores four things, averaged over the two:
//   rate  40%  balls per second over the whole run (times the ball speed of that difficulty)
//   pk    25%  balls per second in the densest 8 seconds (the hardest stretch)
//   irr   20%  how often the gap between balls changes to something that is not x1, x2 or x0.5, plus the spread of the gaps
//   len   15%  log of the ball count (stamina)
// Each is measured against the fixed reference below (the 96-song library at the difficulty table of 2026-11-27), so adding a song never
// moves the stars of the others. Stars: the four cut points give 1 … 5 (19/23/22/21/11 of those 96 songs, the same counts as before that difficulty change).
// Writes tools/stars.json. With --sort it also sorts every constellation in tools/constellations.json from easiest to
// hardest; without it the order stays as it is (since 2026-11-27: the free part of a constellation is its first 30%, so
// re-sorting would turn free songs paid). Run `node tools/build-songs.mjs` afterwards so songs.js carries both.
// Usage: node tools/stars.mjs [--sort] [--check]   (--check: exit 1 if stars.json (or, with --sort, the order) is out of date, write nothing)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const TOOLS = dirname(fileURLToPath(import.meta.url)), ROOT = join(TOOLS, '..');
const check = process.argv.includes('--check'), resort = process.argv.includes('--sort');
const REF = { rate: [2.26738, 0.58218], pk: [2.78512, 0.6669], irr: [0.69918, 0.27431], len: [4.68076, 0.46176] };
const W = { rate: .40, pk: .25, irr: .20, len: .15 };
const CUTS = [-0.661, -0.027, 0.338, 0.908];
const USE = [2, 4];   // DIFFS indices: 困難, 專家

const game = readFileSync(join(ROOT, 'game.js'), 'utf8');
const cut = (from, to) => {
  const a = game.indexOf(from), b = game.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('game.js changed: cannot find "' + from + '" … "' + to + '"');
  return game.slice(a, b);
};
const box = { window: {} };
vm.runInNewContext(readFileSync(join(ROOT, 'songs.js'), 'utf8'), box);
const code = cut('function pickTargets(', 'const STARS=') + cut('const FILL_GAP=', 'function prepare(') + `
  const DIFFS=${cut('const DIFFS=', '\n').replace(/^const DIFFS=/, '').replace(/;\s*$/, '')};
  out={};
  for(const k of ORDER){const s=SD[k];if(!s)continue;
    out[k]=USE.map(d=>{const D=DIFFS[d];melList=[];bkList=[];for(const x of s.n)(x[3]===1?melList:bkList).push(x);lendTop();
      return {t:pickTargets(melList,D.gap).map(i=>melList[i][0]/100),spd:D.spd}})}`;
const ctx = { SD: box.window.SONGDATA, ORDER: box.window.SONGORDER || Object.keys(box.window.SONGDATA), USE, melList: [], bkList: [], out: null };
vm.runInNewContext('let melList=[],bkList=[];' + code, ctx);

function measure({ t, spd }) {
  const n = t.length, span = Math.max(1, t[n - 1] - t[0]), iv = t.slice(1).map((x, i) => x - t[i]);
  let pk = 0; for (let i = 0, j = 0; i < n; i++) { while (t[i] - t[j] > 8) j++; pk = Math.max(pk, (i - j + 1) / 8); }
  const mean = iv.reduce((a, b) => a + b, 0) / Math.max(1, iv.length);
  const cv = Math.sqrt(iv.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, iv.length)) / mean;
  let chg = 0; for (let i = 1; i < iv.length; i++) { const r = iv[i] / iv[i - 1]; if (!(Math.abs(r - 1) < .12 || Math.abs(r - 2) < .2 || Math.abs(r - .5) < .06)) chg++; }
  return { n, rate: n / span * spd, pk: pk * spd, irr: chg / Math.max(1, iv.length - 1) + cv };
}
const STARS = {};
for (const [k, runs] of Object.entries(ctx.out)) {
  const m = runs.map(measure), avg = f => m.reduce((a, x) => a + f(x), 0) / m.length;
  const v = { rate: avg(x => x.rate), pk: avg(x => x.pk), irr: avg(x => x.irr), len: Math.log(avg(x => x.n)) };
  let score = 0; for (const f in W) score += W[f] * (v[f] - REF[f][0]) / REF[f][1];
  STARS[k] = { s: 1 + CUTS.filter(c => score >= c).length, score: +score.toFixed(3) };
}

const consPath = join(TOOLS, 'constellations.json'), starsPath = join(TOOLS, 'stars.json');
const CONS = JSON.parse(readFileSync(consPath, 'utf8'));
// songs pinned to the front of their constellation whatever their score: 小星星 is the tutorial and shop-trial song, so it must stay in the free 30%
const PIN = ['twinkle'];
const sorted = !resort ? CONS : CONS.map(([name, keys, opt]) => {
  const sc = k => PIN.includes(k) ? -1e9 + PIN.indexOf(k) : STARS[k] ? STARS[k].score : 0;
  const ks = keys.map((k, i) => [k, i]).sort((a, b) => sc(a[0]) - sc(b[0]) || a[1] - b[1]).map(x => x[0]);
  return opt ? [name, ks, opt] : [name, ks];
});
const consText = '[\n' + sorted.map(c => '  [' + JSON.stringify(c[0]) + ', [' + c[1].map(k => JSON.stringify(k)).join(', ') + ']' + (c[2] ? ', ' + JSON.stringify(c[2]) : '') + ']').join(',\n') + '\n]\n';
const starsText = '{\n' + Object.keys(STARS).sort().map(k => '  ' + JSON.stringify(k) + ': ' + JSON.stringify(STARS[k])).join(',\n') + '\n}\n';
if (check) {
  let stale = false;
  try { stale = readFileSync(starsPath, 'utf8') !== starsText; } catch { stale = true; }
  if (JSON.stringify(sorted) !== JSON.stringify(CONS)) stale = true;
  if (stale) { console.error('tools/stars.json or the constellation order is out of date: run node tools/stars.mjs'); process.exit(1); }
  console.log('stars up to date'); process.exit(0);
}
writeFileSync(starsPath, starsText);
writeFileSync(consPath, consText);
const dist = [1, 2, 3, 4, 5].map(s => Object.values(STARS).filter(x => x.s === s).length);
console.log(Object.keys(STARS).length + ' songs; stars 1-5: ' + dist.join('/') + '; tools/stars.json and constellations.json written');
