// The first clear lifts a level-1 player to level 2 (level.js settle). Lv2+ players, fails and quits are not touched. node test/firstclear.mjs
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import * as L from '../src/level.js';

const SRV = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const sql = new DatabaseSync(':memory:');
for (const f of readdirSync(join(SRV, 'migrations')).filter(f => f.endsWith('.sql')).sort()) sql.exec(readFileSync(join(SRV, 'migrations', f), 'utf8'));
class Stmt {
  constructor(q, a = []) { this.q = q; this.a = a; }
  bind(...a) { return new Stmt(this.q, a); }
  async first() { return sql.prepare(this.q).get(...this.a) ?? null; }
  async all() { return { results: sql.prepare(this.q).all(...this.a) }; }
  async run() { const r = sql.prepare(this.q).run(...this.a); return { success: true, meta: { changes: Number(r.changes) } }; }
}
const DB = { prepare: q => new Stmt(q), async batch(list) { const out = []; sql.exec('BEGIN'); try { for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } return out; } };
const newPh = () => crypto.randomBytes(16).toString('hex');
const xpOf = ph => sql.prepare('SELECT xp FROM prog WHERE ph = ?').get(ph).xp;
const S = 'twinkle', now0 = Date.now();
let t = now0;
const run = (ph, o) => L.settle(DB, ph, 0, (t += 3600e3), { song: S, d: 3, kind: 'clear', acc: 5000, m: 1, start: t - 100e3, ...o });

{   // Lv1 clear: at least level 2 (a short easy song at 50 % accuracy gives only a handful of experience on its own)
  const ph = newPh(); await L.ensureProg(DB, ph, now0);
  const plain = L.xpClear(S, 3, 5000, 1, 1);
  ok(plain < L.needAt(1), 'the plain reward of this clear is below one level (' + plain + ' < ' + L.needAt(1) + ')');
  const r = await run(ph, {});
  ok(r.from.lv === 1 && r.lv === 2 && xpOf(ph) >= L.needAt(1), 'Lv1 clear -> Lv2 (xp ' + xpOf(ph) + ', lv ' + r.lv + ')');
  ok(r.ups.length === 1 && r.ups[0] === 2, 'the answer lists the level reached');
  ok(r.gain === xpOf(ph) && r.gain === L.needAt(1), 'gain is exactly what lifts it to Lv2 (' + r.gain + ')');
}
{   // a big first clear is not cut back, and a Lv1 player with some xp only gets the missing part
  const ph = newPh(); await L.ensureProg(DB, ph, now0); sql.prepare('UPDATE prog SET xp = 100 WHERE ph = ?').run(ph);
  const r = await run(ph, {});
  ok(r.lv === 2 && xpOf(ph) === L.needAt(1) && r.gain === L.needAt(1) - 100, 'xp 100 + a small clear: lifted to exactly 116, gain ' + r.gain);
  const ph2 = newPh(); await L.ensureProg(DB, ph2, now0); sql.prepare('UPDATE prog SET xp = 110 WHERE ph = ?').run(ph2);
  const big = L.xpClear('prelude', 4, 10000, 1, 1), r2 = await run(ph2, { song: 'prelude', d: 4, acc: 10000 });
  ok(big > 6 && r2.gain === Math.max(big, 6) && xpOf(ph2) === 110 + big, 'a clear worth more than the missing xp is paid in full (' + big + ')');
}
{   // Lv2 and above: untouched
  const ph = newPh(); await L.ensureProg(DB, ph, now0); sql.prepare('UPDATE prog SET xp = 120 WHERE ph = ?').run(ph);
  const plain = L.xpClear(S, 3, 5000, 1, 1), r = await run(ph, {});
  ok(r.from.lv === 2 && r.gain === plain && xpOf(ph) === 120 + plain, 'Lv2 clear: the normal gain only (' + r.gain + ' = ' + plain + ')');
  const ph3 = newPh(); await L.ensureProg(DB, ph3, now0); sql.prepare('UPDATE prog SET xp = 9000 WHERE ph = ?').run(ph3);
  const r3 = await run(ph3, {}); ok(r3.gain === plain, 'a higher level: the normal gain only');
}
{   // fail and quit: nothing extra
  const ph = newPh(); await L.ensureProg(DB, ph, now0);
  const f = await run(ph, { kind: 'fail', accSo: .5, frac: .3 });
  ok(f.lv === 1 && f.gain === L.xpFail(S, 3, .5, .3, 1) && f.gain < L.needAt(1), 'Lv1 fail: the normal fail reward, still Lv1 (' + f.gain + ')');
  const q = await run(ph, { kind: 'quit' }); ok(q.gain === 0 && xpOf(ph) === f.gain, 'Lv1 quit: nothing');
  const d = await L.settle(DB, ph, 0, (t += 3600e3), { song: S, d: 3, kind: 'duel', acc: 5000, mult: 2, start: t - 100e3 });
  ok(d.gain === L.xpClear(S, 3, 5000, 2, 1), 'Lv1 duel round: not a solo clear, the normal reward (' + d.gain + ')');
}
{   // a clear with a light multiplier keeps its multiplier; the lift only raises a too small gain
  const ph = newPh(); await L.ensureProg(DB, ph, now0);
  const r = await run(ph, { m: 4 });
  ok(r.lv === 2 && r.used === 4 && r.gain >= L.needAt(1) && r.base <= r.gain, 'Lv1 clear x4: reaches Lv2, multiplier kept (used ' + r.used + ', gain ' + r.gain + ', base ' + r.base + ')');
}
{   // a clear that earns no experience at all (the ticket was replaced by a newer one) does not lift either
  const ph = newPh(); await L.ensureProg(DB, ph, now0);
  const r = await run(ph, { noxp: true });
  ok(r.gain === 0 && r.lv === 1 && xpOf(ph) === 0 && r.ups.length === 0, 'noxp clear at Lv1: no experience, no lift, still Lv1 (gain ' + r.gain + ', lv ' + r.lv + ')');
}
{   // a clear whose time overlaps the last settled run is turned into a quit by settle: no lift, nothing written
  const ph = newPh(); await L.ensureProg(DB, ph, now0);
  const t1 = (t += 3600e3), f = await L.settle(DB, ph, 0, t1, { song: S, d: 3, kind: 'fail', accSo: .5, frac: .3, m: 1, start: t1 - 100e3 });
  const x1 = xpOf(ph);
  const r = await L.settle(DB, ph, 0, t1 + 10e3, { song: S, d: 3, kind: 'clear', acc: 5000, m: 1, start: t1 - 50e3 });
  ok(f.lv === 1 && r.gain === 0 && r.lv === 1 && xpOf(ph) === x1 && x1 < L.needAt(1), 'overlapping clear (settled as a quit) at Lv1: no experience, no lift (gain ' + r.gain + ', lv ' + r.lv + ')');
  const r2 = await L.settle(DB, ph, 0, t1 + 4000e3, { song: S, d: 3, kind: 'clear', acc: 5000, m: 1, start: t1 + 4000e3 - 100e3 });
  ok(r2.lv === 2 && xpOf(ph) >= L.needAt(1), 'the next clear that does not overlap lifts it to Lv2');
}
console.log(`firstclear: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
