// Shop, equipment, achievements and in-app purchase tests against a local dev server:  node test/shop.mjs   (npm run test:shop)
// Starts `wrangler dev` itself, twice on the same local database (apply migrations first: npm run db:local):
//   A: SHOP_TEST=1 plus a throw-away Apple-like root (IAP_TEST_ROOT_B64, only honoured with ALLOW_LOCAL=1) -> claim, equip, achievements, purchases
//   B: SHOP_TEST=0, IAP_ON=0 -> test ownership turns void, claim refused, /iap/verify answers 503 {error:'off'}
// LB_SECRET is set here (--var) so the run tickets can be signed without reading any secrets file.
import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHARTS, CONS } from '../src/charts.js';
import { CATALOG } from '../src/catalog.js';
import { ACHS, NA, SERVER_IDS, rewardsOf } from '../src/ach.js';
import { chain, jws, tx } from './pki.mjs';

const SRV = join(dirname(fileURLToPath(import.meta.url)), '..'), WS = createRequire(import.meta.url)(join(SRV, 'node_modules', 'ws'));
const ORIGIN = 'https://pingponglight.vercel.app', SECRET = 'shop-test-secret', PA = 8791, PB = 8792;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0, BASE = '';
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const pk = () => crypto.randomBytes(16).toString('hex');
const ip = () => '198.51.100.' + (1 + (ip.n = (ip.n || 0) + 1) % 250);
async function post(path, body, h = {}) {
  const r = await fetch(BASE + path, { method: 'POST', signal: AbortSignal.timeout(20000), headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip(), ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { s: r.status, j };
}
const b64u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ticket = (song, d, ageMs) => { const p = [song, d, Date.now() - ageMs, crypto.randomBytes(8).toString('hex')].join('.'); return p + '.' + b64u(crypto.createHmac('sha256', SECRET).update(p).digest()); };
const perfect = (song, d) => Array.from({ length: CHARTS[song].n[d] }, () => [0, 300]);      // every beat dead on: accuracy 100 %
const okayLog = (song, d) => Array.from({ length: CHARTS[song].n[d] }, () => [60, 200]);      // every beat 60 ms off (a "good", no perfects)
const submit = (K, song, d, log) => post('/lb/submit', { run: ticket(song, d, 600e3), pk: K, log });
const T = a => Object.keys(CATALOG).find(k => k.startsWith('title.') && CATALOG[k].how === 'ach:' + a);   // the title an achievement gives
const name = () => 'T' + crypto.randomBytes(4).toString('hex');
const made = [];   // every player created here is deleted at the end, so the local database stays as the other tests expect it
async function player() { const k = pk(), r = await post('/lb/name', { pk: k, name: name() }); made.push(k); return { pk: k, id: r.j.id }; }

function start(port, vars) {
  const args = ['wrangler', 'dev', '--port', String(port), '--var', 'LB_SECRET:' + SECRET, ...Object.entries(vars).flatMap(([k, v]) => ['--var', k + ':' + v])];
  const p = spawn('npx', args, { cwd: SRV, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  return { p, log: () => log };
}
const stop = s => { try { execSync('taskkill /pid ' + s.p.pid + ' /T /F', { stdio: 'ignore' }); } catch (e) { try { s.p.kill(); } catch (e2) {} } };
async function up(s, port) {
  for (let i = 0; i < 120; i++) { try { const r = await fetch('http://127.0.0.1:' + port + '/health'); if (r.ok) return true; } catch (e) {} await sleep(500); }
  console.log(s.log().slice(-2000)); return false;
}

// ---------- static checks (no server) ----------
function staticChecks() {
  const ids = Object.keys(CATALOG);
  ok(ids.length > 150, 'catalog has items: ' + ids.length);
  for (const [id, it] of Object.entries(CATALOG)) {
    ok(id.split('.')[0] === it.cat || id === 'full', 'id starts with its category: ' + id);
    ok(it.how === 'default' || it.how === 'buy' || it.how === 'sponsor' || it.how.startsWith('ach:'), 'how is valid: ' + id);
    ok(!!it.pid === (it.how === 'buy' || it.cat === 'sponsor'), 'product id only for things that can be bought: ' + id);
    ok(it.vis === (['avatar', 'plate', 'title'].includes(it.cat) ? 1 : 0), 'vis only for avatar, plate and title: ' + id);
    for (const p of it.parts) ok(!!CATALOG[p], 'theme part exists: ' + id + ' -> ' + p);
  }
  // every achievement-only item is handed out by the achievement it names (themes bring their parts)
  const given = new Map();
  for (const a of SERVER_IDS) for (const it of rewardsOf(a)) for (const x of [it, ...(CATALOG[it] ? CATALOG[it].parts : [])]) given.set(x, [...(given.get(x) || []), a]);
  for (const [id, it] of Object.entries(CATALOG)) {
    for (const r of rewardsOf('墨上聽潮')) ok(!!CATALOG[r], 'reward is a catalog item: ' + r);
    if (it.how.startsWith('ach:')) {
      const a = it.how.slice(4);
      if (a === '超新星') continue;                                  // the design lists this item but no achievement for it
      if (!ACHS[a]) { ok(false, 'achievement exists for ' + id + ': ' + a); continue; }
      if (ACHS[a].chk !== 's' || NA.includes(a)) continue;           // needs verified duels / the phone / data the server lacks: nobody can earn it yet
      ok((given.get(id) || []).length > 0, 'item ' + id + ' is given by an achievement');
    }
  }
  for (const a of SERVER_IDS) for (const r of rewardsOf(a)) ok(!!CATALOG[r], 'reward of ' + a + ' is in the catalog: ' + r);
  ok(CONS.length === 16 && CONS.filter(c => !c[2]).flatMap(c => c[1]).length === 71, 'constellation data: 10 regular (71 songs) and 6 reward');
}

// ---------- server A: SHOP_TEST=1 ----------
async function suiteA(PKI) {
  const A = await player(), B = await player();
  let r = await post('/shop/state', { pk: A.pk });
  ok(r.j.mode === 'test' && Array.isArray(r.j.owned) && !r.j.owned.length && r.j.equip.avatar === '', 'state: test mode, nothing owned');
  { const n = await post('/shop/state', { pk: pk() }); ok(n.j.error === 'noname' && n.j.mode === 'test' && n.j.noname === true && !('owned' in n.j) && !('equip' in n.j) && !('ach' in n.j), 'state: unregistered key refused with {error, mode, noname}, no owned/equip data'); }
  { const n = await post('/shop/equip', { pk: pk(), slot: 'avatar', item: '' }); ok(n.j.error === 'noname' && !('owned' in n.j) && !('equip' in n.j) && !('mode' in n.j), 'other endpoints: an error carries only the error'); }
  { const n = await post('/shop/state', { pk: 'abc' }); ok(n.s === 400 && n.j.mode === 'test' && !('owned' in n.j) && !('equip' in n.j), 'state: bad key refused, mode still given, no data'); }
  ok((await post('/shop/state', { pk: A.pk }, { Origin: 'https://evil.example' })).s === 403, 'foreign origin refused');
  ok((await fetch(BASE + '/shop/state', { headers: { Origin: ORIGIN } })).status === 405, 'GET refused');
  ok((await post('/shop/state', 'x'.repeat(20000))).s === 413, 'oversized body refused');
  // claim
  r = await post('/shop/claim', { pk: A.pk, item: 'avatar.planet' }); ok(r.j.ok && r.j.state.owned.includes('avatar.planet'), 'claim a paid avatar');
  r = await post('/shop/claim', { pk: A.pk, item: 'theme.aurora' });
  ok(r.j.ok && ['theme.aurora', 'bg.aurora', 'orb.bubble', 'trail.braid', 'hit.starburst', 'share.aurora'].every(x => r.j.state.owned.includes(x)), 'claiming a theme gives its parts and the share frame');
  for (const bad of [T('新星'), 'avatar.crown', 'orb.core', 'sponsor.30', 'nope', 'avatar.orb', '', 5]) ok((await post('/shop/claim', { pk: A.pk, item: bad })).s === 400, 'claim refused: ' + bad);
  r = await post('/shop/claim', { pk: A.pk, item: 'full' }); ok(r.j.ok && r.j.state.full === true, 'full version can be taken in the test period');
  // equip
  r = await post('/shop/equip', { pk: A.pk, slot: 'avatar', item: 'avatar.planet' }); ok(r.j.ok && r.j.equip.avatar === 'avatar.planet', 'equip an owned avatar');
  ok((await post('/shop/equip', { pk: A.pk, slot: 'avatar', item: 'avatar.crown' })).s === 403, 'equip refused: not owned');
  ok((await post('/shop/equip', { pk: A.pk, slot: 'plate', item: 'avatar.planet' })).s === 400, 'equip refused: wrong slot');
  ok((await post('/shop/equip', { pk: A.pk, slot: 'plate', item: 'plate.glow' })).s === 403, 'equip refused: plate not owned');
  ok((await post('/shop/equip', { pk: A.pk, slot: 'title', item: T('新星') })).s === 403, 'equip refused: title not earned');
  ok((await post('/shop/equip', { pk: A.pk, slot: 'orb', item: 'orb.star' })).s === 400, 'equip refused: not a shared slot');
  ok((await post('/shop/equip', { pk: A.pk, slot: 'avatar', item: 'x'.repeat(100) })).s === 400, 'equip refused: junk');
  ok((await post('/shop/equip', { pk: B.pk, slot: 'avatar', item: 'avatar.planet' })).s === 403, 'another player cannot wear it');
  r = await post('/shop/equip', { pk: A.pk, slot: 'plate', item: 'plate.basic' }); ok(r.j.ok && r.j.equip.plate === '', 'the default plate can always be equipped');
  // leaderboard shows what is worn
  const S = 'green';
  r = await submit(A.pk, S, 0, perfect(S, 0)); ok(r.j.ok, 'A submits a run');
  r = await post('/lb/board', { song: S, d: 0 }); let row = r.j.top.find(x => x.id === A.id);
  ok(row && row.avatar === 'avatar.planet' && row.plate === '' && row.title === '' && row.cmc >= 1, 'leaderboard row carries avatar, plate, title, cmc');
  // achievements from a first clear
  r = await post('/ach/sync', { pk: A.pk }); ok(r.j.ok && r.j.ach.some(a => a.id === '新星'), '新星 earned by the first clear');
  ok(r.j.owned.includes(T('新星')), 'its title is owned');
  const d2 = await player();
  r = await submit(d2.pk, 'twinkle', 2, perfect('twinkle', 2));
  ok(r.j.ach.includes('越級者') && r.j.ach.includes('分毫不差') && r.j.ach.includes('零誤差') && r.j.ach.includes('第一顆 S') && r.j.ach.includes('一氣呵成'), 'submit returns new achievements: ' + (r.j.ach || []).join(','));
  let st = (await post('/shop/state', { pk: d2.pk })).j;
  ok([T('越級者'), T('分毫不差'), 'hit.tick', 'avatar.reticle', 'hit.starburst', 'trail.spark', T('零誤差')].every(x => st.owned.includes(x)), 'rewards were given');
  r = await post('/shop/equip', { pk: d2.pk, slot: 'avatar', item: 'avatar.reticle' }); ok(r.j.ok, 'an achievement-earned avatar can be worn');
  r = await post('/shop/equip', { pk: d2.pk, slot: 'title', item: T('分毫不差') }); ok(r.j.ok && r.j.equip.title === T('分毫不差'), 'an earned title can be worn');
  r = await post('/shop/equip', { pk: d2.pk, slot: 'title', item: '' }); ok(r.j.ok && r.j.equip.title === '', 'title can be taken off');
  r = await submit(d2.pk, 'twinkle', 2, perfect('twinkle', 2)); ok(r.j.ok && !['新星', '越級者', '零誤差', '第一顆 S', '一氣呵成'].some(x => r.j.ach.includes(x)), 'same run again: earned things are not announced twice (only new totals such as 百次完美): ' + JSON.stringify(r.j.ach));
  // not first clear of the song: no 越級者
  const d3 = await player(); await submit(d3.pk, 'twinkle', 0, perfect('twinkle', 0)); r = await submit(d3.pk, 'twinkle', 4, perfect('twinkle', 4));
  ok(!r.j.ach.includes('越級者') && r.j.ach.includes('分毫不差'), '越級者 only on the first clear of a song');
  // a worse run does not hurt, and counts
  const w = await player(); r = await submit(w.pk, 'twinkle', 1, okayLog('twinkle', 1)); ok(r.j.ok && r.j.rank !== 'S' && !r.j.ach.includes('第一顆 S'), 'an ordinary run earns no S');
  await submit(w.pk, 'twinkle', 1, okayLog('twinkle', 1)); r = await submit(w.pk, 'twinkle', 1, okayLog('twinkle', 1));
  ok(r.j.ach.includes('再來一次'), '再來一次: same song cleared 3 times counts every run, not just improvements');
  // constellation + count achievements
  const c = await player(), c0 = CONS[0][1];
  for (const k of c0) r = await submit(c.pk, k, 0, perfect(k, 0));
  ok(r.j.ach.includes('古老旋律座完成') && !r.j.ach.includes('巴洛克座完成'), 'finishing a constellation: ' + r.j.ach.join(','));
  st = (await post('/shop/state', { pk: c.pk })).j;
  ok(st.owned.includes('avatar.cons0') && st.owned.includes('plate.glow') && st.owned.includes('avatar.comet') === false, 'constellation badge avatar and 暖身 plate given (5 songs cleared)');
  const names = st.ach.map(a => a.id);
  ok(['新星', '起程', '暖身', '第一顆星', '半座', '古老旋律座完成', '初得'].every(x => names.includes(x)), 'achievement list: ' + names.join(','));
  ok(st.pts > 0 && st.na.includes('試聽'), 'points and the list of not-yet-open achievements');
  r = await post('/shop/equip', { pk: c.pk, slot: 'plate', item: 'plate.glow' }); ok(r.j.ok, 'plate earned by achievement can be worn');
  // local achievements: recorded only
  r = await post('/ach/sync', { pk: c.pk, local: ['入門完成', '翻閱', '新星', '摘星者', 'nope', 7] });
  const loc = r.j.ach.filter(a => a.l === 1).map(a => a.id).sort();
  ok(loc.join() === ['入門完成', '翻閱'].sort().join(), 'only local achievements are taken from the phone: ' + loc.join());
  ok(!r.j.ach.some(a => a.id === '摘星者') && !r.j.owned.includes('title.摘星者'), 'a phone cannot claim a server-decided achievement');
  ok((await post('/ach/sync', { pk: c.pk, local: 'x' })).s === 400, 'sync: bad local list refused');
  ok((await post('/ach/sync', { pk: pk() })).j.error === 'noname', 'sync: unregistered key refused');
  // duel-only achievements stay closed
  ok(!names.includes('首勝') && !names.includes('初次交手'), 'duel achievements stay closed');
  // friends list and room seats carry cosmetics
  const f1 = await post('/fr/me', { pk: d2.pk }), f2 = await post('/fr/me', { pk: c.pk });
  ok((await post('/fr/add', { pk: c.pk, code: f1.j.code })).j.ok !== undefined, 'friend request sent');
  ok((await post('/fr/respond', { pk: d2.pk, id: c.id, accept: true })).j.ok, 'friend request accepted');
  r = await post('/fr/list', { pk: c.pk }); const fr = r.j.friends.find(x => x.id === d2.id);
  ok(fr && fr.avatar === 'avatar.reticle' && fr.plate === '' && fr.title === '' && fr.cmc > 0, 'friend list carries avatar, plate, title, cmc');
  ok((await post('/ach/sync', { pk: c.pk })).j.ach.some(a => a.id === '雙星相遇'), '雙星相遇 (first friend) earned on sync');
  const room = await (await fetch(BASE + '/m/new?pub=0&max=4&di=1', { headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip() } })).json();
  const ws = await new Promise(res => { const w = new WS(BASE.replace(/^http/, 'ws') + '/m/ws/' + room.code, { headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip() } }); w.msgs = []; w.on('message', m => w.msgs.push(JSON.parse(m))); w.on('open', () => res(w)); w.on('error', () => res(w)); });
  ws.send(JSON.stringify({ t: 'auth', pk: c.pk })); await sleep(800);
  const seat = (ws.msgs.filter(m => m.t === 'room').pop() || { players: [] }).players[0];
  ok(seat && seat.plate === 'plate.glow' && seat.avatar === '' && seat.title === '' && seat.cmc > 0, 'room seat carries avatar, plate, title, cmc: ' + JSON.stringify(seat));
  // changing what is worn in the room: {t:'cos'} makes the server read it again (at most every 3 s)
  await post('/shop/equip', { pk: c.pk, slot: 'avatar', item: 'avatar.cons0' }); ws.send(JSON.stringify({ t: 'cos' })); await sleep(600);
  let seat2 = (ws.msgs.filter(m => m.t === 'room').pop() || { players: [] }).players[0];
  ok(seat2 && seat2.avatar === 'avatar.cons0' && seat2.plate === 'plate.glow', 'room: {t:cos} updates the seat and broadcasts room: ' + JSON.stringify(seat2));
  await post('/shop/equip', { pk: c.pk, slot: 'avatar', item: '' }); ws.send(JSON.stringify({ t: 'cos' })); await sleep(500);
  seat2 = (ws.msgs.filter(m => m.t === 'room').pop() || { players: [] }).players[0];
  ok(seat2 && seat2.avatar === 'avatar.cons0', 'room: a second {t:cos} within 3 s is ignored');
  await sleep(2600); ws.send(JSON.stringify({ t: 'cos' })); await sleep(600);
  seat2 = (ws.msgs.filter(m => m.t === 'room').pop() || { players: [] }).players[0];
  ok(seat2 && seat2.avatar === '', 'room: after 3 s it is read again');
  ws.close();
  // ---------- purchases ----------
  const P = await player(), good = (o, x) => jws(PKI, tx(o), x);
  const star = good({});
  r = await post('/iap/verify', { pk: P.pk, jws: star }); ok(r.j.ok && r.j.results[0].status === 'granted' && r.j.state.owned.includes('orb.star'), 'purchase verified and granted: ' + JSON.stringify(r.j.results));
  r = await post('/iap/verify', { pk: P.pk, jws: star }); ok(r.j.results[0].status === 'dup', 'same transaction again: dup, nothing doubled');
  // restoring on another account moves a non-consumable transaction (once per 24 h); a consumable never moves
  {
    const M1 = await player(), M2 = await player(), jt = jws(PKI, tx({ productId: 'com.nocticat.pingponglight.avatar.jelly' }));
    await post('/iap/verify', { pk: M1.pk, jws: jt }); await post('/shop/equip', { pk: M1.pk, slot: 'avatar', item: 'avatar.jelly' });
    r = await post('/iap/verify', { pk: M2.pk, jws: jt }); ok(r.j.results[0].status === 'moved' && r.j.state.owned.includes('avatar.jelly'), 'restore on another account: moved');
    st = (await post('/shop/state', { pk: M1.pk })).j; ok(!st.owned.includes('avatar.jelly') && st.equip.avatar === '', 'the previous owner lost it and stops wearing it');
    r = await post('/iap/verify', { pk: M1.pk, jws: jt }); ok(r.j.results[0].status === 'taken' && !r.j.state.owned.includes('avatar.jelly'), 'moving it back within 24 h: taken');
    r = await post('/iap/verify', { pk: M2.pk, jws: jt }); ok(r.j.results[0].status === 'dup', 'the new owner: dup');
    const sp = jws(PKI, tx({ productId: 'com.nocticat.pingponglight.sponsor.30', type: 'Consumable' }));
    await post('/iap/verify', { pk: M1.pk, jws: sp }); r = await post('/iap/verify', { pk: M2.pk, jws: sp });
    ok(r.j.results[0].status === 'taken' && r.j.state.sponsor === 0 && !r.j.state.owned.includes('title.lamplighter'), 'a sponsor pack never moves: taken, no sponsor total');
    ok((await post('/shop/state', { pk: M1.pk })).j.sponsor === 30, 'and stays with its buyer');
  }
  // App Store Sandbox purchases: owned and wearable by the buyer, default for everybody else, no sponsor total or reward
  {
    const X = await player(), sx = o => jws(PKI, tx({ environment: 'Sandbox', ...o }));
    r = await post('/iap/verify', { pk: X.pk, jws: sx({ productId: 'com.nocticat.pingponglight.avatar.jelly' }) });
    ok(r.j.results[0].status === 'granted' && r.j.state.owned.includes('avatar.jelly'), 'sandbox purchase is granted to the buyer');
    r = await post('/shop/equip', { pk: X.pk, slot: 'avatar', item: 'avatar.jelly' }); ok(r.j.ok && r.j.equip.avatar === 'avatar.jelly', 'the buyer can wear a sandbox item (own view)');
    ok((await post('/shop/state', { pk: X.pk })).j.equip.avatar === 'avatar.jelly', 'state keeps showing it to the buyer');
    await submit(X.pk, 'green', 0, perfect('green', 0)); r = await post('/lb/board', { song: 'green', d: 0 }); row = r.j.top.find(x => x.id === X.id);
    ok(row && row.avatar === '', 'the leaderboard shows the default avatar for a sandbox item');
    const wx = await new Promise(res => { const w = new WS(BASE.replace(/^http/, 'ws') + '/m/ws/' + room.code, { headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip() } }); w.msgs = []; w.on('message', m => w.msgs.push(JSON.parse(m))); w.on('open', () => res(w)); w.on('error', () => res(w)); });
    wx.send(JSON.stringify({ t: 'auth', pk: X.pk })); await sleep(800);
    const sx0 = (wx.msgs.filter(m => m.t === 'room').pop() || { players: [] }).players[0]; ok(sx0 && sx0.avatar === '', 'a room seat shows the default avatar for a sandbox item: ' + JSON.stringify(sx0)); wx.close();
    r = await post('/iap/verify', { pk: X.pk, jws: sx({ productId: 'com.nocticat.pingponglight.sponsor.300', type: 'Consumable' }) });
    ok(r.j.results[0].status === 'granted' && r.j.state.sponsor === 0 && !r.j.state.owned.includes('title.lamplighter') && !r.j.state.owned.includes('plate.beacon'), 'a sandbox sponsor pack: no sponsor total, no reward');
    const sj = sx({ productId: 'com.nocticat.pingponglight.orb.moon' }), Y = await player();
    await post('/iap/verify', { pk: X.pk, jws: sj }); r = await post('/iap/verify', { pk: Y.pk, jws: sj }); ok(r.j.results[0].status === 'moved' && r.j.state.owned.includes('orb.moon'), 'a sandbox transaction moves like a real one');
    r = await post('/iap/verify', { pk: X.pk, jws: sx({ productId: 'com.nocticat.pingponglight.orb.heart', revocationDate: Date.now() }) }); ok(r.j.results[0].status === 'revoked', 'a sandbox refund seen first gives nothing');
  }
  const th = good({ productId: 'com.nocticat.pingponglight.theme.sea' });
  r = await post('/iap/verify', { pk: P.pk, jws: [th, good({ productId: 'com.nocticat.pingponglight.full' }), star] });
  ok(r.j.results.map(x => x.status).join() === 'granted,granted,dup' && ['theme.sea', 'bg.sea', 'hit.splash', 'full'].every(x => r.j.state.owned.includes(x)) && r.j.state.full, 'several at once (restore): theme parts and full version');
  const bad = [['wrong bundle', tx({ bundleId: 'com.evil.app' }), 'bundle'], ['unknown product', tx({ productId: 'com.nocticat.pingponglight.avatar.crown' }), 'product'], ['achievement-only item', tx({ productId: 'com.nocticat.pingponglight.theme.gold' }), 'product'],
    ['bad environment', tx({ environment: 'Xcode' }), 'env'], ['wrong type', tx({ type: 'Consumable' }), 'type'], ['bad id', tx({ transactionId: 'abc' }), 'tx']];
  for (const [n, p, why] of bad) { r = await post('/iap/verify', { pk: P.pk, jws: jws(PKI, p) }); ok(r.j.results[0].status === 'bad' && r.j.results[0].err === why, 'refused: ' + n + ' ' + JSON.stringify(r.j.results[0])); }
  const evil = chain(); r = await post('/iap/verify', { pk: P.pk, jws: jws(evil, tx({ productId: 'com.nocticat.pingponglight.theme.city' })) });
  ok(r.j.results[0].status === 'bad' && !r.j.state.owned.includes('theme.city'), 'a receipt from another chain gives nothing');
  const forged = star.split('.'); forged[1] = Buffer.from(JSON.stringify({ ...tx(), productId: 'com.nocticat.pingponglight.theme.city' })).toString('base64url');
  r = await post('/iap/verify', { pk: P.pk, jws: forged.join('.') }); ok(r.j.results[0].status === 'bad' && !r.j.state.owned.includes('theme.city'), 'an edited receipt gives nothing');
  ok((await post('/iap/verify', { pk: P.pk, jws: [] })).s === 400 && (await post('/iap/verify', { pk: P.pk, jws: 5 })).s === 400 && (await post('/iap/verify', { pk: P.pk, jws: Array(17).fill(star) })).s === 400, 'verify: bad request shapes refused');
  ok((await post('/iap/verify', { pk: pk(), jws: star })).j.error === 'noname', 'verify: unregistered key refused');
  // refund
  const rf = tx({ productId: 'com.nocticat.pingponglight.orb.heart' });
  r = await post('/iap/verify', { pk: P.pk, jws: jws(PKI, rf) }); ok(r.j.state.owned.includes('orb.heart'), 'bought');
  r = await post('/iap/verify', { pk: P.pk, jws: jws(PKI, { ...rf, revocationDate: Date.now(), revocationReason: 0 }) });
  ok(r.j.results[0].status === 'revoked' && !r.j.state.owned.includes('orb.heart'), 'refunded: item taken back');
  r = await post('/iap/verify', { pk: P.pk, jws: jws(PKI, rf) }); ok(r.j.results[0].status === 'revoked' && !r.j.state.owned.includes('orb.heart'), 'an old copy of a refunded receipt does not bring it back');
  const rn = tx({ productId: 'com.nocticat.pingponglight.orb.gem', revocationDate: Date.now() }); r = await post('/iap/verify', { pk: P.pk, jws: jws(PKI, rn) });
  ok(r.j.results[0].status === 'revoked' && !r.j.state.owned.includes('orb.gem'), 'a refund seen first gives nothing');
  // a purchase that equals a test claim: ownership survives the test period
  await post('/shop/claim', { pk: P.pk, item: 'avatar.jelly' }); r = await post('/iap/verify', { pk: P.pk, jws: good({ productId: 'com.nocticat.pingponglight.avatar.jelly' }) });
  ok(r.j.results[0].status === 'granted', 'bought an item already taken for free in the test period');
  await post('/shop/equip', { pk: P.pk, slot: 'avatar', item: 'avatar.jelly' });
  // sponsoring
  r = await post('/iap/verify', { pk: P.pk, jws: good({ productId: 'com.nocticat.pingponglight.sponsor.30', type: 'Consumable' }) });
  ok(r.j.results[0].status === 'granted' && r.j.state.owned.includes('title.lamplighter') && !r.j.state.owned.includes('plate.beacon') && r.j.state.sponsor === 30, 'NT$30 sponsor: title 點燈人 only');
  const big = tx({ productId: 'com.nocticat.pingponglight.sponsor.300', type: 'Consumable' });
  r = await post('/iap/verify', { pk: P.pk, jws: jws(PKI, big) }); ok(r.j.state.owned.includes('plate.beacon') && r.j.state.sponsor === 330, 'NT$300 more: plate 燈塔');
  r = await post('/iap/verify', { pk: P.pk, jws: jws(PKI, big) }); ok(r.j.results[0].status === 'dup' && r.j.state.sponsor === 330, 'sponsor transaction counted once');
  await post('/shop/equip', { pk: P.pk, slot: 'plate', item: 'plate.beacon' });
  const S2 = await player(); await post('/iap/verify', { pk: S2.pk, jws: good({ productId: 'com.nocticat.pingponglight.sponsor.90', type: 'Consumable' }) }); await post('/iap/verify', { pk: S2.pk, jws: good({ productId: 'com.nocticat.pingponglight.sponsor.90', type: 'Consumable' }) });
  r = await post('/iap/verify', { pk: S2.pk, jws: good({ productId: 'com.nocticat.pingponglight.sponsor.90', type: 'Consumable' }) });
  ok(r.j.state.sponsor === 270 && !r.j.state.owned.includes('plate.beacon'), 'three NT$90 packs = 270: not yet NT$300');
  r = await post('/iap/verify', { pk: S2.pk, jws: good({ productId: 'com.nocticat.pingponglight.sponsor.30', type: 'Consumable' }) });
  ok(r.j.state.sponsor === 300 && r.j.state.owned.includes('plate.beacon'), 'the total reaches NT$300: plate 燈塔');
  r = await post('/iap/verify', { pk: P.pk, jws: jws(PKI, { ...big, revocationDate: Date.now() }) });
  ok(r.j.results[0].status === 'revoked' && r.j.state.sponsor === 30 && !r.j.state.owned.includes('plate.beacon') && r.j.state.owned.includes('title.lamplighter') && r.j.state.equip.plate === '', 'refund of the big pack: plate gone, worn plate falls back, title stays');
  // deleting data
  const del = await player(); await post('/shop/claim', { pk: del.pk, item: 'avatar.planet' }); const dtx = good({ productId: 'com.nocticat.pingponglight.orb.moon' });
  await post('/iap/verify', { pk: del.pk, jws: dtx }); await submit(del.pk, 'green', 0, perfect('green', 0));
  ok((await post('/lb/delete', { pk: del.pk })).j.ok, 'delete my data');
  ok((await post('/shop/state', { pk: del.pk })).j.error === 'noname', 'player is gone');
  const del2 = await player(); r = await post('/iap/verify', { pk: del2.pk, jws: dtx }); ok(r.j.results[0].status === 'moved' && r.j.state.owned.includes('orb.moon'), "a deleted player's receipt (pid 0) can be claimed by a new account");
  r = await post('/iap/verify', { pk: (await player()).pk, jws: dtx }); ok(r.j.results[0].status === 'taken', 'and then not again within 24 h');
  return { P, c, d2, A };
}

// ---------- server B: SHOP_TEST=0 ----------
async function suiteB(k) {
  let r = await post('/shop/state', { pk: k.A.pk });
  ok(r.j.mode === 'web' && !r.j.owned.includes('avatar.planet') && !r.j.owned.includes('theme.aurora') && !r.j.full, 'web mode: items taken for free are void');
  ok(r.j.equip.avatar === '', 'web mode: a worn free avatar falls back to the default');
  r = await post('/lb/board', { song: 'green', d: 0 }); const row = r.j.top.find(x => x.id === k.A.id);
  ok(row && row.avatar === '', 'web mode: the leaderboard shows the default avatar');
  ok((await post('/shop/claim', { pk: k.A.pk, item: 'orb.star' })).s === 403, 'web mode: claim refused');
  ok((await post('/shop/equip', { pk: k.A.pk, slot: 'avatar', item: 'avatar.planet' })).s === 403, 'web mode: a free avatar cannot be worn');
  // earned and bought things stay
  r = await post('/shop/state', { pk: k.d2.pk }); ok(r.j.equip.avatar === 'avatar.reticle' && r.j.owned.includes('hit.tick'), 'web mode: achievement items stay valid');
  r = await post('/shop/state', { pk: k.P.pk }); ok(r.j.owned.includes('orb.star') && r.j.owned.includes('theme.sea') && r.j.equip.avatar === 'avatar.jelly', 'web mode: purchased items stay valid, including one that was also taken for free');
  r = await post('/fr/list', { pk: k.c.pk }); const fr = r.j.friends.find(x => x.id === k.d2.id); ok(fr && fr.avatar === 'avatar.reticle', 'web mode: friend list still shows achievement avatar');
  r = await post('/iap/verify', { pk: k.P.pk, jws: 'a.b.c' }); ok(r.s === 503 && r.j.error === 'off' && !('owned' in r.j) && !('state' in r.j), 'IAP_ON is not 1: verify answers 503 {error:off} and nothing else');
  r = await post('/shop/claim', { pk: k.A.pk, item: 'orb.star' }); ok(r.s === 403 && r.j.error === 'off' && !('owned' in r.j) && !('state' in r.j) && !('equip' in r.j), 'an error answer carries no owned/equip data');
}

(async () => {
  staticChecks();
  const PKI = chain();
  let A = start(PA, { SHOP_TEST: '1', IAP_ON: '1', ALLOW_LOCAL: '1', IAP_TEST_ROOT_B64: PKI.rootB64 }), keep;
  try {
    if (!(await up(A, PA))) { console.log('FAIL server A did not start'); process.exit(1); }
    BASE = 'http://127.0.0.1:' + PA; keep = await suiteA(PKI);
  } catch (e) { fail++; console.log('FAIL suite A threw', e); } finally { stop(A); }
  await sleep(1500);
  const B = start(PB, { SHOP_TEST: '0', IAP_ON: '0' });
  try {
    if (!(await up(B, PB))) { console.log('FAIL server B did not start'); process.exit(1); }
    BASE = 'http://127.0.0.1:' + PB; if (keep) await suiteB(keep);
    for (const k of made) await post('/lb/delete', { pk: k });
  } catch (e) { fail++; console.log('FAIL suite B threw', e); } finally { stop(B); }
  console.log(fail ? 'FAILED' : 'shop tests passed', pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
