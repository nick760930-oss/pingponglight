// Run tickets, /lb/end, star-time ranges, life replay and the achievements that depend on them (no server needed): node test/runs.mjs
// handleLb runs in this process against an in-memory SQLite (node:sqlite) wrapped like D1; every migration is applied to it.
// Tickets are signed here with the test secret and back-dated (the server only takes a result once the song could have been played).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { handleLb, judge, failCheck, parseStar } from '../src/lb.js';
import { CHARTS, CONS } from '../src/charts.js';
import { logFeats, NEW_SONGS, NA, ACHS, SERVER_IDS } from '../src/ach.js';
import { handleShop } from '../src/shop.js';

const SRV = join(dirname(fileURLToPath(import.meta.url)), '..'), SECRET = 'runs-test-secret';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };

// ---- a D1-like wrapper over node:sqlite ----
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
const seen = [];
const env = { LB: DB, LB_SECRET: SECRET };
async function post(path, body) {
  const r = await handleLb(new Request('http://t' + path, { method: 'POST', body: JSON.stringify(body) }), env, path, '203.0.113.7', null, {}, async (e, k) => { seen.push(k); return false; });
  return { s: r.status, j: await r.json() };
}
const q1 = (s, ...a) => sql.prepare(s).get(...a), qa = (s, ...a) => sql.prepare(s).all(...a);

// ---- helpers ----
const b64u = b => b.toString('base64url');
const sign = p => p + '.' + b64u(crypto.createHmac('sha256', SECRET).update(p).digest());
function legacy(song, d, ageMs) { return sign([song, d, Date.now() - ageMs, crypto.randomBytes(8).toString('hex')].join('.')); }
function ticket(pid, song, d, ageMs = 600e3, rec = true) {       // what /lb/start would have issued (and written), back-dated
  const nonce = crypto.randomBytes(8).toString('hex'), ts = Date.now() - ageMs;
  if (rec) sql.prepare('INSERT INTO runs (nonce, pid, song, d, ts, done) VALUES (?, ?, ?, ?, ?, 0)').run(nonce, pid, song, d, ts);
  return sign([song, d, ts, nonce, pid].join('.'));
}
let pn = 0;
async function player() { const pk = crypto.randomBytes(16).toString('hex'), r = await post('/lb/name', { pk, name: 'R' + (++pn) + crypto.randomBytes(3).toString('hex') }); return { pk, id: r.j.id }; }
const songs = Object.keys(CHARTS), N = (s, d) => CHARTS[s].n[d];
const big = songs.slice().sort((a, b) => N(b, 0) - N(a, 0))[0];
const perfect = (s, d) => Array.from({ length: N(s, d) }, () => [0, 300]);
const withAt = (log, i, x) => { const l = log.slice(); l[i] = x; return l; };
const sub = (P, s, d, log, star, age) => post('/lb/submit', { run: ticket(P.id, s, d, age), pk: P.pk, log, ...(star ? { star } : {}) });
const end = (P, s, d, kind, log, star, age = kind === 'quit' ? 900e3 : 70e3, seq) => post('/lb/end', { run: ticket(P.id, s, d, age), pk: P.pk, kind, ...(log ? { log } : {}), ...(star ? { star } : {}), ...(seq ? { seq } : {}) });
const sync = async P => { const r = await handleShop(new Request('http://t/ach/sync', { method: 'POST', body: JSON.stringify({ pk: P.pk }) }), env, '/ach/sync', '203.0.113.9', {}, async () => false); return { s: r.status, j: await r.json() }; };
const itemCap = (s, d) => Math.max(1, 2 + Math.floor((CHARTS[s].dur / CHARTS[s].spd[d] + 3.8 - 9) / 8));
const got = (r, id) => !!(r.j.ach && r.j.ach.includes(id));
const S = songs[0], D2 = 2;   // difficulty 2 costs 5 life per miss, 3 costs 1, 0 costs 2

// ---- /lb/start ----
{
  const P = await player(), U = crypto.randomBytes(16).toString('hex');
  let r = await post('/lb/start', { song: S, d: 1, pk: P.pk }), p = r.j.run.split('.');
  ok(r.s === 200 && p.length === 6 && +p[4] === P.id && p[0] === S && +p[1] === 1, 'start: registered key gets a 6-part ticket naming the player');
  const row = q1('SELECT * FROM runs WHERE nonce = ?', p[3]);
  ok(row && row.pid === P.id && row.done === 0 && row.song === S && row.d === 1, 'start: a runs row (done = 0) is written');
  r = await post('/lb/start', { song: S, d: 1 }); ok(r.j.run.split('.').length === 5, 'start: no key -> legacy 5-part ticket');
  r = await post('/lb/start', { song: S, d: 1, pk: U }); ok(r.j.run.split('.').length === 5, 'start: unregistered key -> legacy ticket');
  r = await post('/lb/start', { song: 'nope', d: 1, pk: P.pk }); ok(r.s === 400, 'start: bad song');
  sql.prepare('INSERT INTO runs (nonce, pid, song, d, ts, done) VALUES (?, 9, ?, 0, ?, 1)').run('old0000000000001', S, Date.now() - 4 * 3600e3);
  await post('/lb/start', { song: S, d: 0, pk: P.pk }); ok(!q1('SELECT 1 FROM runs WHERE nonce = ?', 'old0000000000001'), 'start: rows older than 3 hours are deleted');
  seen.length = 0; await post('/lb/start', { song: S, d: 0, pk: P.pk }); ok(seen[0].startsWith('lbr:'), 'start uses the lbr: limit');
}

