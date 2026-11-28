// Star arc (game.js arcWin): the hit's base points rise by 10 %. The server must still accept that log (lb.js scan: Q_MAX / Q_MIN bounds). node test/arcbonus.mjs
import { scan, TIER_M, Q_MAX, Q_MIN, TIER_MS } from '../src/lb.js';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const P_FIX = .5, sfMax = Math.pow(8, 1.1), sfMin = Math.pow(.3, 1.1);
// game.js bounce(): base = round(100 * T.m * sf * (1 + .3 * P_FIX) * (star ? 2 : 1) * (sprint ? 2 : 1))
const baseOf = (t, sf, star, sprint) => Math.round(100 * TIER_M[t] * sf * (1 + .3 * P_FIX) * (star ? 2 : 1) * (sprint ? 2 : 1));
const bonus = b => Math.round(b * 1.1);
for (let d = 0; d < TIER_MS.length; d++) {
  for (let t = 0; t < 4; t++) {
    const e = t === 0 ? 0 : TIER_MS[d][t - 1] + 1;   // an error that lands in tier t (ms)
    if (t > 0 && t < 3 && e >= TIER_MS[d][t]) continue;
    for (const [label, sf] of [['slowest', sfMin], ['normal', 1], ['fastest', sfMax]]) {
      for (const star of [false, true]) {
        const b = baseOf(t, sf, star, false), b2 = bonus(b), N = 6;
        const log = Array.from({ length: N }, () => [e, b]), logB = Array.from({ length: N }, (_, i) => [e, i === 2 ? b2 : b]);
        const segs = star ? [[0, N]] : [];
        ok(scan(d, log, segs, true) !== null, `plain base accepted d${d} t${t} ${label} star=${star}`);
        ok(scan(d, logB, segs, true) !== null, `+10% base accepted d${d} t${t} ${label} star=${star} (${b} -> ${b2})`);
      }
    }
  }
}
// the duel's last-fifth sprint doubles the base again: the +10% still fits under its doubled limit
{
  const d = 1, N = 10, b = baseOf(0, sfMax, true, true), b2 = bonus(b), log = Array.from({ length: N }, (_, i) => [0, i >= 5 ? b2 : baseOf(0, sfMax, true, false)]);
  ok(scan(d, log, [[0, N]], true, 5) !== null, 'sprint + star + fastest + 10%: accepted');
  const log2 = Array.from({ length: N }, (_, i) => [0, i >= 5 ? baseOf(0, sfMax, false, true) : baseOf(0, sfMax, false, false)]); log2[7] = [0, bonus(baseOf(0, sfMax, false, true))];
  ok(scan(d, log2, [], true, 5) !== null, 'sprint without star + fastest + 10%: accepted');
}
// and the limit still bites: 20 % over the fastest plain hit is refused (strict = a new ticket)
{
  const d = 1, b = Math.round(baseOf(0, sfMax, false, false) * 1.2);
  ok(scan(d, [[0, b], [0, b]], [], true) === null, '+20% over the fastest base is still refused');
}
ok(Q_MAX > 0 && Q_MIN > 0, 'bounds exist');
console.log(`arcbonus: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
