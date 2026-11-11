// Adversarial tests against the local duel server. Usage: node server/test/attack.js [base]
const WS = require(require('path').join(__dirname, '..', 'node_modules', 'ws'));
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const O = 'https://pingponglight.vercel.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log((c ? 'PASS ' : 'FAIL ') + m); };
function conn(code, origin = O) {
  return new Promise(res => {
    const ws = new WS(BASE.replace(/^http/, 'ws') + '/ws/' + code, origin ? { headers: { Origin: origin } } : {});
    ws.msgs = []; ws.closed = null;
    ws.on('message', m => ws.msgs.push(JSON.parse(m)));
    ws.on('close', c => { ws.closed = c; });
    ws.on('open', () => res(ws)); ws.on('error', () => res(ws)); ws.on('unexpected-response', (_, r) => { ws.status = r.statusCode; res(ws); });
  });
}
const S = (ws, o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
const last = (ws, t) => ws.msgs.filter(m => m.t === t).pop();
(async () => {
  // origin checks
  let r = await fetch(BASE + '/new'); ok(r.status === 403, 'no Origin -> /new 403 (' + r.status + ')');
  r = await fetch(BASE + '/new', { headers: { Origin: 'https://evil.example' } }); ok(r.status === 403, 'evil Origin -> 403');
  r = await fetch(BASE + '/new', { headers: { Origin: O } }); const j = await r.json(); ok(/^[A-Z0-9]{4}$/.test(j.code), 'good Origin -> code ' + j.code);
  r = await fetch(BASE + '/new', { method: 'POST', headers: { Origin: O } }); ok(r.status === 405, 'POST -> 405');
  r = await fetch(BASE + '/zzz', { headers: { Origin: O } }); ok(r.status === 404, 'unknown path -> 404');
  const bad = await conn(j.code, null); ok(bad.status === 403, 'ws without Origin rejected (' + bad.status + ')');

  const code = j.code, A = await conn(code), B = await conn(code);
  await sleep(300);
  const C = await conn(code); ok(C.status === 409 || C.readyState !== 1, 'third player rejected');
  // name injection
  S(A, { t: 'hello', name: '<img src=x onerror=alert(1)>"\'`\u0007' }); await sleep(200);
  const nm = last(B, 'room').players.find(p => p.i === 0).name; ok(!/[<>"'`]/.test(nm), 'name sanitized -> ' + JSON.stringify(nm));
  // non-host cfg ignored; host cfg clamped
  S(B, { t: 'cfg', song: 3, di: 2 }); await sleep(150); ok(last(A, 'room').cfg.song === 0, 'non-host cfg ignored');
  S(A, { t: 'cfg', song: 1e9, di: -5 }); await sleep(150); const cf = last(B, 'room').cfg; ok(cf.song === 199 && cf.di === 0, 'cfg clamped ' + JSON.stringify(cf));
  await sleep(450); S(A, { t: 'cfg', song: 2, di: 1 }); await sleep(150);
  // st/atk before play ignored
  B.msgs.length = 0; S(A, { t: 'st', s: 5 }); S(A, { t: 'atk', k: 'fog' }); await sleep(150); ok(!last(B, 'st') && !last(B, 'atk'), 'st/atk ignored in lobby');
  // start
  S(A, { t: 'ready', v: true }); S(B, { t: 'ready', v: true }); await sleep(250); ok(!!last(A, 'start') && last(A, 'start').song === 2, 'game starts');
  // st relay rebuilt and clamped
  B.msgs.length = 0; S(A, { t: 'st', s: 'x', c: -9, l: 999, r: 3, j: 99, evil: '<script>', t2: 1 }); await sleep(150);
  const st = last(B, 'st'); ok(st && st.s === 0 && st.c === 0 && st.l === 100 && st.j === 4 && !('evil' in st), 'st rebuilt ' + JSON.stringify(st));
  // atk whitelist + spacing
  B.msgs.length = 0; S(A, { t: 'atk', k: 'nuke' }); for (let i = 0; i < 10; i++) S(A, { t: 'atk', k: 'fog' }); await sleep(200);
  ok(B.msgs.filter(m => m.t === 'atk').length === 1, 'atk spam -> ' + B.msgs.filter(m => m.t === 'atk').length + ' delivered');
  // 'again' during play ignored (cannot reset opponent mid-round)
  S(B, { t: 'again' }); await sleep(150); S(A, { t: 'st', s: 7 }); await sleep(150); ok(last(B, 'st').s === 7, 'again mid-game ignored');
  // fin clamp and once only
  S(A, { t: 'fin', s: 1e12, ok: 1, acc: 1e9, rank: '<b>', mc: -3 }); S(A, { t: 'fin', s: 5, ok: 0, rank: 'S' }); await sleep(150);
  const fins = B.msgs.filter(m => m.t === 'fin'); ok(fins.length === 1 && fins[0].rank === '—' && fins[0].s === 1e8 && fins[0].acc === 100, 'fin clamped once ' + JSON.stringify(fins[0]));
  // oversized and binary messages close the socket
  const D = await conn(code); // room full -> rejected, use new room for size test
  const r2 = await (await fetch(BASE + '/new', { headers: { Origin: O } })).json();
  const E = await conn(r2.code); S(E, 'x'.repeat(5000)); await sleep(300); ok(E.closed === 1008, 'oversized message -> closed ' + E.closed);
  const F = await conn(r2.code); F.send(Buffer.from([1, 2, 3])); await sleep(300); ok(F.closed === 1008, 'binary message -> closed ' + F.closed);
  // flood
  const r3 = await (await fetch(BASE + '/new', { headers: { Origin: O } })).json();
  const G = await conn(r3.code); for (let i = 0; i < 400; i++) S(G, { t: 'ping', c: i }); await sleep(800);
  const pongs = G.msgs.filter(m => m.t === 'pong').length; ok(pongs <= 60 && G.closed === 1008, 'flood: ' + pongs + ' answered, closed ' + G.closed);
  // garbage JSON does not crash
  const H = await conn(r3.code); for (const g of ['null', '[]', '{"t":5}', '{', '"s"', '{"t":"__proto__"}', '{"t":"ping","c":{"a":1}}']) S(H, g); await sleep(200);
  ok(H.readyState === 1 && last(H, 'pong') && last(H, 'pong').c === 0, 'garbage handled, socket alive');
  // unreserved room code cannot be joined (guessing codes does not create rooms)
  const U = await conn('ZZZZ'); ok(U.status === 404, 'unreserved code -> ' + U.status);
  // cfg spam: storage writes throttled
  const r4 = await (await fetch(BASE + '/new', { headers: { Origin: O } })).json();
  const K = await conn(r4.code), L2 = await conn(r4.code); await sleep(200); L2.msgs.length = 0;
  for (let i = 0; i < 20; i++) { S(K, { t: 'cfg', song: i % 2, di: 1 }); await sleep(50); }
  await sleep(300); const bc = L2.msgs.filter(m => m.t === 'room').length; ok(bc <= 3, 'cfg spam 20 in 1s -> ' + bc + ' broadcasts');
  // stuck round: only one fin, 'again' resets after 20 s
  await sleep(500); S(K, { t: 'ready', v: true }); S(L2, { t: 'ready', v: true }); await sleep(300);
  S(K, { t: 'fin', s: 1, ok: true, rank: 'A', mc: 1 }); await sleep(200);
  S(K, { t: 'again' }); await sleep(200); ok(last(K, 'room').phase === 'play', 'again too early -> still play');
  await sleep(20500); S(K, { t: 'again' }); await sleep(300); ok(last(K, 'room').phase === 'lobby', 'again after 20 s -> lobby');
  for (const w of [A, B, C, D, H, bad, K, L2]) try { w.close(); } catch (e) {}
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
