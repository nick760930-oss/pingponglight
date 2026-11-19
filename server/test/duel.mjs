// Verified duel results and the achievements built on them (no server needed): node test/duel.mjs
// duelJudge, ordering, settle (pure); the rows they write into an in-memory SQLite (node:sqlite, wrapped like D1, every migration applied); achRecalc over those rows;
// the admin 'duelvoid'; friends (by / fresh) through handleFr; and the Arena class driven directly (fake sockets and storage, the same D1 wrapper).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { handleLb } from '../src/lb.js';
import { handleFr } from '../src/friends.js';
import { CHARTS } from '../src/charts.js';
import { ACHS, DUEL_IDS, DUEL_CALC, achRecalc, achList } from '../src/ach.js';
import { duelJudge, ordering, settle, duelFactsFor, duelWrite, dayOf, sprintAt, parseLg, pk as pairKey, SUS_ABS, SUS_REL } from '../src/duel.js';
import { Arena } from '../src/arena.js';

const SRV = join(dirname(fileURLToPath(import.meta.url)), '..'), SECRET = 'duel-test-secret', ADMIN = 'duel-test-admin';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

// ---- a D1-like wrapper over node:sqlite (like runs.mjs) ----
let sql;
const newDb = (skip = []) => { sql = new DatabaseSync(':memory:'); for (const f of readdirSync(join(SRV, 'migrations')).filter(f => f.endsWith('.sql')).sort()) if (!skip.includes(f.slice(0, 4))) sql.exec(readFileSync(join(SRV, 'migrations', f), 'utf8')); };
class Stmt {
  constructor(q, a = []) { this.q = q; this.a = a; }
  bind(...a) { return new Stmt(this.q, a); }
  async first() { return sql.prepare(this.q).get(...this.a) ?? null; }
  async all() { return { results: sql.prepare(this.q).all(...this.a) }; }
  async run() { const r = sql.prepare(this.q).run(...this.a); return { success: true, meta: { changes: Number(r.changes) } }; }
}
const DB = { prepare: q => new Stmt(q),
  async batch(list) { const out = []; sql.exec('BEGIN'); try { for (const s of list) out.push(s.q.trimStart().toUpperCase().startsWith('SELECT') ? await s.all() : await s.run()); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } return out; } };
const hub = { get: () => ({ fetch: async () => Response.json({ n: 0, delivered: false }) }), idFromName: () => 'hub' };
const env = { LB: DB, LB_SECRET: SECRET, LB_ADMIN: ADMIN, HUB: hub };
const q1 = (s, ...a) => sql.prepare(s).get(...a), qa = (s, ...a) => sql.prepare(s).all(...a);
const lb = async (path, body) => { const r = await handleLb(new Request('http://t' + path, { method: 'POST', body: JSON.stringify(body) }), env, path, '203.0.113.7', null, {}, async () => false); return { s: r.status, j: await r.json() }; };
let pn = 0;
const player = async () => { const pk = crypto.randomBytes(16).toString('hex'), r = await lb('/lb/name', { pk, name: 'D' + (++pn) + crypto.randomBytes(3).toString('hex') }); return { pk, id: r.j.id }; };
const songs = Object.keys(CHARTS);
const addScores = (pid, n = 3) => { for (let k = 0; k < n; k++) sql.prepare(`INSERT OR IGNORE INTO scores (board, pid, key, acc, err, combo, ts, hid, log, pf, sus, score, ft, n) VALUES (?, ?, 1, 9000, 10, 5, 1, 0, '[]', 'web', 0, 1000, NULL, 1)`).run(songs[k] + '-0', pid); };

// ---- charts and logs ----
const S = songs[0], D0 = 0, N = CHARTS[S].n[D0], SP = sprintAt(N, D0);      // twinkle on 簡單: 1 ball, 48 beats; the sprint border is beat SP
const plain = (n = N, d = D0) => Array.from({ length: n }, (_, i) => [0, i >= sprintAt(CHARTS[S].n[d], d) ? 600 : 300]);   // every hit perfect, base 3 x speed 1 (x2 in the sprint)
const at = (log, i, x) => { const l = log.slice(); l[i] = x; return l; };

// =============================== duelJudge ===============================
{
  const j = duelJudge(S, D0, plain());
  ok(j && j.ok === 1 && j.acc === 10000 && j.fc === 1 && j.n === N && j.hit === N && j.mc === N && j.rk === 'SSS', 'judge: a perfect whole log');
  eq(j && j.q, 100, 'judge: q is 100 for speed-1 hits (the sprint hits are divided by 2 again)');
  let sc = 0; for (let i = 0; i < N; i++) sc += plain()[i][1] + (i + 1) * 5;
  eq(j && j.s, sc, 'judge: score = bases + combo x 5');
  const cut = Math.floor(N * .9); let t = 0; for (let i = 0; i < cut; i++) t += plain()[i][1] + (i + 1) * 5;
  eq(j && j.t90, t, 'judge: t90 = score over the first floor(.9N) beats');
  // the sprint limit
  ok(duelJudge(S, D0, at(plain(), 0, [0, 5000])) === null, 'judge: base 5000 on beat 0 (limit ~3870) is refused');
  ok(duelJudge(S, D0, at(plain(), N - 1, [0, 5000])) !== null, 'judge: the same base in the sprint is accepted (limit doubled)');
  ok(duelJudge(S, D0, at(plain(), SP - 1, [0, 5000])) === null, 'judge: one beat before the sprint border: still refused');
  ok(duelJudge(S, D0, at(plain(), SP, [0, 5000])) !== null, 'judge: at the sprint border: accepted');
  ok(duelJudge(S, D0, at(plain(), N - 1, [0, 8000])) === null, 'judge: even in the sprint, 8000 (above twice the limit) is refused');
  ok(duelJudge(S, D0, at(plain(), 3, [0, 50])) === null, 'judge: far below the least a perfect hit earns: refused');
  // q ignores the beats around the sprint border
  const odd = plain().map((x, i) => i >= SP && i <= SP + 2 ? [0, 5000] : x);
  eq(duelJudge(S, D0, odd).q, 100, 'judge: the beats at the sprint border do not count for q');
  const hi = plain().map((x, i) => i < SP - 1 ? [0, 600] : x);
  const jh = duelJudge(S, D0, hi); ok(jh && jh.q > 100 && jh.q < 200, 'judge: q follows the base outside the border (got ' + (jh && jh.q) + ')');
  // star time: doubled bases need a star range
  ok(duelJudge(S, D0, at(plain(), 2, [0, 600]), [[2, 3]]) !== null, 'judge: a doubled base inside a star range');
  ok(duelJudge(S, D0, at(plain(), 2, [0, 100]), [[2, 3]]) === null, 'judge: inside a star range a hit below the doubled minimum is refused');
  ok(duelJudge(S, D0, plain(), [[3, 2]]) === null, 'judge: a bad star range is refused');
  eq(duelJudge(S, D0, at(plain(), 2, [0, 600]), [[2, 3]]).q, 100, 'judge: q divides a star hit by 2');
  // partial logs
  const part = plain(20), jp = duelJudge(S, D0, part);
  ok(jp && jp.ok === 0 && jp.n === 20 && jp.hit === 20 && jp.acc === 10000 && jp.fc === 0, 'judge: a partial log (no seq): ok 0, n = its length, accuracy over what was played');
  const jp2 = duelJudge(S, D0, at(plain(20), 5, null));
  ok(jp2 && jp2.n === 20 && jp2.hit === 19 && jp2.acc === Math.floor((19 * 20) * 500 / 20), 'judge: a partial log with a miss');
  ok(duelJudge(S, D0, plain(20), undefined, Array.from({ length: 20 }, (_, i) => i)) !== null, 'judge: a partial log with its seq');
  ok(duelJudge(S, D0, plain(20), undefined, [0, 1, 2]) === null, 'judge: a partial log whose seq stops before the log does (the beats after it are not null)');
  ok(duelJudge(S, D0, [], undefined) === null && duelJudge(S, D0, plain(N + 1)) === null, 'judge: empty and too long logs');
  ok(duelJudge('nope', 0, plain()) === null && duelJudge(S, 9, plain()) === null, 'judge: unknown song / difficulty');
  // life: a whole log that would have died is not ok
  const SD = songs.find(s => CHARTS[s].n[2] >= 30), N2 = CHARTS[SD].n[2];     // 困難: 7 life per miss, 30 life: five misses in a row end it
  const dead = Array.from({ length: N2 }, (_, i) => i < 5 ? null : [0, 300]);
  const jd = duelJudge(SD, 2, dead.map((x, i) => x && [0, i >= sprintAt(N2, 2) ? 600 : 300]));
  ok(jd && jd.ok === 0 && jd.n === N2, 'judge: a whole log whose life ran out is ok 0');
  const alive = Array.from({ length: N2 }, (_, i) => i < 4 ? null : [0, i >= sprintAt(N2, 2) ? 600 : 300]);
  ok(duelJudge(SD, 2, alive).ok === 1, 'judge: four misses (28 life) and then hits: ok 1');
  // shields: too many 0 entries
  ok(duelJudge(S, D0, plain().map((x, i) => i < 10 ? 0 : x)) === null, 'judge: more shields than power-ups could appear: refused');
  // the seat message
  ok(parseLg(JSON.stringify({ t: 'lg', log: [1], star: [], seq: [0] })).log.length === 1 && parseLg('{"t":"x","log":[]}') === null && parseLg('nope') === null && parseLg('{"t":"lg"}') === null, 'parseLg');
}

