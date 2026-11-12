// Tests for the v2 multiplayer server (Arena + Lobby) against the local dev server.
// Usage: QM_WAIT_MS=3000 node server/test/arena.js [base]
// Start the server with:  npx wrangler dev --port 8787 --var QM_WAIT_MS:3000
// (QM_WAIT_MS only has an effect on a server running with ALLOW_LOCAL=1; production always waits 15 s.)
// This script reads QM_WAIT_MS only to know how long to expect the quick-match wait to be (default 15000).
const WS = require(require('path').join(__dirname, '..', 'node_modules', 'ws'));
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const O = 'https://pingponglight.vercel.app';
const WAIT = +process.env.QM_WAIT_MS || 15000;
const PH_WAIT = 15500;   // placeholder life in Lobby is 15 s
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + m); };
// the per-IP limiter (30/min) can trip when the suite runs twice in a row: wait and retry on 429
const get = async (p, origin = O) => { let r; for (let i = 0; i < 8; i++) { r = await fetch(BASE + p, { headers: origin ? { Origin: origin } : {} }); if (r.status !== 429) break; await sleep(10000); } let j = null; try { j = await r.json(); } catch (e) {} return { status: r.status, j }; };
async function conn(code, origin = O) {
  for (let i = 0; i < 8; i++) { const w = await conn1(code, origin); if (w.status !== 429) return w; await sleep(10000); }
  return conn1(code, origin);
}
function conn1(code, origin = O) {
  return new Promise(res => {
    const ws = new WS(BASE.replace(/^http/, 'ws') + '/m/ws/' + code, origin ? { headers: { Origin: origin } } : {});
    ws.msgs = []; ws.closed = null; ws.status = 0;
    ws.on('message', m => ws.msgs.push(JSON.parse(m)));
    ws.on('close', c => { ws.closed = c; });
    ws.on('open', () => res(ws)); ws.on('error', () => res(ws)); ws.on('unexpected-response', (_, r) => { ws.status = r.statusCode; res(ws); });
  });
}
const S = (ws, o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
const last = (ws, t) => ws.msgs.filter(m => m.t === t).pop();
const live = ws => ws.readyState === 1;
async function waitFor(fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(50); } return false; }
async function newRoom(q = 'pub=0&max=8&di=1') { const r = await get('/m/new?' + q); return r.j && r.j.code; }
async function join(code, n) { const a = []; for (let i = 0; i < n; i++) { a.push(await conn(code)); await sleep(60); } await sleep(200); return a; }
const closeAll = a => a.forEach(w => { try { w.close(); } catch (e) {} });
const readyAll = async a => { a.forEach(w => S(w, { t: 'ready', v: true })); await sleep(300); };
const pOf = (ws, i) => last(ws, 'room').players.find(p => p.i === i);

