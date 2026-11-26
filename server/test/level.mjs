// Levels, experience, light (光能) and the light purchases (no server needed): node test/level.mjs   (npm run test:level)
// handleLb / handleLv / handleShop / handleIapNotify run in this process against an in-memory SQLite (node:sqlite) wrapped like D1; every migration is applied.
// Tickets are signed here and back-dated (the server only takes a result once the song could have been played); StoreKit transactions are signed by test/pki.mjs.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { CATALOG } from '../src/catalog.js';
// fake level rewards (the real catalog gets its lv:N items elsewhere): injected before level.js reads the catalog
CATALOG['title.lvtest2'] = { cat: 'title', vis: 1, how: 'lv:2', pid: '', parts: [], price: 0 };
CATALOG['frame.lvtest3'] = { cat: 'frame', vis: 0, how: 'lv:3', pid: '', parts: [], price: 0 };
import { handleLb } from '../src/lb.js';
import { handleShop, handleIapNotify } from '../src/shop.js';
import { CHARTS } from '../src/charts.js';
import * as L from '../src/level.js';
import { chain, jws, tx } from './pki.mjs';

const SRV = join(dirname(fileURLToPath(import.meta.url)), '..'), SECRET = 'level-test-secret';
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
let hook = null;                                          // runs once, just before the next guarded prog update is prepared (a rival write)
const DB = { prepare: q => { if (hook && q.startsWith('UPDATE prog SET xp')) { const h = hook; hook = null; h(); } return new Stmt(q); },
  async batch(list) { const out = []; sql.exec('BEGIN'); try { for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } return out; } };
