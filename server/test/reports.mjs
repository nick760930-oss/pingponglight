// Nickname reports: what "delete my online data" leaves of them, and the yearly sweep (no server needed): node test/reports.mjs
// handleLb runs in this process against an in-memory SQLite (node:sqlite) wrapped like D1; every migration is applied to it.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { handleLb, reportSweep } from '../src/lb.js';

const SRV = join(dirname(fileURLToPath(import.meta.url)), '..'), DAY = 86400e3;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };

// ---- a D1-like wrapper over node:sqlite (like runs.mjs) ----
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
const env = { LB: DB, LB_SECRET: 'reports-test-secret' };
let net = 0;
async function post(path, body, who = '203.0.113.' + (++net)) {      // a new network per request, unless one is given
  const r = await handleLb(new Request('http://t' + path, { method: 'POST', body: JSON.stringify(body) }), env, path, who, null, {}, async () => false);
  return { s: r.status, j: await r.json() };
}
const q1 = (s, ...a) => sql.prepare(s).get(...a), qa = (s, ...a) => sql.prepare(s).all(...a);
let pn = 0;
const nick = n => 'Nn' + n.toString(2).padStart(7, '0').replace(/0/g, 'r').replace(/1/g, 'l');   // fixed names, two letters only: a random one is refused by the word filter now and then
async function player() { const pk = crypto.randomBytes(16).toString('hex'), name = nick(++pn), r = await post('/lb/name', { pk, name }); if (!r.j.id) throw new Error('nickname refused: ' + name); return { pk, id: r.j.id }; }
const report = (by, target, who) => post('/lb/report', { pk: by.pk, id: target.id }, who);
const rows = t => qa('SELECT pid, by, ts, rp FROM reports WHERE pid = ? ORDER BY ts, by', t.id);
const hidden = t => q1('SELECT hidden FROM players WHERE id = ?', t.id).hidden;
const age = (t, days) => sql.prepare('UPDATE reports SET ts = ? WHERE pid = ?').run(Date.now() - days * DAY, t.id);

// ---- a reporter deletes their data: the report stays, without the reporter ----
{
  const T = await player(), A = await player(), B = await player();
  ok(T.id > 0 && A.id > 0 && B.id > 0, 'players registered');
  await report(A, T); await report(B, A);                 // A reported T; B reported A
  const before = rows(T);
  ok(before.length === 1 && before[0].rp === A.id && before[0].by.length === 64, 'the report names its reporter and a hashed network');
  ok(rows(A).length === 1, 'a report against A');
  const del = await post('/lb/delete', { pk: A.pk });
  ok(del.j.ok && !q1('SELECT 1 AS x FROM players WHERE id = ?', A.id), 'A is deleted');
  const after = rows(T);
  ok(after.length === 1, 'the report A made about T is still there');
  ok(after[0].rp === null, 'without the reporter');
  ok(after[0].by === before[0].by && after[0].ts === before[0].ts && after[0].pid === T.id, 'the reported player, the time and the hashed network are unchanged');
  ok(rows(A).length === 0, 'reports against A went with A');
  ok(!q1('SELECT 1 AS x FROM reports WHERE rp = ?', A.id), 'no report names A any more');
  ok(q1('SELECT COUNT(*) AS n FROM reports WHERE rp = ?', B.id).n === 0 && !q1('SELECT 1 AS x FROM reports WHERE pid = ?', A.id), 'B\'s report about A is gone with A, not kept under B');
}

// ---- reports without a reporter still count towards hiding, and several can sit on one nickname ----
{
  const T = await player(), A = await player(), B = await player(), C = await player();
  await report(A, T); await report(B, T);
  await post('/lb/delete', { pk: A.pk }); await post('/lb/delete', { pk: B.pk });
  const r = rows(T);
  ok(r.length === 2 && r[0].rp === null && r[1].rp === null, 'two reports without a reporter on the same nickname');
  ok(hidden(T) === 0, 'two reports do not hide');
  await report(C, T);
  ok(rows(T).length === 3 && hidden(T) === 1, 'the third report hides the nickname (reports of deleted reporters count)');
}

