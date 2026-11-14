// Nine-rank rules (no server needed): node test/rank.mjs
import { judge } from '../src/lb.js';
import { rankOf, atLeastS, singles, logFeats, ftOf, RANKS } from '../src/ach.js';
import { CHARTS } from '../src/charts.js';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const song = Object.keys(CHARTS).sort((a, b) => CHARTS[b].n[1] - CHARTS[a].n[1])[0], D = 1, N = CHARTS[song].n[D];
const E = [0, 60, 120, 200], M = [3, 2, 1.2, 1];
// a run with the given counts: perfect = the rest; misses/great/good/ok placed at the start
function run(great = 0, good = 0, okc = 0, miss = 0) {
  const seq = [...Array(miss).fill(-1), ...Array(good).fill(2), ...Array(okc).fill(3), ...Array(great).fill(1)];
  return Array.from({ length: N }, (_, i) => { const t = i < seq.length ? seq[i] : 0; return t < 0 ? null : [E[t], Math.round(100 * M[t])]; });
}
const rk = (...a) => judge(song, D, run(...a));
ok(RANKS.join() === 'F,E,D,C,B,A,S,SS,SSS', 'order');
ok(rk().rank === 'SSS' && rk().acc === 10000, 'all perfect = SSS');
let r = rk(1); ok(r.acc < 10000 && r.acc >= 9800 && r.rank === 'SS', 'one great: SS, acc ' + r.acc);
r = rk(0, 1); ok(r.acc >= 9800 && r.rank === 'S', 'one good, acc still >= 9800: only S (' + r.acc + ')');
r = rk(0, 0, 1); ok(r.acc >= 9800 && r.rank === 'A', 'one ok, acc very high: only A (' + r.acc + ')');
r = rk(0, 0, 0, 1); ok(r.acc >= 9800 && r.rank === 'A', 'one miss: only A (' + r.acc + ')');
// 9999 is not SSS
ok(rankOf(9999, 0, 0, 0) === 'SS' && rankOf(10000, 0, 0, 0) === 'SSS', '9999 / 10000');
ok(rankOf(9800, 0, 0, 0) === 'SS' && rankOf(9799, 0, 0, 0) === 'S', 'SS edge 9800');
ok(rankOf(9999, 0, 1, 0) === 'S' && rankOf(9999, 0, 0, 1) === 'A' && rankOf(9999, 1, 0, 0) === 'A', 'good<=S, ok/miss<=A');
ok(rankOf(9500, 0, 5, 0) === 'S' && rankOf(9499, 0, 0, 0) === 'A', 'S edge 9500');
const edges = [[9000, 'A'], [8999, 'B'], [8000, 'B'], [7999, 'C'], [7000, 'C'], [6999, 'D'], [6000, 'D'], [5999, 'E'], [5000, 'E'], [4999, 'F'], [0, 'F']];
for (const [a, x] of edges) ok(rankOf(a, 5, 5, 5) === x, a + ' -> ' + x);
// a failed-but-finished run is F
r = judge(song, D, run(0, 0, 0, Math.floor(N * .8))); ok(r && r.rank === 'F', 'mostly missed: F (' + (r && r.rank) + ')');
// rows with only a stored accuracy: old rule, never above S
ok(rankOf(10000, 0) === 'S' && rankOf(9900, 0) === 'S' && rankOf(9900, 1) === 'A', 'acc-only fallback tops out at S');
// ft written at submit carries the new rank; features count good/ok
const F = logFeats(run(1, 2, 3, 0), N), ft = JSON.parse(ftOf(F, 9990));
ok(F.good === 2 && F.ok === 3 && ft.r === 'A', 'logFeats counts good/ok, ft.r = ' + ft.r);
ok(JSON.parse(ftOf(logFeats(run(), N), 10000)).r === 'SSS', 'ft.r SSS');
// S-or-better checks
ok(!atLeastS('A') && atLeastS('S') && atLeastS('SS') && atLeastS('SSS') && !atLeastS('—') && !atLeastS(undefined), 'atLeastS');
const base = { d: 4, acc: 9000, maxCombo: 0, pr: 0, fc: 0, f5: 0, l5: 0, ec: 0, fm: 0 };
for (const x of ['S', 'SS', 'SSS']) ok(singles({ ...base, r: x }).includes('第一顆 S'), '第一顆 S for ' + x);
ok(!singles({ ...base, r: 'A' }).includes('第一顆 S'), 'not for A');
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