const PKI = chain();
const env = { LB: DB, LB_SECRET: SECRET, IAP_ON: '1', ALLOW_LOCAL: '1', IAP_TEST_ROOT_B64: PKI.rootB64 };
let slow = false; const seen = [];
const limited = async (e, k) => { seen.push(k); return slow; };
const raw = (path, body, method = 'POST') => new Request('http://t' + path, { method, body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
async function post(path, body, e = env) { const r = await handleLb(raw(path, body), e, path, '203.0.113.7', null, {}, limited); return { s: r.status, j: await r.json() }; }
async function shop(path, body, e = env) { const r = await handleShop(raw(path, body), e, path, '203.0.113.9', {}, limited); return { s: r.status, j: await r.json() }; }
async function lvme(body, method = 'POST', e = env) { const r = await L.handleLv(raw('/lv/me', body, method), e, '/lv/me', '203.0.113.5', {}, limited); return { s: r.status, j: await r.json() }; }
async function notify(body, e = env, method = 'POST') { const r = await handleIapNotify(raw('/iap/notify', body, method), e, '203.0.113.11', limited); return { s: r.status, j: await r.json() }; }
const q1 = (s, ...a) => sql.prepare(s).get(...a), qa = (s, ...a) => sql.prepare(s).all(...a);

// ---- helpers ----
const b64u = b => b.toString('base64url');
const sign = p => p + '.' + b64u(crypto.createHmac('sha256', SECRET).update(p).digest());
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const legacy = (song, d, ageMs) => sign([song, d, Date.now() - ageMs, crypto.randomBytes(8).toString('hex')].join('.'));
function ticket(pid, ph, song, d, m = 1, ageMs = 600e3) {   // what /lb/start would have issued (and written), back-dated
  const nonce = crypto.randomBytes(8).toString('hex'), ts = Date.now() - ageMs;
  if (ph) sql.prepare('UPDATE prog SET len = 0 WHERE ph = ?').run(ph);   // (tickets here are back-dated: the overlap rule is tested on its own below)
  sql.prepare('INSERT INTO runs (nonce, pid, song, d, ts, done, m, ph) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(nonce, pid, song, d, ts, m, ph);
  return sign([song, d, ts, nonce, pid].join('.'));
}
let pn = 0;
const newPk = () => crypto.randomBytes(16).toString('hex');
async function player() { const pk = newPk(), r = await post('/lb/name', { pk, name: 'L' + (++pn) + crypto.randomBytes(3).toString('hex') }); return { pk, id: r.j.id, ph: sha(pk) }; }
const anon = () => { const pk = newPk(); return { pk, id: 0, ph: sha(pk) }; };
const songs = Object.keys(CHARTS), N = (s, d) => CHARTS[s].n[d], S = 'twinkle', LONG = 'prelude';
const perfect = (s, d) => Array.from({ length: N(s, d) }, () => [0, 300]);
const sub = (P, s, d, m = 1, log = perfect(s, d)) => post('/lb/submit', { run: ticket(P.id, P.ph, s, d, m), pk: P.pk, log });
const end = (P, s, d, kind, m = 1, log, ageMs = kind === 'quit' ? 900e3 : 20e3) => post('/lb/end', { run: ticket(P.id, P.ph, s, d, m, ageMs), pk: P.pk, kind, ...(log ? { log } : {}) });
const prog = P => q1('SELECT * FROM prog WHERE ph = ?', P.ph);
const setProg = (P, o) => { for (const [k, v] of Object.entries(o)) sql.prepare(`UPDATE prog SET ${k} = ? WHERE ph = ?`).run(v, P.ph); };
const light = P => { const r = prog(P); return { nat: r.nat, sub: r.sub, paid: r.paid }; };
const today = () => L.dayOf(Date.now());

// ---- constants and formulas ----
{
  ok(L.needAt(1) === 116 && L.needAt(2) === 140 && L.needAt(99) === 40492 && L.needAt(100) === 40492 && L.needAt(500) === 40492, 'needAt: 100 + 12n + 4n^2, flat 40492 from Lv99 on');
  ok(L.levelOf(0).lv === 1 && L.levelOf(115).lv === 1 && L.levelOf(116).lv === 2 && L.levelOf(116).cur === 0 && L.levelOf(116).need === 140, 'levelOf: Lv1 -> Lv2 at 116');
  ok(L.levelOf(116 + 140 + 5).lv === 3 && L.levelOf(116 + 140 + 5).cur === 5, 'levelOf: crossing two levels');
  let cum = 0; for (let n = 1; n < 100; n++) cum += L.needAt(n);
  ok(L.levelOf(cum - 1).lv === 99 && L.levelOf(cum).lv === 100 && L.levelOf(cum + 40491).lv === 100 && L.levelOf(cum + 40492).lv === 101, 'levelOf: Lv100 starts at the sum of 99 steps, then 40492 per level');
  const st = L.levelOf(cum + 40492 * 7 + 9); ok(st.lv === 107 && st.cur === 9 && st.need === 40492, 'levelOf: star levels have no cap');
  ok(L.levelOf(-5).lv === 1 && L.levelOf(NaN).lv === 1, 'levelOf: junk is level 1');
  ok(L.dayOf(Date.UTC(2026, 10, 25, 19, 59, 59)) === L.dayOf(Date.UTC(2026, 10, 25, 12, 0, 0)) && L.dayOf(Date.UTC(2026, 10, 25, 20, 0, 0)) === L.dayOf(Date.UTC(2026, 10, 25, 19, 59, 59)) + 1, 'dayOf: turns over at 20:00 UTC = 04:00 Taiwan');
  ok(Math.abs(L.lenF('prelude', 0) - 140 / 120) < 1e-9 && L.lenF('twinkle', 1) === 0.6 && L.lenF('prelude', 4) >= 0.6 && songs.every(s => [0, 1, 2, 3, 4].every(d => L.lenF(s, d) >= 0.6 && L.lenF(s, d) <= 1.5)), 'lenF: dur / spd / 120 clamped to 0.6..1.5');
  ok(L.xpClear('prelude', 0, 10000, 1, 1) === 35 && L.xpClear('prelude', 0, 0, 1, 1) === Math.round(30 * 0.5 * 140 / 120) && L.xpClear('prelude', 0, 10000, 3, 0.5) === Math.round(30 * 140 / 120 * 3 * 0.5), 'xpClear: base x (0.5 + 0.5 acc) x lenF x mult x half');
  ok(L.xpClear('twinkle', 3, 10000, 1, 1) === 12 && L.xpClear('twinkle', 4, 10000, 4, 1) === 216, 'xpClear: easy 20 and expert 90 bases with lenF 0.6');
  ok(L.XP_BASE.join() === '30,45,70,20,90' && JSON.stringify(L.MULT_COST) === '{"1":0,"2":5,"3":10,"4":15}' && L.LIGHT_CAP === 60 && L.PASS_CAP === 120 && L.LIGHT_MS === 360000 && L.DAY_SPEND_CAP === 200, 'constants as in the spec');
  // light refill
  const now = 1e12, base = { pass: 0, sub: 0, paid: 0 };
  let a = L.lightAt({ ...base, nat: 10, nts: now - 6 * 360000 - 1000 }, now); ok(a.nat === 16 && a.nts === now - 1000 && a.cap === 60, 'lightAt: 6 points after 36 min, the remainder is kept');
  a = L.lightAt({ ...base, nat: 59, nts: now - 10 * 360000 }, now); ok(a.nat === 60, 'lightAt: stops at the cap');
  a = L.lightAt({ ...base, nat: 100, nts: now - 99 * 360000 }, now); ok(a.nat === 100, 'lightAt: above the cap (pass ended): nothing taken, nothing added');
  a = L.lightAt({ ...base, pass: now + 1e6, nat: 60, nts: now - 5 * 360000 }, now); ok(a.nat === 65 && a.cap === 120, 'lightAt: the pass raises the cap to 120');
  a = L.lightAt({ ...base, nat: 5, nts: now + 99999 }, now); ok(a.nat === 5, 'lightAt: a clock that went backwards adds nothing');
}

// ---- /lv/me and /lb/start ----
{
  const P = await player(), U = anon(); let r;
  r = await lvme({ pk: P.pk }); const lv = r.j.lv;
  ok(r.s === 200 && lv.lv === 1 && lv.xp === 0 && lv.cur === 0 && lv.need === 116 && lv.star === 0 && lv.light.nat === 60 && lv.light.total === 60 && lv.light.cap === 60 && lv.light.next === 0 && lv.light.dayCap === 200 && lv.pass === 0 && lv.half === false && lv.mult === 1 && lv.dsec === 0 && lv.light.spent === 0, '/lv/me: a new player starts full: ' + JSON.stringify(lv));
  ok(!!prog(P), '/lv/me: the row exists');
  r = await lvme({ pk: U.pk }); ok(r.s === 200 && !!prog(U) && !q1('SELECT 1 FROM players WHERE ph = ?', U.ph), '/lv/me: a key without a nickname gets a row too');
  ok((await lvme({ pk: 'zz' })).s === 400 && (await lvme({})).s === 400 && (await lvme('[1]')).s === 400 && (await lvme('{')).s === 400, '/lv/me: bad input refused');
  ok((await lvme({ pk: P.pk }, 'GET')).s === 405, '/lv/me: POST only');
  ok((await lvme({ pk: P.pk, pad: 'x'.repeat(3000) })).s === 413, '/lv/me: body size limit');
  seen.length = 0; await lvme({ pk: P.pk }); ok(seen[0].startsWith('lv:'), '/lv/me: has its own rate limit key');
  slow = true; r = await lvme({ pk: P.pk }); slow = false; ok(r.s === 429, '/lv/me: rate limited -> 429');
  ok((await L.handleLv(raw('/lv/other', { pk: P.pk }), env, '/lv/other', 'x', {}, limited)).status === 404, '/lv: unknown path 404');
  // start
  r = await post('/lb/start', { song: S, d: 1, pk: P.pk, m: 3 }); let p = r.j.run.split('.');
  let row = q1('SELECT * FROM runs WHERE nonce = ?', p[3]); ok(p.length === 6 && +p[4] === P.id && row.m === 3 && row.ph === P.ph, 'start: registered key + m: the ticket names the player, runs keeps m and ph');
  for (const bad of [0, 5, 2.5, '3', null, -1]) { r = await post('/lb/start', { song: S, d: 1, pk: P.pk, m: bad }); row = q1('SELECT m FROM runs WHERE nonce = ?', r.j.run.split('.')[3]); ok(row.m === 1, 'start: bad m ' + JSON.stringify(bad) + ' -> 1'); }
  r = await post('/lb/start', { song: S, d: 1, pk: P.pk }); row = q1('SELECT m FROM runs WHERE nonce = ?', r.j.run.split('.')[3]); ok(row.m === 1, 'start: no m -> 1 (old game)');
  const V = anon(); r = await post('/lb/start', { song: S, d: 1, pk: V.pk, m: 2 }); p = r.j.run.split('.');
  row = q1('SELECT * FROM runs WHERE nonce = ?', p[3]); ok(p.length === 6 && p[4] === '0' && row.pid === 0 && row.ph === V.ph && row.m === 2 && !!prog(V), 'start: a key without a nickname (game sent m): pid 0 ticket, runs row with ph, prog row created');
  r = await post('/lb/start', { song: S, d: 1, pk: anon().pk }); ok(r.j.run.split('.').length === 5, 'start: a key without a nickname and no m: the old legacy ticket (old game unchanged)');
  r = await post('/lb/start', { song: S, d: 1, m: 2 }); ok(r.j.run.split('.').length === 5, 'start: no key: legacy ticket');
}

// ---- clearing a run: experience, multiplier, light ----
{
  const P = await player(); await lvme({ pk: P.pk });
  let r = await sub(P, S, 1, 1);
  const e1 = L.xpClear(S, 1, 10000, 1, 1);
  ok(r.j.ok && r.j.lv && r.j.lv.gain === e1 && r.j.lv.base === e1 && r.j.lv.used === 1 && r.j.lv.cost === 0 && r.j.lv.xp === e1, 'submit x1: gain = formula: ' + JSON.stringify(r.j.lv));
  ok(r.j.lv.from.lv === 1 && r.j.lv.from.cur === 0 && Array.isArray(r.j.lv.ups) && r.j.lv.ups.length === 0 && Array.isArray(r.j.lv.rewards) && r.j.lv.light.total === 60 && prog(P).xp === e1, 'submit: from / ups / rewards / light in the answer, xp stored');
  ok(r.j.lv.pass === 0 && r.j.lv.half === false && r.j.lv.dsec === Math.round(L.playSecs(S, 1)) && r.j.lv.mult === 1 && r.j.lv.title === '', 'submit: dsec counts the song length');
  // x3: costs 10 from the natural pool
  r = await sub(P, S, 1, 3); const e3 = L.xpClear(S, 1, 10000, 3, 1);
  ok(r.j.lv.used === 3 && r.j.lv.cost === 10 && r.j.lv.gain === e3 && r.j.lv.base === e1 && light(P).nat === 50, 'submit x3: 10 light spent, 3x experience');
  const lg = qa('SELECT * FROM lightlog WHERE ph = ? AND kind = ?', P.ph, 'spend'); ok(lg.length === 1 && lg[0].pool === 'nat' && lg[0].amt === -10 && lg[0].ref === S + '.1', 'lightlog: one spend row, negative');
  ok(prog(P).mult === 3 && prog(P).dspend === 10 && prog(P).xp === e1 + e3, 'prog: last multiplier, spent today, xp');
  // lower accuracy
  const log = perfect(S, 1); for (let i = 0; i < 12; i++) log[i] = null;
  r = await post('/lb/submit', { run: ticket(P.id, P.ph, S, 1, 1), pk: P.pk, log });
  ok(r.j.lv.gain === L.xpClear(S, 1, r.j.acc, 1, 1) && r.j.lv.gain < e1, 'submit: experience follows the server-computed accuracy ' + JSON.stringify([r.j.acc, r.j.lv, e1]));
  // the long song and difficulties
  const Q = await player(); r = await sub(Q, LONG, 0, 1); ok(r.j.lv.gain === 35, 'prelude easy perfect: 35');
  r = await sub(Q, LONG, 4, 4); ok(r.j.lv.gain === L.xpClear(LONG, 4, 10000, 4, 1) && r.j.lv.used === 4 && light(Q).nat === 45, 'expert x4: 15 light');
  // order of spending: nat, then sub, then paid
  const O = await player(); await lvme({ pk: O.pk }); setProg(O, { nat: 3, sub: 4, paid: 10 });
  r = await sub(O, S, 1, 4); const o = light(O);
  ok(r.j.lv.used === 4 && r.j.lv.cost === 15 && o.nat === 0 && o.sub === 0 && o.paid === 2, 'spend order: nat 3, sub 4, paid 8 -> ' + JSON.stringify(o));
  const lgs = qa('SELECT pool, amt FROM lightlog WHERE ph = ? AND kind = ? ORDER BY id', O.ph, 'spend'); ok(lgs.map(x => x.pool + x.amt).join() === 'nat-3,sub-4,paid-8', 'lightlog: one row per pool');
  // not enough light: drops to the highest multiplier that can be paid
  const D = await player(); await lvme({ pk: D.pk }); setProg(D, { nat: 7, sub: 0, paid: 0 });
  r = await sub(D, S, 1, 4); ok(r.j.lv.used === 2 && r.j.lv.cost === 5 && light(D).nat === 2 && r.j.lv.gain === L.xpClear(S, 1, 10000, 2, 1), 'not enough for x4 / x3: x2 (7 light -> 2)');
  r = await sub(D, S, 1, 4); ok(r.j.lv.used === 1 && r.j.lv.cost === 0 && light(D).nat >= 2 && light(D).nat <= 3, 'not enough for anything: x1, nothing spent, never negative (nat ' + light(D).nat + ')');
  setProg(D, { nat: 0, sub: 0, paid: 0, nts: Date.now() }); r = await sub(D, S, 1, 3); ok(r.j.lv.used === 1 && light(D).nat === 0 && light(D).sub === 0 && light(D).paid === 0, 'zero light: x1 and still 0');
  // daily cap of 200
  const C = await player(); await lvme({ pk: C.pk }); setProg(C, { paid: 500, day: today(), dspend: 195 });
  r = await sub(C, S, 1, 2); ok(r.j.lv.used === 2 && prog(C).dspend === 200 && r.j.lv.light.spent === 200, 'daily cap: 195 + 5 = 200 is allowed');
  r = await sub(C, S, 1, 2); ok(r.j.lv.used === 1 && r.j.lv.cost === 0 && prog(C).dspend === 200, 'daily cap: over 200 -> x1');
  setProg(C, { dspend: 190 }); r = await sub(C, S, 1, 4); ok(r.j.lv.used === 3 && r.j.lv.cost === 10 && prog(C).dspend === 200, 'daily cap: x4 (15) would pass 200 -> x3 (10)');
  // a new game day clears the day counters
  setProg(C, { day: today() - 1, dspend: 200, dsec: 99999 }); r = await sub(C, S, 1, 2);
  ok(r.j.lv.used === 2 && prog(C).day === today() && prog(C).dspend === 5 && r.j.lv.half === false && prog(C).dsec === Math.round(L.playSecs(S, 1)), 'a new day: counters start again, full experience');
  r = await lvme({ pk: C.pk }); ok(r.j.lv.dsec === prog(C).dsec, '/lv/me shows today\'s numbers');
  setProg(C, { day: today() - 1, dsec: 99999, dspend: 77 }); r = await lvme({ pk: C.pk }); ok(r.j.lv.dsec === 0 && r.j.lv.half === false && r.j.lv.light.spent === 0, '/lv/me: yesterday\'s numbers do not show as today\'s');
}

// ---- half experience after an hour of play a day ----
{
  const P = await player(); await lvme({ pk: P.pk }); setProg(P, { day: today(), dsec: 3599 });
  let r = await sub(P, S, 1, 1); ok(r.j.lv.gain === L.xpClear(S, 1, 10000, 1, 1) && r.j.lv.half === true, 'half: 3599 s played so far is still full; the song takes it past 3600');
  r = await sub(P, S, 1, 1); ok(r.j.lv.gain === L.xpClear(S, 1, 10000, 1, 0.5) && r.j.lv.gain < L.xpClear(S, 1, 10000, 1, 1), 'half: after 3600 s the next song gives half');
  const e = await sub(P, S, 1, 2); ok(e.j.lv.gain === L.xpClear(S, 1, 10000, 2, 0.5) && e.j.lv.base === L.xpClear(S, 1, 10000, 1, 0.5), 'half: the multiplier applies on the halved base');
  setProg(P, { day: today() - 1 }); r = await sub(P, S, 1, 1); ok(r.j.lv.gain === L.xpClear(S, 1, 10000, 1, 1), 'half: a new day is full again');
}

// ---- light refill and the pass in a real settle ----
{
  const P = await player(); await lvme({ pk: P.pk });
  setProg(P, { nat: 10, nts: Date.now() - 6 * 360000 - 1000 }); let r = await lvme({ pk: P.pk });
  ok(r.j.lv.light.nat === 16 && r.j.lv.light.next > 0 && r.j.lv.light.next <= 360000, '/lv/me: natural light has refilled: ' + JSON.stringify(r.j.lv.light));
  r = await sub(P, S, 1, 3); ok(r.j.lv.light.nat === 6 && r.j.lv.light.next > 0, 'spending from a partly refilled pool keeps the clock');
  const t0 = prog(P).nts; ok(t0 > Date.now() - 360000 - 5000, 'nts is kept (remainder), not reset');
  const F = await player(); await lvme({ pk: F.pk }); r = await sub(F, S, 1, 2);   // from full: the clock starts now
  ok(prog(F).nat === 55 && Math.abs(prog(F).nts - Date.now()) < 5000, 'spending from a full pool starts the refill clock');
  setProg(P, { pass: Date.now() + 86400e3, nat: 60, nts: Date.now() - 5 * 360000 }); r = await lvme({ pk: P.pk });
  ok(r.j.lv.light.cap === 120 && r.j.lv.light.nat === 65 && r.j.lv.pass > Date.now(), 'pass active: cap 120, keeps refilling past 60');
  setProg(P, { pass: Date.now() - 1000, nat: 100 }); r = await lvme({ pk: P.pk });
  ok(r.j.lv.light.cap === 60 && r.j.lv.light.nat === 100 && r.j.lv.pass === 0, 'pass ended: 100 stays, only stops refilling');
  r = await sub(P, S, 1, 4); ok(r.j.lv.light.nat === 85 && r.j.lv.used === 4, 'spending above the cap works normally');
}

// ---- failed and quit runs ----
{
  const P = await player(); await lvme({ pk: P.pk }); setProg(P, { nat: 60 });
  const M = null, log = [...Array.from({ length: 10 }, () => [0, 300]), M, M, M, M, M, M];   // difficulty 2: 6 misses end a full-life run
  let r = await end(P, S, 2, 'fail', 4, log);
  const accSo = 200 * 500 / 16 / 10000, ex = Math.round(70 * (0.5 + 0.5 * accSo) * L.lenF(S, 2) * (16 / N(S, 2)) * 0.5);
  ok(r.j.ok && r.j.lv.gain === ex && ex > 0 && r.j.lv.used === 1 && r.j.lv.cost === 0 && light(P).nat === 60 && prog(P).xp === ex, 'fail: half-weight experience for the settled part, no multiplier, no light spent (' + ex + ')');
  ok(prog(P).dsec === Math.round(L.playSecs(S, 2) * 16 / N(S, 2)) && prog(P).mult === 1, 'fail: play seconds count the settled share');
  r = await end(P, S, 2, 'fail', 1, [M, M, M, M, M, M]); ok(r.j.ok && r.j.lv.gain === Math.round(70 * 0.5 * L.lenF(S, 2) * (6 / N(S, 2)) * 0.5), 'fail with no hit: base 0.5');
  r = await end(P, S, 2, 'fail', 1, [M, M, M]); ok(r.s === 400 && r.j.error === 'log', 'fail: an impossible log is refused and nothing is settled');
  const xp0 = prog(P).xp;
  r = await end(P, S, 1, 'quit', 4); ok(r.j.ok && r.j.lv.gain === 0 && r.j.lv.used === 1 && prog(P).xp === xp0 && light(P).nat === 60, 'quit: 0 experience, no light spent');
  // fail with the settle order (seq): the log is longer than the beats settled
  const lg2 = [[0, 300], [0, 300], M, M, M, M, M, M]; // 8 beats
  r = await end(P, S, 2, 'fail', 1, lg2); ok(r.j.ok, 'fail: another valid log');
  // half applies to failures too
  setProg(P, { day: today(), dsec: 4000 }); const x1 = prog(P).xp; r = await end(P, S, 2, 'fail', 1, log);
  ok(r.j.lv.gain === Math.round(70 * (0.5 + 0.5 * accSo) * L.lenF(S, 2) * (16 / N(S, 2)) * 0.5 * 0.5) && prog(P).xp === x1 + r.j.lv.gain, 'fail: half experience after an hour too');
}

// ---- leveling up and rewards ----
{
  const P = await player(); await lvme({ pk: P.pk });
  const e = L.xpClear(S, 1, 10000, 1, 1); setProg(P, { xp: L.needAt(1) - 1 });
  let r = await sub(P, S, 1, 1);
  ok(r.j.lv.lv === 2 && r.j.lv.from.lv === 1 && r.j.lv.ups.join() === '2' && r.j.lv.rewards.filter(x => x.includes('lvtest')).join() === 'title.lvtest2', 'level up: lv 2, ups [2], rewards [title.lvtest2]: ' + JSON.stringify(r.j.lv));
  ok(!!q1("SELECT 1 FROM ents WHERE pid = ? AND item = 'title.lvtest2' AND src = 'lv' AND ref = '2'", P.id) && !q1("SELECT 1 FROM ents WHERE pid = ? AND item = 'frame.lvtest3'", P.id) && prog(P).lvr === 2, 'rewards: granted to ents (src lv), lvr = 2, level 3 reward not yet');
  ok(r.j.lv.title === 'title.lvtest2', 'state.title = the highest title reward reached');
  // several levels at once
  setProg(P, { xp: 0, lvr: 0 }); sql.prepare("DELETE FROM ents WHERE pid = ? AND src = 'lv'").run(P.id);
  setProg(P, { xp: 0 });
  r = await sub(P, LONG, 4, 4); ok(r.j.lv.lv === 3 && r.j.lv.ups.join() === '2,3' && r.j.lv.rewards.join() === 'title.lvtest2,frame.lvtest3', 'leveling past two levels: ups and both rewards ' + JSON.stringify(r.j.lv));
  ok(qa("SELECT item FROM ents WHERE pid = ? AND src = 'lv' AND item LIKE '%lvtest%' ORDER BY item", P.id).map(x => x.item).join() === 'frame.lvtest3,title.lvtest2' && prog(P).lvr === 3, 'both rewards in ents');
  // no repeat
  r = await sub(P, S, 1, 1); ok(r.j.lv.rewards.length === 0 && qa("SELECT 1 FROM ents WHERE pid = ? AND src = 'lv' AND item LIKE '%lvtest%'", P.id).length === 2, 'no new rewards without a new level ' + JSON.stringify(r.j.lv));
  // star levels: Lv101+
  let cum = 0; for (let n = 1; n < 100; n++) cum += L.needAt(n);
  setProg(P, { xp: cum + 40492 * 2 + 10 }); r = await lvme({ pk: P.pk }); ok(r.j.lv.lv === 102 && r.j.lv.star === 2 && r.j.lv.need === 40492 && r.j.lv.cur === 10, 'Lv102 shows star 2');
  setProg(P, { xp: cum - 1 }); r = await lvme({ pk: P.pk }); ok(r.j.lv.lv === 99 && r.j.lv.star === 0, 'Lv99 has no star');
  // catch-up: a registered player who is owed rewards gets them from /lv/me
  const Q = await player(); await lvme({ pk: Q.pk }); setProg(Q, { xp: 1000, lvr: 0 });
  await lvme({ pk: Q.pk }); ok(!!q1("SELECT 1 FROM ents WHERE pid = ? AND item = 'frame.lvtest3'", Q.id) && prog(Q).lvr === L.levelOf(1000).lv, '/lv/me hands out rewards that are owed');
}

// ---- no nickname: anonymous tickets, and the backfill when a nickname is chosen ----
{
  const U = anon(); await lvme({ pk: U.pk });
  const tk = ticket(0, U.ph, S, 1, 2), log = perfect(S, 1);
  let r = await post('/lb/submit', { run: tk, pk: U.pk, log });
  ok(r.s === 400 && r.j.error === 'noname' && r.j.lv && r.j.lv.gain === L.xpClear(S, 1, 10000, 2, 1) && r.j.lv.used === 2 && prog(U).xp === r.j.lv.gain && light(U).nat === 55, 'anonymous submit: error noname (old games unchanged) plus lv; experience and light settled: ' + JSON.stringify(r.j));
  ok(!q1('SELECT 1 FROM players WHERE ph = ?', U.ph) && qa('SELECT * FROM scores').every(s => true) && !q1("SELECT 1 FROM ents WHERE src = 'lv' AND pid = 0"), 'anonymous: no player row, no ents');
  const nS = q1('SELECT COUNT(*) AS n FROM scores').n; await post('/lb/submit', { run: ticket(0, U.ph, S, 1), pk: U.pk, log }); ok(q1('SELECT COUNT(*) AS n FROM scores').n === nS, 'anonymous: nothing on the boards');
  r = await post('/lb/submit', { run: tk, pk: U.pk, log }); ok(r.s === 400 && r.j.error === 'ticket' && !r.j.lv, 'anonymous: a ticket works once');
  const xp1 = prog(U).xp;
  const X = anon(); r = await post('/lb/submit', { run: ticket(0, U.ph, S, 1), pk: X.pk, log }); ok(r.s === 400 && r.j.error === 'ticket', "anonymous: another key cannot use somebody's ticket");
  r = await post('/lb/submit', { run: ticket(0, null, S, 1), pk: U.pk, log }); ok(r.j.error === 'ticket', 'anonymous: a ticket that was never tied to a key hash is refused');
  r = await post('/lb/submit', { run: ticket(777, U.ph, S, 1), pk: U.pk, log }); ok(r.j.error === 'noname' && !r.j.lv, 'a ticket naming some player that is not this key: noname, nothing settled');
  r = await post('/lb/submit', { run: legacy(S, 1, 600e3), pk: U.pk, log }); ok(r.j.error === 'noname' && !r.j.lv, 'legacy ticket without a nickname: noname as before, nothing settled');
  ok(prog(U).xp === xp1, 'those did not change experience');
  r = await post('/lb/submit', { run: ticket(0, U.ph, S, 1, 1, 1000), pk: U.pk, log }); ok(r.j.error === 'ticket', 'anonymous: too early for the song length');
  r = await post('/lb/submit', { run: ticket(0, U.ph, S, 1), pk: U.pk, log: [] }); ok(r.j.error === 'log' || r.s === 400, 'anonymous: a bad log is refused');
  // end: fail and quit
  r = await end(U, S, 2, 'fail', 1, [null, null, null, null, null, null]); ok(r.s === 200 && r.j.ok && r.j.lv && r.j.lv.gain >= 0, 'anonymous: /lb/end fail works');
  const xp2 = prog(U).xp; r = await end(U, S, 1, 'quit'); ok(r.s === 200 && r.j.lv.gain === 0 && prog(U).xp === xp2, 'anonymous: quit gives nothing');
  r = await post('/lb/end', { run: ticket(0, U.ph, S, 1, 1, 900e3), pk: X.pk, kind: 'quit' }); ok(r.j.error === 'ticket', 'anonymous: end with another key refused');
  // register: the rewards owed are granted
  setProg(U, { xp: 2000, lvr: 0 });
  r = await post('/lb/name', { pk: U.pk, name: 'Anon' + crypto.randomBytes(3).toString('hex') }); ok(r.j.ok, 'anonymous: nickname chosen');
  const id = r.j.id, want = L.levelOf(2000).lv;
  ok(want >= 3 && qa("SELECT item FROM ents WHERE pid = ? AND src = 'lv' AND item LIKE '%lvtest%' ORDER BY item", id).map(x => x.item).join() === 'frame.lvtest3,title.lvtest2' && prog(U).lvr === want, 'nickname: level rewards earned as an anonymous player are granted now ');
  ok(prog(U).xp === 2000, 'nickname: experience carries over');
  // a ticket from before the nickname still works afterwards (same key)
  const old = ticket(0, U.ph, S, 1); const xpB = prog(U).xp;
  r = await post('/lb/submit', { run: old, pk: U.pk, log }); ok(r.j.ok && r.j.lv && prog(U).xp === xpB + r.j.lv.gain && !!q1('SELECT 1 FROM scores WHERE pid = ?', id), 'a pid 0 ticket started before the nickname is accepted afterwards for the same key (board and experience)');
  U.id = id;
  // delete as anonymous
  const W = anon(); await post('/lb/start', { song: S, d: 1, pk: W.pk, m: 1 }); setProg(W, { paid: 40 }); await sub(W, S, 1, 1);
  ok(!!prog(W) && qa('SELECT 1 FROM runs WHERE ph = ?', W.ph).length >= 1, 'anonymous: has data');
  r = await post('/lb/delete', { pk: W.pk }); ok(r.j.ok && !prog(W) && qa('SELECT 1 FROM runs WHERE ph = ?', W.ph).length === 0 && qa('SELECT 1 FROM lightlog WHERE ph = ?', W.ph).length === 0, 'delete: an anonymous key loses prog, runs and lightlog');
  const wr = q1('SELECT * FROM wiped WHERE ph = ?', W.ph); ok(wr && wr.paid === 40, 'delete: unspent bought light is remembered in wiped (40)');
}

// ---- legacy tickets and old games ----
{
  const P = await player(); await lvme({ pk: P.pk });
  const x0 = prog(P).xp; let r = await post('/lb/submit', { run: legacy(S, 1, 600e3), pk: P.pk, log: perfect(S, 1) });
  ok(r.j.ok && r.j.improved && !('lv' in r.j) && prog(P).xp === x0, 'legacy ticket: no experience, no lv in the answer');
  r = await post('/lb/end', { run: legacy(S, 1, 600e3), pk: P.pk, kind: 'quit' }); ok(r.s === 400 && r.j.error === 'ticket', 'legacy ticket cannot end a run (as before)');
  // old game: registered, no m -> x1
  const s = await post('/lb/start', { song: S, d: 1, pk: P.pk }); const p = s.j.run.split('.'); sql.prepare('UPDATE runs SET ts = ts - 600000 WHERE nonce = ?').run(p[3]);
  const t2 = sign([p[0], p[1], +p[2] - 600000, p[3], p[4]].join('.'));
  r = await post('/lb/submit', { run: t2, pk: P.pk, log: perfect(S, 1) }); ok(r.j.ok && r.j.lv.used === 1 && r.j.lv.cost === 0 && r.j.lv.gain === L.xpClear(S, 1, 10000, 1, 1), 'old game (no m): x1 experience');
  // the existing answer fields are untouched
  ok(['ok', 'improved', 'acc', 'err', 'score', 'rank', 'me', 'total', 'ach'].every(k => k in r.j), 'submit answer keeps every old field');
}

// ---- a settle never counts twice, and survives a rival write ----
{
  const P = await player(); await lvme({ pk: P.pk });
  const tk = ticket(P.id, P.ph, S, 1, 2), log = perfect(S, 1), req = () => post('/lb/submit', { run: tk, pk: P.pk, log });
  const [a, b] = await Promise.all([req(), req()]); const oks = [a, b].filter(x => x.j.ok);
  ok(oks.length === 1 && prog(P).xp === L.xpClear(S, 1, 10000, 2, 1) && light(P).nat === 55, 'the same ticket twice at once: settled once ' + JSON.stringify([a.j.ok, b.j.ok, a.j.error, b.j.error, prog(P), light(P)]));
  ok(qa('SELECT 1 FROM lightlog WHERE ph = ? AND kind = ?', P.ph, 'spend').length === 1, 'and logged once');
  // a rival changes the row between the read and the write: the guarded update retries on fresh data
  const xp0 = prog(P).xp, pd0 = prog(P).paid;
  hook = () => sql.prepare('UPDATE prog SET xp = xp + 1000, paid = paid + 7 WHERE ph = ?').run(P.ph);
  const r = await sub(P, S, 1, 1);
  ok(r.j.lv && prog(P).xp === xp0 + 1000 + r.j.lv.gain && prog(P).paid === pd0 + 7, 'compare-and-set: a rival write is not lost (xp + 1000 and paid + 7 kept)');
  // numbers can never go below 0, whatever happens
  setProg(P, { nat: 0, sub: 0, paid: 0 }); await sub(P, S, 1, 4);
  const z = prog(P); ok(z.nat >= 0 && z.sub >= 0 && z.paid >= 0 && z.xp >= 0 && z.dspend >= 0, 'nothing is negative');
  // a ticket row older than the migration (no m / ph) still settles as x1
  const nonce = crypto.randomBytes(8).toString('hex'), ts = Date.now() - 600e3; sql.prepare('INSERT INTO runs (nonce, pid, song, d, ts, done) VALUES (?, ?, ?, ?, ?, 0)').run(nonce, P.id, S, 1, ts);
  const r2 = await post('/lb/submit', { run: sign([S, 1, ts, nonce, P.id].join('.')), pk: P.pk, log }); ok(r2.j.ok && r2.j.lv.used === 1, 'a runs row without m / ph (older ticket): x1');
}

// ---- delete of a registered player ----
{
  const P = await player(); await lvme({ pk: P.pk }); setProg(P, { paid: 120 }); await sub(P, S, 1, 2);
  await shop('/shop/state', { pk: P.pk });
  ok(!!prog(P) && qa('SELECT 1 FROM lightlog WHERE ph = ?', P.ph).length >= 1 && qa("SELECT 1 FROM ents WHERE pid = ? AND src = 'lv'", P.id).length >= 0, 'player has level data');
  const paid = prog(P).paid; const r = await post('/lb/delete', { pk: P.pk });
  ok(r.j.ok && !prog(P) && !q1('SELECT 1 FROM players WHERE ph = ?', P.ph) && qa('SELECT 1 FROM lightlog WHERE ph = ?', P.ph).length === 0 && qa('SELECT 1 FROM runs WHERE pid = ?', P.id).length === 0, 'delete: prog, lightlog, runs and the player are gone');
  const w = q1('SELECT * FROM wiped WHERE ph = ?', P.ph); ok(w && w.paid === paid && paid > 0, 'delete: unspent bought light kept in wiped: ' + paid);
  ok((await post('/lb/delete', { pk: P.pk })).j.ok, 'delete twice is fine');
  sql.prepare('INSERT INTO wiped (ph, ts, paid) VALUES (?, ?, 5)').run('old', Date.now() - 366 * 86400e3); await L.levelSweep(env); ok(!q1("SELECT 1 FROM wiped WHERE ph = 'old'"), 'wiped rows are kept one year (sweep)');
}

// ---- light purchases ----
const txOf = (product, o = {}) => tx({ productId: 'com.nocticat.pingponglight.' + product, type: 'Consumable', ...o });
const buy = (P, t, e = env) => shop('/iap/verify', { pk: P.pk, jws: jws(PKI, t) }, e);
{
  const P = await player(), now = Date.now(); await lvme({ pk: P.pk });
  let r = await shop('/iap/verify', { pk: P.pk, jws: jws(PKI, txOf('light.s')) }, { ...env, IAP_ON: '0' }); ok(r.s === 503 && r.j.error === 'off' && prog(P).paid === 0, 'IAP_ON is not 1: nothing is granted');
  const s1 = txOf('light.s'); r = await buy(P, s1);
  ok(r.j.ok && r.j.results[0].status === 'granted' && r.j.results[0].pts === 90 && prog(P).paid === 90, 'light.s: 90 to the bought pool: ' + JSON.stringify(r.j.results));
  ok(r.j.state && r.j.state.light && r.j.state.light.paid === 90 && r.j.state.light.total === 150 && r.j.state.lv && r.j.state.lv.light.total === 150, 'the answer carries the light total (state.light, state.lv)');
  ok(q1('SELECT * FROM iaptx WHERE txid = ?', s1.transactionId).product === 'light.s' && q1("SELECT * FROM lightlog WHERE ph = ? AND kind = 'buy'", P.ph).amt === 90, 'iaptx and lightlog rows');
  r = await buy(P, s1); ok(r.j.results[0].status === 'dup' && prog(P).paid === 90 && qa("SELECT 1 FROM lightlog WHERE kind = 'buy' AND ph = ?", P.ph).length === 1, 'the same transaction again: nothing doubled');
  r = await shop('/iap/verify', { pk: P.pk, jws: [jws(PKI, s1), jws(PKI, s1)] }); ok(prog(P).paid === 90, 'the same transaction twice in one request: still once');
  r = await buy(P, txOf('light.m')); ok(prog(P).paid === 390, 'light.m: 300');
  r = await buy(P, txOf('light.l')); ok(prog(P).paid === 1470, 'light.l: 1080');
  r = await buy(P, txOf('light.s', { environment: 'Sandbox' })); ok(r.j.results[0].status === 'granted' && prog(P).paid === 1560, 'a sandbox purchase gives light too');
  // refused
  r = await buy(P, txOf('light.s', { type: 'Non-Consumable' })); ok(r.j.results[0].status === 'bad' && r.j.results[0].err === 'type', 'wrong type refused');
  r = await buy(P, txOf('light.s', { bundleId: 'com.evil' })); ok(r.j.results[0].err === 'bundle', 'wrong bundle refused');
  r = await buy(P, txOf('light.s', { transactionId: 'abc' })); ok(r.j.results[0].err === 'tx', 'bad transaction id refused');
  r = await buy(P, txOf('light.s', { environment: 'Xcode' })); ok(r.j.results[0].err === 'env', 'bad environment refused');
  r = await buy(P, txOf('light.xl')); ok(r.j.results[0].err === 'product', 'unknown product refused');
  const evil = chain(); r = await shop('/iap/verify', { pk: P.pk, jws: jws(evil, txOf('light.l')) }); ok(r.j.results[0].status === 'bad' && prog(P).paid === 1560, 'a receipt from a foreign chain gives nothing');
  const [h, p, sg] = jws(PKI, txOf('light.l')).split('.'); const p2 = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), productId: 'com.nocticat.pingponglight.light.l', transactionId: '99999991' })).toString('base64url');
  r = await shop('/iap/verify', { pk: P.pk, jws: h + '.' + p2 + '.' + sg }); ok(r.j.results[0].status === 'bad' && prog(P).paid === 1560, 'an edited receipt gives nothing');
  // another player cannot take it
  const Q = await player(); r = await buy(Q, s1); ok(r.j.results[0].status === 'taken' && !prog(Q) || (prog(Q) && prog(Q).paid === 0), 'light never moves to another player: taken');
  // refund: from the bought pool, down to 0 at most
  const R = await player(); await lvme({ pk: R.pk }); const rt = txOf('light.m'); await buy(R, rt); setProg(R, { paid: 120 });   // 180 already spent
  r = await buy(R, { ...rt, revocationDate: Date.now(), revocationReason: 0 });
  ok(r.j.results[0].status === 'revoked' && prog(R).paid === 0, 'refund: takes back what is left, not below 0');
  const lr = qa("SELECT * FROM lightlog WHERE ph = ? AND kind = 'refund'", R.ph); ok(lr.length === 1 && lr[0].amt === -120 && lr[0].pool === 'paid' && lr[0].ref === rt.transactionId, 'refund: lightlog -120');
  ok(!q1('SELECT 1 FROM players WHERE ph = ? AND hidden = 1', R.ph) && q1('SELECT 1 FROM players WHERE ph = ?', R.ph), 'refund does not lock the account');
  r = await buy(R, { ...rt, revocationDate: Date.now() }); ok(r.j.results[0].status === 'revoked' && prog(R).paid === 0 && qa("SELECT 1 FROM lightlog WHERE ph = ? AND kind = 'refund'", R.ph).length === 1, 'refund twice: taken back once');
  r = await buy(R, rt); ok(r.j.results[0].status === 'revoked' && prog(R).paid === 0, 'an old copy of a refunded receipt does not bring the light back');
  const rn = txOf('light.s', { revocationDate: Date.now() }); r = await buy(R, rn); ok(r.j.results[0].status === 'revoked' && prog(R).paid === 0 && q1('SELECT revoked FROM iaptx WHERE txid = ?', rn.transactionId).revoked === 1, 'a refund seen first: nothing was given');
  r = await buy(R, { ...rn, revocationDate: undefined }); ok(r.j.results[0].status === 'revoked' && prog(R).paid === 0, '... and the later copy gives nothing');
  // a refund after part was spent from other pools: still only paid is touched
  const T = await player(); await lvme({ pk: T.pk }); const tt = txOf('light.l'); await buy(T, tt); setProg(T, { sub: 50, nat: 33 }); await buy(T, { ...tt, revocationDate: Date.now() });
  ok(prog(T).paid === 0 && prog(T).sub === 50 && prog(T).nat === 33, 'refund only touches the bought pool');
}