// =============================== ordering / validity ===============================
const T0 = 1.7e12, NOW = T0 + 10 * 60e3, DUR = CHARTS[S].dur / CHARTS[S].spd[D0] * 900;
let rn = 0;
const seatsOf = pids => pids.map((pid, i) => ({ i, pid }));
const round = (pids, o = {}) => ({ at: T0, song: S, di: D0, id: 'rd' + (++rn), kind: 'room', host: pids[0], seats: seatsOf(pids), fr0: [], ...o });
const vr = (o = {}) => ({ s: 10000, acc: 9000, mc: 10, fc: 0, ok: 1, n: N, hit: N, q: 100, t90: 5000, rk: 'A', ...o });
const rec = (i, o = {}) => ({ i, name: 'P' + i, cos: null, fin: { s: 99999, ok: true, acc: .5, rank: 'F', mc: 1 }, vr: vr(), n: 0, s: 0, off: false, ...o });
const facts = (pids, o = {}) => ({ games: new Map(), wins: new Map(), songs: new Map(pids.map(p => [p, 5])), pairs: new Set(), ...o });
const row = (res, pid) => res && res.rows.find(r => r.pid === pid);
{
  const R = round([11, 12, 13]);
  let o = ordering(R, [rec(0, { vr: vr({ s: 8000 }) }), rec(1, { vr: vr({ s: 9000 }) }), rec(2, { vr: vr({ s: 7000 }) })], NOW);
  eq(o.rows.map(r => r.i), [1, 0, 2], 'ordering: places follow the recomputed score, not what the fin says (they all claimed 99999)');
  ok(o.rows[0].s === 9000 && o.rows[0].acc === .9 && o.rows[0].rank === 'A' && o.rows.every(r => r.v === 1) && o.valid === 3 && o.counts, 'ordering: values come from vr; all three valid');
  // fin says ok but the log is not a whole one
  o = ordering(R, [rec(0), rec(1, { vr: vr({ ok: 0, n: N - 5, s: 20000 }) })], NOW);
  ok(o.rows.find(r => r.i === 1).ok === false && o.rows[0].i === 0, 'ordering: ok = fin.ok && vr.ok');
  // grouping: finished, failed, online unfinished, offline unfinished
  o = ordering(R, [rec(0, { fin: { s: 1, ok: false, acc: 0, rank: '—', mc: 0 }, vr: vr({ ok: 0, s: 50000 }) }), rec(1, { vr: vr({ s: 10 }) }), rec(2, { fin: null, vr: null, s: 70000, n: 0, off: false })], NOW);
  eq(o.rows.map(r => r.i), [1, 0, 2], 'ordering: finished before failed before unfinished, whatever the scores');
  // a legacy phone: fin, no log
  o = ordering(R, [rec(0), rec(1), rec(2, { vr: null })], NOW);
  ok(o.valid === 2 && o.rows.find(r => r.i === 2).v === 0 && o.rows.find(r => r.i === 0).v === 1, 'ordering: a seat with fin but no log is not valid, the others are');
  ok(o.rows.find(r => r.i === 2).s === 99999, 'ordering: ...and it is shown as it reported');
  // duplicate account
  const Rd = round([11, 11, 13], { seats: [{ i: 0, pid: null, dup: 1 }, { i: 1, pid: null, dup: 1 }, { i: 2, pid: 13 }] });
  o = ordering(Rd, [rec(0), rec(1), rec(2)], NOW); eq(o.valid, 1, 'ordering: one account in two seats: both invalid (1 valid seat left)');
  ok(!o.counts, 'ordering: 1 valid seat: the round does not count');
  // the snapshot decides: a seat that was not signed in at the start stays invalid
  o = ordering(round([11, 0, 13], { seats: [{ i: 0, pid: 11 }, { i: 1, pid: null }, { i: 2, pid: 13 }] }), [rec(0), rec(1), rec(2)], NOW);
  ok(o.rows.find(r => r.i === 1).v === 0 && o.valid === 2, 'ordering: signed in after the start: invalid');
  o = ordering(round([11, 12], { seats: [{ i: 0, pid: 11 }, { i: 1, pid: null, dup: 1 }] }), [rec(0), rec(1)], NOW); ok(!o.counts, 'ordering: dup seat marked in the snapshot');
  // 30 %
  o = ordering(R, [rec(0), rec(1, { vr: vr({ n: Math.ceil(N * .3) - 1 }) }), rec(2, { vr: vr({ n: Math.ceil(N * .3) }) })], NOW);
  eq(o.rows.map(r => r.v).sort(), [0, 1, 1], 'ordering: a log under 30 % of the beats is not valid, 30 % is');
  // offline without a log
  const off = (n, extra = {}) => rec(1, { fin: null, vr: null, off: true, n, s: 123, ...extra });
  o = ordering(R, [rec(0), off(Math.ceil(N * .3))], NOW); ok(o.rows.find(r => r.i === 1).v === 1 && o.counts, 'ordering: left at 30 % without a log: valid (a loser)');
  o = ordering(R, [rec(0), off(Math.ceil(N * .3) - 1)], NOW); ok(o.rows.find(r => r.i === 1).v === 0 && !o.counts, 'ordering: left before 30 %: invalid');
  o = ordering(R, [rec(0), rec(1, { fin: null, vr: null, off: false, n: N, s: 5 })], NOW); ok(o.rows.find(r => r.i === 1).v === 0, 'ordering: still online without a log: invalid');
  o = ordering(R, [rec(0), off(N, { fin: { s: 1, ok: true, acc: 1, rank: 'SSS', mc: 1 } })], NOW); ok(o.rows.find(r => r.i === 1).v === 0, 'ordering: a legacy fin from a seat that then left: invalid');
  ok(o.rows.find(r => r.i === 1).s === 1, 'ordering: ...shown as it reported');
  // too short a round
  o = ordering(R, [rec(0), rec(1)], T0 + DUR - 1); ok(!o.counts && o.rows.every(r => r.v === 0), 'ordering: shorter than dur / spd x 900 ms: nothing counts, every row v 0');
  o = ordering(R, [rec(0), rec(1)], T0 + DUR); ok(o.counts, 'ordering: exactly long enough');
  // a rank for a failed seat
  o = ordering(R, [rec(0), rec(1, { fin: { s: 1, ok: false, acc: 0, rank: '—', mc: 0 }, vr: vr({ ok: 0, rk: 'S' }) })], NOW); ok(o.rows.find(r => r.i === 1).rank === '—', 'ordering: a failed seat has no rank');
}