// ---- one report per network and per reporter (unchanged) ----
{
  const T = await player(), A = await player(), B = await player();
  await report(A, T, '198.51.100.1'); await report(A, T, '198.51.100.2');     // the same reporter from another network
  ok(rows(T).length === 1, 'one report per reporter');
  await report(B, T, '198.51.100.1');                                          // another reporter on the first network
  ok(rows(T).length === 1, 'one report per network');
  await report(A, A);
  ok(rows(A).length === 0, 'nobody reports themselves');
}

// ---- the sweep: older than a year goes, unless the nickname is hidden ----
{
  const Old = await player(), New = await player(), Hid = await player(), Edge = await player();
  const R = [await player(), await player(), await player()];
  await report(R[0], Old); await report(R[1], Old); age(Old, 366);
  await report(R[0], New); age(New, 364);
  await report(R[0], Edge); age(Edge, 365.5);
  for (const r of R) await report(r, Hid);
  ok(hidden(Hid) === 1, 'three reports hide');
  age(Hid, 800);
  await reportSweep(env);
  ok(rows(Old).length === 0, 'reports older than a year are deleted');
  ok(rows(New).length === 1, 'a report 364 days old stays');
  ok(rows(Edge).length === 0, 'a report just over a year old is deleted');
  ok(rows(Hid).length === 3 && hidden(Hid) === 1, 'the reports of a hidden nickname stay, however old');
  await reportSweep(env);
  ok(rows(New).length === 1 && rows(Hid).length === 3, 'a second sweep changes nothing');
  // a moderator un-hides (lb.js op 'unhide' also deletes the reports itself); if only the flag were cleared, the sweep takes the old ones
  sql.prepare('UPDATE players SET hidden = 0 WHERE id = ?').run(Hid.id);
  await reportSweep(env);
  ok(rows(Hid).length === 0, 'once the nickname is no longer hidden, its old reports go');
  // old reports no longer count towards hiding
  const T = await player();
  await report(R[0], T); await report(R[1], T); age(T, 400);
  await reportSweep(env);
  await report(R[2], T);
  ok(rows(T).length === 1 && hidden(T) === 0, 'two reports from over a year ago and one new one do not hide');
  // the player the reports are about deletes their data: everything about them goes (unchanged)
  await post('/lb/delete', { pk: T.pk });
  ok(rows(T).length === 0, 'reports against a deleted player are deleted');
  // no database: nothing to do, no error
  let threw = false; try { await reportSweep({}); } catch (e) { threw = true; }
  ok(!threw, 'no database, no error');
  // a database that fails: the sweep gives up quietly, so the other hourly jobs are not cut short
  threw = false; try { await reportSweep({ LB: { prepare() { throw new Error('down'); } } }); } catch (e) { threw = true; }
  ok(!threw, 'a failing database does not throw');
}

// ---- the admin's un-hide deletes the reports (unchanged) ----
{
  env.LB_ADMIN = 'reports-test-admin';
  const T = await player(), R = [await player(), await player(), await player()];
  for (const r of R) await report(r, T);
  ok(hidden(T) === 1, 'hidden after three');
  const list = await post('/lb/admin', { token: env.LB_ADMIN, op: 'reports' });
  ok(list.j.rows && list.j.rows.some(x => x.id === T.id && x.n === 3 && x.hidden === 1), 'the admin list shows the nickname with 3 reports');
  const un = await post('/lb/admin', { token: env.LB_ADMIN, op: 'unhide', id: T.id });
  ok(un.j.ok && hidden(T) === 0 && rows(T).length === 0, 'un-hide clears the flag and the reports');
}

console.log(fail ? 'FAILED ' + fail + ' of ' + (pass + fail) : 'reports: ' + pass + ' checks passed');
process.exit(fail ? 1 : 0);