// ---- the 30-day light pass (a consumable: 30 light every game day, paid by itself) ----
{
  const DAY = 86400e3, endOf = r => (r.pday + r.pleft + 1) * 86400000 - 14400000;   // the end of the last pay day
  const dayPasses = P => sql.prepare('UPDATE prog SET pday = pday - 1 WHERE ph = ?').run(P.ph);   // a game day goes by (pay days are compared with the real today)
  const P = await player(); await lvme({ pk: P.pk });
  const t1 = txOf('pass'); let r = await buy(P, t1), row = prog(P);
  ok(r.j.results[0].status === 'granted' && r.j.results[0].pts === 900 && row.sub === 30 && row.pleft === 29 && row.pday === today() && row.paid === 0, 'pass: the day of purchase pays 30, 29 days are left (not 900 at once): ' + JSON.stringify([row.sub, row.pleft, row.pday]));
  ok(row.pass === endOf(row) && row.pass > Date.now() + 28 * DAY && row.pass <= Date.now() + 30 * DAY, 'pass end = the end of the last pay day (about 30 days)');
  ok(r.j.state.lv.light.pday === 29 && r.j.state.light.pday === 29 && r.j.state.lv.pass === row.pass && r.j.state.light.cap === 120 && r.j.state.light.sub === 30, 'state: light.pday = pay days still to come (29), pass end, cap 120');
  const lg = qa("SELECT kind, amt, pool FROM lightlog WHERE ph = ? ORDER BY id", P.ph).map(x => x.kind + ':' + x.amt).join(); ok(lg === 'pass:30,pass_day:30', 'lightlog: the purchase row (30 days, pool pleft) and one pass_day row: ' + lg);
  ok(q1("SELECT pool FROM lightlog WHERE ph = ? AND kind = 'pass'", P.ph).pool === 'pleft' && q1("SELECT SUM(amt) AS s FROM lightlog WHERE ph = ? AND pool = 'sub'", P.ph).s === prog(P).sub, 'lightlog: the pass purchase is not light: the sub rows add up to the pool (' + prog(P).sub + ')');
  r = await buy(P, t1); ok(r.j.results[0].status === 'dup' && prog(P).sub === 30 && prog(P).pleft === 29, 'the same transaction again: dup, nothing added');
  r = await lvme({ pk: P.pk }); ok(prog(P).sub === 30 && r.j.lv.light.pday === 29, 'the same day: nothing more is paid');
  dayPasses(P); r = await lvme({ pk: P.pk }); ok(prog(P).sub === 60 && prog(P).pleft === 28 && r.j.lv.light.pday === 28, 'the next day: +30');
  for (let i = 0; i < 5; i++) dayPasses(P); r = await lvme({ pk: P.pk }); ok(prog(P).sub === 210 && prog(P).pleft === 23 && prog(P).pday === today(), 'five days away: one visit pays 150');
  ok(q1("SELECT amt FROM lightlog WHERE ph = ? AND kind = 'pass_day' ORDER BY id DESC", P.ph).amt === 150 && qa("SELECT 1 FROM lightlog WHERE ph = ? AND kind = 'pass_day'", P.ph).length === 3, 'one pass_day row per catch-up (amt 150)');
  setProg(P, { pday: today() - 400 }); await lvme({ pk: P.pk }); ok(prog(P).sub === 210 + 23 * 30 && prog(P).pleft === 0, 'a very long absence pays only the pending days (23), never more');
  r = await lvme({ pk: P.pk }); dayPasses(P); r = await lvme({ pk: P.pk }); ok(prog(P).sub === 210 + 23 * 30, 'with none left nothing is paid any more');
  ok(r.j.lv.light.pday === 0, 'light.pday 0 when none is left');
  // the whole 30 days, then it stops (day 31 gives nothing)
  const W = await player(); await lvme({ pk: W.pk }); await buy(W, txOf('pass')); let paidDays = 1;
  for (let i = 0; i < 40; i++) { const b = prog(W).sub; dayPasses(W); await lvme({ pk: W.pk }); if (prog(W).sub > b) paidDays++; }
  ok(paidDays === 30 && prog(W).sub === 900 && prog(W).pleft === 0, 'exactly 30 days are paid (900 in all), day 31 on gives nothing: ' + paidDays);
  // stacking: more days, still 30 a day
  const K = await player(); await lvme({ pk: K.pk }); await buy(K, txOf('pass')); const e0 = prog(K).pass; await buy(K, txOf('pass'));
  ok(prog(K).pleft === 59 && prog(K).sub === 30 && prog(K).pass === e0 + 30 * DAY, 'a second pass adds 30 more days (59 pending), the daily amount stays 30');
  dayPasses(K); await lvme({ pk: K.pk }); ok(prog(K).sub === 60 && prog(K).pleft === 58, 'a day later: +30 only (not 60)');
  r = await buy(K, txOf('pass', { quantity: 2 })); ok(prog(K).pleft === 118 && r.j.results[0].pts === 1800, 'quantity 2 adds 60 days');
  await buy(K, txOf('pass', { quantity: 99 })); ok(prog(K).pleft === 118 + 300, 'quantity is clamped to 10');
  r = await buy(K, txOf('pass', { type: 'Auto-Renewable Subscription' })); ok(r.j.results[0].err === 'type', 'the auto-renewable subscription type is refused');
  r = await buy(K, txOf('pass', { type: 'Non-Renewing Subscription' })); ok(r.j.results[0].status === 'granted', 'the pass is also accepted as a Non-Renewing Subscription');
  r = await buy(K, txOf('light.m', { type: 'Non-Renewing Subscription' })); ok(r.j.results[0].err === 'type', 'the light packs stay Consumable only');
  r = await buy(K, txOf('light.m', { type: 'Non-Consumable' })); ok(r.j.results[0].err === 'type', 'a light pack as a Non-Consumable: refused');
  // nothing pending: buying long after does not pay old days
  const G = await player(); await lvme({ pk: G.pk }); setProg(G, { pday: today() - 200, pleft: 0 }); await buy(G, txOf('pass'));
  ok(prog(G).sub === 30 && prog(G).pleft === 29 && prog(G).pday === today(), 'bought with nothing pending long after: only today is paid, not the old days');
  // a pass that ended: counted again from today
  const H = await player(); await lvme({ pk: H.pk }); await buy(H, txOf('pass')); setProg(H, { pleft: 0, pday: today() - 3, pass: Date.now() - DAY, sub: 0 }); await buy(H, txOf('pass'));
  ok(prog(H).sub === 30 && prog(H).pleft === 29 && prog(H).pass > Date.now() + 28 * DAY, 'a new pass after the old one ended starts from today');
  // spending uses the pass pool after the natural pool
  setProg(P, { nat: 2, sub: 40 }); r = await sub(P, S, 1, 2); ok(light(P).nat === 0 && light(P).sub === 37, 'pass light is spent after the natural pool');
  // refunds
  const R = await player(); await lvme({ pk: R.pk }); const rt = txOf('pass'); await buy(R, rt); for (let i = 0; i < 3; i++) dayPasses(R); await lvme({ pk: R.pk });   // 4 days paid (120), 26 pending
  ok(prog(R).sub === 120 && prog(R).pleft === 26, 'test: 4 days paid');
  r = await buy(R, { ...rt, revocationDate: Date.now() }); row = prog(R);
  ok(r.j.results[0].status === 'revoked' && row.pleft === 0 && row.sub === 0 && row.pass >= Date.now() && row.pass <= endOf({ pday: today(), pleft: 0 }), 'refund: the 26 pending days go, the 4 paid days (120) come back from the pass pool, the pass ends with today');
  ok(q1("SELECT amt FROM lightlog WHERE ph = ? AND kind = 'refund_days'", R.ph).amt === -26 && q1("SELECT amt FROM lightlog WHERE ph = ? AND kind = 'refund'", R.ph).amt === -120, 'refund log: -26 days, -120 light');
  ok(q1("SELECT SUM(amt) AS s FROM lightlog WHERE ph = ? AND pool = 'sub'", R.ph).s === 0, 'after the refund the sub rows of lightlog add up to 0 = the pool');
  r = await buy(R, { ...rt, revocationDate: Date.now() }); ok(prog(R).sub === 0 && prog(R).pleft === 0 && qa("SELECT 1 FROM lightlog WHERE ph = ? AND kind = 'refund_days'", R.ph).length === 1, 'refunded once');
  r = await buy(R, rt); ok(r.j.results[0].status === 'revoked' && prog(R).pleft === 0, 'an old copy of the refunded receipt gives nothing');
  dayPasses(R); await lvme({ pk: R.pk }); ok(prog(R).sub === 0, 'after the refund no more is paid');
  // refund when the pool was spent: down to 0 at most; refund on the day of purchase
  const R2 = await player(); await lvme({ pk: R2.pk }); const rt2 = txOf('pass'); await buy(R2, rt2); for (let i = 0; i < 3; i++) dayPasses(R2); await lvme({ pk: R2.pk }); setProg(R2, { sub: 50 });
  await buy(R2, { ...rt2, revocationDate: Date.now() }); ok(prog(R2).sub === 0 && prog(R2).pleft === 0, 'refund: more owed than is in the pool: 0, not negative');
  const R3 = await player(); await lvme({ pk: R3.pk }); const rt3 = txOf('pass'); await buy(R3, rt3); await buy(R3, { ...rt3, revocationDate: Date.now() });
  ok(prog(R3).sub === 0 && prog(R3).pleft === 0, 'refund on the day of purchase: the first day paid (30) comes back too');
  const R4 = await player(); await lvme({ pk: R4.pk }); const q2 = txOf('pass', { quantity: 2 }); await buy(R4, q2); const keep = txOf('pass'); await buy(R4, keep);   // 60 + 30 days
  await buy(R4, { ...q2, revocationDate: Date.now() }); ok(prog(R4).pleft === 29 && prog(R4).sub === 30, 'refund of a quantity 2 pass takes its 60 pending days (89 - 60 = 29), the 30 paid stay: ' + JSON.stringify([prog(R4).pleft, prog(R4).sub]));
  ok(q1("SELECT SUM(amt) AS s FROM lightlog WHERE ph = ? AND pool = 'sub'", R4.ph).s === 30 && q1("SELECT amt FROM lightlog WHERE ph = ? AND kind = 'refund_days'", R4.ph).amt === -60, 'refund log: -60 days, no light taken');
  // two readers at once pay once
  const C = await player(); await lvme({ pk: C.pk }); setProg(C, { pleft: 5, pday: today() - 3, sub: 0 });
  const rs = await Promise.all(Array.from({ length: 20 }, () => lvme({ pk: C.pk }))); row = prog(C);
  ok(rs.every(x => x.s === 200) && row.sub === 90 && row.pleft === 2 && row.pday === today() && qa("SELECT amt FROM lightlog WHERE ph = ? AND kind = 'pass_day'", C.ph).map(x => x.amt).join() === '90', '20 parallel /lv/me: the 3 owed days are paid once (90)');
  setProg(C, { pleft: 5, pday: today() - 3, sub: 0 }); const rs2 = await Promise.all([...Array.from({ length: 10 }, () => lvme({ pk: C.pk })), ...Array.from({ length: 5 }, () => shop('/shop/state', { pk: C.pk })), sub(C, S, 1, 1)]);
  ok(prog(C).sub === 90 && prog(C).pleft === 2, 'readers of every kind at once (lv/me, shop/state, a settle): still once');
  // the last day paid today, then a second pass: today is not paid twice, tomorrow is the first day of the new one
  const Z = await player(); await lvme({ pk: Z.pk }); await buy(Z, txOf('pass')); setProg(Z, { pleft: 0, pday: today(), sub: 870 });
  await buy(Z, txOf('pass')); ok(prog(Z).sub === 870 && prog(Z).pleft === 30 && prog(Z).pday === today(), 'a pass bought on the day the last one paid out: nothing more today (' + JSON.stringify([prog(Z).sub, prog(Z).pleft]) + ')');
  ok(prog(Z).pass === endOf(prog(Z)), 'its end counts from tomorrow');
  dayPasses(Z); await lvme({ pk: Z.pk }); ok(prog(Z).sub === 900 && prog(Z).pleft === 29, 'the next day +30');
  for (let i = 0; i < 40; i++) { dayPasses(Z); await lvme({ pk: Z.pk }); } ok(prog(Z).sub === 870 + 900 && prog(Z).pleft === 0, 'all in all 900 more for the second pass');
  // a rival writer between the read and the write
  setProg(C, { pleft: 5, pday: today() - 3, sub: 0 }); const real = DB.prepare; let fired = false;
  DB.prepare = q => { if (!fired && q.startsWith('UPDATE prog SET sub = sub + ?2, pleft')) { fired = true; sql.prepare('UPDATE prog SET pleft = 9 WHERE ph = ?').run(C.ph); } return real(q); };
  await lvme({ pk: C.pk }); DB.prepare = real; row = prog(C); ok(fired && row.sub === 90 && row.pleft === 6, 'a change between the read and the write is not overwritten: re-read, 3 days paid on the new total (' + row.pleft + ')');
}

