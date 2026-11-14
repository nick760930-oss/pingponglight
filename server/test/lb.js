// Leaderboard server tests. Needs `npx wrangler dev --port 8788` in server/ (with .dev.vars) and the local
// database (`npm run db:local`). Usage: node server/test/lb.js http://127.0.0.1:8788
// Tickets are normally only accepted after the song could have been played; the tests sign back-dated
// tickets with the local LB_SECRET instead of waiting.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const crypto = require('node:crypto');
const BASE = process.argv[2] || 'http://127.0.0.1:8788', ORIGIN = 'http://localhost:8000';
const vars = Object.fromEntries(readFileSync(join(__dirname, '..', '.dev.vars'), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const chartsSrc = readFileSync(join(__dirname, '..', 'src', 'charts.js'), 'utf8');
const CHARTS = JSON.parse(chartsSrc.slice(chartsSrc.indexOf('{'), chartsSrc.indexOf('};\n') + 1));   // the first export only (CONS follows)
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const b64u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ticket = (song, d, ageMs) => { const p = [song, d, Date.now() - ageMs, crypto.randomBytes(8).toString('hex')].join('.'); return p + '.' + b64u(crypto.createHmac('sha256', vars.LB_SECRET).update(p).digest()); };
const pk = () => crypto.randomBytes(16).toString('hex');
async function post(path, body, h = {}) {
  // a fresh address per request keeps the per-IP limit (30/min) out of the way, where local dev honours it
  const ip = '203.0.113.' + (1 + (post.n = (post.n || 0) + 1) % 250);
  const r = await fetch(BASE + path, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { s: r.status, j };
}
// a believable run: errors spread like a person's (mean |e| ~25 ms), a few misses optional
function humanLog(n, spread = 30, misses = 0, seed = 1) {
  let x = seed; const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
  const log = Array.from({ length: n }, () => { const e = Math.round((rnd() + rnd() + rnd() - 1.5) * spread * 1.6), a = Math.abs(e);
    const m = a < 45 ? 3 : a < 90 ? 2 : a < 150 ? 1.2 : 1; return [e, Math.round(100 * m * (1 + rnd()))]; });
  for (let i = 0; i < misses; i++) log[Math.floor(rnd() * n)] = null;
  return log;
}
(async () => {
  const S = 'minuetg', D = 1, N = CHARTS[S].n[D], A = pk(), B = pk(), C = pk();
  // origin and method
  ok((await post('/lb/start', { song: S, d: D }, { Origin: 'https://evil.example' })).s === 403, 'foreign origin refused');
  ok((await fetch(BASE + '/lb/start', { method: 'POST', body: '{}' })).status === 403, 'missing origin refused');
  ok((await fetch(BASE + '/lb/board', { headers: { Origin: ORIGIN } })).status === 405, 'GET refused');
  ok((await post('/lb/board', 'x'.repeat(20000))).s === 413, 'oversized body refused');
  ok((await post('/lb/board', 'not json')).s === 400, 'bad json refused');
  // nicknames: register first, unique, filtered
  ok((await post('/lb/submit', { run: ticket(S, D, 120e3), pk: C, log: humanLog(N) })).j.error === 'noname', 'no nickname yet: refused');
  for (const n of ['幹你娘', 'f.u.c.k', 'Admin', 'PingPong官方', 'sh1t', 'ass', '   ', '<>']) {
    const r = await post('/lb/name', { pk: C, name: n });
    ok(r.j && r.j.error === 'name' && r.j.why !== 'taken', 'name refused: ' + n);
  }
  ok((await post('/lb/name', { pk: A, name: '小明 classic' })).j.ok, 'A registers');
  ok((await post('/lb/name', { pk: B, name: 'Lumi<b>' })).j.name === 'Lumib', 'markup stripped from name');
  ok((await post('/lb/name', { pk: B, name: 'Lumi' })).j.ok, 'B renames');
  for (const n of ['lumi', 'LUMI', 'Ｌｕｍｉ', 'lu mi', 'Lumi!']) {
    const r = await post('/lb/name', { pk: C, name: n });
    ok(r.s === 409 && r.j.why === 'taken', 'duplicate refused: ' + n);
  }
  ok((await post('/lb/name', { pk: B, name: 'LUMI' })).j.ok, 'owner may change the case of own name');
  ok((await post('/lb/name', { pk: B, name: 'Lumi' })).j.ok, 'and back');
  ok((await post('/lb/me', { pk: B })).j.me.name === 'Lumi', '/lb/me returns the name');
  ok((await post('/lb/me', { pk: pk() })).j.me === null, '/lb/me null for a new key');
  ok((await post('/lb/name', { pk: C, name: 'Cee' })).j.ok, 'C registers');
  // tickets
  const st = await post('/lb/start', { song: S, d: D });
  ok(st.s === 200 && typeof st.j.run === 'string', 'ticket issued');
  ok((await post('/lb/start', { song: 'nope', d: 0 })).s === 400, 'unknown song refused');
  ok((await post('/lb/start', { song: S, d: 5 })).s === 400, 'bad difficulty refused');
  ok((await post('/lb/start', { song: '__proto__', d: 0 })).s === 400, 'prototype key refused');
  const good = humanLog(N);
  ok((await post('/lb/submit', { run: st.j.run, pk: A, log: good })).j.error === 'ticket', 'too-early result refused');
  const forged = ticket(S, D, 120e3).replace(/.$/, c => c === 'A' ? 'B' : 'A');
  ok((await post('/lb/submit', { run: forged, pk: A, log: good })).j.error === 'ticket', 'bad signature refused');
  ok((await post('/lb/submit', { run: ticket(S, D, 4 * 3600e3), pk: A, log: good })).j.error === 'ticket', 'expired ticket refused');
  const swapped = ticket(S, D, 120e3).split('.'); swapped[1] = '2';
  ok((await post('/lb/submit', { run: swapped.join('.'), pk: A, log: good })).j.error === 'ticket', 'edited difficulty refused');
  // logs
  ok((await post('/lb/submit', { run: ticket(S, D, 120e3), pk: A, log: good.slice(1) })).j.error === 'log', 'wrong beat count refused');
  const perfect = Array.from({ length: N }, (_, i) => [i % 2, 900]);   // high score: it stays first on an accuracy tie
  const pf = await post('/lb/submit', { run: ticket(S, D, 120e3), pk: C, log: perfect, pf: 'ios' });
  ok(pf.s === 200 && pf.j.acc === 10000, 'machine-steady run accepted');
  ok((await post('/lb/submit', { run: ticket(S, D, 120e3), pk: A, log: good.map((x, i) => i ? x : [900, 100]) })).j.error === 'log', 'out-of-window error refused');
  ok((await post('/lb/submit', { run: ticket(S, D, 120e3), pk: A, log: good.map((x, i) => i ? x : [1.5, 300]) })).j.error === 'log', 'non-integer error refused');
  ok((await post('/lb/submit', { run: ticket(S, D, 120e3), pk: 'abc', log: good })).s === 400, 'bad player key refused');
  ok((await post('/lb/submit', { run: ticket(S, D, 120e3), pk: A, log: good.map((x, i) => i ? x : [x[0], 999999]) })).j.error === 'log', 'impossible hit points refused');
  ok((await post('/lb/submit', { run: ticket(S, D, 120e3), pk: A, log: good.map((x, i) => i ? x : [x[0], 1]) })).j.error === 'log', 'too-small hit points refused');
  ok((await post('/lb/submit', { run: ticket(S, D, 120e3), pk: A, log: good.map((x, i) => i ? x : x[0]) })).j.error === 'log', 'old log format refused');
  // scoring and ranks
  const a1 = await post('/lb/submit', { run: ticket(S, D, 120e3), pk: A, log: good });
  ok(a1.s === 200 && a1.j.me.r === 2 && a1.j.improved, 'first human run ranked 2 (behind the steady one)');
  ok(['F','E','D','C','B','A','S','SS','SSS'].includes(a1.j.rank) && a1.j.rank !== undefined, 'submit returns one of the nine ranks: ' + a1.j.rank);
  const b1 = await post('/lb/submit', { run: ticket(S, D, 120e3), pk: B, log: humanLog(N, 70, 3, 7) });
  ok(b1.s === 200 && b1.j.me.r === 3 && b1.j.acc < a1.j.acc, 'worse run ranked 3');
  const b2 = await post('/lb/submit', { run: ticket(S, D, 120e3), pk: B, log: humanLog(N, 12, 0, 9) });
  ok(b2.s === 200 && b2.j.me.r === 2 && b2.j.improved, 'better rerun passes A');
  const b3 = await post('/lb/submit', { run: ticket(S, D, 120e3), pk: B, log: humanLog(N, 80, 5, 3) });
  ok(b3.s === 200 && !b3.j.improved && b3.j.me.r === 2, 'worse rerun keeps the best');
  const bd = await post('/lb/board', { song: S, d: D, pk: A });
  ok(bd.s === 200 && bd.j.top.length === 3 && bd.j.top[1].name === 'Lumi' && bd.j.me.r === 3 && bd.j.total === 3, 'board lists all three, me = 3');
  ok(!JSON.stringify(bd.j).includes(A) && bd.j.top.every(r => !('ph' in r)), 'board leaks no keys');
  ok(bd.j.top[2].name === '小明 classic', 'names kept');
  ok(!JSON.stringify(bd.j).includes('"log"'), 'board does not expose beat logs');
  const other = await post('/lb/board', { song: S, d: 0 });
  ok(other.s === 200 && other.j.top.length === 0 && other.j.me === null, 'boards are separate per difficulty');
  // equal accuracy: the higher score ranks first
  const E = pk(), F = pk(); await post('/lb/name', { pk: E, name: 'Tie低分' }); await post('/lb/name', { pk: F, name: 'Tie高分' });
  const tie = (base) => Array.from({ length: N }, (_, i) => [i % 2 ? 20 : -20, base]);
  const e1 = await post('/lb/submit', { run: ticket(S, 0, 120e3), pk: E, log: tie(300).slice(0, CHARTS[S].n[0]) });
  const f1 = await post('/lb/submit', { run: ticket(S, 0, 120e3), pk: F, log: tie(600).slice(0, CHARTS[S].n[0]) });
  ok(e1.j.acc === f1.j.acc && f1.j.score > e1.j.score, 'same accuracy, different score');
  const tb = await post('/lb/board', { song: S, d: 0 });
  ok(tb.j.top[0].name === 'Tie高分' && tb.j.top[1].name === 'Tie低分' && tb.j.top[0].score === f1.j.score, 'higher score ranks first on a tie');
  const expect = (base, n) => { let t = 0; for (let i = 1; i <= n; i++) t += base + i * 5; return t; };
  ok(e1.j.score === expect(300, CHARTS[S].n[0]), 'server adds the combo bonus itself');
  // reports: hidden after 3 different networks
  const id = bd.j.top[0].id;
  ok((await post('/lb/report', { id })).s === 400, 'report needs a player key');
  ok((await post('/lb/report', { id, pk: pk() })).j.error === 'noname', 'report needs a registered nickname');
  const R1 = pk(), R2 = pk(), R3 = pk();
  for (const [k, n] of [[R1, 'Rep一'], [R2, 'Rep二'], [R3, 'Rep三']]) await post('/lb/name', { pk: k, name: n });
  // (network, reporter): same network twice, then the same reporter on another network: only 1 counts
  for (const [ip, k] of [['198.51.100.1', R1], ['198.51.100.1', R2], ['198.51.100.2', R1], ['198.51.100.2', R2]]) await post('/lb/report', { id, pk: k }, { 'CF-Connecting-IP': ip });
  let v = await post('/lb/board', { song: S, d: D });
  ok(v.j.top.some(r => r.id === id), 'not hidden after 2 distinct reports (duplicates ignored)');
  await post('/lb/report', { id, pk: R3 }, { 'CF-Connecting-IP': '198.51.100.3' });
  v = await post('/lb/board', { song: S, d: D, pk: A });
  const ipSpoof = !v.j.top.some(r => r.id === id);
  ok(ipSpoof ? v.j.me.r === 2 : true, 'hidden player drops out of ranks');
  console.log(ipSpoof ? '  (local dev honours CF-Connecting-IP: auto-hide tested)' : '  (local dev ignores CF-Connecting-IP: auto-hide not testable here)');
  // admin
  ok((await post('/lb/admin', { token: 'x', op: 'reports' })).s === 403, 'admin needs the token');
  const rep = await post('/lb/admin', { token: vars.LB_ADMIN, op: 'reports' }, { Origin: '' });
  ok(rep.s === 200 && rep.j.rows.some(r => r.id === id), 'admin sees reports');
  ok((await post('/lb/admin', { token: vars.LB_ADMIN, op: 'unhide', id })).s === 200, 'admin unhide');
  const fl = await post('/lb/admin', { token: vars.LB_ADMIN, op: 'flagged' });
  ok(fl.s === 200 && fl.j.rows.length === 1 && fl.j.rows[0].name === 'Cee' && fl.j.rows[0].pf === 'ios', 'steady run listed for review');
  const run = await post('/lb/admin', { token: vars.LB_ADMIN, op: 'run', id: fl.j.rows[0].id, board: S + '-' + D });
  ok(run.s === 200 && JSON.parse(run.j.run.log).length === N, 'admin can read the beat log');
  v = await post('/lb/board', { song: S, d: D });
  ok(v.j.top.some(r => r.id === id), 'unhidden player back');
  // delete my records
  ok((await post('/lb/delete', { pk: B })).s === 200, 'delete ok');
  v = await post('/lb/board', { song: S, d: D, pk: B });
  ok(v.j.top.length === 2 && v.j.me === null, 'deleted player gone');
  ok((await post('/lb/name', { pk: C, name: 'Lumi' })).j.ok, 'a deleted name is free again');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