// ---- single use, pid, legacy ----
{
  const A = await player(), B = await player(), log = perfect(S, 1), s1 = ticket(A.id, S, 1);
  let r = await post('/lb/submit', { run: s1, pk: A.pk, log }); ok(r.j.ok && r.j.ach.includes('新星'), 'submit: a new ticket works');
  ok(q1('SELECT done FROM runs WHERE nonce = ?', s1.split('.')[3]).done === 1, 'submit: the runs row is used up');
  r = await post('/lb/submit', { run: s1, pk: A.pk, log }); ok(r.s === 400 && r.j.error === 'ticket', 'the same ticket twice: refused');
  r = await post('/lb/end', { run: s1, pk: A.pk, kind: 'quit' }); ok(r.s === 400 && r.j.error === 'ticket', 'a submitted ticket cannot be ended either');
  const s2 = ticket(A.id, S, 1);
  r = await post('/lb/submit', { run: s2, pk: B.pk, log }); ok(r.s === 400 && r.j.error === 'ticket', "another player's key with my ticket: refused");
  r = await post('/lb/submit', { run: s2, pk: A.pk, log }); ok(r.j.ok, 'a refused try did not use the ticket up');
  r = await post('/lb/submit', { run: ticket(A.id, S, 1, 600e3, false), pk: A.pk, log }); ok(r.s === 400 && r.j.error === 'ticket', 'a signed ticket the server never recorded: refused');
  const forged = ticket(A.id, S, 1).split('.'); forged[4] = String(B.id);
  r = await post('/lb/submit', { run: forged.join('.'), pk: B.pk, log }); ok(r.s === 400 && r.j.error === 'ticket', 'changing the pid breaks the signature');
  const sig5 = ticket(A.id, S, 1).split('.'); sig5.splice(4, 1);
  r = await post('/lb/submit', { run: sig5.join('.'), pk: A.pk, log }); ok(r.s === 400 && r.j.error === 'ticket', 'dropping the pid from a new ticket: refused');
  r = await post('/lb/submit', { run: ticket(A.id, S, 1, 1e3), pk: A.pk, log }); ok(r.s === 400 && r.j.error === 'ticket', 'submit: too early for the song length');
  const n0 = q1('SELECT n FROM scores WHERE pid = ?', A.id).n, h0 = q1('SELECT hits FROM pstats WHERE pid = ?', A.id).hits;
  // legacy: only the best score
  const C = await player();
  await post('/lb/submit', { run: ticket(C.id, S, 1), pk: C.pk, log: Array.from({ length: N(S, 1) }, () => [60, 200]) });
  const c0 = q1('SELECT n, acc FROM scores WHERE pid = ?', C.id), ch0 = q1('SELECT hits FROM pstats WHERE pid = ?', C.id).hits;
  r = await post('/lb/submit', { run: legacy(S, 1, 600e3), pk: C.pk, log });
  const c1 = q1('SELECT n, acc FROM scores WHERE pid = ?', C.id);
  ok(r.j.ok && r.j.improved && c1.acc > c0.acc, 'legacy ticket: the best score is updated');
  ok(c1.n === c0.n && q1('SELECT hits FROM pstats WHERE pid = ?', C.id).hits === ch0, 'legacy ticket: no run count, no totals');
  ok(Array.isArray(r.j.ach) && r.j.ach.length === 0, 'legacy ticket: no achievements');
  const E = await player(); r = await post('/lb/submit', { run: legacy(S, 2, 600e3), pk: E.pk, log: perfect(S, 2) });
  ok(r.j.ok && r.j.ach.length === 0 && q1('SELECT n FROM scores WHERE pid = ?', E.id).n === 0 && !q1('SELECT 1 FROM pstats WHERE pid = ?', E.id), 'legacy ticket on a new board: row with n = 0, nothing else');
  ok(!q1('SELECT 1 FROM tries WHERE pid = ?', C.id) || q1('SELECT ends FROM tries WHERE pid = ? AND d = 1', C.id).ends === 1, 'legacy ticket does not touch tries');
  // a new-ticket run counts n and tries
  ok(n0 === 2 && h0 === 2 * N(S, 1) && q1('SELECT ends FROM tries WHERE pid = ?', A.id).ends === 2, 'new tickets: n, totals and tries.ends count every accepted run');
}

// ---- 0 = shield-held miss; old clients send only null ----
{
  const log = withAt(withAt(perfect(S, 1), 3, null), 4, 0), n = N(S, 1);
  const r = judge(S, 1, log), F = logFeats(log, n);
  ok(r && r.miss === 2 && r.tiers[0] === n - 2 && r.maxCombo === n - 5, 'judge: 0 counts as a miss and breaks the combo (' + (r && r.miss) + ')');
  ok(F.miss === 2 && F.hits === n - 2 && F.maxCombo === n - 5 && F.fc === 0, 'logFeats: 0 counts as a miss too');
  ok(logFeats(withAt(perfect(S, 1), 0, 0), n).fm === 1 && logFeats(withAt(perfect(S, 1), 0, null), n).fm === 1, 'logFeats: a first beat missed under the shield is still 出師不利');
  const rn = judge(S, 1, withAt(withAt(perfect(S, 1), 3, null), 4, null));
  ok(rn.miss === r.miss && rn.acc === r.acc && rn.rank === r.rank, 'old clients (null only) judge the same');
  ok(judge(S, 1, withAt(perfect(S, 1), 0, 1)) === null && judge(S, 1, withAt(perfect(S, 1), 0, [1])) === null, 'judge: other junk entries refused');
}