// ---- quantity, Sandbox cap ----
{
  const P = await player(); await lvme({ pk: P.pk });
  let r = await buy(P, txOf('light.s', { quantity: 3 })); ok(r.j.results[0].pts === 270 && prog(P).paid === 270, 'consumable x quantity 3 = 270');
  await buy(P, txOf('light.s', { quantity: 50 })); ok(prog(P).paid === 270 + 900, 'quantity above 10 counts as 10');
  await buy(P, txOf('light.s', { quantity: 0 })); await buy(P, txOf('light.s', { quantity: 'x' })); ok(prog(P).paid === 270 + 900 + 180, 'a bad quantity counts as 1');
  const t = txOf('light.m', { quantity: 2 }); await buy(P, t); const p0 = prog(P).paid; await buy(P, { ...t, revocationDate: Date.now() }); ok(prog(P).paid === p0 - 600, 'refund takes back the quantity');
  // Sandbox: gives light, up to 3000 per player; the rest is refused (and the transaction is not kept)
  const S1 = await player(); await lvme({ pk: S1.pk }); const sx = p => txOf(p, { environment: 'Sandbox' });
  r = await buy(S1, sx('light.l')); ok(r.j.results[0].status === 'granted' && prog(S1).paid === 1080, 'sandbox: granted (App Review sees it)');
  await buy(S1, sx('light.l')); r = await buy(S1, sx('light.m')); ok(r.j.results[0].status === 'granted' && prog(S1).paid === 2460, 'sandbox: 2460 so far');
  await buy(S1, sx('light.m')); ok(prog(S1).paid === 2760, 'sandbox: 2760');
  const over = sx('light.m'); r = await buy(S1, over); ok(r.j.results[0].status === 'sbxcap' && r.j.results[0].pts === 300 && prog(S1).paid === 2760 && !q1('SELECT 1 FROM iaptx WHERE txid = ?', over.transactionId), 'sandbox: over 3000 -> sbxcap, nothing given, not kept');
  r = await buy(S1, sx('light.s')); ok(r.j.results[0].status === 'granted' && prog(S1).paid === 2850, 'sandbox: a smaller one that still fits is granted');
  r = await buy(S1, sx('pass')); ok(r.j.results[0].status === 'sbxcap' && prog(S1).sub === 0 && prog(S1).pass === 0, 'sandbox pass over the cap: nothing, no pass days either');
  const kinds = qa("SELECT DISTINCT kind FROM lightlog WHERE ph = ? ORDER BY kind", S1.ph).map(x => x.kind).join(); ok(kinds === 'sbx_buy', 'sandbox log rows are marked sbx_buy: ' + kinds);
  r = await buy(S1, txOf('light.l')); ok(r.j.results[0].status === 'granted' && prog(S1).paid === 2850 + 1080 && qa("SELECT kind FROM lightlog WHERE ph = ? AND kind = 'buy'", S1.ph).length === 1, 'production purchases are not limited by the cap and logged as buy');
  const rf = sx('light.s'); const S2 = await player(); await lvme({ pk: S2.pk }); await buy(S2, rf); await buy(S2, { ...rf, revocationDate: Date.now() }); ok(prog(S2).paid === 0, 'sandbox refund works');
  const S3 = await player(); await lvme({ pk: S3.pk }); await buy(S3, sx('light.l')); await buy(S3, sx('light.l')); const q3 = sx('light.l'); await buy(S3, q3); ok(prog(S3).paid === 2160, 'cap counts what was given, per player (a second player is separate)');
  const S4 = await player(); await lvme({ pk: S4.pk }); r = await buy(S4, sx('light.l')); ok(r.j.results[0].status === 'granted', 'another player has their own 3000');
  let p4 = sx('pass'), pp = sx('pass'); r = await buy(S4, p4); await buy(S4, pp); ok(prog(S4).sub === 30 && prog(S4).pleft === 59 && qa("SELECT 1 FROM lightlog WHERE ph = ? AND kind = 'sbx_pass_day'", S4.ph).length === 1 && qa("SELECT 1 FROM lightlog WHERE ph = ? AND kind = 'pass_day'", S4.ph).length === 0, 'sandbox pass: counts 900 each against the cap, pays 30 a day, logged sbx_pass_day');
  r = await buy(S4, sx('pass')); ok(r.j.results[0].status === 'sbxcap' && prog(S4).pleft === 59, 'sandbox pass over the cap (2880 + 900): no days added');
  { const M = await player(); await lvme({ pk: M.pk }); await buy(M, txOf('pass')); await buy(M, sx('pass'));
    ok(prog(M).pleft === 59 && prog(M).psbx === 30 && qa("SELECT 1 FROM lightlog WHERE ph = ? AND kind = 'pass_day'", M.ph).length === 1 && qa("SELECT 1 FROM lightlog WHERE ph = ? AND kind = 'sbx_pass_day'", M.ph).length === 0, 'production and Sandbox passes together: today is paid as production, 30 of the 59 days are Sandbox');
    sql.prepare('UPDATE prog SET pday = pday - 30 WHERE ph = ?').run(M.ph); await lvme({ pk: M.pk });
    ok(prog(M).pleft === 29 && prog(M).psbx === 29 && qa("SELECT amt FROM lightlog WHERE ph = ? AND kind = 'pass_day' ORDER BY id", M.ph).map(x => x.amt).join() === '30,870' && qa("SELECT amt FROM lightlog WHERE ph = ? AND kind = 'sbx_pass_day'", M.ph).map(x => x.amt).join() === '30', 'a catch-up over both kinds is two rows: 870 production, 30 Sandbox (production first)');
    for (let i = 0; i < 31; i++) { sql.prepare('UPDATE prog SET pday = pday - 1 WHERE ph = ?').run(M.ph); await lvme({ pk: M.pk }); }
    ok(prog(M).pleft === 0 && prog(M).psbx === 0 && q1("SELECT SUM(amt) AS s FROM lightlog WHERE ph = ? AND kind = 'sbx_pass_day'", M.ph).s === 900 && q1("SELECT SUM(amt) AS s FROM lightlog WHERE ph = ? AND kind = 'pass_day'", M.ph).s === 900, 'in the end 900 production and 900 Sandbox are logged separately'); }
  sql.prepare('UPDATE prog SET pday = pday - 2 WHERE ph = ?').run(S4.ph); await lvme({ pk: S4.pk }); ok(qa("SELECT amt FROM lightlog WHERE ph = ? AND kind = 'sbx_pass_day' ORDER BY id", S4.ph).map(x => x.amt).join() === '30,60', 'a later catch-up is one sbx_pass_day row (60)');
}

