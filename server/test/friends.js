// Friends server tests. Needs `npx wrangler dev --port 8789` in server/ and the local database (`npm run db:local`).
// Usage: node server/test/friends.js http://127.0.0.1:8789
// Uses the game origin (always allowed) and `ws` from server/node_modules for WebSockets (custom Origin header).
const path = require('node:path');
const crypto = require('node:crypto');
const WS = require(path.join(__dirname, '..', 'node_modules', 'ws'));
const BASE = process.argv[2] || 'http://127.0.0.1:8789', ORIGIN = 'https://pingponglight.vercel.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const pk = () => crypto.randomBytes(16).toString('hex');
const ip = () => '203.0.113.' + (1 + (ip.n = (ip.n || 0) + 1) % 250);   // fresh address per request: keeps the per-IP limit out of the way
async function post(p, body, h = {}) {
  const r = await fetch(BASE + p, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip(), ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { s: r.status, j };
}
function conn(origin = ORIGIN) {
  return new Promise(res => {
    const ws = new WS(BASE.replace(/^http/, 'ws') + '/fr/ws', { headers: origin ? { Origin: origin, 'CF-Connecting-IP': ip() } : {} });
    ws.msgs = []; ws.closed = null;
    ws.on('message', m => ws.msgs.push(JSON.parse(m)));
    ws.on('close', c => { ws.closed = c; });
    ws.on('open', () => res(ws)); ws.on('error', () => res(ws)); ws.on('unexpected-response', (_, r) => { ws.status = r.statusCode; res(ws); });
  });
}
const S = (ws, o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
const last = (ws, t) => ws.msgs.filter(m => m.t === t).pop();
async function waitFor(f, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (f()) return true; await sleep(50); } return !!f(); }
const rnd = () => crypto.randomBytes(3).toString('hex');
async function player(name) {
  const k = pk(); const r = await post('/lb/name', { pk: k, name: name + rnd() });
  const me = await post('/fr/me', { pk: k });
  return { pk: k, id: r.j.id, name: r.j.name, code: me.j.code };
}
const list = async p => (await post('/fr/list', { pk: p.pk })).j;
async function online(p, st, song) {
  const ws = await conn(); S(ws, { t: 'auth', pk: p.pk }); await waitFor(() => last(ws, 'hi'));
  if (st) S(ws, { t: 'st', s: st, song: song === undefined ? null : song });
  return ws;
}

(async () => {
  // access and input checks
  const stranger = pk();
  ok((await post('/fr/me', { pk: stranger })).j.error === 'noname', 'unregistered key: noname');
  ok((await post('/fr/list', { pk: stranger })).s === 400, 'noname is a 400');
  ok((await post('/fr/me', { pk: 'abc' })).s === 400, 'bad key refused');
  ok((await post('/fr/me', { pk: stranger }, { Origin: 'https://evil.example' })).s === 403, 'foreign origin refused');
  ok((await fetch(BASE + '/fr/me', { headers: { Origin: ORIGIN } })).status === 405, 'GET refused');
  ok((await post('/fr/me', 'not json')).s === 400, 'bad json refused');
  ok((await post('/fr/me', 'x'.repeat(5000))).s === 413, 'oversized body refused');

  const A = await player('Ann'), B = await player('Bob'), C = await player('Cy'), D = await player('Di');
  // codes
  ok(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/.test(A.code), 'code format ' + A.code);
  ok((await post('/fr/me', { pk: A.pk })).j.code === A.code, 'code is stable');
  ok(new Set([A.code, B.code, C.code, D.code]).size === 4, 'codes are unique');
  ok(!JSON.stringify((await post('/fr/me', { pk: A.pk })).j).includes(A.pk), '/fr/me returns no key');
  // add: unknown code, self
  ok((await post('/fr/add', { pk: A.pk, code: 'AAAAAAAA' })).j.error === 'nocode', 'unknown code: nocode');
  ok((await post('/fr/add', { pk: A.pk, code: 'abc' })).j.error === 'nocode', 'short code: nocode');
  ok((await post('/fr/add', { pk: A.pk, code: 12 })).s === 400, 'non-string code refused');
  ok((await post('/fr/add', { pk: A.pk, code: A.code })).j.error === 'self', 'adding myself refused');
  // pending request, with a live socket on B to receive the push
  const wsB = await online(B, 'menu');
  let r = await post('/fr/add', { pk: A.pk, code: ' ' + B.code.slice(0, 4).toLowerCase() + '-' + B.code.slice(4).toLowerCase() + ' ' });
  ok(r.j.ok && r.j.pending, 'add with a sloppy code (case, space, dash) -> pending');
  ok(await waitFor(() => last(wsB, 'req')), 'target gets a req push');
  const req = last(wsB, 'req');
  ok(req && req.from.id === A.id && req.from.name === A.name && Object.keys(req.from).length === 2, 'req push has id and name only');
  ok((await post('/fr/add', { pk: A.pk, code: B.code })).j.pending, 'asking twice is harmless');
  let la = await list(A), lb = await list(B);
  ok(la.outgoing.length === 1 && la.outgoing[0].id === B.id && !la.friends.length, 'A sees outgoing');
  ok(lb.incoming.length === 1 && lb.incoming[0].id === A.id && lb.incoming[0].name === A.name, 'B sees incoming');
  ok(!JSON.stringify([la, lb]).match(/"(pk|ph)"/) && !JSON.stringify([la, lb]).includes(A.pk), 'lists leak no keys');
  ok((await post('/fr/respond', { pk: A.pk, id: B.id, accept: true })).s === 400, 'cannot accept a request I sent');
  ok((await post('/fr/respond', { pk: B.pk, id: A.id, accept: 'yes' })).s === 400, 'accept must be boolean');
  wsB.msgs.length = 0;
  const wsA = await online(A, 'home');
  ok((await post('/fr/respond', { pk: B.pk, id: A.id, accept: true })).j.ok, 'B accepts');
  ok(await waitFor(() => last(wsA, 'friend')) && last(wsA, 'friend').id === B.id && last(wsA, 'friend').name === B.name, 'requester gets a friend push');
  la = await list(A); lb = await list(B);
  ok(la.friends.length === 1 && la.friends[0].id === B.id && !la.outgoing.length && !lb.incoming.length, 'now friends, requests cleared');
  ok(lb.friends.length === 1 && lb.friends[0].id === A.id, 'friendship is mutual');
  ok((await post('/fr/add', { pk: A.pk, code: B.code })).j.error === 'already', 'already friends');
  ok((await post('/fr/add', { pk: B.pk, code: A.code })).j.error === 'already', 'already friends (other side)');
  // decline
  ok((await post('/fr/add', { pk: C.pk, code: A.code })).j.pending, 'C asks A');
  ok((await post('/fr/respond', { pk: A.pk, id: C.id, accept: false })).j.ok, 'A declines');
  ok(!(await list(A)).incoming.length && !(await list(C)).outgoing.length, 'declined request gone');
  // mutual add auto-accepts
  ok((await post('/fr/add', { pk: C.pk, code: D.code })).j.pending, 'C asks D');
  const rd = await post('/fr/add', { pk: D.pk, code: C.code });
  ok(rd.j.ok && rd.j.friends && !rd.j.pending, 'D asks C back: friends at once');
  ok((await list(C)).friends.some(f => f.id === D.id) && !(await list(C)).outgoing.length, 'mutual add shows as friends');
  // remove
  ok((await post('/fr/remove', { pk: D.pk, id: C.id })).j.ok, 'remove friend');
  ok(!(await list(C)).friends.length && !(await list(D)).friends.length, 'removed on both sides');
  ok((await post('/fr/add', { pk: C.pk, code: D.code })).j.pending, 'can ask again after removal');
  ok((await post('/fr/remove', { pk: D.pk, id: C.id })).j.ok && !(await list(C)).outgoing.length && !(await list(D)).incoming.length, 'remove cancels a pending request (either direction)');
  // block
  ok((await post('/fr/block', { pk: A.pk, id: A.id })).j.error === 'self', 'cannot block myself');
  ok((await post('/fr/block', { pk: A.pk, id: B.id })).j.ok, 'A blocks B');
  la = await list(A); lb = await list(B);
  ok(!la.friends.length && la.blocked.length === 1 && la.blocked[0].id === B.id && !lb.friends.length && !lb.blocked.length, 'block removes the friendship, shown only to the blocker');
  ok((await post('/fr/add', { pk: B.pk, code: A.code })).j.error === 'nocode', 'blocked B gets nocode');
  ok((await post('/fr/add', { pk: A.pk, code: B.code })).j.error === 'nocode', 'blocker gets nocode too');
  ok((await post('/fr/unblock', { pk: A.pk, id: B.id })).j.ok && !(await list(A)).blocked.length, 'unblock');
  ok((await post('/fr/add', { pk: B.pk, code: A.code })).j.pending, 'adding works again after unblock');
  ok((await post('/fr/respond', { pk: A.pk, id: B.id, accept: true })).j.ok, 'A accepts B again');
  // invites: not friends
  const bad = { id: C.id, room: 'ABCD', song: 'minuetg', d: 1 };
  ok((await post('/fr/invite', { pk: A.pk, ...bad })).j.error === 'notfriend', 'invite to a non-friend refused');
  ok((await post('/fr/decline', { pk: A.pk, id: C.id })).j.error === 'notfriend', 'decline to a non-friend refused');
  for (const x of [{ room: 'ab' }, { room: 'ABC0' }, { song: 'Bad Song' }, { song: 'x'.repeat(25) }, { d: 3 }, { d: 1.5 }, { id: 'x' }]) ok((await post('/fr/invite', { pk: A.pk, id: B.id, room: 'ABCD', song: 'minuetg', d: 1, ...x })).s === 400, 'bad invite field refused: ' + JSON.stringify(x));

  // WebSocket: auth required
  ok((await conn(null)).status === 403, 'ws without Origin rejected');
  ok((await conn('https://evil.example')).status === 403, 'ws with foreign Origin rejected');
  const u = await conn(); S(u, { t: 'st', s: 'play', song: 'x' }); S(u, { t: 'ping' }); S(u, { t: 'bogus' }); await sleep(400);
  ok(u.msgs.length === 0 && u.closed === null, 'unauthenticated socket gets nothing (no pong, no status)');
  ok(!(await list(B)).friends.some(f => f.on === 1 && f.st === 'play'), 'unauthenticated st does not show presence');
  const bd = await conn(); S(bd, { t: 'auth', pk: pk() }); ok(await waitFor(() => bd.closed !== null), 'unknown key: socket closed');
  const bd2 = await conn(); S(bd2, { t: 'auth', pk: 'zz' }); ok(await waitFor(() => bd2.closed !== null), 'malformed key: socket closed');
  // presence and invite over the socket
  for (const w of [wsA, wsB]) w.close();
  await sleep(300);
  const ws1 = await online(A, 'duel', 'minuetg'), ws2 = await online(B, 'menu', null);
  ok(last(ws1, 'hi').id === A.id && last(ws1, 'hi').name === A.name, 'hi carries id and name');
  S(ws1, { t: 'ping' }); ok(await waitFor(() => last(ws1, 'pong')), 'ping -> pong');
  S(ws1, { t: 'st', s: 'bogus', song: null }); S(ws1, { t: 'st', s: 'duel', song: 'Bad Song!' }); S(ws1, { t: 'st', s: 'duel', song: 12 }); await sleep(300);
  await sleep(300);
  lb = await list(B); const fa = lb.friends.find(f => f.id === A.id);
  ok(fa && fa.on === 1 && fa.st === 'duel' && fa.song === 'minuetg', 'list shows on:1, st and song (invalid st updates ignored): ' + JSON.stringify(fa));
  ok(lb.friends.find(f => f.id === A.id).name === A.name && !('pk' in fa) && !('ph' in fa), 'friend row has no keys');
  S(ws1, { t: 'st', s: 'play', song: null }); await sleep(300);
  ok((await list(B)).friends[0].st === 'play' && (await list(B)).friends[0].song === null, 'status change and null song');
  const inv = { id: B.id, room: 'K7P2', song: 'minuetg', d: 2 };
  const t0 = Date.now();
  const iv = await post('/fr/invite', { pk: A.pk, ...inv });
  ok(iv.j.ok === true && iv.j.delivered === true, 'invite delivered');
  ok(await waitFor(() => last(ws2, 'inv')), 'B socket receives inv');
  const m = last(ws2, 'inv');
  ok(m && m.from.id === A.id && m.from.name === A.name && m.room === 'K7P2' && m.song === 'minuetg' && m.d === 2 && m.exp > t0 + 55000 && m.exp < Date.now() + 61000, 'inv fields: ' + JSON.stringify(m));
  ok((await post('/fr/invite', { pk: A.pk, ...inv })).s === 429, 'second invite within 5 s to the same friend: 429');
  S(ws2, { t: 'st', s: 'menu', song: null });
  ok((await post('/fr/decline', { pk: B.pk, id: A.id })).j.ok, 'B declines');
  ok(await waitFor(() => last(ws1, 'invno')) && last(ws1, 'invno').from.id === B.id && last(ws1, 'invno').from.name === B.name, 'inviter receives invno');
  // invite to a friend who is offline
  ws2.close(); await sleep(700);
  await sleep(5000);
  const off = await post('/fr/invite', { pk: A.pk, ...inv });
  ok(off.j.ok === true && off.j.delivered === false, 'invite to an offline friend: delivered false');
  const fo = (await list(A)).friends.find(f => f.id === B.id);
  ok(fo && fo.on === 0 && fo.seen > t0 - 1000 && fo.seen <= Date.now(), 'offline friend: on:0 and seen set ' + JSON.stringify(fo));
  // per-minute invite cap (20)
  const ws3 = await online(B, 'menu'); let sent = 0, limitedAt = 0;
  // pair spacing is 5 s, so the cap needs many different recipients: befriend a few extra players
  const extra = []; for (let i = 0; i < 22; i++) { const p = await player('E'); extra.push(p); await post('/fr/add', { pk: A.pk, code: p.code }); await post('/fr/respond', { pk: p.pk, id: A.id, accept: true }); }
  for (const p of extra) { const x = await post('/fr/invite', { pk: A.pk, id: p.id, room: 'ABCD', song: 'minuetg', d: 0 }); if (x.j.ok) sent++; else if (x.s === 429 && !limitedAt) limitedAt = sent; }
  ok(limitedAt >= 17 && limitedAt <= 19 && sent === limitedAt, 'sender capped at 20 invites per minute (sent ' + sent + ' more after the earlier ones)');
  ws3.close();
  // oversized and binary messages close the socket
  const big = await online(B); S(big, 'x'.repeat(300)); ok(await waitFor(() => big.closed === 1008), 'oversized ws message -> closed ' + big.closed);
  const bin = await online(B); bin.send(Buffer.from([1, 2, 3])); ok(await waitFor(() => bin.closed === 1008), 'binary ws message -> closed ' + bin.closed);
  const fl = await online(B); for (let i = 0; i < 100; i++) S(fl, { t: 'ping' }); ok(await waitFor(() => fl.closed === 1008, 4000), 'ping flood -> closed ' + fl.closed);
  // unauthenticated socket is dropped after the auth timeout
  const idle = await conn(); const t1 = Date.now();
  // the close frame arrives at ~10 s (readyState 2 = closing); the TCP close completes later, so do not wait for the 'close' event
  ok(await waitFor(() => idle.readyState >= 2, 14000) && Date.now() - t1 >= 9000, 'unauthenticated socket closed after ~10 s (' + (Date.now() - t1) + ' ms)');
  // delete: every friends row about the player goes
  ok((await post('/fr/block', { pk: D.pk, id: A.id })).j.ok, 'D blocks A');
  ok((await post('/fr/add', { pk: A.pk, code: C.code })).j.pending, 'A asks C');
  ok((await post('/fr/add', { pk: D.pk, code: C.code })).j.pending, 'D asks C');
  ok((await post('/fr/add', { pk: C.pk, code: B.code })).j.pending, 'C asks B');
  ok((await post('/fr/remove', { pk: C.pk, id: B.id })).j.ok && (await post('/fr/add', { pk: B.pk, code: C.code })).j.pending, 'B asks C');
  ok((await list(B)).friends.some(f => f.id === A.id) && (await list(C)).incoming.length === 3, 'before delete: B has A as a friend, C has 3 incoming');
  ok((await post('/lb/delete', { pk: A.pk })).s === 200, 'A deletes their data');
  lb = await list(B); const lc = await list(C), ld = await list(D);
  ok(!lb.friends.some(f => f.id === A.id), "A is gone from B's friends");
  ok(!lc.incoming.some(f => f.id === A.id) && lc.incoming.length === 2, "A's outgoing request is gone from C");
  ok(!ld.blocked.some(f => f.id === A.id) && !ld.blocked.length, "D's block of A is gone");
  ok(!(await list(extra[0])).friends.length && !(await list(extra[21])).friends.length, 'extra friends of A lost the friendship');
  ok((await post('/fr/me', { pk: A.pk })).j.error === 'noname', 'A is unregistered afterwards');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