// ---- life replay and /lb/end ----
{
  const P = await player(), M = null, H = [0, 300];
  const dead6 = [M, M, M, M, M, M];                                   // difficulty 2: 30 -> 25 -> 20 -> 15 -> 10 -> 5 -> 0
  const M5 = [M, M, M, M, M];                                          // 5 life left
  let r = await end(P, S, D2, 'fail', dead6); ok(r.j.ok && Array.isArray(r.j.ach), 'fail: a possible fall is accepted');
  let t = q1('SELECT ends, fails FROM tries WHERE pid = ? AND song = ? AND d = ?', P.id, S, D2); ok(t.ends === 1 && t.fails === 1, 'fail: records one try and one failure');
  ok(failCheck(S, D2, dead6), 'failCheck: 6 misses at difficulty 2');
  ok(!failCheck(S, D2, [M, M, M, M]) && !failCheck(S, D2, M5), 'failCheck: not enough misses to fall');
  r = await end(P, S, D2, 'fail', [M, M, M]); ok(r.s === 400 && r.j.error === 'log', 'fail: an impossible fall is refused');
  ok(!failCheck(S, D2, [...M5, M, M]), 'failCheck: life was gone before the last beat');
  ok(!failCheck(S, D2, [...M5, 0]) && !failCheck(S, D2, [...M5, H]), 'failCheck: the last entry must be a real miss');
  ok(failCheck(S, D2, [...M5, 0, M]), 'failCheck: a shielded miss costs nothing: the fall comes later');
  ok(failCheck(S, D2, [...M5, [200, 100], M]) && !failCheck(S, D2, [...M5, H, M]), 'failCheck: a perfect hit heals 2 (5 -> 7: survives a miss at 5), an ok-tier hit heals nothing');
  ok(failCheck(S, 3, Array(30).fill(M)) && !failCheck(S, 3, Array(29).fill(M)), 'failCheck: difficulty 3 costs 1 per miss (30 misses)');
  ok(failCheck(S, 0, Array(15).fill(M)) && !failCheck(S, 0, Array(14).fill(M)), 'failCheck: difficulty 0 costs 2 per miss');
  ok(failCheck(S, 4, Array(5).fill(M)) && !failCheck(S, 4, Array(4).fill(M)) && failCheck(S, 1, Array(10).fill(M)) && !failCheck(S, 1, Array(9).fill(M)), 'failCheck: difficulty 4 costs 6, difficulty 1 costs 3');
  ok(!failCheck(S, D2, []) && !failCheck(S, D2, 'x') && !failCheck(S, D2, Array(N(S, D2)).fill(M)), 'failCheck: empty, junk and full-length logs refused');
  ok(!failCheck(S, D2, [...M5, [0, 5000]]) && !failCheck(S, D2, [...M5, [999, 300]]), 'failCheck: every entry gets the same checks as judge');
  ok(failCheck(S, D2, dead6, [[0, 2]]) && !failCheck(S, D2, dead6, [[0, 9]]), 'failCheck: star ranges are checked against the partial length');
  // tiers heal 2/1/1/0: a tier-3 hit gives nothing
  { const pre = Array(9).fill(M);   // difficulty 1 (3 per miss): 9 misses leave 3 life; then a hit, then a miss. ok tier heals 0 (3 -> 0 falls); good 1 (4 -> 1) and perfect 2 (5 -> 2) survive
    ok(failCheck(S, 1, [...pre, [200, 100], M]) && !failCheck(S, 1, [...pre, [100, 120], M]) && !failCheck(S, 1, [...pre, [30, 280], M]), 'failCheck: heal by tier: ok 0 (falls), good and perfect both heal (survives)'); }
  r = await end(P, S, D2, 'fail'); ok(r.s === 400 && r.j.error === 'log', 'fail without a log: refused');
  // quit
  r = await end(P, S, D2, 'quit'); ok(r.j.ok, 'quit: accepted'); t = q1('SELECT ends, fails FROM tries WHERE pid = ? AND song = ? AND d = ?', P.id, S, D2); ok(t.ends === 2 && t.fails === 1, 'quit: one more try, no failure');
  // timing, kinds, tickets
  r = await end(P, S, D2, 'quit', null, null, 5e3); ok(r.s === 400 && r.j.error === 'ticket', 'end: under 10 seconds is refused');
  r = await end(P, S, D2, 'fail', dead6, null, 2e3); ok(r.s === 400 && r.j.error === 'ticket', 'end (fail): under 3 seconds is refused');
  r = await end(P, S, D2, 'quit', null, null, 3 * 3600e3 + 5e3); ok(r.s === 400 && r.j.error === 'ticket', 'end: older than 3 hours is refused');
  r = await end(P, S, D2, 'fail', dead6, null, 3.5e3); ok(r.j.ok, 'end (fail): 3 seconds is enough');
  r = await post('/lb/end', { run: ticket(P.id, S, D2, 20e3), pk: P.pk, kind: 'win' }); ok(r.s === 400 && r.j.error === 'bad', 'end: only fail or quit');
  r = await post('/lb/end', { run: legacy(S, D2, 20e3), pk: P.pk, kind: 'quit' }); ok(r.s === 400 && r.j.error === 'ticket', 'end: legacy tickets are refused');
  const tk = ticket(P.id, S, D2, 20e3); await post('/lb/end', { run: tk, pk: P.pk, kind: 'quit' });
  r = await post('/lb/end', { run: tk, pk: P.pk, kind: 'quit' }); ok(r.s === 400 && r.j.error === 'ticket', 'end: the same ticket twice is refused');
  const O = await player(); r = await post('/lb/end', { run: ticket(P.id, S, D2, 20e3), pk: O.pk, kind: 'quit' }); ok(r.s === 400 && r.j.error === 'ticket', 'end: pid mismatch refused');
  r = await post('/lb/end', { run: ticket(P.id, S, D2, 20e3), pk: crypto.randomBytes(16).toString('hex'), kind: 'quit' }); ok(r.s === 400 && r.j.error === 'noname', 'end: unknown key');
  seen.length = 0; await end(P, S, D2, 'quit'); ok(seen[0] && seen[0].startsWith('lbr:'), 'end uses the lbr: limit');
  // a failed attempt with a bad log did not use the ticket up
  const tk2 = ticket(P.id, S, D2, 20e3);
  r = await post('/lb/end', { run: tk2, pk: P.pk, kind: 'fail', log: [M, M, M] }); ok(r.s === 400, 'bad log refused');
  r = await post('/lb/end', { run: tk2, pk: P.pk, kind: 'fail', log: dead6 }); ok(r.j.ok, 'a refused log does not burn the ticket');
}