// ---- App Store Server Notifications ----
const note = (type, t, o = {}) => jws(PKI, { notificationType: type, subtype: o.subtype, notificationUUID: o.uuid || crypto.randomUUID(), signedDate: Date.now(), data: { bundleId: 'com.nocticat.pingponglight', environment: o.env || 'Production', signedTransactionInfo: o.inner || jws(PKI, t), ...o.data } });
{
  const P = await player(), DAY = 86400e3; await lvme({ pk: P.pk });
  { const E = await player(); await lvme({ pk: E.pk }); const et = txOf('light.m'); await buy(E, et); const e0 = prog(E).paid; setProg(E, { paid: 0 });   // all of it spent
    await notify({ signedPayload: note('REFUND', et) }); ok(prog(E).paid === 0, 'light spent, then refunded: nothing taken (nothing left)');
    await notify({ signedPayload: note('REFUND_REVERSED', et) }); ok(prog(E).paid === 0 && e0 === 300, 'and the reversal gives back only what the refund took (0), not 300');
    const E2 = await player(); await lvme({ pk: E2.pk }); const et2 = txOf('light.m'); await buy(E2, et2); setProg(E2, { paid: 100 });
    await notify({ signedPayload: note('REFUND', et2) }); await notify({ signedPayload: note('REFUND_REVERSED', et2) }); ok(prog(E2).paid === 100, 'spent down to 100: refund takes 100, the reversal gives 100 back (net 100)');
    await notify({ signedPayload: note('REFUND', et2) }); await notify({ signedPayload: note('REFUND_REVERSED', et2) }); ok(prog(E2).paid === 100, 'refund and reverse again: still 100'); }
  const bt = txOf('light.m'); await buy(P, bt); const p0 = prog(P).paid;
  const u1 = crypto.randomUUID(); let r = await notify({ signedPayload: note('REFUND', { ...bt, revocationDate: Date.now(), revocationReason: 1 }, { uuid: u1 }) });
  ok(r.s === 200 && r.j.note === 'revoked' && prog(P).paid === Math.max(0, p0 - 300) && p0 >= 300 && !!q1('SELECT 1 FROM iapnote WHERE uuid = ?', u1), 'REFUND: light taken back, the notification id is remembered');
  r = await notify({ signedPayload: note('REFUND', { ...bt, revocationDate: Date.now() }, { uuid: u1 }) }); ok(r.s === 200 && r.j.note === 'dup', 'the same notification id again: dup');
  r = await notify({ signedPayload: note('REFUND', { ...bt, revocationDate: Date.now() }) }); ok(r.s === 200 && prog(P).paid === Math.max(0, p0 - 300), 'a new id for the same refund: nothing more taken');
  // refund reversed: the light comes back
  const rv = note('REFUND_REVERSED', bt); r = await notify({ signedPayload: rv }); ok(r.s === 200 && r.j.note === 'granted' && prog(P).paid === Math.max(0, p0 - 300) + 300 && qa("SELECT 1 FROM lightlog WHERE ph = ? AND kind = 'reverse'", P.ph).length === 1, 'REFUND_REVERSED: 300 given back');
  r = await notify({ signedPayload: note('REFUND_REVERSED', bt) }); ok(r.j.note === 'dup' && prog(P).paid === Math.max(0, p0 - 300) + 300, 'REFUND_REVERSED twice: given once');
  r = await notify({ signedPayload: note('REFUND', { ...bt, revocationDate: Date.now() }, { uuid: u1 }) }); ok(r.j.note === 'dup' && prog(P).paid === Math.max(0, p0 - 300) + 300, 'a replayed old REFUND (same id) cannot undo the reversal');
  r = await buy(P, bt); ok(r.j.results[0].status === 'dup', 'after the reversal the receipt is a normal one again');
  // the pass: the refund takes the days off, the reversal puts them back
  const b0 = prog(P).sub, pt = txOf('pass'); await buy(P, pt); const pe = prog(P).pass;
  r = await notify({ signedPayload: note('REFUND', pt) }); ok(r.j.note === 'revoked' && prog(P).sub === b0 && prog(P).pleft === 0 && prog(P).pass <= pe - 28 * DAY, 'REFUND of a pass: pending days removed, the paid day taken back (pleft ' + prog(P).pleft + ')');
  r = await notify({ signedPayload: note('REFUND_REVERSED', pt) }); ok(r.j.note === 'granted' && prog(P).sub === b0 + 30 && prog(P).pleft === 29 && prog(P).pass >= Date.now() + 28 * DAY, 'REFUND_REVERSED of a pass: the days and the light come back');
  // REVOKE without a revocationDate
  const bt2 = txOf('light.s'); await buy(P, bt2); setProg(P, { paid: 30 });
  r = await notify({ signedPayload: note('REVOKE', bt2) }); ok(r.s === 200 && prog(P).paid === 0 && q1('SELECT revoked FROM iaptx WHERE txid = ?', bt2.transactionId).revoked === 1, 'REVOKE: revoked, to 0 at most');
  ok(!!q1('SELECT 1 FROM players WHERE ph = ?', P.ph) && !q1('SELECT 1 FROM players WHERE ph = ? AND hidden = 1', P.ph), 'the account is not locked');
  // a refund for a transaction we never saw
  const ghost = txOf('light.l'); r = await notify({ signedPayload: note('REFUND', { ...ghost, revocationDate: Date.now() }) }); ok(r.s === 200 && q1('SELECT revoked FROM iaptx WHERE txid = ?', ghost.transactionId).revoked === 1, 'REFUND for an unseen transaction is recorded');
  const pb = prog(P).paid; r = await buy(P, ghost); ok(r.j.results[0].status === 'revoked' && prog(P).paid === pb, 'and the transaction later gives nothing');
  r = await notify({ signedPayload: note('REFUND_REVERSED', txOf('light.s')) }); ok(r.s === 200 && r.j.note === 'ignored', 'REFUND_REVERSED for a transaction we never saw: ignored');
  // a refunded cosmetic through a notification
  const cos = tx({ productId: 'com.nocticat.pingponglight.full', type: 'Non-Consumable' }); r = await buy(P, cos); ok(r.j.results[0].status === 'granted', 'a cosmetic purchase');
  r = await notify({ signedPayload: note('REFUND', { ...cos, revocationDate: Date.now() }) }); ok(r.j.note === 'revoked' && !q1("SELECT 1 FROM ents WHERE pid = ? AND item = 'full'", P.id), 'REFUND of a cosmetic: taken away too');
  // other types are ignored (no renewals any more)
  // refund -> reverse -> refund -> reverse: the amounts are the net of what was taken and given back
  { const N = await player(); await lvme({ pk: N.pk }); const nt = txOf('pass'); await buy(N, nt); for (let i = 0; i < 3; i++) { sql.prepare('UPDATE prog SET pday = pday - 1 WHERE ph = ?').run(N.ph); await lvme({ pk: N.pk }); }
    const st = () => prog(N).sub + '/' + prog(N).pleft; ok(st() === '120/26', 'test: 4 days paid');
    for (let i = 0; i < 3; i++) { await notify({ signedPayload: note('REFUND', nt) }); const a = st(); await notify({ signedPayload: note('REFUND_REVERSED', nt) }); ok(a === '0/0' && st() === '120/26', 'refund / reverse round ' + (i + 1) + ': ' + a + ' then ' + st()); }
    ok(q1("SELECT SUM(amt) AS s FROM lightlog WHERE ph = ? AND pool = 'sub'", N.ph).s === 120, 'the sub rows of lightlog still add up to the pool');
    // unpaid days and unspent pass light are remembered when the account is deleted
    await L.levelWipe(DB, N.ph, Date.now()); const wn = q1('SELECT * FROM wiped WHERE ph = ?', N.ph); ok(wn && wn.sub === 120 && wn.pleft === 26 && wn.paid === 0, 'delete: unspent pass light and unpaid pass days are in wiped: ' + JSON.stringify(wn)); }
  for (const ty of ['DID_RENEW', 'SUBSCRIBED', 'EXPIRED', 'DID_CHANGE_RENEWAL_STATUS']) { const s0 = prog(P).sub; r = await notify({ signedPayload: note(ty, txOf('pass')) }); ok(r.s === 200 && r.j.note === 'ignored' && prog(P).sub === s0, ty + ': acknowledged and ignored'); }
  r = await notify({ signedPayload: jws(PKI, { notificationType: 'TEST', data: { bundleId: 'com.nocticat.pingponglight', environment: 'Sandbox' }, signedDate: Date.now() }) }); ok(r.s === 200 && r.j.note === 'ignored', 'TEST notification acknowledged');
  // environment must agree
  r = await notify({ signedPayload: note('REFUND', { ...txOf('light.s', { environment: 'Sandbox' }), revocationDate: Date.now() }, { env: 'Production' }) }); ok(r.s === 400 && r.j.why === 'env', 'outer Production, inner Sandbox: refused');
  r = await notify({ signedPayload: note('REFUND', { ...txOf('light.s'), revocationDate: Date.now() }, { env: 'Sandbox' }) }); ok(r.s === 400 && r.j.why === 'env', 'outer Sandbox, inner Production: refused');
  r = await notify({ signedPayload: note('REFUND', txOf('light.s'), { env: 'Xcode' }) }); ok(r.s === 400, 'an unknown environment: refused');
  // length limits: outer up to 64 KB, inner as before
  const fat = { ...txOf('light.s'), pad: 'p'.repeat(1000) }; const outerBig = note('REFUND', fat, { data: { pad: 'q'.repeat(30000) } });
  ok(outerBig.length > 16384 && outerBig.length < 65536, 'test: a long outer notification (' + outerBig.length + ' chars)'); r = await notify({ signedPayload: outerBig }); ok(r.s === 200, 'a notification longer than 16 KB is accepted (it wraps whole transactions)');
  r = await notify({ signedPayload: note('REFUND', txOf('light.s'), { data: { pad: 'q'.repeat(50000) } }) }); ok(r.s === 400, 'an outer notification over 64 KB: refused');
  r = await notify({ signedPayload: note('REFUND', { ...txOf('light.s'), pad: 'p'.repeat(20000) }) }); ok(r.s === 400 && r.j.why === 'input', 'an inner transaction over 16 KB: refused');
  // missing id, everything that is not Apple
  r = await notify({ signedPayload: jws(PKI, { notificationType: 'REFUND', data: { bundleId: 'com.nocticat.pingponglight', environment: 'Production', signedTransactionInfo: jws(PKI, txOf('light.s')) }, signedDate: Date.now() }) }); ok(r.s === 400, 'a notification without an id: refused');
  const evil = chain(); r = await notify({ signedPayload: jws(evil, { notificationType: 'REFUND', notificationUUID: crypto.randomUUID(), data: { bundleId: 'com.nocticat.pingponglight', environment: 'Production', signedTransactionInfo: jws(PKI, txOf('light.s')) }, signedDate: Date.now() }) });
  ok(r.s === 400 && r.j.error === 'bad', 'a payload from a foreign chain: 400');
  r = await notify({ signedPayload: note('REFUND', txOf('light.s'), { inner: jws(evil, txOf('light.s')) }) }); ok(r.s === 400, 'a transaction inside from a foreign chain: 400');
  r = await notify({ signedPayload: note('REFUND', txOf('light.s', { bundleId: 'com.evil' })) }); ok(r.s === 400, 'a transaction for another bundle: 400');
  r = await notify({ signedPayload: jws(PKI, { notificationType: 'REFUND', notificationUUID: crypto.randomUUID(), data: { bundleId: 'com.evil', environment: 'Production', signedTransactionInfo: jws(PKI, txOf('light.s')) }, signedDate: Date.now() }) }); ok(r.s === 400, 'a notification for another bundle: 400');
  ok((await notify({ signedPayload: 'a.b.c' })).s === 400 && (await notify({ signedPayload: 5 })).s === 400 && (await notify({})).s === 400 && (await notify('[1]')).s === 400 && (await notify('{')).s === 400, 'garbage refused');
  const sp = note('REFUND', { ...txOf('light.s'), revocationDate: Date.now() }); const [h, pp, sg] = sp.split('.');
  const tam = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(pp, 'base64url')), notificationType: 'TEST' })).toString('base64url'); r = await notify({ signedPayload: h + '.' + tam + '.' + sg }); ok(r.s === 400, 'an edited notification: 400');
  ok((await notify({ signedPayload: sp }, env, 'GET')).s === 405, '/iap/notify: POST only');
  ok((await notify({ signedPayload: sp }, { ...env, IAP_ON: '0' })).s === 503 && (await notify({ signedPayload: sp }, { ...env, IAP_ON: undefined })).s === 503, '/iap/notify: off unless IAP_ON=1');
  ok((await notify({ signedPayload: 'x'.repeat(95000) })).s === 413, '/iap/notify: size limit');
  seen.length = 0; await notify({ signedPayload: 'a.b.c' }); ok(seen[0].startsWith('iapn:'), '/iap/notify: its own rate limit key');
  slow = true; r = await notify({ signedPayload: 'a.b.c' }); slow = false; ok(r.s === 429, '/iap/notify: rate limited -> 429');
}