// =============================== settle: the flags ===============================
{
  const P = [11, 12, 13];
  const go = (recs, F, o = {}, pids = P) => settle(round(pids, o.round), ordering(round(pids, o.round), recs, NOW), F || facts(pids), NOW, o.log1 || null);
  const base = [rec(0, { vr: vr({ s: 9000, acc: 9500 }) }), rec(1, { vr: vr({ s: 8000, acc: 9000 }) }), rec(2, { vr: vr({ s: 7000, acc: 8000 }) })];
  // make ordering() and settle() see the same round object
  const run = (recs, F, o = {}, pids = P) => { const R = o.round ? { ...round(pids), ...o.round } : round(pids); return settle(R, ordering(R, recs, o.now || NOW), F || facts(pids), o.now || NOW, o.log1 || null); };
  let r = run(base);
  ok(r && r.rows.length === 3 && r.duel.valid === 3 && r.duel.seats === 3 && r.duel.kind === 'room' && r.duel.host === 11 && r.duel.song === S && r.duel.d === D0 && r.duel.day === dayOf(NOW), 'settle: the duels row');
  ok(row(r, 11).place === 1 && row(r, 12).place === 2 && row(r, 13).place === 3 && row(r, 11).score === 9000 && row(r, 11).acc === 9500, 'settle: place, score, acc from the log');
  ok(row(r, 11).cg === 1 && row(r, 11).cw === 1 && row(r, 12).cw === 0 && row(r, 12).cg === 1, 'settle: the winner counts a win, everybody a round');
  ok(run(base, null, { now: T0 + DUR - 1 }) === null, 'settle: a round that does not count writes nothing');
  eq(run(base, null, { log1: 'LOG' }).duel.log1, 'LOG', 'settle: log1');
  // --- cw, one counter-example each
  const cw = (recs, F, o, pids) => { const x = run(recs, F, o, pids); return x ? row(x, 11).cw : -1; };
  eq(cw(base), 1, 'cw: base case');
  { const x = run(base, facts(P, { songs: new Map([[11, 5], [12, 2], [13, 3]]) })); eq([row(x, 11).qual, row(x, 12).qual, row(x, 13).qual], [1, 0, 1], 'qual: 1 for a seat with 3+ songs and a log with 30 % hits, 0 for a seat with 2 songs'); }
  eq(cw(base, facts(P, { games: new Map([[11, 30]]) })), 0, 'cw: 30 rounds already today -> not cg -> no win');
  eq(row(run(base, facts(P, { games: new Map([[11, 30]]) })), 11).cg, 0, 'cg: 30 today -> 0');
  eq(row(run(base, facts(P, { games: new Map([[11, 29]]) })), 11).cg, 1, 'cg: 29 today -> 1');
  eq(cw([rec(0, { vr: vr({ s: 9000 }) }), rec(1, { vr: vr({ s: 9500 }) }), rec(2)]), 0, 'cw: not first');
  eq(cw([rec(0, { vr: vr({ s: 9000, ok: 0 }), fin: { s: 1, ok: false, acc: 0, rank: '—', mc: 0 } }), rec(1, { vr: vr({ s: 100 }) }), rec(2, { vr: vr({ s: 100 }) })]), 0, 'cw: first but did not finish');
  eq(cw([rec(0, { vr: vr({ s: 9000, q: 700 }) }), rec(1, { vr: vr({ s: 100, q: 100 }) }), rec(2, { vr: vr({ s: 100, q: 120 }) })]), 0, 'cw: sus (q 700 vs the others\' median 110) -> no win');
  eq(row(run([rec(0, { vr: vr({ s: 9000, q: 700 }) }), rec(1, { vr: vr({ q: 100 }) }), rec(2, { vr: vr({ q: 120 }) })]), 11).sus, 1, 'sus: flagged');
  eq(cw([rec(0, { vr: vr({ s: 9000, q: SUS_ABS }) }), rec(1, { vr: vr({ s: 100, q: 10 }) }), rec(2, { vr: vr({ s: 100, q: 10 }) })]), 1, 'sus: q equal to the absolute limit is not above it');
  eq(cw([rec(0, { vr: vr({ s: 9000, q: 400 }) }), rec(1, { vr: vr({ s: 100, q: 400 / SUS_REL }) }), rec(2, { vr: vr({ s: 100, q: 400 / SUS_REL }) })]), 1, 'sus: exactly the relative limit is not above it');
  eq(cw([rec(0, { vr: vr({ s: 9000, q: 400 }) }), rec(1, { vr: vr({ s: 100, q: 400 }) }), rec(2, { vr: vr({ s: 100, q: 350 }) })]), 1, 'sus: everybody fast (a fast song): no one is sus');
  eq(cw(base, facts(P, { songs: new Map([[11, 5], [12, 2], [13, 2]]) })), 0, 'cw: no opponent with 3 different songs -> no win');
  eq(cw(base, facts(P, { songs: new Map([[11, 5], [12, 2], [13, 3]]) })), 1, 'cw: one qualified opponent is enough');
  eq(cw([base[0], base[1], rec(2, { vr: vr({ s: 7000, hit: Math.ceil(N * .3) - 1 }) })], facts(P, { songs: new Map([[11, 5], [12, 0], [13, 9]]) })), 0, 'cw: the only 3-song opponent hit under 30 % -> not qualified');
  eq(cw(base, facts(P, { wins: new Map([['11:12', 3], ['11:13', 3]]) })), 0, 'cw: 3 wins against each opponent today already -> no win');
  eq(cw(base, facts(P, { wins: new Map([['11:12', 3], ['11:13', 2]]) })), 1, 'cw: one opponent still has room (2 of 3) -> win');
  eq(cw(base, facts(P, { wins: new Map([['11:12', 2], ['11:13', 9]]) })), 1, 'cw: the pair limit is per opponent');
  const gone = o => rec(1, { fin: null, vr: null, off: true, n: Math.ceil(N * .3), s: 100, ...o });
  eq(cw([rec(0, { vr: vr({ s: 9000 }) }), gone({})], facts([11, 12]), {}, [11, 12]), 1, 'cw: the only opponent left after 30 % of the beats with a score above 0 (no log): qualified');
  eq(cw([rec(0, { vr: vr({ s: 9000 }) }), gone({ s: 0 })], facts([11, 12]), {}, [11, 12]), 0, 'cw: the opponent left with a last score of 0: not qualified');
  eq(cw([rec(0, { vr: vr({ s: 9000 }) }), gone({ n: Math.ceil(N * .3) - 1 })], facts([11, 12]), {}, [11, 12]), -1, 'cw: the opponent left before 30 %: not valid, one valid seat, the round does not count (no win)');
  eq(cw([rec(0, { vr: vr({ s: 9000 }) }), gone({})], facts([11, 12], { songs: new Map([[11, 5], [12, 2]]) }), {}, [11, 12]), 0, 'cw: the leaver has under 3 songs: not qualified');
  eq(cw([rec(0, { vr: vr({ s: 9000 }) }), gone({ vr: vr({ s: 100, hit: Math.ceil(N * .3) - 1, n: Math.ceil(N * .3) }) })], facts([11, 12]), {}, [11, 12]), 0, 'cw: an idle opponent with a log under 30 % hits stays not qualified (even if it left)');
  eq(cw([rec(0, { vr: vr({ s: 9000 }) }), rec(1, { fin: null, vr: null, off: false, n: N, s: 100 })], facts([11, 12]), {}, [11, 12]), -1, 'cw: an opponent still online without a log is not valid: the round does not count (no win)');
  { const x = run([rec(0, { vr: vr({ s: 9000 }) }), gone({})], facts([11, 12]), {}, [11, 12]); eq([row(x, 11).qual, row(x, 12).qual], [1, 1], 'qual: a leaver after 30 % with a score above 0 qualifies'); }
  { const x = run([rec(0, { vr: vr({ s: 9000 }) }), gone({ s: 0 })], facts([11, 12]), {}, [11, 12]); eq(row(x, 12).qual, 0, 'qual: a leaver with a last score of 0 does not'); }
  eq(cw([rec(0, { vr: vr({ s: 9000 }) }), rec(1, { vr: vr({ s: 100 }) })], facts([11, 12]), {}, [11, 12]), 1, 'cw: a 1 v 1');
  // the Taiwan day
  const midnight = Date.UTC(2026, 5, 10, 16, 0, 0);          // 00:00 on 11 June in Taiwan
  eq(dayOf(midnight) - dayOf(midnight - 1), 1, 'dayOf: the day turns at 16:00 UTC (00:00 Taiwan)');
  eq(dayOf(midnight + 86400e3 - 1), dayOf(midnight), 'dayOf: 23:59:59.999 Taiwan is still the same day');
  // --- the other flags
  r = run(base, facts(P, { pairs: new Set([pairKey(11, 12)]) }));
  ok(row(r, 11).fr === 1 && row(r, 12).fr === 1 && row(r, 13).fr === 0, 'fr: friends among the valid opponents');
  r = run(base, facts(P, { pairs: new Set([pairKey(11, 12), pairKey(11, 13)]) })); eq(row(r, 11).fr, 2, 'fr: two friends');
  // eq
  r = run([rec(0, { vr: vr({ s: 9000, acc: 9000 }) }), rec(1, { vr: vr({ s: 8000, acc: 9000 }) }), rec(2, { vr: vr({ s: 7000, acc: 8000 }) })]);
  ok(row(r, 11).eq === 1 && row(r, 12).eq === 1 && row(r, 13).eq === 0, 'eq: the same accuracy (basis points) among finishers');
  r = run([rec(0, { vr: vr({ s: 9000, acc: 9000 }) }), rec(1, { vr: vr({ s: 8000, acc: 9000, ok: 0 }), fin: { s: 1, ok: false, acc: 0, rank: '—', mc: 0 } }), rec(2, { vr: vr({ s: 7000, acc: 8000 }) })]);
  eq(row(r, 11).eq, 0, 'eq: the other one did not finish -> no');
  r = run([rec(0, { vr: vr({ s: 9000, acc: 9001 }) }), rec(1, { vr: vr({ s: 8000, acc: 9000 }) }), rec(2, { vr: vr({ s: 7000, acc: 8999 }) })]); eq(row(r, 11).eq, 0, 'eq: 1 basis point apart -> no');
  // cb: last at 90 %, first at the end, >= 3 logs
  const cbRecs = (t90s, s = [9000, 8000, 7000]) => t90s.map((t, i) => rec(i, { vr: vr({ s: s[i], t90: t }) }));
  eq(row(run(cbRecs([100, 500, 400])), 11).cb, 1, 'cb: last at 90 %, first at the end');
  eq(row(run(cbRecs([500, 100, 400])), 11).cb, 0, 'cb: not last at 90 %');
  eq(row(run(cbRecs([100, 100, 400])), 11).cb, 0, 'cb: tied for last does not count');
  eq(row(run(cbRecs([100, 500, 400], [8000, 9000, 7000])), 11).cb, 0, 'cb: not first at the end');
  eq(row(run(cbRecs([100, 500]), facts([11, 12]), {}, [11, 12]), 11).cb, 0, 'cb: only 2 seats');
  eq(row(run([...cbRecs([100, 500]), rec(2, { fin: null, vr: null, off: true, n: N, s: 5 })]), 11).cb, 0, 'cb: needs 3 seats WITH logs');
  eq(row(run([rec(0, { vr: vr({ s: 9000, t90: 100, ok: 0 }), fin: { s: 1, ok: false, acc: 0, rank: '—', mc: 0 } }), rec(1, { vr: vr({ s: 100, t90: 500, ok: 0 }), fin: { s: 1, ok: false, acc: 0, rank: '—', mc: 0 } }), rec(2, { vr: vr({ s: 50, t90: 400, ok: 0 }), fin: { s: 1, ok: false, acc: 0, rank: '—', mc: 0 } })]), 11).cb, 0, 'cb: first by score but did not finish -> no');
  // s8 / f8
  const P8 = [21, 22, 23, 24, 25, 26, 27, 28], r8 = P8.map((_, i) => rec(i, { vr: vr({ s: 9000 - i * 100, acc: 9000 - i * 10, t90: 100 + i * 50 }) }));
  const fr8 = new Set(P8.slice(1).map(p => pairKey(21, p)));
  r = run(r8, facts(P8), {}, P8); ok(row(r, 21).s8 === 1 && row(r, 21).f8 === 0 && row(r, 28).s8 === 1 && r.duel.seats === 8 && r.duel.valid === 8, 's8: 8 seats and 7 valid opponents; f8 needs friends');
  r = run(r8, facts(P8), { round: { fr0: [...fr8] } }, P8); eq([row(r, 21).f8, row(r, 22).f8], [1, 0], 'f8: the other 7 were all friends of this player at the start (22 is not a friend of 23)');
  r = run(r8, facts(P8), { round: { fr0: [...fr8].filter(x => x !== pairKey(21, 25)) } }, P8); eq(row(r, 21).f8, 0, 'f8: one of the 7 was not a friend at the start');
  const r8b = r8.map((x, i) => i >= 6 ? rec(i, { fin: null, vr: null, off: true, n: 1, s: 1 }) : x);   // 2 of 8 gone before 30 %: 6 valid -> only 5 valid opponents
  r = run(r8b, facts(P8), { round: { fr0: [...fr8] } }, P8); ok(row(r, 21).s8 === 0 && row(r, 21).f8 === 0 && r.duel.valid === 6, 's8: 5 valid opponents (6 valid seats) is not enough');
  const r8c = r8.map((x, i) => i === 7 ? rec(i, { fin: null, vr: null, off: true, n: N, s: 1 }) : x);   // one gone after 30 %: still valid; 7 valid opponents
  r = run(r8c, facts(P8), { round: { fr0: [...fr8] } }, P8); ok(row(r, 21).s8 === 1 && row(r, 21).f8 === 1, 's8/f8: one valid loser that left late: still 8 / 8');
  r = run(r8.slice(0, 7), facts(P8.slice(0, 7)), { round: { seats: seatsOf(P8.slice(0, 7)) } }, P8.slice(0, 7)); eq(row(r, 21).s8, 0, 's8: 7 seats at the start -> no');
  r = run(r8, facts(P8), { round: { fr0: [...fr8], seats: seatsOf(P8).map((x, i) => i === 3 ? { i, pid: null } : x) } }, P8); eq(row(r, 21).f8, 0, 'f8: a seat not signed in at the start -> no');
  // 8-seat winner needs the win flags too
  ok(row(run(r8, facts(P8), {}, P8), 21).cw === 1, 'cw in an 8-seat round');
}

