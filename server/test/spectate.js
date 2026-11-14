// Spectator relay tests (docs/spectate-spec.md "協定") against the local dev server.
// Usage: node server/test/spectate.js [base]      (start the server first: npx wrangler dev --port 8787)
// Takes about 30 s (one check waits out the 20 s "stuck round" rule to reach finishRound while someone is still watching).
const WS = require(require('path').join(__dirname, '..', 'node_modules', 'ws'));
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const O = 'https://pingponglight.vercel.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + m); };
async function get(p) { let r; for (let i = 0; i < 8; i++) { r = await fetch(BASE + p, { headers: { Origin: O } }); if (r.status !== 429) break; await sleep(10000); } return r.json(); }
function conn1(code) {
  return new Promise(res => {
    const ws = new WS(BASE.replace(/^http/, 'ws') + '/m/ws/' + code, { headers: { Origin: O } });
    ws.msgs = []; ws.status = 0; ws.closed = null;
    ws.on('message', m => ws.msgs.push(JSON.parse(m))); ws.on('close', c => { ws.closed = c; });
    ws.on('open', () => res(ws)); ws.on('error', () => res(ws)); ws.on('unexpected-response', (_, r) => { ws.status = r.statusCode; res(ws); });
  });
}
async function conn(code) { for (let i = 0; i < 8; i++) { const w = await conn1(code); if (w.status !== 429) return w; await sleep(10000); } return conn1(code); }
const S = (ws, o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
const of = (ws, t) => ws.msgs.filter(m => m.t === t);
const last = (ws, t) => of(ws, t).pop();
const mark = ws => ws.msgs.length;                                  // later: only what arrived after this point
const since = (ws, n, t) => ws.msgs.slice(n).filter(m => m.t === t);
async function room(n) { const c = (await get('/m/new?pub=0&max=8&di=1')).code, a = []; for (let i = 0; i < n; i++) { a.push(await conn(c)); await sleep(60); } await sleep(200); return { code: c, a }; }
const startAll = async a => { a.forEach(w => S(w, { t: 'ready', v: true })); await sleep(500); };
const FIN = { t: 'fin', s: 100, ok: true, acc: 90, rank: 'A', mc: 5 };

(async () => {
  const { a: P } = await room(4);                                    // seats 0..3
  // lobby: nothing is accepted
  S(P[0], { t: 'fin', s: 1 }); S(P[0], { t: 'watch', i: 1 }); await sleep(200);
  ok(of(P[1], 'wcnt').length === 0, 'watch in the lobby is ignored');
  await startAll(P); ok(P.every(w => last(w, 'start')), 'round started');
  // not finished -> cannot watch
  let m = mark(P[1]); S(P[0], { t: 'watch', i: 1 }); await sleep(200);
  ok(since(P[1], m, 'wcnt').length === 0 && of(P[0], 'wend').length === 0, 'a player who has not finished cannot watch');
  S(P[0], { t: 'v', g: 1, b: [[0.5, 0.5]] }); await sleep(150);
  ok(P.slice(1).every(w => of(w, 'v').length === 0), 'a frame with nobody watching goes nowhere');
  // finished -> can watch
  S(P[0], FIN); await sleep(200);
  m = mark(P[1]); S(P[0], { t: 'watch', i: 1 }); await sleep(250);
  ok(since(P[1], m, 'wcnt').length === 1 && last(P[1], 'wcnt').n === 1, 'watch accepted: target gets wcnt n=1');
  m = mark(P[2]); S(P[2], { t: 'v', g: 2, s: 9 }); S(P[1], { t: 'v', g: 7, b: [[0.1, 0.2], [0.3, 0.4]], e: [[0, 0.5, 0.5]], s: 50, c: 3, l: 90, k: ['orb.star'] }); await sleep(250);
  const got = of(P[0], 'v'); ok(got.length === 1 && got[0].i === 1 && got[0].g === 7 && got[0].b.length === 2 && got[0].s === 50, 'v from the watched seat reaches the watcher with i = sender: ' + JSON.stringify(got[0] || null));
  ok(of(P[1], 'v').length === 0 && of(P[2], 'v').length === 0 && of(P[3], 'v').length === 0, 'v goes only to whoever watches the sender (not the sender, not others, not a seat nobody watches)');
  // second watcher, switching, counts
  S(P[1], { t: 'fin', s: 50, ok: false, acc: 10, rank: 'D', mc: 1 }); await sleep(250);
  ok(of(P[0], 'wend').length === 1 && last(P[0], 'wend').i === 1, 'target finished: watcher gets wend i=1');
  m = mark(P[0]); S(P[1], { t: 'watch', i: 2 }); S(P[0], { t: 'watch', i: 2 }); await sleep(300);
  ok(last(P[2], 'wcnt').n === 2, 'two watchers: wcnt n=2 (' + (last(P[2], 'wcnt') || {}).n + ')');
  S(P[1], { t: 'watch', i: 3 }); await sleep(250);
  ok(last(P[2], 'wcnt').n === 1 && last(P[3], 'wcnt').n === 1, 'switching moves the count: seat 2 -> 1, seat 3 -> 1');
  S(P[1], { t: 'watch', i: -1 }); await sleep(250);
  ok(last(P[3], 'wcnt').n === 0, 'watch -1 stops watching: wcnt n=0');
  // bad targets
  m = mark(P[1]); S(P[1], { t: 'watch', i: 1 }); S(P[1], { t: 'watch', i: 0 }); S(P[1], { t: 'watch', i: 6 }); S(P[1], { t: 'watch', i: 'x' }); await sleep(300);
  const we = since(P[1], m, 'wend').map(x => x.i); ok(we.join() === '1,0,6', 'watching self, a finished seat or an empty seat answers wend: ' + we.join());
  // size and frequency limits (watcher P0 watches seat 2)
  m = mark(P[0]); const pad = n => '{"t":"v","g":1,"x":"' + 'a'.repeat(n) + '"}';
  S(P[2], pad(978)); await sleep(150); const sz1 = since(P[0], m, 'v').length;
  ok(sz1 === 1 && P[2].closed === null, 'a frame of exactly 1000 bytes is delivered (' + sz1 + ')');
  // a burst (frames queued behind a network stall): the bucket holds 150, the rest is dropped silently without a kick
  await sleep(8000); m = mark(P[0]); for (let i = 0; i < 200; i++) S(P[2], { t: 'v', g: i }); await sleep(800);
  const fr = since(P[0], m, 'v').length; ok(fr >= 140 && fr <= 165 && P[2].closed === null, 'a 200-frame burst: about 150 get through (' + fr + ') and no flood kick');
  // a finished seat's frames are dropped
  m = mark(P[0]); S(P[1], { t: 'v', g: 1 }); await sleep(200); ok(since(P[0], m, 'v').length === 0, 'a finished seat cannot send v');
  // target leaves -> wend
  m = mark(P[0]); P[2].close(); await sleep(400);
  ok(since(P[0], m, 'wend').some(x => x.i === 2), 'watched seat left: watcher gets wend');
  // finishRound clears watches: P0 watches seat 3 (never sends st), 20 s later P0 'again' closes the round
  S(P[0], { t: 'watch', i: 3 }); await sleep(250); ok(last(P[3], 'wcnt').n === 1, 'P0 watches seat 3');
  await sleep(20500); S(P[0], { t: 'again' }); await sleep(500);
  ok(of(P[0], 'res').length === 1, 'round closed while P0 was still watching');
  await startAll([P[0], P[1], P[3]]); ok(of(P[0], 'start').length === 2, 'next round started');
  S(P[0], FIN); await sleep(200); m = mark(P[0]); S(P[3], { t: 'v', g: 1 }); await sleep(250);
  ok(since(P[0], m, 'v').length === 0, 'the old watch did not survive the round');
  S(P[0], { t: 'watch', i: 3 }); await sleep(250); ok(last(P[3], 'wcnt').n === 1, 'and a new watch works again');
  P.forEach(w => { try { w.close(); } catch (e) {} });
  // v is not exempt from flood protection (own room: nobody needs to be watching)
  {
    const { a: Q } = await room(2); await startAll(Q);
    S(Q[0], pad(979)); await sleep(500);
    ok(Q[0].closed === 1008, 'a single v over 1000 bytes is treated like any oversize message: connection closed (' + Q[0].closed + ')');
    const big = '{"t":"v","x":"' + 'a'.repeat(100000) + '"}';
    const R = (await room(2)).a; await startAll(R);
    for (let i = 0; i < 300; i++) { try { S(R[0], big); } catch (e) {} } await sleep(800);
    ok(R[0].closed === 1008 && R[1].closed === null, '300 x 100 KB v frames: the sender is disconnected, the other seat is not');
    const T = (await room(2)).a; await startAll(T);
    for (let i = 0; i < 300; i++) S(T[0], '{"t":"v","g":1}'); await sleep(800);
    ok(T[0].closed === 1008, '300 v frames in one burst (over 20 per second): disconnected after the drop threshold (' + T[0].closed + ')');
    const U = (await room(2)).a; await startAll(U);
    for (let i = 0; i < 80; i++) { S(U[0], { t: 'v', g: i, b: [[0.5, 0.5]], s: i, c: 1, l: 90 }); await sleep(66); }   // about 15 fps for 5 s
    ok(U[0].closed === null && U[1].closed === null, 'normal 15 fps spectator stream (80 frames, 5 s) is not disconnected');
    [...Q, ...R, ...T, ...U].forEach(w => { try { w.close(); } catch (e) {} });
  }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