// ---- duel experience ----
{
  const A = await player(), B = await player(), C = await player(), U = anon(); for (const x of [A, B, C]) await lvme({ pk: x.pk });
  ok(L.duelMult(2, 1) === 2.5 && L.duelMult(2, 2) === 2 && L.duelMult(3, 1) === 2.75 && L.duelMult(3, 2) === 2.5 && L.duelMult(3, 3) === 2.25 && L.duelMult(4, 1) === 3 && L.duelMult(4, 2) === 2.75 && L.duelMult(5, 1) === 3.25 && L.duelMult(6, 1) === 3.5 && L.duelMult(8, 1) === 3.5 && L.duelMult(8, 3) === 3, 'duelMult: 2 + min(1, 0.25 (n - 2)) + place bonus, x2 .. x3.5');
  const U2 = { id: 0 }; const mk = (id, n, rows, song = S, d = 1) => ({ duel: { id, song, d, valid: n }, rows });
  const row = (P, place, o = {}) => ({ pid: P.id, place, ok: 1, acc: 9500, sus: 0, ...o });
  const light0 = light(A), res = mk('d1', 3, [row(A, 1), row(B, 2, { acc: 8000 }), row(C, 3, { acc: 4999 })]);
  let out = await L.duelXp(DB, res, Date.now() - 600e3, Date.now()), a = out.find(x => x.pid === A.id), b = out.find(x => x.pid === B.id);
  ok(a && a.duel.n === 3 && a.duel.place === 1 && a.duel.mult === 2.75 && a.lv.gain === L.xpClear(S, 1, 9500, 2.75, 1) && prog(A).xp === a.lv.gain, 'duel: first place of 3 gets x2.75: ' + JSON.stringify(a && a.duel));
  ok(b && b.duel.mult === 2.5 && b.lv.gain === L.xpClear(S, 1, 8000, 2.5, 1), 'duel: second place of 3 gets x2.5');
  ok(!out.find(x => x.pid === C.id) && prog(C).xp === 0, 'duel: accuracy under 50 % gets nothing');
  ok(light(A).nat === light0.nat && prog(A).dspend === 0 && a.lv.cost === 0 && a.lv.light.total === 60, 'duel: no light spent, no daily usage');
  ok(prog(A).dsec === Math.round(L.playSecs(S, 1)), 'duel: counts toward the day\'s play time');
  ok(a.lv.from && Array.isArray(a.lv.ups) && Array.isArray(a.lv.rewards), 'duel: the lv object carries gain, from, ups, rewards');
  out = await L.duelXp(DB, res, Date.now() - 600e3, Date.now()); ok(out.length === 0 && prog(A).xp === a.lv.gain, 'duel: the same round settles once per player');
  const xpA = prog(A).xp;
  out = await L.duelXp(DB, mk('d2', 2, [row(A, 2, { ok: 0 }), row(B, 1, { sus: 1 }), row(C, 1, { pid: 0 })]), Date.now() - 600e3, Date.now()); ok(out.length === 0 && prog(A).xp === xpA, 'duel: not finished, flagged sus, or not signed in: nothing');
  out = await L.duelXp(DB, mk('d3', 2, [row(A, 1)]), Date.now() - 600e3, Date.now()); ok(out.length === 1 && out[0].duel.mult === 2.5, 'duel: a 2-player round, winner x2.5');
  out = await L.duelXp(DB, mk('d4', 2, [row(U2, 1, { pid: 0 }), row(B, 1), row(A, 2)]), Date.now() - 600e3, Date.now()); ok(out.find(x => x.pid === A.id).duel.mult === 2, 'duel: the loser of a 2-player round x2');
  // an unregistered pid (no players row): nothing
  out = await L.duelXp(DB, mk('d5', 2, [{ pid: 99999, place: 1, ok: 1, acc: 9000, sus: 0 }]), Date.now() - 600e3, Date.now()); ok(out.length === 0, 'duel: only registered players');
  // half after an hour, the multiplier applies on the halved base
  setProg(B, { day: today(), dsec: 4000, len: 0 }); out = await L.duelXp(DB, mk('d6', 2, [row(B, 1)]), Date.now() - 600e3, Date.now()); ok(out[0].lv.gain === L.xpClear(S, 1, 9500, 2.5, 0.5) && out[0].lv.half === true, 'duel: half experience after the first hour of the day');
  // overlap with the last run
  await L.settle(DB, B.ph, B.id, Date.now(), { song: S, d: 1, kind: 'clear', acc: 9500, m: 1, start: Date.now() - 100e3 }); const xB = prog(B).xp; out = await L.duelXp(DB, mk('d7', 2, [row(B, 1)]), Date.now() - 50e3, Date.now()); ok(out[0].lv.gain === 0 && prog(B).xp === xB, 'duel: a round whose time overlaps the last run earns nothing');
  // the place counts valid seats only: an unverified guest ahead does not push the player down
  { const V = await player(); await lvme({ pk: V.pk }); setProg(V, { len: 0 });
    out = await L.duelXp(DB, mk('d9', 2, [{ pid: 0, place: 1, ok: 1, acc: 9000, sus: 0 }, row(V, 2)]), Date.now() - 600e3, Date.now());
    ok(out.length === 1 && out[0].duel.place === 1 && out[0].duel.mult === 2.5 && out[0].duel.n === 2, 'duel: a guest first, the valid player second: place 1, x2.5');
    // a duel does not move the single-player clock: a single run that began during the duel still counts
    const pv = prog(V), dur = Math.round(L.playSecs(S, 1) * 1000); ok(pv.lst > Date.now() - 700e3 && pv.len === pv.lst + dur, 'duel: lst = the start, len = start + the song (not the server settle time): ' + (pv.len - pv.lst));
    const xv = prog(V).xp, rr = await L.settle(DB, V.ph, V.id, Date.now(), { song: S, d: 1, kind: 'clear', acc: 9500, m: 1, start: Date.now() - 300e3 });
    ok(rr.gain > 0 && prog(V).xp > xv, 'a single run after a duel settled (it began before the settle) earns its experience');
    const x2 = prog(V).xp; out = await L.duelXp(DB, mk('d9', 2, [row(V, 1)]), Date.now() - 600e3, Date.now()); ok(out.length === 0 && prog(V).xp === x2, 'duel: no repeat for the same round (no farming)');
    { // two rooms at once: the second duel of the same account overlaps the first
      const X = await player(); await lvme({ pk: X.pk }); setProg(X, { len: 0 }); const t0 = Date.now() - 10e3;
      out = await L.duelXp(DB, mk('e1', 2, [row(X, 1)]), t0, Date.now()); ok(out.length === 1 && out[0].lv.gain > 0, 'two rooms: the first duel gives experience');
      out = await L.duelXp(DB, mk('e2', 2, [row(X, 1)]), t0 + 500, Date.now()); ok(out.length === 1 && out[0].lv.gain === 0, 'two rooms: the second, overlapping duel gives none');
      const xx = prog(X).xp, d1 = await L.settle(DB, X.ph, X.id, Date.now(), { song: S, d: 1, kind: 'clear', acc: 9500, m: 1, start: t0 + 3000 }); ok(d1.gain === 0 && prog(X).xp === xx, 'a single run that began during the duel earns nothing');
      const t1 = prog(X).len + 5000, d2 = await L.settle(DB, X.ph, X.id, t1 + 60e3, { song: S, d: 1, kind: 'clear', acc: 9500, m: 1, start: t1 }); ok(d2.gain > 0, 'a single run that began after the duel ended earns experience'); }
    { // a single run that began 5 s after the song of a duel ended and settled first: the duel is still not an overlap
      const Y = await player(); await lvme({ pk: Y.pk }); setProg(Y, { len: 0, lst: 0 }); const dd = Math.round(L.playSecs(S, 1) * 1000), s0 = Date.now() - dd - 40e3, ss = s0 + dd + 5000;
      const sg = await L.settle(DB, Y.ph, Y.id, Date.now(), { song: S, d: 1, kind: 'clear', acc: 9500, m: 1, start: ss }); ok(sg.gain > 0, 'single run after the duel song, settled first: experience');
      out = await L.duelXp(DB, mk('f1', 2, [row(Y, 1)]), s0, Date.now()); ok(out.length === 1 && out[0].lv.gain > 0, 'the duel settled after it is not judged an overlap: experience');
      const Y2 = await player(); await lvme({ pk: Y2.pk }); setProg(Y2, { len: 0, lst: 0 });
      out = await L.duelXp(DB, mk('f2', 2, [row(Y2, 1)]), s0, Date.now()); const sg2 = await L.settle(DB, Y2.ph, Y2.id, Date.now(), { song: S, d: 1, kind: 'clear', acc: 9500, m: 1, start: s0 + 10e3 });
      ok(out[0].lv.gain > 0 && sg2.gain === 0, 'a single run that began during the duel song, after the duel settled: nothing'); }
    const rr2 = await L.settle(DB, V.ph, V.id, Date.now(), { song: S, d: 1, kind: 'clear', acc: 9500, m: 1, start: Date.now() - 300e3 }); ok(rr2.gain === 0, 'two single runs at once still earn once'); }
  // a failing write releases the round for a retry
  setProg(C, { len: 0 }); const real = DB.prepare; let broke = true; DB.prepare = q => { if (broke && q.startsWith('UPDATE prog SET xp')) { broke = false; throw new Error('boom'); } return real(q); };
  out = await L.duelXp(DB, mk('d8', 2, [row(C, 1)]), Date.now() - 600e3, Date.now()); DB.prepare = real;
  ok(out.length === 0 && !q1("SELECT 1 FROM duelxp WHERE did = 'd8'"), 'duel: a failed settle does not use the round up');
  out = await L.duelXp(DB, mk('d8', 2, [row(C, 1)]), Date.now() - 600e3, Date.now()); ok(out.length === 1 && prog(C).xp > 0, 'duel: and the retry works');
  // the Arena sends it: flushPend gives { t: 'lv', lv, duel }
  const arenaSrc = readFileSync(join(SRV, 'src', 'arena.js'), 'utf8'); ok(/t: 'lv', lv: x\.lv, duel: x\.duel/.test(arenaSrc) && /duelXp\(this\.env\.LB, res, p\.round\.at, p\.now\)/.test(arenaSrc), 'arena.js: sends the lv message after the round is written');
}