// =============================== D1: duelFactsFor, duelWrite, achRecalc ===============================
newDb();
const addDuel = (id, o, rows) => {
  const d = { ts: 1.7e12, day: dayOf(1.7e12), song: S, d: 0, kind: 'qm', host: null, seats: rows.length, valid: rows.length, void: 0, ...o };
  sql.prepare('INSERT INTO duels (id, ts, day, song, d, kind, host, seats, valid, void, log1) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)').run(id, d.ts, d.day, d.song, d.d, d.kind, d.host, d.seats, d.valid, d.void);
  for (const r of rows) { const x = { place: 2, acc: 9000, score: 1000, ok: 1, fc: 0, q: 100, sus: 0, cg: 1, cw: 0, fr: 0, eq: 0, cb: 0, s8: 0, f8: 0, qual: 1, ...r };
    sql.prepare('INSERT INTO duelp (did, pid, place, acc, score, ok, fc, q, sus, cg, cw, fr, eq, cb, s8, f8, qual) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, x.pid, x.place, x.acc, x.score, x.ok, x.fc, x.q, x.sus, x.cg, x.cw, x.fr, x.eq, x.cb, x.s8, x.f8, x.qual); }
};
let did = 0; const nid = () => 'd' + (++did);
const ids = async pid => (await achRecalc(DB, pid, Date.now(), null, false)).ids;
const has = async (pid, id) => (await ids(pid)).includes(id);
{
  // each of the 20 table-decided achievements: one scenario that gives it, one near miss that does not
  const A = await player(); const others = []; for (let k = 0; k < 25; k++) others.push((await player()).id);
  const mk = async (rowsFor) => { const P = await player(); rowsFor(P.id); return P.id; };
  const times = (n, f) => { for (let k = 0; k < n; k++) f(k); };
  // counts of rounds: 1 / 10 / 50 / 200 played
  for (const [id, n] of [['初次交手', 1], ['熱身賽', 10], ['擂台常駐', 50], ['百戰', 200]]) {
    const yes = await mk(p => times(n, k => addDuel(nid(), {}, [{ pid: p }, { pid: others[k % 25] }]))), no = await mk(p => times(n - 1, k => addDuel(nid(), {}, [{ pid: p }, { pid: others[k % 25] }])));
    ok(await has(yes, id), id + ': ' + n + ' rounds gives it'); ok(!(await has(no, id)), id + ': ' + (n - 1) + ' rounds does not');
  }
  { const p = await mk(p => addDuel(nid(), {}, [{ pid: p, cg: 0 }, { pid: others[0] }])); ok(!(await has(p, '初次交手')), '初次交手: a round that is not cg does not count'); }
  { const p = await mk(p => addDuel(nid(), { void: 1 }, [{ pid: p }, { pid: others[0] }])); ok(!(await has(p, '初次交手')), '初次交手: a voided round does not count'); }
  // wins
  for (const [id, wins, opp] of [['初露鋒芒', 10, 3], ['凱旋曲', 50, 10], ['常勝樂章', 200, 20]]) {
    const yes = await mk(p => times(wins, k => addDuel(nid(), {}, [{ pid: p, cw: 1, place: 1 }, { pid: others[k % opp] }])));
    const few = await mk(p => times(wins, k => addDuel(nid(), {}, [{ pid: p, cw: 1, place: 1 }, { pid: others[k % (opp - 1)] }])));
    const less = await mk(p => times(wins - 1, k => addDuel(nid(), {}, [{ pid: p, cw: 1, place: 1 }, { pid: others[k % opp] }])));
    ok(await has(yes, id), id + ': ' + wins + ' wins over ' + opp + ' players gives it'); ok(!(await has(few, id)), id + ': over ' + (opp - 1) + ' players only: no');
    ok(!(await has(less, id)), id + ': one win short: no');
  }
  { const p = await mk(p => times(10, k => addDuel(nid(), {}, [{ pid: p, cw: 1, place: 1 }, { pid: others[k % 3], qual: k % 3 === 2 ? 0 : 1 }]))); ok(!(await has(p, '初露鋒芒')), '初露鋒芒: 10 wins over 3 players but one of them never qualified: only 2 different qualified opponents: no'); }
  { const p = await mk(p => times(10, k => addDuel(nid(), {}, [{ pid: p, cw: 1, place: 1 }, { pid: others[k % 4], qual: k % 4 === 3 ? 0 : 1 }]))); ok(await has(p, '初露鋒芒'), '初露鋒芒: 3 qualified opponents among 4 (the 4th never qualified): yes'); }
  { const p = await mk(p => addDuel(nid(), {}, [{ pid: p, cw: 1, place: 1 }, { pid: others[0] }])); ok(await has(p, '首勝'), '首勝'); }
  { const p = await mk(p => addDuel(nid(), {}, [{ pid: p, cw: 0, place: 1 }, { pid: others[0] }])); ok(!(await has(p, '首勝')), '首勝: first place without cw: no'); }
  // 同台: valid >= 4
  { const p = await mk(p => addDuel(nid(), {}, [{ pid: p }, ...others.slice(0, 3).map(pid => ({ pid }))])); ok(await has(p, '同台'), '同台: 4 valid seats'); }
  { const p = await mk(p => addDuel(nid(), {}, [{ pid: p }, ...others.slice(0, 2).map(pid => ({ pid }))])); ok(!(await has(p, '同台')), '同台: 3 valid seats: no'); }
  { const p = await mk(p => addDuel(nid(), { valid: 4, seats: 4 }, [{ pid: p, cg: 0 }, ...others.slice(0, 3).map(pid => ({ pid }))])); ok(!(await has(p, '同台')), '同台: 4 valid but not cg: no'); }
  // 再會: 3 rounds with the same player
  { const p = await mk(p => times(3, () => addDuel(nid(), {}, [{ pid: p }, { pid: others[5] }]))); ok(await has(p, '再會'), '再會: 3 rounds with the same player'); }
  { const p = await mk(p => times(3, k => addDuel(nid(), {}, [{ pid: p }, { pid: others[k] }]))); ok(!(await has(p, '再會')), '再會: 3 rounds with 3 different players: no'); }
  { const p = await mk(p => times(2, () => addDuel(nid(), {}, [{ pid: p }, { pid: others[5] }]))); ok(!(await has(p, '再會')), '再會: only 2 rounds: no'); }
  // 知音 / 最終樂章
  { const p = await mk(p => addDuel(nid(), {}, [{ pid: p, eq: 1 }, { pid: others[0] }])); ok(await has(p, '知音'), '知音'); }
  { const p = await mk(p => addDuel(nid(), {}, [{ pid: p, eq: 0 }, { pid: others[0] }])); ok(!(await has(p, '知音')), '知音: no'); }
  { const p = await mk(p => addDuel(nid(), {}, [{ pid: p, cb: 1 }, { pid: others[0] }, { pid: others[1] }])); ok(await has(p, '最終樂章'), '最終樂章'); }
  { const p = await mk(p => addDuel(nid(), {}, [{ pid: p, cb: 1, cg: 0 }, { pid: others[0] }, { pid: others[1] }])); ok(!(await has(p, '最終樂章')), '最終樂章: not cg: no'); }
  // 八方之冠 / 全場最佳
  { const p = await mk(p => addDuel(nid(), { seats: 8, valid: 8 }, [{ pid: p, cw: 1, s8: 1, place: 1 }, ...others.slice(0, 7).map(pid => ({ pid }))])); ok(await has(p, '八方之冠') && !(await has(p, '全場最佳')), '八方之冠 without a full combo: no 全場最佳'); }
  { const p = await mk(p => addDuel(nid(), { seats: 8, valid: 8 }, [{ pid: p, cw: 1, s8: 1, fc: 1, place: 1 }, ...others.slice(0, 7).map(pid => ({ pid }))])); ok(await has(p, '八方之冠') && await has(p, '全場最佳'), '全場最佳: 8 seats, win, full combo'); }
  { const p = await mk(p => addDuel(nid(), { seats: 8, valid: 8 }, [{ pid: p, cw: 0, s8: 1, fc: 1, place: 2 }, ...others.slice(0, 7).map(pid => ({ pid }))])); ok(!(await has(p, '八方之冠')) && !(await has(p, '全場最佳')), '八方之冠: 8 seats but no win: no'); }
  { const p = await mk(p => addDuel(nid(), { seats: 8, valid: 8 }, [{ pid: p, cw: 1, s8: 0, fc: 1, place: 1 }, ...others.slice(0, 7).map(pid => ({ pid }))])); ok(!(await has(p, '八方之冠')), '八方之冠: win but not s8: no'); }
  // 開張 / 指揮家
  { const p = await mk(p => addDuel(nid(), { kind: 'room', host: p }, [{ pid: p }, { pid: others[0] }])); ok(await has(p, '開張') && !(await has(p, '指揮家')), '開張: host of a private room'); }
  { const p = await mk(p => addDuel(nid(), { kind: 'qm', host: p }, [{ pid: p }, { pid: others[0] }])); ok(!(await has(p, '開張')), '開張: quick match does not count'); }
  { const p = await mk(p => addDuel(nid(), { kind: 'room', host: others[0] }, [{ pid: p }, { pid: others[0] }])); ok(!(await has(p, '開張')), '開張: somebody else was the host'); }
  { const p = await mk(p => addDuel(nid(), { kind: 'room', host: p }, [{ pid: p, cg: 0 }, { pid: others[0] }])); ok(!(await has(p, '開張')), '開張: not cg: no'); }
  { const p = await mk(p => times(30, () => addDuel(nid(), { kind: 'room', host: p }, [{ pid: p }, { pid: others[0] }]))); ok(await has(p, '指揮家'), '指揮家: 30 rounds as the host'); }
  { const p = await mk(p => times(29, () => addDuel(nid(), { kind: 'room', host: p }, [{ pid: p }, { pid: others[0] }]))); ok(!(await has(p, '指揮家')), '指揮家: 29: no'); }
  // 好夥伴 / 合奏團 / 八音和鳴
  { const p = await mk(p => times(20, () => addDuel(nid(), {}, [{ pid: p, fr: 1 }, { pid: others[0] }]))); ok(await has(p, '好夥伴'), '好夥伴: 20 rounds with a friend'); }
  { const p = await mk(p => times(19, () => addDuel(nid(), {}, [{ pid: p, fr: 1 }, { pid: others[0] }]))); ok(!(await has(p, '好夥伴')), '好夥伴: 19: no'); }
  { const p = await mk(p => times(20, () => addDuel(nid(), {}, [{ pid: p, fr: 0 }, { pid: others[0] }]))); ok(!(await has(p, '好夥伴')), '好夥伴: no friends in those rounds: no'); }
  { const p = await mk(p => times(10, () => addDuel(nid(), {}, [{ pid: p, fr: 2 }, ...others.slice(0, 3).map(pid => ({ pid }))]))); ok(await has(p, '合奏團'), '合奏團: 10 rounds of 4+ with 2+ friends'); }
  { const p = await mk(p => times(10, () => addDuel(nid(), {}, [{ pid: p, fr: 1 }, ...others.slice(0, 3).map(pid => ({ pid }))]))); ok(!(await has(p, '合奏團')), '合奏團: only 1 friend: no'); }
  { const p = await mk(p => times(10, () => addDuel(nid(), {}, [{ pid: p, fr: 2 }, ...others.slice(0, 2).map(pid => ({ pid }))]))); ok(!(await has(p, '合奏團')), '合奏團: only 3 valid seats: no'); }
  { const p = await mk(p => times(9, () => addDuel(nid(), {}, [{ pid: p, fr: 2 }, ...others.slice(0, 3).map(pid => ({ pid }))]))); ok(!(await has(p, '合奏團')), '合奏團: 9: no'); }
  { const p = await mk(p => addDuel(nid(), { seats: 8, valid: 8 }, [{ pid: p, f8: 1 }, ...others.slice(0, 7).map(pid => ({ pid }))])); ok(await has(p, '八音和鳴'), '八音和鳴'); }
  { const p = await mk(p => addDuel(nid(), { seats: 8, valid: 8 }, [{ pid: p, f8: 0 }, ...others.slice(0, 7).map(pid => ({ pid }))])); ok(!(await has(p, '八音和鳴')), '八音和鳴: no'); }
  // 引路人: fships.by + fresh, and the other side now has a score
  { const x = await player(), y = await player();
    sql.prepare('INSERT INTO fships (a, b, ts, by, fresh) VALUES (?, ?, 1, ?, 1)').run(Math.min(x.id, y.id), Math.max(x.id, y.id), x.id);
    ok(!(await has(x.id, '引路人')), '引路人: the friend has no score yet: no');
    addScores(y.id, 1); ok(await has(x.id, '引路人'), '引路人: the friend cleared a song');
    ok(!(await has(y.id, '引路人')), '引路人: the other side does not get it'); }
  { const x = await player(), y = await player(); addScores(y.id, 1);
    sql.prepare('INSERT INTO fships (a, b, ts, by, fresh) VALUES (?, ?, 1, ?, 0)').run(Math.min(x.id, y.id), Math.max(x.id, y.id), x.id); ok(!(await has(x.id, '引路人')), '引路人: the friend had scores already (fresh 0): no'); }
  { const x = await player(), y = await player(); addScores(y.id, 1);
    sql.prepare('INSERT INTO fships (a, b, ts, by, fresh) VALUES (?, ?, 1, NULL, NULL)').run(Math.min(x.id, y.id), Math.max(x.id, y.id)); ok(!(await has(x.id, '引路人')) && !(await has(y.id, '引路人')), '引路人: an old friendship (by NULL): neither'); }
  // 邀約 is only recorded: achRecalc's `more`
  { const p = await player(); ok(!(await has(p.id, '邀約')), '邀約: not by itself'); const r = await achRecalc(DB, p.id, Date.now(), null, false, ['邀約']); ok(r.fresh.includes('邀約') && (await has(p.id, '邀約')), '邀約: recorded through achRecalc'); }
  // the list is open now
  ok(DUEL_IDS.length === 21 && DUEL_IDS.every(id => ACHS[id] && ACHS[id].chk === 's'), 'all 21 duel and social achievements are server-decided now');
  ok(Object.values(ACHS).every(a => a.chk !== 'v'), 'no achievement waits for verification any more');
}

// =============================== duelFactsFor + duelWrite against the database ===============================
{
  newDb();
  const [a, b, c] = [await player(), await player(), await player()]; addScores(a.id, 4); addScores(b.id, 2); addScores(c.id, 3);
  const R = round([a.id, b.id, c.id], { host: a.id });
  const recs = [rec(0, { vr: vr({ s: 9000 }) }), rec(1, { vr: vr({ s: 8000 }) }), rec(2, { vr: vr({ s: 7000 }) })], ord = ordering(R, recs, NOW);
  sql.prepare('INSERT INTO fships (a, b, ts) VALUES (?, ?, 1)').run(Math.min(a.id, c.id), Math.max(a.id, c.id));
  const F = await duelFactsFor(DB, R, ord, NOW);
  ok(F.songs.get(a.id) === 4 && F.songs.get(b.id) === 2 && F.pairs.has(pairKey(a.id, c.id)) && !F.pairs.has(pairKey(a.id, b.id)) && F.games.size === 0, 'facts: songs, friend pairs, nothing played today');
  const res = settle(R, ord, F, NOW, 'L'); await duelWrite(DB, res);
  eq(qa('SELECT pid, place, cw, cg, fr FROM duelp ORDER BY place').map(r => [r.pid, r.place, r.cw, r.cg, r.fr]), [[a.id, 1, 1, 1, 1], [b.id, 2, 0, 1, 0], [c.id, 3, 0, 1, 1]], 'write: the duelp rows');
  ok(q1('SELECT * FROM duels').valid === 3 && q1('SELECT log1 FROM duels').log1 === 'L' && q1('SELECT host FROM duels').host === a.id, 'write: the duels row');
  await duelWrite(DB, res); eq(q1('SELECT COUNT(*) AS n FROM duelp').n, 3, 'write: again with the same round id changes nothing (INSERT OR IGNORE)');
  // a second round the same day: today's counts
  const R2 = round([a.id, b.id, c.id]), ord2 = ordering(R2, recs, NOW), F2 = await duelFactsFor(DB, R2, ord2, NOW);
  ok(F2.games.get(a.id) === 1 && F2.wins.get(a.id + ':' + b.id) === 1 && F2.wins.get(a.id + ':' + c.id) === 1 && !F2.wins.has(b.id + ':' + a.id), 'facts: one round today, one win over each opponent');
  // the Taiwan day turns at 16:00 UTC
  const late = Date.UTC(2026, 5, 10, 15, 59, 0), next = Date.UTC(2026, 5, 10, 16, 1, 0);
  const R3 = { ...round([a.id, b.id, c.id]), at: late - 3600e3 }; await duelWrite(DB, settle(R3, ordering(R3, recs, late), F, late, null));
  const F3 = await duelFactsFor(DB, round([a.id, b.id, c.id]), ord, next), F4 = await duelFactsFor(DB, round([a.id, b.id, c.id]), ord, late + 1000);
  ok(!F3.games.has(a.id) && F4.games.get(a.id) === 1, 'facts: a round at 23:59 Taiwan counts for that day, not for the next one one minute later');
  // 30 rounds in a day: the 31st is not cg
  for (let k = 0; k < 29; k++) addDuel(nid(), { ts: NOW, day: dayOf(NOW) }, [{ pid: a.id }, { pid: b.id }]);
  const F5 = await duelFactsFor(DB, R2, ord2, NOW); eq(F5.games.get(a.id), 30, 'facts: 30 counted rounds today');
  eq(row(settle(R2, ord2, F5, NOW, null), a.id).cg, 0, 'settle with those facts: the 31st round is not cg');
  // a voided round no longer counts toward today's totals
  sql.prepare('UPDATE duels SET void = 1').run(); eq((await duelFactsFor(DB, R2, ord2, NOW)).games.size, 0, 'facts: voided rounds are left out');
}

// =============================== admin: duels, duel, duelvoid ===============================
{
  newDb();
  const A = await player(), B = await player(), C = await player(), X = await player();
  for (const p of [B, C, X]) addScores(p.id, 3);
  // A: 1 win in round d1 (首勝, 初次交手); a second round d2 (熱身... only 2 rounds)
  addDuel('v1', { kind: 'room', host: A.id }, [{ pid: A.id, cw: 1, place: 1, q: 120 }, { pid: B.id, place: 2 }]);
  addDuel('v2', {}, [{ pid: A.id, place: 2 }, { pid: C.id, place: 1, cw: 1 }]);
  await achRecalc(DB, A.id, Date.now(), null, true);
  const mine = await ids(A.id); ok(mine.includes('首勝') && mine.includes('初次交手') && mine.includes('開張'), 'void: A has 首勝, 初次交手 and 開張 first');
  // other achievements that must not be touched: a single-run one and a local one
  sql.prepare('INSERT OR IGNORE INTO achs (pid, ach, ts, loc) VALUES (?, ?, 1, 0)').run(A.id, '起步 A'); sql.prepare('INSERT OR IGNORE INTO achs (pid, ach, ts, loc) VALUES (?, ?, 1, 1)').run(A.id, '觀星');
  sql.prepare('INSERT OR IGNORE INTO achs (pid, ach, ts, loc) VALUES (?, ?, 1, 0)').run(A.id, '邀約');
  const ents0 = qa("SELECT item, ref FROM ents WHERE pid = ? AND src = 'ach'", A.id);
  const titleItem = qa("SELECT item FROM ents WHERE pid = ? AND src = 'ach' AND ref = '初次交手'", A.id);
  // wear something the 首勝/開張 give (if any): the first item of a later-revoked achievement
  const rev = qa("SELECT item, ref FROM ents WHERE pid = ? AND src = 'ach' AND ref IN ('首勝', '開張')", A.id)[0];
  if (rev) { const slot = rev.item.split('.')[0]; if (['avatar', 'plate', 'title'].includes(slot)) sql.prepare(`UPDATE players SET ${slot} = ? WHERE id = ?`).run(rev.item, A.id); }
  let r = await lb('/lb/admin', { token: 'wrong', op: 'duelvoid', did: 'v1' }); ok(r.s === 403, 'admin: a wrong token');
  r = await lb('/lb/admin', { token: ADMIN, op: 'duels' }); ok(r.s === 200 && r.j.rows.length === 2 && r.j.rows.find(x => x.id === 'v1').pid === A.id && r.j.rows.find(x => x.id === 'v1').q === 120 && r.j.rows.find(x => x.id === 'v1').name, 'admin duels: lists rounds with the first place');
  r = await lb('/lb/admin', { token: ADMIN, op: 'duel', did: 'v1' }); ok(r.s === 200 && r.j.duel.id === 'v1' && r.j.rows.length === 2 && r.j.rows[0].place === 1, 'admin duel: the round with its rows');
  r = await lb('/lb/admin', { token: ADMIN, op: 'duel', did: 'zzz' }); ok(r.s === 404, 'admin duel: unknown round');
  r = await lb('/lb/admin', { token: ADMIN, op: 'duelvoid', did: 'zzz' }); ok(r.s === 404, 'admin duelvoid: unknown round');
  r = await lb('/lb/admin', { token: ADMIN, op: 'duelvoid', did: 'v1' });
  ok(r.s === 200 && r.j.ok && r.j.players === 2 && r.j.revoked.some(x => x.pid === A.id && x.ach === '首勝') && r.j.revoked.some(x => x.pid === A.id && x.ach === '開張'), 'admin duelvoid: 首勝 and 開張 are taken back');
  const after = await ids(A.id);
  ok(!after.includes('首勝') && !after.includes('開張') && after.includes('初次交手'), 'void: 首勝 and 開張 gone, 初次交手 stays (the other round still counts)');
  ok(after.includes('起步 A') && after.includes('邀約') && q1("SELECT 1 AS x FROM achs WHERE pid = ? AND ach = '觀星' AND loc = 1", A.id), 'void: other achievements (single-run, 邀約, local) are untouched');
  ok(!qa("SELECT 1 FROM ents WHERE pid = ? AND src = 'ach' AND ref IN ('首勝', '開張')", A.id).length, 'void: the items those two gave are gone');
  eq(qa("SELECT item, ref FROM ents WHERE pid = ? AND src = 'ach' AND ref NOT IN ('首勝', '開張')", A.id), ents0.filter(x => !['首勝', '開張'].includes(x.ref)), 'void: the items of the other achievements stay');
  if (rev && ['avatar', 'plate', 'title'].includes(rev.item.split('.')[0])) ok(q1(`SELECT ${rev.item.split('.')[0]} AS w FROM players WHERE id = ?`, A.id).w === '', 'void: a worn item that was taken back is reset to the default');
  ok(q1("SELECT void FROM duels WHERE id = 'v1'").void === 1, 'void: the round is marked');
  // a later recalc does not give them back
  await achRecalc(DB, A.id, Date.now(), null, true); ok(!(await ids(A.id)).includes('首勝'), 'void: a later recalc (even with ensure) does not give 首勝 back');
  // the other player of that round: B had 初次交手 only through v1
  ok(!(await ids(B.id)).includes('初次交手'), 'void: B (only in v1) loses 初次交手 as well');
  r = await lb('/lb/admin', { token: ADMIN, op: 'duelvoid', did: 'v1' }); ok(r.s === 200 && r.j.revoked.length === 0, 'void: doing it twice takes nothing more');
}
{
  // a worn title taken back: 初露鋒芒 gives title.debut (10 wins over 3 qualified opponents)
  newDb();
  const T = await player(), O = [await player(), await player(), await player()];
  for (let k = 0; k < 10; k++) addDuel('t' + k, {}, [{ pid: T.id, cw: 1, place: 1 }, { pid: O[k % 3].id }]);
  await achRecalc(DB, T.id, Date.now(), null, true);
  ok((await ids(T.id)).includes('初露鋒芒') && qa("SELECT 1 FROM ents WHERE pid = ? AND item = 'title.debut' AND src = 'ach' AND ref = '初露鋒芒'", T.id).length === 1, 'void title: 初露鋒芒 earned and its title item is owned');
  sql.prepare("UPDATE players SET title = 'title.debut' WHERE id = ?").run(T.id);
  sql.prepare('INSERT OR IGNORE INTO achs (pid, ach, ts, loc) VALUES (?, ?, 1, 0)').run(T.id, '起步 A'); sql.prepare('INSERT OR IGNORE INTO achs (pid, ach, ts, loc) VALUES (?, ?, 1, 0)').run(T.id, '引路人'); sql.prepare('INSERT OR IGNORE INTO achs (pid, ach, ts, loc) VALUES (?, ?, 1, 0)').run(T.id, '邀約');
  const other0 = qa("SELECT item, ref FROM ents WHERE pid = ? AND src = 'ach' AND ref NOT IN ('初露鋒芒', '熱身賽') ORDER BY item", T.id);
  let r = await lb('/lb/admin', { token: ADMIN, op: 'duelvoid', did: 't0' });
  eq(r.j.revoked.map(x => x.ach).sort(), ['初露鋒芒', '熱身賽'], 'void title: 初露鋒芒 (9 wins left) and 熱身賽 (9 rounds left) are taken back, nothing else');
  ok(!q1("SELECT 1 AS x FROM achs WHERE pid = ? AND ach = '初露鋒芒'", T.id), 'void title: the achs row is deleted');
  ok(!qa("SELECT 1 FROM ents WHERE pid = ? AND item = 'title.debut'", T.id).length, 'void title: the title item is taken back');
  eq(q1('SELECT title FROM players WHERE id = ?', T.id).title, '', 'void title: the worn title goes back to the default');
  const aft = await ids(T.id);
  ok(aft.includes('首勝') && aft.includes('初次交手') && aft.includes('起步 A') && aft.includes('引路人') && aft.includes('邀約'), 'void title: other achievements stay, including 引路人 and 邀約 (never taken back)');
  eq(qa("SELECT item, ref FROM ents WHERE pid = ? AND src = 'ach' AND ref NOT IN ('初露鋒芒', '熱身賽') ORDER BY item", T.id), other0, 'void title: the other rewards stay');
  ok(!DUEL_CALC.includes('引路人') && !DUEL_CALC.includes('邀約') && DUEL_CALC.length === 19, 'DUEL_CALC has 19 ids, without 引路人 and 邀約');
}

// =============================== wipe and missing tables ===============================
{
  newDb();
  const A = await player(), B = await player(); addDuel('w1', {}, [{ pid: A.id, cw: 1, place: 1 }, { pid: B.id }]);
  let r = await lb('/lb/delete', { pk: A.pk }); ok(r.s === 200 && !q1('SELECT 1 FROM duelp WHERE pid = ?', A.id) && q1('SELECT 1 FROM duelp WHERE pid = ?', B.id) && q1('SELECT 1 FROM duels WHERE id = ?', 'w1'), 'wipe: the player\'s duelp rows go, the other player\'s and the duels row stay');
  { const W = await player(), V = await player();
    addDuel('wl1', {}, [{ pid: W.id, cw: 1, place: 1 }, { pid: V.id }]); addDuel('wl2', {}, [{ pid: V.id, cw: 1, place: 1 }, { pid: W.id }]);
    sql.prepare("UPDATE duels SET log1 = 'LOG'").run();
    r = await lb('/lb/delete', { pk: W.pk }); ok(r.s === 200, 'wipe: deleted');
    ok(q1("SELECT log1 FROM duels WHERE id = 'wl1'").log1 === null && q1("SELECT log1 FROM duels WHERE id = 'wl2'").log1 === 'LOG', 'wipe: the log of the round the deleted player won is cleared; the other player log stays'); }
  newDb(['0011']);                                    // a database that has not had migration 0011 yet
  const C = await player();
  r = await achRecalc(DB, C.id, Date.now(), null, false); ok(Array.isArray(r.ids) && !r.ids.includes('初次交手'), 'no duel tables: achRecalc still works (all zeros)');
  r = await lb('/lb/delete', { pk: C.pk }); ok(r.s === 200 && !q1('SELECT 1 FROM players WHERE id = ?', C.id), 'no duel tables: deleting an account still works');
  r = await lb('/lb/admin', { token: ADMIN, op: 'duels' }); ok(r.s === 500 && r.j.error === 'nodb', 'no duel tables: admin duels answers an error, no exception');
  r = await lb('/lb/admin', { token: ADMIN, op: 'duel', did: 'x' }); ok(r.s === 500 && r.j.error === 'nodb', 'no duel tables: admin duel answers an error');
  r = await lb('/lb/admin', { token: ADMIN, op: 'duelvoid', did: 'x' }); ok(r.s === 500 && r.j.error === 'nodb', 'no duel tables: admin duelvoid answers an error');
  r = await achRecalc(DB, C.id, Date.now(), null, true); ok(Array.isArray(r.ids), 'no duel tables: the achievement sync (ensure) still works');
  newDb();
}

// =============================== friends: by and fresh ===============================
{
  const fr = async (path, who, body) => { const r = await handleFr(new Request('http://t' + path, { method: 'POST', body: JSON.stringify({ pk: who.pk, ...body }) }), env, path, '203.0.113.7', null, {}, async () => false, { waitUntil() {} }); return { s: r.status, j: await r.json() }; };
  const code = async P => (await fr('/fr/me', P, {})).j.code;
  const ship = (x, y) => q1('SELECT "by", fresh FROM fships WHERE a = ? AND b = ?', Math.min(x.id, y.id), Math.max(x.id, y.id));
  // path 1: A asks with B's code, B answers /fr/respond
  let A = await player(), B = await player(), r;
  r = await fr('/fr/add', A, { code: await code(B) }); ok(r.j.pending, 'friends: A asks');
  r = await fr('/fr/respond', B, { id: A.id, accept: true }); ok(r.j.ok, 'friends: B accepts');
  eq(ship(A, B), { by: A.id, fresh: 1 }, 'friends /fr/respond: by = the one who asked; fresh = the other side (B) has no score');
  // B had a score
  A = await player(); B = await player(); addScores(B.id, 1);
  await fr('/fr/add', A, { code: await code(B) }); await fr('/fr/respond', B, { id: A.id, accept: true });
  eq(ship(A, B), { by: A.id, fresh: 0 }, 'friends /fr/respond: the other side had a score -> fresh 0');
  // A had a score but B did not: fresh looks at the OTHER side only
  A = await player(); B = await player(); addScores(A.id, 1);
  await fr('/fr/add', A, { code: await code(B) }); await fr('/fr/respond', B, { id: A.id, accept: true });
  eq(ship(A, B), { by: A.id, fresh: 1 }, 'friends: only the side that did not ask is looked at');
  // path 2: both ask: the second one completes it, by = the first
  A = await player(); B = await player();
  await fr('/fr/add', A, { code: await code(B) }); r = await fr('/fr/add', B, { code: await code(A) }); ok(r.j.friends, 'friends: B asks back and they are friends');
  eq(ship(A, B), { by: A.id, fresh: 1 }, 'friends (both asked): by = the first one to ask; fresh looks at the one who answered (no score)');
  // a database without migration 0011 (no by / fresh columns): friendships still work, the old way
  newDb(['0011']); A = await player(); B = await player();
  await fr('/fr/add', A, { code: await code(B) }); r = await fr('/fr/respond', B, { id: A.id, accept: true }); ok(r.j.ok, 'no 0011: /fr/respond still makes the friendship');
  ok(!!q1('SELECT 1 FROM fships WHERE a = ? AND b = ?', Math.min(A.id, B.id), Math.max(A.id, B.id)) && !q1('SELECT 1 FROM freqs WHERE frm = ? OR "to" = ?', A.id, A.id), 'no 0011: the fships row exists, the request is gone');
  A = await player(); B = await player();
  await fr('/fr/add', A, { code: await code(B) }); r = await fr('/fr/add', B, { code: await code(A) }); ok(r.j.friends, 'no 0011: asking back still makes the friendship');
  newDb();
}

// =============================== Arena, driven directly ===============================
let T = Date.now(); const realNow = Date.now; Date.now = () => T;
const sha = async s => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2, '0')).join('');
class FakeStorage {
  constructor() { this.m = new Map(); this.alarm = null; }
  async get(k) { return this.m.get(k); }
  async put(k, v) { if (typeof k === 'string') this.m.set(k, structuredClone(v)); else for (const [a, b] of Object.entries(k)) this.m.set(a, structuredClone(b)); }
  async delete(k) { for (const x of Array.isArray(k) ? k : [k]) this.m.delete(x); }
  async setAlarm(t) { this.alarm = t; } async getAlarm() { return this.alarm; }
}
class FakeWs { constructor() { this.readyState = 1; this.att = null; this.out = []; this.closed = null; }
  serializeAttachment(a) { this.att = structuredClone(a); } deserializeAttachment() { return this.att; }
  send(m) { this.out.push(JSON.parse(m)); } close(c, w) { this.readyState = 3; this.closed = [c, w]; }
  last(t) { return this.out.filter(m => m.t === t).pop(); } count(t) { return this.out.filter(m => m.t === t).length; } }