(async () => {
  const keep = [];
  // ---- origin / routing / capacity ----
  let r = await get('/m/new', null); ok(r.status === 403, 'no Origin -> /m/new 403 (' + r.status + ')');
  r = await get('/m/new', 'https://evil.example'); ok(r.status === 403, 'evil Origin -> /m/new 403');
  r = await get('/m/rooms', 'https://evil.example'); ok(r.status === 403, 'evil Origin -> /m/rooms 403');
  r = await get('/m/match', 'https://evil.example'); ok(r.status === 403, 'evil Origin -> /m/match 403');
  const code = await newRoom(); ok(/^[A-Z0-9]{4}$/.test(code || ''), '/m/new -> code ' + code);
  let w = await conn(code, 'https://evil.example'); ok(w.status === 403, 'ws with evil Origin -> 403 (' + w.status + ')');
  w = await conn(code, null); ok(w.status === 403, 'ws without Origin -> 403 (' + w.status + ')');
  w = await conn('ZZZZ'); ok(w.status === 404, 'unknown room -> 404 (' + w.status + ')');
  r = await get('/m/zzz'); ok(r.status === 404, 'unknown /m path -> 404');
  const P = await join(code, 8);
  ok(P.every(live), '8 players joined (3..8 all accepted)');
  ok(last(P[7], 'room').players.length === 8 && last(P[7], 'room').you === 7 && last(P[7], 'room').code === code, 'room msg has 8 players, you=7, code');
  const nine = await conn(code); ok(nine.status === 409, '9th player -> 409 (' + nine.status + ')');
  closeAll(P); closeAll([nine]);
  await sleep(300);

  // ---- hello, cfg ----
  const c2 = await newRoom('pub=0&max=5&di=1'); const A = await join(c2, 3);
  S(A[0], { t: 'hello', name: '<b>Ann"</b>' }); await sleep(200);
  ok(!/[<>"]/.test(pOf(A[1], 0).name) && pOf(A[1], 0).name.includes('Ann'), 'hello name sanitised -> ' + pOf(A[1], 0).name);
  S(A[0], { t: 'hello', name: 'fuck' }); await sleep(200); ok(pOf(A[1], 0).name.includes('Ann'), 'blocked name ignored');
  const cfg0 = last(A[0], 'room').cfg; ok(cfg0.qm === false && cfg0.max === 5 && cfg0.di === 1 && cfg0.pub === false, 'initial cfg ' + JSON.stringify(cfg0));
  S(A[1], { t: 'cfg', song: 'canon', di: 3, max: 6 }); await sleep(200);
  const cfg1 = last(A[0], 'room').cfg; ok(cfg1.song === cfg0.song && cfg1.di === 1 && cfg1.max === 5, 'non-host cfg ignored');
  S(A[0], { t: 'cfg', song: 'no_such_song' }); await sleep(200);
  ok(last(A[0], 'room').cfg.song === cfg0.song, 'cfg with unknown song rejected');
  await sleep(450); S(A[0], { t: 'cfg', max: 2 }); await sleep(200);
  ok(last(A[0], 'room').cfg.max === 5, 'cfg max < players rejected');
  await sleep(450); S(A[0], { t: 'ready', v: true }); S(A[1], { t: 'ready', v: true }); await sleep(200);
  S(A[0], { t: 'cfg', song: 'canon', di: 2, max: 4, pub: true, vote: false }); await sleep(250);
  const cfg2 = last(A[1], 'room').cfg; ok(cfg2.song === 'canon' && cfg2.di === 2 && cfg2.max === 4 && cfg2.pub === true, 'host cfg applied ' + JSON.stringify(cfg2));
  ok(last(A[1], 'room').players.every(p => !p.ready), 'cfg song/di change clears ready');
  await sleep(450); S(A[0], { t: 'cfg', di: 99 }); await sleep(200); ok(last(A[0], 'room').cfg.di === 4, 'cfg di clamped to 4');
  await sleep(450); S(A[0], { t: 'cfg', di: 2 }); await sleep(200);
  // cfg spam throttled
  A[2].msgs.length = 0; for (let i = 0; i < 12; i++) { S(A[0], { t: 'cfg', di: i % 5 }); await sleep(40); }
  await sleep(300); ok(A[2].msgs.filter(m => m.t === 'room').length <= 3, 'cfg spam throttled (' + A[2].msgs.filter(m => m.t === 'room').length + ' broadcasts)');
  await sleep(450); S(A[0], { t: 'cfg', di: 2 }); await sleep(250);
  S(A[1], { t: 'vote', song: 'twinkle' }); await sleep(150); ok(!pOf(A[0], 1).vote, 'vote ignored when voting is off');

  // ---- ready / start ----
  S(A[0], { t: 'ready', v: true }); S(A[1], { t: 'ready', v: true }); await sleep(300);
  ok(!last(A[0], 'start'), 'not everyone ready -> no start');
  S(A[2], { t: 'ready', v: true }); await sleep(400);
  const st0 = A.map(x => last(x, 'start')); ok(st0.every(Boolean), 'all ready -> start sent to all');
  ok(st0[0].song === 'canon' && st0[0].di === 2 && st0[0].n === 3, 'start carries song key / di / n ' + JSON.stringify(st0[0]));
  ok(st0.every(s => s.seed === st0[0].seed && s.at === st0[0].at) && typeof st0[0].seed === 'number', 'start seed and at identical for everyone');
  const lateW = await conn(c2); ok(lateW.status === 423, 'join during play -> 423 (' + lateW.status + ')');
  S(A[0], { t: 'cfg', di: 0 }); S(A[0], { t: 'hello', name: 'Zed' }); await sleep(200);
  ok(last(A[0], 'room').phase === 'play' && last(A[0], 'room').cfg.di === 2, 'cfg/hello ignored during play');

  // ---- board / atk ----
  A.forEach(x => { x.msgs.length = 0; });
  S(A[0], { t: 'st', s: 300, c: 5, l: 80, r: 0, j: 1 }); S(A[1], { t: 'st', s: 200, c: 3, l: 70, r: 0, j: 2 }); S(A[2], { t: 'st', s: 100, c: 1, l: 60, r: 0, j: 0 });
  await sleep(400); S(A[2], { t: 'st', s: 100, c: 1, l: 60, r: 0, j: 0 }); await sleep(400);
  let bd = last(A[1], 'board'); ok(bd && bd.p.length === 3 && [0, 1, 2].every(i => bd.p.some(x => x[0] === i)), 'board has all players ' + JSON.stringify(bd && bd.p));
  const row = i => last(A[0], 'board').p.find(x => x[0] === i);
  ok(row(0)[1] === 300 && row(1)[1] === 200 && row(2)[1] === 100 && row(0)[5] === 0 && row(0).length === 7 && row(0)[6] === 1, 'board rows [i,s,c,l,j,fin,ok] correct');
  S(A[0], { t: 'st', s: 10 }); S(A[1], { t: 'st', s: 150 }); await sleep(400); S(A[0], { t: 'st', s: 99999 }); await sleep(300); S(A[2], { t: 'st', s: 101 }); await sleep(400);
  ok(row(0)[1] === 30300 && row(1)[1] === 200, 'score going backwards ignored; a jump > 30000 is clamped to last+30000 (' + row(0)[1] + ',' + row(1)[1] + ')');
  const bs = A[0].msgs.filter(m => m.t === 'board').length; ok(bs >= 1 && bs <= 6, 'board throttled (' + bs + ' boards)');
  A.forEach(x => { x.msgs.length = 0; });
  S(A[2], { t: 'atk', k: 'fog' }); await sleep(250);
  ok(last(A[1], 'atk') && last(A[1], 'atk').from === 2 && last(A[1], 'atk').k === 'fog' && !last(A[0], 'atk') && !last(A[2], 'atk'), 'atk from 3rd goes only to the one ahead (2nd)');
  S(A[1], { t: 'atk', k: 'bump' }); await sleep(250); ok(last(A[0], 'atk') && last(A[0], 'atk').from === 1 && !last(A[2], 'atk'), 'atk from 2nd goes to 1st');
  S(A[0], { t: 'atk', k: 'shrink' }); await sleep(250); ok(last(A[1], 'atk') && last(A[1], 'atk').k === 'shrink' && !last(A[2], 'atk'), 'leader attacks the 2nd');
  await sleep(2000); A[1].msgs.length = 0; S(A[2], { t: 'atk', k: 'nuke' }); S(A[2], { t: 'atk', k: 'bump' }); S(A[2], { t: 'atk', k: 'bump' }); await sleep(250);
  ok(A[1].msgs.filter(m => m.t === 'atk').length === 1, 'invalid atk ignored, atk spaced 2 s (' + A[1].msgs.filter(m => m.t === 'atk').length + ' delivered)');

  // ---- fin / res ordering ----
  A.forEach(x => { x.msgs.length = 0; });
  S(A[2], { t: 'fin', s: 100, ok: true, acc: 50, rank: 'C', mc: 2 }); S(A[2], { t: 'fin', s: 9999, ok: true, rank: 'S' }); await sleep(250);
  ok(!last(A[0], 'res') && last(A[0], 'board').p.find(x => x[0] === 2)[5] === 1, 'one fin -> board shows fin flag, no res yet');
  S(A[1], { t: 'fin', s: 999, ok: false, acc: 20, rank: '<x>', mc: 1 }); await sleep(300);
  const bf = last(A[0], 'board').p; ok(bf.find(x => x[0] === 1)[5] === 1 && bf.find(x => x[0] === 1)[6] === 0 && bf.find(x => x[0] === 2)[6] === 1, 'board: fin + ok:false -> ok 0, fin + ok:true -> ok 1 ' + JSON.stringify(bf));
  S(A[0], { t: 'fin', s: 300, ok: true, acc: 99.5, rank: 'A', mc: 9 }); await sleep(400);
  const res = last(A[1], 'res');
  ok(res && res.r.length === 3 && res.r.map(x => x.i).join() === '0,2,1', 'res order: finished by score, failed after ' + JSON.stringify(res && res.r.map(x => [x.i, x.s, x.ok])));
  ok(res && res.r[1].s === 100 && res.r[1].rank === 'C' && res.r[2].rank === '—' && res.r[0].acc === 99.5 && res.r[0].name, 'res rows hold clamped fields and names');
  ok(last(A[0], 'room').phase === 'lobby', 'back to lobby after res');
  closeAll(A);
  await sleep(300);

  // ---- vote ----
  const cv = await newRoom('pub=0&max=4&di=0'); const V = await join(cv, 3);
  S(V[0], { t: 'cfg', song: 'green', vote: true }); await sleep(250);
  S(V[0], { t: 'vote', song: 'twinkle' }); S(V[1], { t: 'vote', song: 'canon' }); S(V[2], { t: 'vote', song: 'nope' }); await sleep(250); S(V[2], { t: 'vote', song: 'canon' }); await sleep(250);
  const vr = last(V[0], 'room'); ok(vr.votes.canon === 2 && vr.votes.twinkle === 1 && pOf(V[0], 1).vote === 'canon', 'votes tallied ' + JSON.stringify(vr.votes));
  S(V[0], { t: 'vote', song: 'auld' }); await sleep(200); S(V[0], { t: 'vote', song: 'canon' }); await sleep(200);
  await readyAll(V); ok(last(V[0], 'start') && last(V[0], 'start').song === 'canon', 'vote: top-voted song starts (' + (last(V[0], 'start') || {}).song + ')');
  closeAll(V); await sleep(300);
  const cv2 = await newRoom('pub=0&max=4&di=0'); const V2 = await join(cv2, 2);
  S(V2[0], { t: 'cfg', song: 'auld', vote: true }); await sleep(250); await readyAll(V2);
  ok(last(V2[0], 'start') && last(V2[0], 'start').song === 'auld', 'vote on but nobody voted -> host song');
  closeAll(V2); await sleep(300);

  // ---- leaving mid-round ----
  const cl = await newRoom('pub=0&max=4&di=1'); const L = await join(cl, 3); await readyAll(L);
  S(L[1], { t: 'st', s: 40 }); S(L[0], { t: 'st', s: 70 }); await sleep(300);
  S(L[0], { t: 'fin', s: 70, ok: true, acc: 90, rank: 'B', mc: 3 }); S(L[2], { t: 'fin', s: 10, ok: false, acc: 10, rank: 'D', mc: 1 }); await sleep(250);
  L[0].msgs.length = 0; L[2].msgs.length = 0; L[1].close(); await sleep(500);
  const lf = last(L[0], 'left'); ok(lf && lf.i === 1, 'left {i} broadcast when a player drops');
  const res2 = last(L[0], 'res');
  ok(res2 && res2.r.length === 3 && res2.r.map(x => x.i).join() === '0,2,1' && res2.r[2].ok === false && res2.r[2].s === 40 && res2.r[2].name, 'all remaining fin -> immediate res, offline unfinished last with last st score ' + JSON.stringify(res2 && res2.r.map(x => [x.i, x.s, x.ok])));
  ok(last(L[0], 'room').phase === 'lobby' && last(L[0], 'room').players.length === 2, 'lobby again with 2 players');
  await readyAll([L[0], L[2]]); L[0].msgs.length = 0; L[2].msgs.length = 0;
  S(L[0], { t: 'st', s: 5 }); L[0].close(); await sleep(400);
  ok(!last(L[2], 'res') && last(L[2], 'room').phase === 'play', 'one still playing -> no res yet');
  S(L[2], { t: 'fin', s: 8, ok: true, rank: 'B' }); await sleep(300);
  const res3 = last(L[2], 'res'); ok(res3 && res3.r.length === 2 && res3.r[0].i === 2 && res3.r[1].i === 0 && res3.r[1].s === 5 && !res3.r[1].ok, 'res lists the dropped player last');
  closeAll(L);
  const cl2 = await newRoom('pub=0&max=3'); const L2 = await join(cl2, 2); await readyAll(L2); closeAll(L2); await sleep(500);
  const w3 = await conn(cl2); await sleep(300); ok(w3.readyState === 1 && last(w3, 'room') && last(w3, 'room').phase === 'lobby', 'everyone left mid-round -> room back to lobby');
  closeAll([w3]);

  // ---- lobby drop starts the round when the rest are all ready ----
  const cd = await newRoom('pub=0&max=4&di=1'); const D = await join(cd, 3);
  S(D[0], { t: 'ready', v: true }); S(D[1], { t: 'ready', v: true }); await sleep(300);
  ok(!last(D[0], 'start'), 'drop test: 2 of 3 ready -> no start');
  D[2].close(); await sleep(600);
  ok(last(D[0], 'start') && last(D[1], 'start') && last(D[0], 'start').n === 2, 'unready player leaves, remaining 2 all ready -> round starts immediately');
  closeAll(D); await sleep(300);
  const cd2 = await newRoom('pub=0&max=4&di=1'); const D2 = await join(cd2, 2);
  S(D2[0], { t: 'ready', v: true }); await sleep(200); D2[1].close(); await sleep(500);
  ok(!last(D2[0], 'start'), 'one player left alone and ready -> no start');
  closeAll(D2);

  // ---- lobby placeholders / pending joins (quick match reservations) ----
  const ph = await get('/m/match?di=4&max=7'); const phc = ph.j.code;
  ok(ph.status === 200 && /^[A-Z0-9]{4}$/.test(phc || ''), '/m/match creates a room, never 503 (' + ph.status + ')');
  ok(!(await get('/m/rooms?di=4')).j.rooms.some(x => x.code === phc), 'placeholder room is not listed');
  const pm = await get('/m/match?di=4&max=2'), pm2 = await get('/m/match?di=4&max=2');
  ok(pm.j.code && pm.j.code === pm2.j.code, 'pending: two matchers get the same max=2 room');
  const pw = await conn(pm.j.code); await sleep(400);          // one of them really connects (Arena upsert n=1)
  const pm3 = await get('/m/match?di=4&max=2');
  ok(pm3.j.code && pm3.j.code !== pm.j.code, 'pending joiner survives the Arena upsert: 1 connected + 1 pending = full -> 3rd matcher gets a new room (' + pm3.j.code + ' vs ' + pm.j.code + ')');
  const pw2 = await conn(pm.j.code); await sleep(300);
  const pm4 = await get('/m/match?di=4&max=2');
  ok(pm4.j.code === pm3.j.code, 'both really connected -> pending cleared, the 3rd matcher room is still the open one');
  closeAll([pw, pw2]);
  await sleep(PH_WAIT);
  const pm5 = await get('/m/match?di=4&max=7'); ok(pm5.j.code && pm5.j.code !== phc, 'unused placeholder expires (~15 s) and is not matched again (' + phc + ' -> ' + pm5.j.code + ')');

  // ---- /m/rooms ----
  const pa = await newRoom('pub=1&max=6&di=4'), pb = await newRoom('pub=0&max=6&di=4'), pc = await newRoom('pub=1&max=3&di=2');
  const R1 = await join(pa, 1), R2 = await join(pb, 1), R3 = await join(pc, 2); await sleep(400);
  await sleep(800); S(R1[0], { t: 'hello', name: 'Hosty' }); await sleep(1300);
  let li = (await get('/m/rooms?di=-1')).j.rooms; ok(Array.isArray(li) && li.length <= 30, '/m/rooms returns <= 30 rooms');
  const fa = li.find(x => x.code === pa);
  ok(fa && fa.host === 'Hosty' && fa.di === 4 && fa.n === 1 && fa.max === 6 && fa.phase === 'lobby' && fa.qm === false && typeof fa.song === 'string', 'public room listed with summary ' + JSON.stringify(fa));
  ok(!li.some(x => x.code === pb), 'private room not listed');
  li = (await get('/m/rooms?di=4')).j.rooms; ok(li.some(x => x.code === pa) && !li.some(x => x.code === pc), 'di=4 filter');
  li = (await get('/m/rooms?di=2')).j.rooms; ok(li.some(x => x.code === pc) && !li.some(x => x.code === pa), 'di=2 filter');
  await readyAll(R3); await sleep(400);
  li = (await get('/m/rooms?di=2')).j.rooms; ok(li.find(x => x.code === pc) && li.find(x => x.code === pc).phase === 'play', 'playing room listed with phase play');
  li = (await get('/m/rooms?di=2&space=1')).j.rooms; ok(!li.some(x => x.code === pc), 'space=1 hides rooms in play');
  closeAll(R3); closeAll(R2);
  const R4 = await join(pc, 2); S(R4[0], { t: 'cfg', max: 2 }); await sleep(500); await sleep(0);
  li = (await get('/m/rooms?di=2&space=1')).j.rooms; ok(!li.some(x => x.code === pc), 'space=1 hides full rooms (n == max)');
  S(R4[0], { t: 'cfg', max: 3 }); await sleep(500);
  li = (await get('/m/rooms?di=2&space=1')).j.rooms; ok(li.some(x => x.code === pc), 'space=1 lists lobby rooms with space');
  closeAll(R4); closeAll(R1); await sleep(500);
  li = (await get('/m/rooms?di=-1')).j.rooms; ok(!li.some(x => x.code === pa || x.code === pc), 'empty rooms are removed from the list');

  // ---- quick match ----
  const m1 = await get('/m/match?di=3&max=4'), m2 = await get('/m/match?di=3&max=4');
  ok(m1.j.code && m1.j.code === m2.j.code, 'two /m/match with same conditions -> same room (' + m1.j.code + ',' + m2.j.code + ')');
  const m3 = await get('/m/match?di=0&max=4'); ok(m3.j.code && m3.j.code !== m1.j.code, 'different difficulty -> different room');
  const m4 = await get('/m/match?di=3&max=5'); ok(m4.j.code && m4.j.code !== m1.j.code, 'different max -> different room');
  const Q = [await conn(m1.j.code), await conn(m1.j.code)]; await sleep(300);
  const qroom = last(Q[0], 'room'); ok(qroom && qroom.cfg.qm === true && qroom.cfg.di === 3 && qroom.cfg.max === 4 && qroom.phase === 'lobby', 'qm room cfg ' + JSON.stringify(qroom && qroom.cfg));
  ok(qroom.auto && qroom.auto.at > Date.now() - 5000, 'room.auto present with 2 players');
  S(Q[0], { t: 'cfg', song: 'canon', di: 0 }); S(Q[0], { t: 'ready', v: true }); S(Q[1], { t: 'ready', v: true }); await sleep(300);
  ok(last(Q[0], 'room').cfg.di === 3 && !last(Q[0], 'start'), 'qm room: cfg and ready ignored');
  // di=-1 prefers the fullest room
  const m5 = await get('/m/match?di=-1&max=4'); ok(m5.j.code === m1.j.code, 'di=-1 prefers the room with most players');
  const m6 = await get('/m/match?di=1&max=2'); const m7 = await get('/m/match?di=1&max=2'); ok(m6.j.code === m7.j.code, 'max=2 matched together');
  // 2 players -> auto start after the wait
  const t0 = Date.now(); const waited = await waitFor(() => last(Q[0], 'start') && last(Q[1], 'start'), WAIT + 4000);
  const el = Date.now() - t0 + 300; ok(waited, 'quick match: 2 players auto start within wait (' + el + ' ms, wait ' + WAIT + ')');
  ok(waited && el >= WAIT - 800, 'quick match: not before the wait (' + el + ' ms)');
  const qs = last(Q[0], 'start'); ok(qs && Object.prototype.hasOwnProperty.call({ green: 1, twinkle: 1, auld: 1, grace: 1, silent: 1, canon: 1, prelude: 1, minuetg: 1, spring: 1, air: 1, hallelujah: 1, fireworks: 1, turkish: 1, nacht: 1, k545: 1, moon: 1 }, qs.song) || (qs && typeof qs.song === 'string' && qs.song.length > 0), 'qm start has a song key ' + (qs && qs.song));
  // after the round: back to the lobby, no automatic countdown until 2 players sent again
  Q.forEach(x => { x.msgs.length = 0; });
  S(Q[0], { t: 'fin', s: 50, ok: true, acc: 0.5, rank: 'B', mc: 1 }); S(Q[1], { t: 'fin', s: 40, ok: true, acc: 0.4, rank: 'C', mc: 1 }); await sleep(500);
  let qr = last(Q[0], 'room');
  ok(last(Q[0], 'res') && qr.phase === 'lobby' && qr.auto === null && qr.players.length === 2 && qr.players.every(p => p.back === false), 'qm after round: lobby, no auto countdown, players back=false ' + JSON.stringify(qr.players));
  Q.forEach(x => { x.msgs.length = 0; }); await sleep(WAIT + 1200);
  ok(!last(Q[0], 'start'), 'qm: no new round starts by itself after the wait');
  S(Q[0], { t: 'again' }); await sleep(400);
  qr = last(Q[1], 'room'); ok(qr && qr.players.find(p => p.i === 0).back === true && qr.players.find(p => p.i === 1).back === false && qr.auto === null, 'one again -> back for that player only, still no countdown');
  const ta = Date.now(); S(Q[1], { t: 'again' }); await sleep(300);
  ok(last(Q[0], 'room') && last(Q[0], 'room').auto && last(Q[0], 'room').players.every(p => p.back), 'second again -> countdown begins (room.auto set)');
  const w2 = await waitFor(() => last(Q[0], 'start') && last(Q[1], 'start'), WAIT + 4000);
  ok(w2 && Date.now() - ta >= WAIT - 800, 'qm 2nd round starts after the wait (' + (Date.now() - ta) + ' ms)');
  closeAll(Q);
  // full room starts in about 3 s
  const f1 = (await get('/m/match?di=2&max=3')).j.code; const FQ = [await conn(f1), await conn(f1)]; await sleep(300);
  const f2 = (await get('/m/match?di=2&max=3')).j.code; ok(f1 === f2, 'third matcher lands in same room');
  const tf = Date.now(); FQ.push(await conn(f2)); const fs = await waitFor(() => FQ.every(x => last(x, 'start')), 6000);
  const fel = Date.now() - tf; ok(fs && fel >= 2000 && fel <= 5500 && (WAIT > 3500 ? fel < WAIT : true), 'room reaching max starts after ~3 s (' + fel + ' ms)');
  ok(fs && last(FQ[0], 'start').n === 3, 'start n = 3');
  closeAll(FQ);

  // ---- abuse ----
  const ca = await newRoom('pub=0&max=4&di=1');
  const E = await conn(ca); S(E, 'x'.repeat(5000)); await sleep(300); ok(E.closed === 1008, 'oversized message -> closed ' + E.closed);
  const F = await conn(ca); F.send(Buffer.from([1, 2, 3])); await sleep(300); ok(F.closed === 1008, 'binary message -> closed ' + F.closed);
  const G = await conn(ca); for (let i = 0; i < 400; i++) S(G, { t: 'ping', c: i }); await sleep(800);
  const pongs = G.msgs.filter(m => m.t === 'pong').length; ok(pongs <= 60 && G.closed === 1008, 'flood: ' + pongs + ' answered, closed ' + G.closed);
  const H = await conn(ca); for (const g of ['null', '[]', '{"t":5}', '{', '"s"', '{"t":"__proto__"}', '{"t":"ping","c":{"a":1}}', '{"t":"cfg","song":{"a":1}}', '{"t":"vote","song":"__proto__"}', '{"t":"st","s":"x"}']) S(H, g); await sleep(300);
  ok(live(H) && last(H, 'pong') && last(H, 'pong').c === 0, 'garbage handled, socket alive');
  S(H, { t: 'st', s: 5 }); S(H, { t: 'atk', k: 'fog' }); S(H, { t: 'fin', s: 1 }); await sleep(200); ok(live(H), 'st/atk/fin in lobby ignored');
  const gk = await newRoom('pub=0&max=2'); const K = await join(gk, 2); const K3 = await conn(gk); ok(K3.status === 409, 'max=2 room: 3rd -> 409');
  closeAll([E, F, G, H, K3, ...K]);

  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