// ---- parallel tickets: a newer ticket takes the experience of the older ones ----
{
  const P = await player(); await lvme({ pk: P.pk });
  const mkTk = async () => (await post('/lb/start', { song: S, d: 1, pk: P.pk, m: 2 })).j.run;
  const back = (run, ms) => { const p = run.split('.'); sql.prepare('UPDATE runs SET ts = ts - ? WHERE nonce = ?').run(ms, p[3]); p[2] = String(+p[2] - ms); p.pop(); return sign(p.join('.')); };
  const runs = []; for (let i = 0; i < 5; i++) runs.push(back(await mkTk(), 600e3 + i * 1000));
  ok(qa('SELECT xp FROM runs WHERE pid = ? AND done = 0 ORDER BY ts DESC', P.id).filter(x => x.xp === 1).length === 1, 'start: only the newest open ticket still earns experience');
  let tot = 0, oks = 0; const log = perfect(S, 1);
  for (const run of runs) { const r = await post('/lb/submit', { run, pk: P.pk, log }); if (r.j.ok) { oks++; tot += r.j.lv.gain; } }
  ok(oks === 5 && tot === L.xpClear(S, 1, 10000, 2, 1) && prog(P).xp === tot, 'five parallel tickets: all five count for the board, only one gives experience: ' + tot);
  ok(qa('SELECT 1 FROM scores WHERE pid = ?', P.id).length === 1, 'the board still takes the run');
  // the answer of an older ticket is a no-gain state
  const r2 = await post('/lb/submit', { run: back(await mkTk(), 700e3), pk: P.pk, log }); const old = back(await mkTk(), 700e3);
  ok(r2.j.lv.gain >= 0, 'a normal run still gives experience');
  const r3 = await post('/lb/submit', { run: old, pk: P.pk, log }); ok(r3.j.ok && r3.j.lv.gain === 0 && r3.j.lv.cost === 0, 'an older ticket answers with lv gain 0 and spends no light');
  // anonymous keys too
  const U = anon(); const t1 = await post('/lb/start', { song: S, d: 1, pk: U.pk, m: 3 }), t2 = await post('/lb/start', { song: S, d: 1, pk: U.pk, m: 3 });
  const a1 = back(t1.j.run, 700e3), a2 = back(t2.j.run, 700e3); const e1 = await post('/lb/submit', { run: a1, pk: U.pk, log }), e2 = await post('/lb/submit', { run: a2, pk: U.pk, log });
  ok(e1.j.error === 'noname' && e1.j.lv.gain === 0 && e2.j.lv.gain > 0 && e2.j.lv.used === 3, 'anonymous: the older ticket earns nothing, the newer one does');
  // a different player is not affected
  const Q = await player(); await lvme({ pk: Q.pk }); const q1t = await mkTk(); const qr = (await post('/lb/start', { song: S, d: 1, pk: Q.pk, m: 1 })).j.run; ok(!!q1t && qa('SELECT xp FROM runs WHERE pid = ? AND xp = 1 AND done = 0', Q.id).length === 1, 'another player\'s ticket is untouched');
  // a quit/fail with a replaced ticket: no experience either
  const f1 = back((await post('/lb/start', { song: S, d: 2, pk: Q.pk, m: 1 })).j.run, 700e3); await post('/lb/start', { song: S, d: 2, pk: Q.pk, m: 1 });
  const x0 = prog(Q).xp, fr = await post('/lb/end', { run: f1, pk: Q.pk, kind: 'fail', log: [null, null, null, null, null, null] }); ok(fr.j.ok && fr.j.lv.gain === 0 && prog(Q).xp === x0, 'a replaced ticket gives no experience for a fail either');
  // overlapping runs: a run that began before the last experience run ended earns nothing
  const O = await player(); await lvme({ pk: O.pk }); setProg(O, { len: Date.now() + 1 });
  const ot = sign([S, 1, Date.now() - 600e3, 'aaaaaaaaaaaaaaaa', O.id].join('.')); sql.prepare('INSERT INTO runs (nonce, pid, song, d, ts, done, m, ph) VALUES (?, ?, ?, ?, ?, 0, 1, ?)').run('aaaaaaaaaaaaaaaa', O.id, S, 1, Date.now() - 600e3, O.ph);
  const ro = await post('/lb/submit', { run: ot, pk: O.pk, log }); ok(ro.j.ok && ro.j.lv.gain === 0 && prog(O).xp === 0, 'overlap: a run that began before the previous one ended earns nothing');
  const L0 = Date.now(); setProg(O, { len: 0 }); const r5 = await sub(O, S, 1, 1); ok(r5.j.lv.gain > 0 && prog(O).len >= L0 && prog(O).lst > 0 && prog(O).lst < prog(O).len, 'each settled run records its start and end');
}