async function room(opts = {}) {
  const socks = []; const ctx = { id: { name: 'TEST' }, storage: new FakeStorage(), getWebSockets: () => socks, acceptWebSocket: w => socks.push(w) };
  const lobbyStub = { get: () => ({ fetch: async () => Response.json({ ok: true }) }), idFromName: () => 'l' };
  const E = { ...env, LOBBY: lobbyStub, ...(opts.env || {}) };
  const arena = new Arena(ctx, E);
  await ctx.storage.put({ cfg: { song: S, di: D0, pub: false, max: 8, vote: false, qm: !!opts.qm }, phase: 'lobby', resv: T, gone: [] });
  return { arena, ctx, socks, E };
}
let seatN = 0;
async function sit(R, P) {   // a seat joins (like fetch does) and signs in
  const w = new FakeWs(), used = R.socks.map(x => x.att.i); let i = 0; while (used.includes(i)) i++;
  R.ctx.acceptWebSocket(w); w.serializeAttachment({ i, name: '玩家' + (i + 1), ready: false, back: true, vote: null, fin: null, st: null, seen: T });
  if (P) { await R.arena.webSocketMessage(w, JSON.stringify({ t: 'auth', pk: P.pk })); }
  return w;
}
const msg = (R, w, o) => R.arena.webSocketMessage(w, typeof o === 'string' ? o : JSON.stringify(o));
const lgMsg = (log, extra = {}) => JSON.stringify({ t: 'lg', log, star: [], seq: log.map((_, i) => i), ...extra });
async function start(R, ws) { for (const w of ws) await msg(R, w, { t: 'ready', v: true }); }
const play = async (R, w, log, ok = true) => { await msg(R, w, lgMsg(log)); await msg(R, w, { t: 'fin', s: 1, ok, acc: 1, rank: 'SSS', mc: 1 }); };
{
  newDb();
  const [A, B, C] = [await player(), await player(), await player()]; for (const p of [A, B, C]) addScores(p.id, 3);
  // ---- a normal 3-seat round: everybody sends a log and fin
  let R = await room(); const wa = await sit(R, A), wb = await sit(R, B), wc = await sit(R, C);
  ok(wa.att.pid === A.id && wb.att.pid === B.id, 'arena: auth sets the pid');
  await start(R, [wa, wb, wc]);
  const rd = await R.ctx.storage.get('round');
  ok(rd && rd.id.length === 32 && rd.kind === 'room' && rd.host === A.id && rd.seats.length === 3 && rd.seats.every(s => s.pid) && rd.song === S && rd.di === D0, 'arena: startRound stores the snapshot');
  ok((await R.ctx.storage.get('phase')) === 'play' && wa.att.vr === null, 'arena: playing');
  // an early lg from a seat before anything: stored; the second one is ignored
  const goodA = plain(), goodB = at(plain(), 5, null), goodC = plain(30);
  await msg(R, wa, lgMsg(goodA));
  ok(wa.att.vr && wa.att.vr.s > 0 && wa.att.vr.ok === 1 && wa.att.lg === 1, 'arena lg: a good log gives the seat a vr');
  ok((await R.ctx.storage.get('lg:0')) === lgMsg(goodA), 'arena lg: the raw log is in storage, not in the attachment');
  ok(JSON.stringify(wa.att).length < 1500, 'arena lg: the attachment stays small (' + JSON.stringify(wa.att).length + ' bytes)');
  const vr0 = JSON.stringify(wa.att.vr); await msg(R, wa, lgMsg(at(plain(), 0, [0, 310])));
  ok(JSON.stringify(wa.att.vr) === vr0, 'arena lg: a second log from the same seat is ignored');
  await msg(R, wa, { t: 'fin', s: 5, ok: true, acc: 1, rank: 'SSS', mc: 1 });
  await play(R, wb, goodB); T += 60e3; await play(R, wc, goodC, false);
  const res = wa.last('res');
  ok(res && res.r.length === 3 && res.r.every(x => x.v === 1) && res.r[0].i === 0 && res.r[0].ok === true && res.r[0].acc === 1 && res.r[0].rank === 'SSS', 'arena res: rows carry v, values from the logs (not the fin: s was 1/5)');
  ok(res.r[0].s > 1000 && res.r.find(x => x.i === 2).ok === false && res.r.find(x => x.i === 2).rank === '—', 'arena res: the score is the recomputed one; the seat that did not finish has no rank');
  eq((await R.ctx.storage.get('pend')) || [], [], 'arena: the result was written, pend is empty');
  eq(qa('SELECT pid, place, cg, cw FROM duelp ORDER BY place').map(r => [r.pid, r.place, r.cg, r.cw]), [[A.id, 1, 1, 1], [B.id, 2, 1, 0], [C.id, 3, 1, 0]], 'arena: duelp rows written');
  ok(q1('SELECT kind, host, seats, valid, log1 FROM duels').host === A.id && q1('SELECT log1 FROM duels').log1 === lgMsg(goodA), 'arena: the duels row, with the winner\'s log');
  ok(wa.count('ach') === 1 && wb.count('ach') === 1 && wc.count('ach') === 1, 'arena: every valid seat is told {t:"ach"}');
  ok(!R.ctx.storage.m.has('lg:0') && (await R.ctx.storage.get('round')) === null && wa.att.vr === null && wa.att.lg === 0, 'arena: raw logs, snapshot and per-seat state are cleared after the round');
  ok((await ids(A.id)).includes('首勝') && (await ids(C.id)).includes('初次交手') && !(await ids(C.id)).includes('首勝'), 'arena -> achRecalc: the winner has 首勝, everybody 初次交手');
  ok((await ids(A.id)).includes('開張'), 'arena -> achRecalc: the host of a private room has 開張');

  // ---- lg handling
  R = await room(); const x1 = await sit(R, A), x2 = await sit(R, B), x3 = await sit(R, null);
  await msg(R, x1, lgMsg(plain()));
  ok(x1.att.vr === undefined || x1.att.vr === null, 'arena lg: in the lobby (no round) it is dropped');
  await start(R, [x1, x2, x3]); const rd0 = x1.last('start');
  await msg(R, x3, lgMsg(plain())); ok(!x3.att.vr && !x3.att.lg, 'arena lg: a seat that is not signed in: dropped');
  await msg(R, x1, lgMsg(at(plain(), 0, [0, 5000]))); ok(!x1.att.vr && x1.att.lg === 1, 'arena lg: a log that fails duelJudge: no vr, and that was its only try');
  await msg(R, x1, lgMsg(plain())); ok(!x1.att.vr, 'arena lg: ...a later good one is not taken either');
  await msg(R, x2, '{"t":"lg","log":'); ok(!x2.att.vr && x2.closed === null, 'arena lg: broken JSON: no vr, no kick');
  const huge = '{"t":"lg","log":[' + '[0,300],'.repeat(3000) + '[0,300]]}'; ok(huge.length > 16384, 'test: the huge message is over 16 KB');
  await msg(R, x2, huge); ok(x2.closed && x2.closed[1] === 'bad message', 'arena lg: over 16 KB: bad message (dropped)');
  // the token bucket comes before every other check: a seat that already sent its log, or is not signed in, cannot flood lg
  { const fl = x => { let n = 0; return (async () => { for (; n < 200 && !x.closed; n++) await msg(R, x, lgMsg(plain())); return n; })(); };
    const n1 = await fl(x1); ok(x1.closed && x1.closed[1] === 'flood' && n1 > 30 && n1 < 150, 'arena lg flood: a seat that already sent its log is limited, then kicked (after ' + n1 + ' messages)');
    const n3 = await fl(x3); ok(x3.closed && x3.closed[1] === 'flood' && n3 > 30 && n3 < 150, 'arena lg flood: a seat that is not signed in is limited, then kicked (after ' + n3 + ' messages)'); }
  ok(rd0 && rd0.lg === 1, 'arena start: the start message says lg:1 (a client sends a log only then)');
  R = await room(); const y1 = await sit(R, A), y2 = await sit(R, B); await start(R, [y1, y2]);
  await msg(R, y1, JSON.stringify({ t: 'lg', log: plain(), seq: 'x' })); ok(!y1.att.vr, 'arena lg: a bad seq: no vr');
  // a seat that signs in after the start
  R = await room(); const z1 = await sit(R, A), z2 = await sit(R, null); await start(R, [z1, z2]);
  await msg(R, z2, { t: 'auth', pk: B.pk }); await msg(R, z2, lgMsg(plain())); ok(z2.att.pid === B.id && !z2.att.vr, 'arena lg: signed in after the start: the snapshot says no pid -> dropped');
  // the same account in two seats
  R = await room(); const d1 = await sit(R, A), d2 = await sit(R, A), d3 = await sit(R, B); await start(R, [d1, d2, d3]);
  const rd2 = await R.ctx.storage.get('round'); ok(rd2.seats.filter(s => s.dup).length === 2 && rd2.seats.filter(s => s.pid).length === 1, 'arena: one account in two seats: both marked dup, no pid');
  const nDuels = qa('SELECT 1 FROM duels').length; await play(R, d1, plain()); await play(R, d2, plain()); await play(R, d3, plain());
  ok(qa('SELECT 1 FROM duels').length === nDuels, 'arena: only 1 valid seat: nothing written');
  ok(d3.last('res').r.every(x => x.v === 0), 'arena: ...and every row says v 0');

  // ---- a seat that leaves in the middle (closes the tab) with 30 %, the other one finishes
  R = await room(); const m1 = await sit(R, A), m2 = await sit(R, B); await start(R, [m1, m2]);
  await msg(R, m2, { t: 'st', s: 500, c: 5, l: 100, r: Math.ceil(N * .3), j: 0 });
  await msg(R, m1, lgMsg(plain())); T += 60e3;
  await R.arena.webSocketClose(m2);
  ok(m1.count('res') === 0, 'arena: the leaver does not end the round while the other one has not finished');
  await msg(R, m1, { t: 'fin', s: 5, ok: true, acc: 1, rank: 'SSS', mc: 1 });
  const r2 = m1.last('res'); ok(r2 && r2.r.length === 2 && r2.r[0].i === 0 && r2.r[1].i === 1 && r2.r.every(x => x.v === 1), 'arena: a leaver with 30 % counts as a valid loser');
  ok(qa('SELECT pid FROM duelp').some(r => r.pid === B.id) && q1('SELECT cg, cw, place FROM duelp WHERE pid = ? ORDER BY rowid DESC', A.id).cg === 1 && q1('SELECT cw, place FROM duelp WHERE pid = ? ORDER BY rowid DESC', A.id).cw === 1 && q1('SELECT ok, cg, place FROM duelp WHERE pid = ? ORDER BY rowid DESC', B.id).ok === 0 && q1('SELECT cg FROM duelp WHERE pid = ? ORDER BY rowid DESC', B.id).cg === 1, 'arena: ...B is written as a loser (ok 0, counts as a played round); A gets the win (the leaver left after 30 % with a score above 0: a qualified opponent)');
  // a leaver with 30 % but a last score of 0: the winner counts the round but not a win
  R = await room(); const q1w = await sit(R, A), q2w = await sit(R, B); await start(R, [q1w, q2w]);
  await msg(R, q2w, { t: 'st', s: 0, c: 0, l: 100, r: Math.ceil(N * .3), j: 0 }); await msg(R, q1w, lgMsg(plain())); T += 60e3; await R.arena.webSocketClose(q2w);
  await msg(R, q1w, { t: 'fin', s: 5, ok: true, acc: 1, rank: 'SSS', mc: 1 });
  { const x = q1('SELECT cg, cw FROM duelp WHERE pid = ? ORDER BY rowid DESC', A.id); eq([x.cg, x.cw], [1, 0], 'arena: the leaver had a score of 0: the winner gets the round (cg 1) but no win (cw 0)'); }
  // a leaver under 30 %
  R = await room(); const n1 = await sit(R, A), n2 = await sit(R, B); await start(R, [n1, n2]);
  await msg(R, n2, { t: 'st', s: 5, c: 1, l: 100, r: 3, j: 0 }); await msg(R, n1, lgMsg(plain())); T += 60e3; await R.arena.webSocketClose(n2);
  await msg(R, n1, { t: 'fin', s: 5, ok: true, acc: 1, rank: 'SSS', mc: 1 });
  ok(n1.last('res').r.every(x => x.v === 0), 'arena: a leaver under 30 %: the round does not count (1 valid seat)');
  // a legacy phone (no lg, only fin)
  R = await room(); const l1 = await sit(R, A), l2 = await sit(R, B), l3 = await sit(R, C); await start(R, [l1, l2, l3]); T += 60e3;
  await play(R, l1, plain()); await play(R, l2, plain()); await msg(R, l3, { t: 'fin', s: 999999, ok: true, acc: 1, rank: 'SSS', mc: 999 });
  const r3 = l1.last('res'); ok(r3.r.find(x => x.i === 2).v === 0 && r3.r.find(x => x.i === 2).s === 999999 && r3.r.filter(x => x.v === 1).length === 2, 'arena: a legacy phone: shown as it reported, v 0; the two others count');
  // round too short
  R = await room(); const s1 = await sit(R, A), s2 = await sit(R, B); await start(R, [s1, s2]); T = (await R.ctx.storage.get('round')).at + 1000;
  await play(R, s1, plain()); await play(R, s2, plain()); ok(s1.last('res').r.every(x => x.v === 0), 'arena: a round shorter than the song: nothing counts'); T += 3600e3;

  // ---- a failed D1 write: kept in pend, retried by the alarm; 5 retries, then dropped
  R = await room(); const f1 = await sit(R, A), f2 = await sit(R, B); await start(R, [f1, f2]);
  const goodBatch = DB.batch; let failing = true; DB.batch = async l => { if (failing && l.some(s => s.q.includes('INSERT OR IGNORE INTO duels'))) throw new Error('D1 down'); return goodBatch.call(DB, l); };
  const before = qa('SELECT 1 FROM duels').length;
  await play(R, f1, plain()); T += 60e3; await play(R, f2, plain());
  ok(f1.last('res') && qa('SELECT 1 FROM duels').length === before, 'arena pend: the result screen came out although D1 failed; nothing written');
  let pend = await R.ctx.storage.get('pend'); ok(pend.length === 1 && pend[0].tries === 1 && f1.count('ach') === 0, 'arena pend: kept, 1 failed try, nobody told yet');
  ok(R.ctx.storage.alarm !== null, 'arena pend: an alarm is set');
  failing = false; T += 6000; await R.arena.alarm();
  ok(((await R.ctx.storage.get('pend')) || []).length === 0 && qa('SELECT 1 FROM duels').length === before + 1 && f1.count('ach') === 1, 'arena pend: the alarm writes it and tells the seats');
  failing = true; R = await room(); const g1 = await sit(R, A), g2 = await sit(R, B); await start(R, [g1, g2]); await play(R, g1, plain()); T += 60e3; await play(R, g2, plain());
  for (let k = 0; k < 4; k++) { T += 6000; await R.arena.alarm(); }
  pend = await R.ctx.storage.get('pend'); ok(pend.length === 1 && pend[0].tries === 5, 'arena pend: the first try and 4 retries failed, still kept (tries = ' + (pend[0] && pend[0].tries) + ')');
  T += 6000; await R.arena.alarm(); ok(((await R.ctx.storage.get('pend')) || []).length === 0, 'arena pend: dropped when the 5th retry fails');
  failing = false; DB.batch = goodBatch;
  // the room empties while something is pending: the alarm still runs
  R = await room(); const h1 = await sit(R, A), h2 = await sit(R, B); await start(R, [h1, h2]);
  DB.batch = async l => { if (l.some(s => s.q.includes('INSERT OR IGNORE INTO duels'))) throw new Error('D1 down'); return goodBatch.call(DB, l); };
  await play(R, h1, plain()); T += 60e3; await play(R, h2, plain()); DB.batch = goodBatch;
  await R.arena.webSocketClose(h1); await R.arena.webSocketClose(h2);
  ok((await R.ctx.storage.get('pend')).length === 1 && R.ctx.storage.alarm !== null, 'arena pend: both left, the result is still pending and an alarm is set');
  T += 6000; await R.arena.alarm(); ok(((await R.ctx.storage.get('pend')) || []).length === 0, 'arena pend: written even with nobody in the room');

  // everybody leaves in the middle of a round: the raw logs go
  R = await room(); const e1 = await sit(R, A), e2 = await sit(R, B); await start(R, [e1, e2]); await msg(R, e1, lgMsg(plain()));
  ok(typeof (await R.ctx.storage.get('lg:0')) === 'string', 'arena cleanup: the raw log is in storage during the round');
  await R.arena.webSocketClose(e1); await R.arena.webSocketClose(e2);
  ok((await R.ctx.storage.get('lg:0')) === undefined && (await R.ctx.storage.get('phase')) === 'lobby', 'arena cleanup: everybody left mid-round: lg:* deleted');
  // expired invites are swept by the alarm
  R = await room(); const iv1 = await sit(R, A); await R.arena.fetch(new Request('https://arena/inv', { method: 'POST', body: JSON.stringify({ from: A.id, to: B.id }) }));
  ok((await R.ctx.storage.get('invs')).length === 1, 'arena sweep: an invite is stored'); T += 61e3; iv1.att.seen = T; iv1.serializeAttachment(iv1.att); await R.arena.alarm();
  ok((await R.ctx.storage.get('invs')).length === 0, 'arena sweep: the alarm drops the expired invite');

  // ---- 邀約: /inv, then the invited seat signs in
  newDb(); const [I, J] = [await player(), await player()];
  R = await room(); const i1 = await sit(R, I);
  let rr = await R.arena.fetch(new Request('https://arena/inv', { method: 'POST', body: JSON.stringify({ from: I.id, to: J.id }) })); ok((await rr.json()).ok, 'arena /inv: accepted');
  rr = await R.arena.fetch(new Request('https://arena/inv', { method: 'POST', body: JSON.stringify({ from: 'x', to: 2 }) })); ok(!(await rr.json()).ok, 'arena /inv: bad body');
  ok((await R.ctx.storage.get('invs')).length === 1, 'arena /inv: stored');
  const j1 = await sit(R, J);
  ok(i1.count('ach') === 1 && (await ids(I.id)).includes('邀約') && (await R.ctx.storage.get('invs')).length === 0, 'arena: the invited friend signs in while the inviter is here: 邀約, the invite is used up');
  ok(j1.count('ach') === 0 && !(await ids(J.id)).includes('邀約'), 'arena: ...the invited one gets nothing');
  // expired; inviter not present; someone else signs in; 20 cap
  R = await room(); await sit(R, I); await R.arena.fetch(new Request('https://arena/inv', { method: 'POST', body: JSON.stringify({ from: I.id, to: J.id }) }));
  T += 61e3; sql.prepare("DELETE FROM achs WHERE pid = ? AND ach = '邀約'").run(I.id); await sit(R, J); ok(!(await ids(I.id)).includes('邀約'), 'arena /inv: an expired invite gives nothing');
  R = await room(); await R.arena.fetch(new Request('https://arena/inv', { method: 'POST', body: JSON.stringify({ from: I.id, to: J.id }) })); await sit(R, J); ok(!(await ids(I.id)).includes('邀約'), 'arena /inv: the inviter is not in the room: nothing');
  R = await room(); const K = await player(); await sit(R, I); await R.arena.fetch(new Request('https://arena/inv', { method: 'POST', body: JSON.stringify({ from: I.id, to: J.id }) })); await sit(R, K); ok(!(await ids(I.id)).includes('邀約'), 'arena /inv: another player signing in does not use it');
  R = await room(); await sit(R, I); for (let k = 0; k < 30; k++) await R.arena.fetch(new Request('https://arena/inv', { method: 'POST', body: JSON.stringify({ from: 1000 + k, to: 2000 + k }) })); eq((await R.ctx.storage.get('invs')).length, 20, 'arena /inv: at most 20 kept');
  rr = await (await room({})).arena.fetch(new Request('https://arena/inv', { method: 'POST', body: JSON.stringify({ from: 1, to: 2 }) })); ok(!(await rr.json()).ok, 'arena /inv: an existing room with nobody connected: refused');
  { const E0 = await room({}); await E0.arena.fetch(new Request('https://arena/inv', { method: 'POST', body: JSON.stringify({ from: 1, to: 2 }) })); ok((await E0.ctx.storage.get('invs')) === undefined && E0.ctx.storage.alarm === null, 'arena /inv: no connected seat: nothing stored, no alarm'); }
  const empty = { arena: new Arena({ id: { name: 'E' }, storage: new FakeStorage(), getWebSockets: () => [] }, env) }; rr = await empty.arena.fetch(new Request('https://arena/inv', { method: 'POST', body: JSON.stringify({ from: 1, to: 2 }) })); ok(!(await rr.json()).ok, 'arena /inv: a room that does not exist: nothing stored');
}
// ---- a database without migration 0011: the round is played and settled, nothing is written, the pending entry is dropped after the retries
{
  newDb(['0011']); const [A, B] = [await player(), await player()]; for (const p of [A, B]) addScores(p.id, 3);
  const R = await room(); const a1 = await sit(R, A), b1 = await sit(R, B); await start(R, [a1, b1]);
  await play(R, a1, plain()); T += 60e3; await play(R, b1, plain());
  ok(a1.last('res') && a1.last('res').r.length === 2 && a1.last('res').r.every(x => x.v === 1 || x.v === 0), 'no 0011 arena: the result screen still comes out (res.v is ' + JSON.stringify(a1.last('res').r.map(x => x.v)) + ')');
  ok(a1.count('ach') === 0, 'no 0011 arena: nobody is told about achievements');
  let pend = await R.ctx.storage.get('pend'); ok(pend && pend.length === 1 && pend[0].tries === 1, 'no 0011 arena: kept in pend for a retry');
  for (let k = 0; k < 4; k++) { T += 6000; await R.arena.alarm(); }
  T += 6000; await R.arena.alarm(); ok(((await R.ctx.storage.get('pend')) || []).length === 0, 'no 0011 arena: dropped after the 5th retry');
  ok((await R.ctx.storage.get('phase')) === 'lobby', 'no 0011 arena: the room is back in the lobby');
  newDb();
}
Date.now = realNow;

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