// ---- star-time ranges ----
{
  const n = N(S, 1), pr = perfect(S, 1);
  ok(JSON.stringify(parseStar(undefined, 10)) === '[]' && JSON.stringify(parseStar(null, 10)) === '[]' && JSON.stringify(parseStar([[0, 3], [3, 5], [7, 10]], 10)) === '[[0,3],[3,5],[7,10]]', 'star: none and valid ranges');
  for (const [bad, why] of [[[[5, 8], [0, 3]], 'unsorted'], [[[0, 5], [4, 8]], 'overlapping'], [[[0, 101]], 'beyond the log'], [[[-1, 3]], 'negative'], [[[3, 3]], 'empty range'],
    [[[4, 3]], 'backwards'], [[[0.5, 3]], 'not an integer'], [[[0, 3, 4]], 'three numbers'], ['x', 'not a list'], [{}, 'object'], [Array.from({ length: 51 }, (_, i) => [i * 2, i * 2 + 1]), '51 ranges'], [[null], 'null range']])
    ok(parseStar(bad, 100) === null, 'star invalid: ' + why);
  ok(parseStar([[0, 11]], 10) === null && parseStar([[0, 10]], 10) !== null, 'star: the end may be the log length, not more');
  ok(parseStar(Array.from({ length: 50 }, (_, i) => [i * 2, i * 2 + 1]), 100) !== null, 'star: 50 ranges are fine');
  ok(judge(S, 1, pr, [[0, 5]]) && judge(S, 1, pr, [[5, 8], [0, 3]]) === null && judge(S, 1, pr, [[0, n + 1]]) === null, 'judge: star ranges validated');
  // base limits: inside >= 2 * min, outside <= max / 2
  const low = withAt(pr, 2, [0, 40]);                                   // q = 40 / 300 = .13: below even the plain minimum
  ok(judge(S, 1, low) === null, 'a base below the plain minimum is refused');
  const mid = withAt(pr, 2, [0, 120]);                                  // q = .4: possible outside star time, not inside it
  ok(judge(S, 1, mid) !== null && judge(S, 1, mid, [[0, 5]]) === null && judge(S, 1, mid, [[3, 6]]) !== null, 'inside a star range a base below the doubled minimum is refused, outside it is fine');
  const high = withAt(pr, 2, [0, 300 * 14]);                            // q = 14: only a doubled hit can earn this
  ok(judge(S, 1, high, undefined, true) === null && judge(S, 1, high, [[1, 4]], true) !== null && judge(S, 1, high, [[3, 6]], true) === null && judge(S, 1, high) !== null, 'outside star time a base above half the maximum is refused; inside it is fine');
  ok(judge(S, 1, withAt(pr, 2, [0, 300 * 30]), [[0, 5]]) === null, 'even inside star time the full maximum holds');
  ok(judge(S, 1, withAt(pr, 2, null), [[0, 5]]) !== null && judge(S, 1, withAt(pr, 2, 0), [[0, 5]]) !== null, 'misses inside a star range are fine');
  const P = await player();
  let r = await sub(P, S, 1, high, [[3, 6]]); ok(r.s === 400 && r.j.error === 'log', 'submit: star range that does not cover the big base: refused');
  r = await sub(P, S, 1, high, [[1, 4]]); ok(r.j.ok, 'submit: star range that covers it: accepted');
  r = await sub(P, S, 1, pr, [[5, 5]]); ok(r.s === 400 && r.j.error === 'log', 'submit: empty range refused');
  r = await sub(P, S, 1, pr, 'x'); ok(r.s === 400 && r.j.error === 'log', 'submit: junk star refused');
  const O = await player(); r = await sub(O, S, 1, high); ok(r.s === 400 && r.j.error === 'log', 'submit: no star = no star time: the outer limit applies (a phone that doubles without sending ranges is refused when its base is high)');
}