// ---- fail needs the settled share of the song ----
{
  const P = await player(); await lvme({ pk: P.pk }); const n0 = N(S, 0), last = perfect(S, 0).slice(0, n0 - 15).concat(Array(15).fill(null));   // 15 misses at difficulty 0 reach 0 life on the last beat
  const dur = CHARTS[S].dur / CHARTS[S].spd[0] * 900;
  let r = await end(P, S, 0, 'fail', 1, last, 20e3); ok(r.s === 400 && r.j.error === 'ticket', 'fail: a whole-song log 20 s after the start is refused (' + Math.round(dur) + ' ms needed)');
  r = await end(P, S, 0, 'fail', 1, last, Math.ceil(dur) - 1000); ok(r.s === 400 && r.j.error === 'ticket', 'fail: just before the settled share of the song could have been played: refused');
  ok(!q1('SELECT 1 FROM tries WHERE pid = ?', P.id) && prog(P).xp === 0, 'a refused fail changes nothing');
  r = await end(P, S, 0, 'fail', 1, last, Math.ceil(dur) + 500); ok(r.j.ok && r.j.lv.gain > 0, 'fail: after it: accepted with experience');
  const short = Array(15).fill(null); r = await end(P, S, 0, 'fail', 1, short, 3.5e3); ok(r.s === 400 && r.j.error === 'ticket', 'fail: 15 settled beats of 48 need 15/48 of 90 % of the song, not 3 s');
  r = await end(P, S, 0, 'fail', 1, short, Math.ceil(dur * 15 / n0) + 500); ok(r.j.ok, 'fail: 15 beats after their share of the song');
  r = await end(P, S, 2, 'fail', 1, [null, null, null, null, null, null], 1e3); ok(r.s === 400 && r.j.error === 'ticket', 'fail: the 3 second floor stays');
  r = await end(P, S, 2, 'fail', 1, [null, null, null, null, null, null], 20e3); ok(r.j.ok, 'fail: 6 beats at 20 s');
  // the probe's attack: a full-length fake log at 3.1 s
  const Q = await player(); r = await end(Q, 'prelude', 3, 'fail', 1, Array.from({ length: N('prelude', 3) }, (_, i) => i < N('prelude', 3) - 30 ? [0, 300] : null), 3100); ok(r.s === 400 && r.j.error === 'ticket' && !prog(Q) || prog(Q).xp === 0, 'the 3-second fail attack is refused');
}

// ---- IAP_ON and SHOP_TEST together ----
{
  const index = (await import('../src/index.js')).default;
  const call = (e, path = '/health') => index.fetch(new Request('http://t' + path), e, { waitUntil() {} });
  const errs = []; const ce = console.error; console.error = (...a) => errs.push(a.join(' '));
  let r = await call({ IAP_ON: '1', SHOP_TEST: '1' }); ok(r.status === 503 && errs.length === 1 && /SHOP_TEST/.test(errs[0]), 'IAP_ON=1 and SHOP_TEST=1: 503 and console.error');
  r = await call({ IAP_ON: '1', SHOP_TEST: '1' }, '/iap/notify'); ok(r.status === 503, '... also /iap/notify');
  r = await call({ IAP_ON: '1', SHOP_TEST: '1' }, '/lb/board'); ok(r.status === 503, '... and every other path');
  errs.length = 0;
  r = await call({ IAP_ON: '1', SHOP_TEST: '0' }); ok(r.status === 200 && !errs.length, 'IAP_ON=1, SHOP_TEST=0: normal');
  r = await call({ IAP_ON: '0', SHOP_TEST: '1' }); ok(r.status === 200, 'IAP_ON=0, SHOP_TEST=1: normal');
  r = await call({}); ok(r.status === 200, 'neither: normal');
  r = await call({ IAP_ON: '1', SHOP_TEST: '1', ALLOW_LOCAL: '1' }); ok(r.status === 200, 'local development (ALLOW_LOCAL=1) is exempt: the purchase tests need both');
  console.error = ce;
  ok(L.misconfigured({ IAP_ON: '1', SHOP_TEST: '1' }) && !L.misconfigured({ IAP_ON: '1', SHOP_TEST: '0' }) && !L.misconfigured({ IAP_ON: '0', SHOP_TEST: '1' }) && !L.misconfigured({ IAP_ON: 1, SHOP_TEST: 1 }), 'misconfigured(): only the strings "1" and "1"');
}

// ---- sweep ----
{
  const now = Date.now(), Y = 365 * 86400e3, ins = (ph, created, o = {}) => sql.prepare('INSERT INTO prog (ph, nts, created, len, paid, sub) VALUES (?, ?, ?, ?, ?, ?)').run(ph, created, created, o.len || 0, o.paid || 0, o.sub || 0);
  const R = await player(); await lvme({ pk: R.pk }); sql.prepare('UPDATE prog SET created = ?, len = 0 WHERE ph = ?').run(now - 2 * Y, R.ph);
  ins('sw-old', now - 2 * Y); ins('sw-old-paid', now - 2 * Y, { paid: 5 }); ins('sw-old-sub', now - 2 * Y, { sub: 5 }); ins('sw-new', now - 10 * 86400e3); ins('sw-played', now - 2 * Y, { len: now - 10 * 86400e3 });
  sql.prepare("INSERT INTO lightlog (ph, ts, kind, pool, amt) VALUES ('sw-old', ?, 'spend', 'nat', -5)").run(now - 2 * Y);
  sql.prepare("INSERT INTO runs (nonce, pid, song, d, ts, done, ph) VALUES ('swrun', 0, 'x', 0, ?, 0, 'sw-old')").run(now - 3600e3);
  sql.prepare("INSERT INTO lightlog (ph, ts, kind, pool, amt) VALUES ('keep', ?, 'spend', 'nat', -5), ('gone', ?, 'spend', 'nat', -5)").run(now - 700 * 86400e3, now - 740 * 86400e3);
  sql.prepare("INSERT INTO iapnote (uuid, ts) VALUES ('n-old', ?), ('n-new', ?)").run(now - 91 * 86400e3, now - 86400e3);
  await L.levelSweep(env);
  const has = ph => !!q1('SELECT 1 FROM prog WHERE ph = ?', ph);
  ok(!has('sw-old') && has('sw-old-paid') && has('sw-old-sub') && has('sw-new') && has('sw-played') && has(R.ph), 'sweep: anonymous progress with no light, idle for a year, goes; the rest stays (paid, pass light, recent, played, registered)');
  ok(!q1("SELECT 1 FROM lightlog WHERE ph = 'sw-old'") && !q1("SELECT 1 FROM runs WHERE nonce = 'swrun'"), 'sweep: its light log and open runs go with it');
  ok(!!q1("SELECT 1 FROM lightlog WHERE ph = 'keep'") && !q1("SELECT 1 FROM lightlog WHERE ph = 'gone'"), 'sweep: the light log is kept 2 years');
  ok(!q1("SELECT 1 FROM iapnote WHERE uuid = 'n-old'") && !!q1("SELECT 1 FROM iapnote WHERE uuid = 'n-new'"), 'sweep: handled notifications are kept 90 days');
  sql.prepare('INSERT INTO wiped (ph, ts, paid) VALUES (?, ?, 5)').run('w-old', now - 366 * 86400e3); sql.prepare('INSERT INTO wiped (ph, ts, paid) VALUES (?, ?, 5)').run('w-new', now - 300 * 86400e3); await L.levelSweep(env);
  ok(!q1("SELECT 1 FROM wiped WHERE ph = 'w-old'") && !!q1("SELECT 1 FROM wiped WHERE ph = 'w-new'"), 'sweep: wiped is still kept 1 year');
}

console.log(fail ? 'FAILED' : 'level tests passed', pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