// ---- achievements ----
{
  ok(NA.length === 0, 'NA is empty');
  for (const id of ['拾級而上', '試聽', '遍聽', '百折不撓', '屢敗屢戰', '一線生機', '不滅', '星光初拾', '星光全收', '金色時刻', '新曲嘗鮮']) ok(SERVER_IDS.includes(id), 'server decides ' + id);
  const M = null;
  // 拾級而上: 3 difficulties of one song at A or better
  { const P = await player(); let r = await sub(P, S, 0, perfect(S, 0)); r = await sub(P, S, 1, perfect(S, 1)); ok(!got(r, '拾級而上'), '拾級而上 not with 2 difficulties');
    r = await sub(P, S, 3, Array.from({ length: N(S, 3) }, () => [60, 200])); ok(!got(r, '拾級而上'), '拾級而上 not when the third is below A (all "good" = about 70 %)');
    r = await sub(P, S, 2, perfect(S, 2)); ok(got(r, '拾級而上'), '拾級而上 with 3 difficulties at A or better'); }
  { const P = await player(); await sub(P, songs[1], 0, perfect(songs[1], 0)); await sub(P, songs[2], 1, perfect(songs[2], 1)); const r = await sub(P, songs[3], 2, perfect(songs[3], 2)); ok(!got(r, '拾級而上'), '拾級而上 needs the same song'); }
  // 試聽: 10 different songs with a try
  { const P = await player(); let r;
    for (let i = 0; i < 9; i++) r = await end(P, songs[i], 0, 'quit'); ok(!got(r, '試聽'), '試聽 not with 9 songs');
    r = await end(P, songs[9], 0, 'quit'); ok(got(r, '試聽'), '試聽 with the 10th song (quit counts)');
    const Q = await player(); for (let i = 0; i < 5; i++) await end(Q, songs[i], 0, 'quit'); for (let i = 5; i < 9; i++) r = await sub(Q, songs[i], 0, perfect(songs[i], 0));
    ok(!got(r, '試聽'), '試聽: 5 tried + 4 cleared = 9'); r = await sub(Q, songs[9], 0, perfect(songs[9], 0)); ok(got(r, '試聽'), '試聽: scores count with tries'); }
  { const P = await player(); for (let i = 0; i < 12; i++) await end(P, songs[0], i % 5, 'quit'); const r = await end(P, songs[0], 0, 'quit'); ok(!got(r, '試聽'), '試聽: the same song 13 times is one song'); }
  // 遍聽: all 71 regular songs
  { const P = await player(), all = CONS.filter(c => !c[2]).flatMap(c => c[1]); let r;
    ok(all.length === 71, '71 regular songs');
    for (let i = 0; i < 70; i++) r = await end(P, all[i], 0, 'quit'); ok(!got(r, '遍聽'), '遍聽 not with 70');
    const rw = CONS.filter(c => c[2]).flatMap(c => c[1])[0]; r = await end(P, rw, 0, 'quit'); ok(!got(r, '遍聽'), '遍聽: a reward-constellation song does not count');
    r = await end(P, all[70], 0, 'quit'); ok(got(r, '遍聽'), '遍聽 with all 71'); }
  // 百折不撓: 30 ended runs of one song, any difficulty
  { const P = await player(); let r; for (let i = 0; i < 29; i++) r = await end(P, S, i % 5, i % 2 ? 'quit' : 'fail', i % 2 ? null : Array(i % 5 === 0 ? 15 : i % 5 === 1 ? 10 : i % 5 === 2 ? 6 : i % 5 === 3 ? 30 : 5).fill(M));
    ok(r.j.ok && !got(r, '百折不撓'), '百折不撓 not with 29'); r = await end(P, S, 1, 'quit'); ok(got(r, '百折不撓'), '百折不撓 with 30');
    const Q = await player(); for (let i = 0; i < 20; i++) await end(Q, songs[i % 20], 0, 'quit'); r = await end(Q, songs[0], 0, 'quit'); ok(!got(r, '百折不撓'), '百折不撓 needs one song'); }
  // 屢敗屢戰: the chart failed 5 times before, then cleared
  { const P = await player(); for (let i = 0; i < 4; i++) await end(P, S, D2, 'fail', Array(6).fill(M));
    let r = await sub(P, S, D2, perfect(S, D2)); ok(!got(r, '屢敗屢戰'), '屢敗屢戰 not with 4 fails');
    const Q = await player(); for (let i = 0; i < 5; i++) await end(Q, S, D2, 'fail', Array(6).fill(M));
    r = await sub(Q, S, 1, perfect(S, 1)); ok(!got(r, '屢敗屢戰'), '屢敗屢戰: the fails belong to the chart (another difficulty does not count)');
    r = await sub(Q, S, D2, perfect(S, D2)); ok(got(r, '屢敗屢戰'), '屢敗屢戰 with 5 fails then a clear');
    const R = await player(); for (let i = 0; i < 5; i++) await end(R, S, D2, 'quit'); r = await sub(R, S, D2, perfect(S, D2)); ok(!got(r, '屢敗屢戰'), '屢敗屢戰: quits are not failures'); }
  // life: 一線生機 / 不滅
  { const H = [0, 300], n = N(S, D2), P = await player(), base = perfect(S, D2), tail = base.slice(0, n - 7).concat([M, M, M, M, M, H, M]);   // difficulty 2 (5 per miss): 5 misses 30 -> 5, a perfect hit -> 7, a miss -> 2
    let r = await sub(P, S, D2, tail); ok(r.j.ok && got(r, '一線生機'), '一線生機: finished with 2 life');
    const Q = await player(); r = await sub(Q, S, D2, base); ok(!got(r, '一線生機') && !got(r, '不滅'), '一線生機 not with full life');
    const R = await player(); r = await sub(R, S, D2, base.slice(0, n - 8).concat([M, M, M, M, M, H, [100, 120], M])); ok(!got(r, '一線生機'), '一線生機 not with 3 life (5 misses 30 -> 5, +2 +1, a miss -> 3: the boundary)');
    const X = await player(), gone = [M, M, M, M, M, M].concat(base.slice(0, n - 13), [M, M, M, M, M, H, M]);   // the life was gone at beat 6, then healed, then 5 misses, a hit and a miss (2 life at the end)
    r = await sub(X, S, D2, gone); ok(r.j.ok && r.j.ach.includes('新星') && !got(r, '一線生機') && !got(r, '不滅'), 'life that hit 0 in a finished run: accepted, but no life achievement'); }
  { const d = 1, n = N(big, d), P = await player(), M2 = null;       // difficulty 1: 3 per miss (difficulty 0 needs 15 misses, too many for rank A). 9 misses -> 3, a good-tier hit (+1) -> 4, a miss -> 1
    const mk = lo => { const l = perfect(big, d); for (let i = 0; i < 9; i++) l[i] = M2; l[9] = [100, 120]; l[10] = M2; return l; };
    let r = await sub(P, big, d, mk()); const r0 = judge(big, d, mk());
    ok(r0.life.min === 1 && r0.life.dead < 0 && r0.rank === 'A', '不滅 test run: lowest life 1, never gone, rank A (' + r0.life.min + ',' + r0.rank + ')');
    ok(got(r, '不滅'), '不滅: lowest life exactly 1 with rank A'); ok(!got(r, '一線生機') || r0.life.end < 3, '(end life ' + r0.life.end + ')');
    const Q = await player(); const l2 = perfect(big, d); for (let i = 0; i < 8; i++) l2[i] = M2; r = await sub(Q, big, d, l2); ok(judge(big, d, l2).life.min === 6 && !got(r, '不滅'), '不滅 not when the lowest life is 6');
    const R = await player(); const l3 = perfect(big, d); for (let i = 0; i < 9; i++) l3[i] = M2; l3[9] = [100, 120]; l3[10] = M2; for (let i = 11; i < n; i++) l3[i] = M2;   // many misses: rank below A, and life goes to 0 anyway
    r = await sub(R, big, d, l3); ok(!got(r, '不滅'), '不滅 not below rank A / when the life ran out'); }
  // star time: 星光初拾 / 星光全收 / 金色時刻
  { const S1 = songs.slice().sort((a, b) => N(b, 4) - N(a, 4))[0], n = N(S1, 4), pr = perfect(S1, 4);
    const P = await player(); let r = await sub(P, S1, 4, withAt(pr, 3, M), [[0, 3], [3, 6]]); ok(got(r, '星光初拾') && !got(r, '星光全收'), '星光初拾 with one clean range out of two (a miss in the other)');
    const Q = await player(); r = await sub(Q, S1, 4, withAt(pr, 3, M), [[3, 4]]); ok(!got(r, '星光初拾') && !got(r, '星光全收'), 'neither with the only range containing a miss');
    const R = await player(); r = await sub(R, S1, 4, withAt(pr, 3, 0), [[3, 4]]); ok(!got(r, '星光初拾'), 'a shielded miss (0) inside a range counts as a miss');
    const T = await player(); r = await sub(T, S1, 4, withAt(pr, 30, M), [[0, 3], [10, 14]]); ok(got(r, '星光初拾') && got(r, '星光全收'), '星光全收: every range clean (a miss outside them does not matter)');
    const U = await player(); r = await sub(U, S1, 4, pr); ok(!got(r, '星光初拾') && !got(r, '星光全收') && !got(r, '金色時刻'), 'no star ranges: none of the three');
    const V = await player(); r = await sub(V, S1, 4, pr, [[0, 50]]); ok(got(r, '星光初拾') && !got(r, '金色時刻'), '金色時刻 not with a combo of only 50');
    const W = await player(); r = await sub(W, S1, 4, pr, [[90, 120]]); ok(got(r, '金色時刻'), '金色時刻: the 100th hit in a row falls inside a range');
    const X = await player(); r = await sub(X, S1, 4, pr, [[0, 99]]); ok(!got(r, '金色時刻'), '金色時刻 not when the range ends at beat 99 (combo 99)');
    const Y = await player(); r = await sub(Y, S1, 4, withAt(pr, 60, M), [[70, 140]]); ok(n > 140 && !got(r, '金色時刻'), '金色時刻 not when the combo was broken and only reached 80 inside the range');
    const Z = await player(); r = await sub(Z, S1, 4, withAt(pr, 5, M), [[110, 130]]); ok(got(r, '金色時刻'), '金色時刻: the combo restarts after a miss and still reaches 100 later');
    // the old kind of ticket can earn none of them
    const L = await player(); r = await post('/lb/submit', { run: legacy(S1, 4, 600e3), pk: L.pk, log: pr, star: [[90, 120]] }); ok(r.j.ok && !got(r, '金色時刻') && !got(r, '星光初拾'), 'a legacy ticket earns nothing'); }
  // 新曲嘗鮮
  { const P = await player(), five = songs.slice(30, 35);
    let r = await sub(P, five[0], 0, perfect(five[0], 0)); ok(!got(r, '新曲嘗鮮'), '新曲嘗鮮: the list is empty, nobody earns it');
    NEW_SONGS.push(...five);
    try {
      const Q = await player(); for (let i = 0; i < 4; i++) r = await sub(Q, five[i], i % 5, perfect(five[i], i % 5)); ok(!got(r, '新曲嘗鮮'), '新曲嘗鮮 not with 4 new songs');
      r = await sub(Q, five[0], 3, perfect(five[0], 3)); ok(!got(r, '新曲嘗鮮'), '新曲嘗鮮: another difficulty of the same song is not a new song');
      r = await sub(Q, five[4], 4, perfect(five[4], 4)); ok(got(r, '新曲嘗鮮'), '新曲嘗鮮 with 5 new songs (any difficulty)');
      const R = await player(); for (let i = 0; i < 4; i++) await end(R, five[i], 0, 'quit'); r = await end(R, five[4], 0, 'quit'); ok(!got(r, '新曲嘗鮮'), '新曲嘗鮮 needs clears, not tries');
    } finally { NEW_SONGS.length = 0; }
  }
}

// ---- strict (new ticket) versus legacy base limit ----
{
  const n = N(S, 1), hi = withAt(perfect(S, 1), 2, [0, 4200]), A = await player();
  let r = await post('/lb/submit', { run: legacy(S, 1, 600e3), pk: A.pk, log: hi }); ok(r.j.ok && r.j.improved, 'legacy ticket + a doubled base (4200) and no star ranges: accepted (a phone that does not report star time)');
  r = await sub(A, S, 1, hi); ok(r.s === 400 && r.j.error === 'log', 'new ticket + the same base outside star time: refused');
  r = await sub(A, S, 1, hi, [[1, 4]]); ok(r.j.ok, 'new ticket + the same base inside a star range: accepted');
  ok(judge(S, 1, withAt(perfect(S, 1), 2, [0, 300 * 30])) === null, 'legacy: even the loose limit holds');
}

// ---- a database without migration 0010 ----
{
  const P = await player(); await end(P, S, D2, 'quit'); const mig = readFileSync(join(SRV, 'migrations', '0010_runs.sql'), 'utf8');
  sql.exec('DROP TABLE runs; DROP TABLE tries;');
  try {
    let r = await post('/lb/start', { song: S, d: 1, pk: P.pk }); ok(r.s === 200 && r.j.run.split('.').length === 5, 'no runs table: /lb/start falls back to a legacy ticket');
    r = await post('/lb/delete', { pk: P.pk }); ok(r.s === 200 && r.j.ok, 'no runs/tries tables: deleting the account still succeeds');
    ok(!q1('SELECT 1 FROM players WHERE id = ?', P.id), 'the player is gone');
    const Q = await player(); r = await sync(Q); ok(r.j.ok, 'no tries table: /ach/sync still works');
  } finally { sql.exec(mig); }
}

// ---- last-beat fall, settle order (seq), shield and star-range caps, quit minimum ----
{
  const M = null, H = [0, 300], P = await player();
  // a fall on the very last beat is a legal fail (log length N)
  const n3 = N(S, 0), last = perfect(S, 0).slice(0, n3 - 15).concat(Array(15).fill(M));   // difficulty 0 (2 per miss): 15 misses reach 0 (difficulty 3 would need 30 = the whole song)
  let r = await end(P, S, 0, 'fail', last); ok(failCheck(S, 0, last) && r.j.ok, 'fail: life reaching 0 exactly on the last beat of the song (log length N)');
  ok(!failCheck(S, 0, perfect(S, 0).slice(0, n3 - 14).concat(Array(14).fill(M))), 'fail: 14 misses at the end do not reach 0');
  // seq: beats 11 and 12 settled in the other order. Difficulty 1: 3 life per miss, two balls (displacement must stay below 2)
  const f1 = [M, M, M, M, M, M, M, M, M, [100, 120], M, M, H];  // 9 misses -> 3, a good hit -> 4, a miss -> 1; beat 11 miss, beat 12 hit
  const s1 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 11];        // the hit settled first: 1 -> 3 -> 0 at beat 11, the last settled (beat order: dead at beat 11, then a hit)
  ok(!failCheck(S, 1, f1) && failCheck(S, 1, f1, undefined, s1), 'seq: in beat order that run is not a fall at its end, in settle order it is');
  const s2 = [0, 1, 2, 3, 4, 5, 6, 8, 9, 10], f2 = Array(11).fill(M);   // beat 7 not settled yet (placeholder), beat 10 the fatal miss
  ok(failCheck(S, 1, f2, undefined, s2) && !failCheck(S, 1, f2), 'seq: beats not settled yet cost no life (10 misses settled, a placeholder between)');
  ok(!failCheck(S, 1, [M, M, M, M, M, M, M, [0, 300], M, M, M], undefined, [0, 1, 2, 3, 4, 5, 6, 8, 9, 10]), 'seq: an unsettled beat that is not a null placeholder is refused');
  ok(!failCheck(S, 1, f1, undefined, [2, 1, 0, 3, 4, 5, 6, 7, 8, 9, 10, 12, 11]) && !failCheck(S, 1, f1, undefined, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 10]) && !failCheck(S, 1, f1, undefined, [0, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 11]), 'seq: displacement of nb or more, a repeat, a duplicate: refused');
  ok(!failCheck(S, 1, f1, undefined, 'x') && !failCheck(S, 1, f1, undefined, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 99]) && !failCheck(S, 1, f1, undefined, [0, 1.5, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 11]), 'seq: not a list, out of range, not an integer: refused');
  ok(!failCheck(S, 0, Array(15).fill(M), undefined, [1, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) && failCheck(S, 0, Array(15).fill(M), undefined, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]), 'seq: one ball at a time (difficulty 0) allows no displacement');
  r = await end(P, S, 1, 'fail', f1, null, 20e3, s1); ok(r.j.ok, '/lb/end accepts a seq');
  r = await end(P, S, 1, 'fail', f1, null, 20e3, [2, 1, 0, 3, 4, 5, 6, 7, 8, 9, 10, 12, 11]); ok(r.s === 400 && r.j.error === 'log', '/lb/end refuses a seq that moves a beat too far');
  // whole run: life follows seq, everything else the beat order
  const s4 = songs.slice().sort((a, b) => N(b, 4) - N(a, 4))[0], l4 = perfect(s4, 4); for (const i of [0, 1, 2, 3, 4]) l4[i] = M; l4[5] = H; l4[6] = H;   // difficulty 4: 6 per miss, 5 misses in beat order = 0
  const sq = Array.from({ length: N(s4, 4) }, (_, i) => i); [sq[4], sq[5], sq[6]] = [5, 6, 4];   // the 5th miss settles after the two hits: 6 -> 8 -> 10 -> 4
  const a = judge(s4, 4, l4, undefined, true), b = judge(s4, 4, l4, undefined, true, sq);
  ok(a.life.dead >= 0 && b.life.dead === -1 && b.life.min === 4, 'seq: full run, two hits settled before a miss: life survives where beat order would have fallen (' + a.life.dead + ' / ' + b.life.dead + ', min ' + b.life.min + ')');
  ok(a.acc === b.acc && a.score === b.score && a.maxCombo === b.maxCombo && a.rank === b.rank && a.miss === b.miss, 'seq: accuracy, score, combo and rank stay in beat order');
  ok([sq.slice(1), sq.map((x, i) => i === 10 ? 12 : x), 'x'].every(z => { const j = judge(s4, 4, l4, undefined, true, z); return j && j.lifeBad && j.acc === a.acc && j.score === a.score; }), 'seq: not a full permutation within nb: the run is still judged (score unchanged), only its life is marked bad');
  const sw = Array.from({ length: N(s4, 4) }, (_, i) => i); [sw[0], sw[3]] = [3, 0];
  ok(judge(s4, 4, l4, undefined, true, sw).lifeBad === true && judge(s4, 4, l4, undefined, true, sq).lifeBad === false, 'seq: displacement 3 with three balls: life marked bad, not refused');
  ok(judge(s4, 4, l4, undefined, false, sw) !== null, 'seq is ignored for legacy tickets');
  r = await sub(P, s4, 4, l4, null); ok(r.j.ok, 'submit without seq: beat order (old behaviour)');
  const Q = await player(); r = await post('/lb/submit', { run: ticket(Q.id, s4, 4), pk: Q.pk, log: l4, seq: sq }); ok(r.j.ok, 'submit with seq: accepted');
  { const nb = q1('SELECT n FROM scores WHERE pid = ?', Q.id).n; r = await post('/lb/submit', { run: ticket(Q.id, s4, 4), pk: Q.pk, log: l4, seq: sw });
    ok(r.s === 200 && r.j.ok && q1('SELECT n FROM scores WHERE pid = ?', Q.id).n === nb + 1 && !got(r, '一線生機') && !got(r, '不滅'), 'submit with a bad seq: the run is accepted and counted, no life achievements'); }
  { const X = await player(), n4 = N(S, D2), tail = perfect(S, D2).slice(0, n4 - 7).concat([M, M, M, M, M, H, M]);   // would earn 一線生機 (2 life at the end)
    let rr = await post('/lb/submit', { run: ticket(X.id, S, D2), pk: X.pk, log: tail, seq: sw }); ok(rr.j.ok && !got(rr, '一線生機') && q1('SELECT n FROM scores WHERE pid = ?', X.id).n === 1, '一線生機 withheld when the seq is bad (score kept)');
    const Y = await player(); rr = await post('/lb/submit', { run: ticket(Y.id, S, D2), pk: Y.pk, log: tail }); ok(got(rr, '一線生機'), '(same log without a seq: earns it)'); }
  // shield and star-range caps (new tickets)
  const c = itemCap(s4, 4), base = perfect(s4, 4), zs = k => base.map((x, i) => i < k ? 0 : x);
  ok(judge(s4, 4, zs(c), undefined, true).lifeBad === false && judge(s4, 4, zs(c + 1), undefined, true).lifeBad === true && judge(s4, 4, zs(c + 1)) !== null, 'shield cap: ' + c + ' shielded misses fine, one more marks the life bad (run still judged)');
  { const c2 = itemCap(s4, 2), mk = k => { const z = perfect(s4, 2).map((x, i) => i < k ? 0 : x); z.splice(z.length - 7, 7, M, M, M, M, M, H, M); return z; };   // hard: five misses, a perfect hit and a miss at the end leave 2 life, which earns 一線生機 unless the life is bad
    const X = await player(); let rr = await post('/lb/submit', { run: ticket(X.id, s4, 2), pk: X.pk, log: mk(c2 + 1) });
    ok(rr.j.ok && !got(rr, '一線生機') && q1('SELECT n FROM scores WHERE pid = ?', X.id).n === 1, 'too many shields at submit: accepted, no life achievement');
    const Y = await player(); rr = await post('/lb/submit', { run: ticket(Y.id, s4, 2), pk: Y.pk, log: mk(c2) }); ok(got(rr, '一線生機'), '(same run with shields inside the cap: earns it)');
    const g = c + 1, near = Array.from({ length: g }, (_, i) => [i * 3, i * 3 + 2]);   // expert (3 balls): ranges one beat apart are one power-up
    ok(judge(s4, 4, base, near, true).starBad === false, 'star ranges split by out-of-order settling count as one power-up'); }
  const rg = k => Array.from({ length: k }, (_, i) => [i * 4, i * 4 + 1]);
  ok(judge(s4, 4, base, rg(c), true).sc === c && judge(s4, 4, base, rg(c + 1), true).starBad === true && judge(s4, 4, base, rg(c + 1), true).sg === 0 && judge(s4, 4, base, rg(c + 1), true).gold === 0, 'star-range cap: ' + c + ' fine, one more: no star achievements data (run still judged)');
  { const X = await player(); let rr = await post('/lb/submit', { run: ticket(X.id, s4, 4), pk: X.pk, log: base, star: rg(c + 1) }); ok(rr.j.ok && !got(rr, '星光初拾') && !got(rr, '星光全收') && !got(rr, '金色時刻'), 'too many star ranges at submit: accepted, no star achievements');
    const Y = await player(); rr = await post('/lb/submit', { run: ticket(Y.id, s4, 4), pk: Y.pk, log: withAt(base, 0, [0, 120]), star: rg(c + 1) }); ok(rr.s === 400 && rr.j.error === 'log', 'ranges still bound the base points: refused'); }
  ok(!failCheck(S, D2, [M, M, M, M, M, ...Array(itemCap(S, D2) + 1).fill(0), M]) && failCheck(S, D2, [M, M, M, M, M, ...Array(itemCap(S, D2)).fill(0), M]), 'fail: the shield cap applies too');
  ok(2 * itemCap(S, 0) + 2 <= n3 && failCheck(S, 0, last, rg(itemCap(S, 0)).map(g => [g[0] / 2, g[0] / 2 + 1])) && !failCheck(S, 0, last, rg(itemCap(S, 0) + 1).map(g => [g[0] / 2, g[0] / 2 + 1])), 'fail: the star-range cap applies too');
  ok(itemCap(S, 0) >= 1 && itemCap(s4, 4) === Math.max(1, 2 + Math.floor((CHARTS[s4].dur / CHARTS[s4].spd[4] - 5.2) / 8)), 'cap formula: 9 s first item, 8 s apart, +1');
  // a quit needs a quarter of the song
  const lg = songs.slice().sort((a, b) => CHARTS[b].dur / CHARTS[b].spd[0] - CHARTS[a].dur / CHARTS[a].spd[0])[0], q = CHARTS[lg].dur / CHARTS[lg].spd[0] * 250;
  ok(q > 10500, 'the longest song needs more than 10 s (' + Math.round(q) + ' ms)');
  r = await end(P, lg, 0, 'quit', null, null, q - 1500); ok(r.s === 400 && r.j.error === 'ticket', 'quit before a quarter of the song: refused');
  r = await end(P, lg, 0, 'quit', null, null, q + 1500); ok(r.j.ok, 'quit after a quarter of the song: accepted');
  r = await end(P, lg, 0, 'fail', Array(15).fill(M), null, Math.ceil(CHARTS[lg].dur / CHARTS[lg].spd[0] * 900 * 15 / N(lg, 0)) + 500); ok(r.j.ok, 'a fail is accepted once the settled share of the song could have been played');
  // tries achievements through the sync endpoint
  const T = await player(); for (let i = 0; i < 10; i++) sql.prepare('INSERT INTO tries (pid, song, d, ends, fails) VALUES (?, ?, 0, 1, 0)').run(T.id, songs[i]);
  r = await sync(T); ok(r.j.ok && r.j.fresh.includes('試聽') && !r.j.fresh.includes('百折不撓'), '/ach/sync gives 試聽 from tries');
  const U = await player(); sql.prepare('INSERT INTO tries (pid, song, d, ends, fails) VALUES (?, ?, 0, 17, 0), (?, ?, 3, 13, 2)').run(U.id, S, U.id, S);
  r = await sync(U); ok(r.j.fresh.includes('百折不撓') && !r.j.fresh.includes('試聽'), '/ach/sync gives 百折不撓 from tries (30 over two difficulties)');
  r = await sync(U); ok(!r.j.fresh.includes('百折不撓') && r.j.ach.some(x => x.id === '百折不撓'), 'and only once');
}

// ---- deleting a player removes runs and tries ----
{
  const P = await player(); await end(P, S, D2, 'quit'); await sub(P, S, 1, perfect(S, 1)); ticket(P.id, S, 0);
  ok(q1('SELECT COUNT(*) AS n FROM runs WHERE pid = ?', P.id).n === 3 && q1('SELECT COUNT(*) AS n FROM tries WHERE pid = ?', P.id).n === 2, 'delete: rows exist before');
  const r = await post('/lb/delete', { pk: P.pk }); ok(r.j.ok, 'delete: ok');
  ok(q1('SELECT COUNT(*) AS n FROM runs WHERE pid = ?', P.id).n === 0 && q1('SELECT COUNT(*) AS n FROM tries WHERE pid = ?', P.id).n === 0 && !q1('SELECT 1 FROM scores WHERE pid = ?', P.id), 'delete: runs and tries are gone with the scores');
}
ok(qa('SELECT name FROM sqlite_master WHERE name IN (\'runs\', \'tries\')').length === 2, 'migration 0010 made runs and tries');

console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
