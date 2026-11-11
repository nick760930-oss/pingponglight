// Friends: friend codes, requests, blocks, invites and online presence.
//
// Data lives in D1 (migrations/0002_friends.sql); presence lives in ONE Durable Object ("Hub") that holds every
// player's WebSocket, so "is X online / what are they doing" and "send this to X" are single-object calls.
// Presence is only ever shown to friends, and a block is never revealed (add answers 'nocode' either way).
//
// Players are the ones /lb/name registered; the phone's secret key pk is hashed and looked up like in lb.js.
// Responses never contain pk or ph.
export const friendWipe = (db, id) => [        // every friends row about a player, in both directions (see lb.js wipe)
  db.prepare('DELETE FROM fcodes WHERE pid = ?1').bind(id),
  db.prepare('DELETE FROM fships WHERE a = ?1').bind(id), db.prepare('DELETE FROM fships WHERE b = ?1').bind(id),
  db.prepare('DELETE FROM freqs WHERE frm = ?1').bind(id), db.prepare('DELETE FROM freqs WHERE "to" = ?1').bind(id),
  db.prepare('DELETE FROM fblocks WHERE pid = ?1').bind(id), db.prepare('DELETE FROM fblocks WHERE target = ?1').bind(id),
];

const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';          // no 0/O/1/I/L (same as duel room codes)
const MAX_BODY = 2048, MAX_FRIENDS = 100, MAX_OUT = 50, MAX_BLOCKS = 200, LIST_CAP = 100;
const ST = ['home', 'menu', 'play', 'duel'];
const SONG = /^[a-z0-9]{1,24}$/, ROOM = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
const INV_PAIR_MS = 5000, INV_MIN = 20, INV_TTL = 60000;
const enc = new TextEncoder();
const sha = async s => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))), b => b.toString(16).padStart(2, '0')).join('');
const isPk = v => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
const isId = v => Number.isInteger(v) && v >= 1 && v <= 2 ** 40;
const rndCode = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), b => ALPH[b % ALPH.length]).join('');
// Hub calls never throw: presence is a nicety, so a hub hiccup must not fail a friend action.
const hub = async (env, path, body) => {
  try { const r = await env.HUB.get(env.HUB.idFromName('hub')).fetch('https://hub' + path, { method: 'POST', body: JSON.stringify(body) }); return await r.json(); } catch (e) { return null; }
};

const friendCount = async (db, id) => (await db.prepare('SELECT (SELECT COUNT(*) FROM fships WHERE a = ?1) + (SELECT COUNT(*) FROM fships WHERE b = ?1) AS n').bind(id).first()).n;
const areFriends = async (db, x, y) => !!(await db.prepare('SELECT 1 FROM fships WHERE a = ?1 AND b = ?2').bind(Math.min(x, y), Math.max(x, y)).first());
const becomeFriends = (db, x, y, now) => [
  db.prepare('DELETE FROM freqs WHERE (frm = ?1 AND "to" = ?2) OR (frm = ?2 AND "to" = ?1)').bind(x, y),
  db.prepare('INSERT OR IGNORE INTO fships (a, b, ts) VALUES (?1, ?2, ?3)').bind(Math.min(x, y), Math.max(x, y), now),
];
const unlink = (db, x, y) => [          // friendship and requests, both directions
  db.prepare('DELETE FROM fships WHERE a = ?1 AND b = ?2').bind(Math.min(x, y), Math.max(x, y)),
  db.prepare('DELETE FROM freqs WHERE (frm = ?1 AND "to" = ?2) OR (frm = ?2 AND "to" = ?1)').bind(x, y),
];

export async function handleFr(req, env, path, who, origin, H, limited) {
  const json = (o, s = 200, extra) => Response.json(o, { status: s, headers: { ...H, ...extra } });
  if (!env.LB || !env.HUB) return json({ error: 'off' }, 503);
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (await limited(env, 'fr:' + who)) return json({ error: 'slow' }, 429, { 'Retry-After': '60' });
  const len = +(req.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return json({ error: 'big' }, 413);
  let body; try { const t = await req.text(); if (t.length > MAX_BODY) return json({ error: 'big' }, 413); body = JSON.parse(t); } catch (e) { return json({ error: 'bad' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad' }, 400);
  const db = env.LB, now = Date.now();
  const bad = () => json({ error: 'bad' }, 400);
  if (!isPk(body.pk)) return bad();
  const me = await db.prepare('SELECT id, name FROM players WHERE ph = ?1').bind(await sha(body.pk)).first();
  if (!me) return json({ error: 'noname' }, 400);
  const mine = { id: me.id, name: me.name };

  if (path === '/fr/me') {                            // my id, name and (lazily created, then stable) friend code
    let c = await db.prepare('SELECT code FROM fcodes WHERE pid = ?1').bind(me.id).first();
    for (let i = 0; !c && i < 6; i++) {
      // pid is the primary key (a concurrent first call just loses), code is UNIQUE (a collision throws: draw again)
      try { await db.prepare('INSERT INTO fcodes (pid, code) VALUES (?1, ?2) ON CONFLICT(pid) DO NOTHING').bind(me.id, rndCode()).run(); } catch (e) {}
      c = await db.prepare('SELECT code FROM fcodes WHERE pid = ?1').bind(me.id).first();
    }
    if (!c) return json({ error: 'busy' }, 503);
    return json({ id: me.id, name: me.name, code: c.code });
  }

  if (path === '/fr/add') {
    if (typeof body.code !== 'string' || body.code.length > 64) return bad();
    const code = Array.from(body.code.toUpperCase()).filter(ch => ALPH.includes(ch)).join('');
    const hit = code.length === 8 ? await db.prepare('SELECT f.pid AS id, p.name FROM fcodes f JOIN players p ON p.id = f.pid WHERE f.code = ?1').bind(code).first() : null;
    if (!hit) return json({ error: 'nocode' });
    if (hit.id === me.id) return json({ error: 'self' });
    // a block in either direction looks exactly like an unknown code
    if (await db.prepare('SELECT 1 FROM fblocks WHERE (pid = ?1 AND target = ?2) OR (pid = ?2 AND target = ?1)').bind(me.id, hit.id).first()) return json({ error: 'nocode' });
    if (await areFriends(db, me.id, hit.id)) return json({ error: 'already' });
    if (await db.prepare('SELECT 1 FROM freqs WHERE frm = ?1 AND "to" = ?2').bind(me.id, hit.id).first()) return json({ ok: true, pending: true });   // asked before: nothing new
    const mutual = await db.prepare('SELECT 1 FROM freqs WHERE frm = ?1 AND "to" = ?2').bind(hit.id, me.id).first();
    if (mutual) {                                      // they already asked me: adding them accepts
      if ((await friendCount(db, me.id)) >= MAX_FRIENDS || (await friendCount(db, hit.id)) >= MAX_FRIENDS) return json({ error: 'full' });
      await db.batch(becomeFriends(db, me.id, hit.id, now));
      await hub(env, '/i/push', { to: hit.id, msg: { t: 'friend', id: me.id, name: me.name } });
      return json({ ok: true, friends: true });
    }
    const out = await db.prepare('SELECT COUNT(*) AS n FROM freqs WHERE frm = ?1').bind(me.id).first();
    if ((await friendCount(db, me.id)) >= MAX_FRIENDS || out.n >= MAX_OUT) return json({ error: 'full' });
    await db.prepare('INSERT OR IGNORE INTO freqs (frm, "to", ts) VALUES (?1, ?2, ?3)').bind(me.id, hit.id, now).run();
    await hub(env, '/i/push', { to: hit.id, msg: { t: 'req', from: mine } });
    return json({ ok: true, pending: true });
  }

  if (path === '/fr/respond') {
    if (!isId(body.id) || typeof body.accept !== 'boolean') return bad();
    const q = await db.prepare('SELECT 1 FROM freqs WHERE frm = ?1 AND "to" = ?2').bind(body.id, me.id).first();
    if (!q) return json({ error: 'nopending' }, 400);
    if (!body.accept) { await db.prepare('DELETE FROM freqs WHERE frm = ?1 AND "to" = ?2').bind(body.id, me.id).run(); return json({ ok: true }); }
    if ((await friendCount(db, me.id)) >= MAX_FRIENDS || (await friendCount(db, body.id)) >= MAX_FRIENDS) return json({ error: 'full' });
    await db.batch(becomeFriends(db, me.id, body.id, now));
    await hub(env, '/i/push', { to: body.id, msg: { t: 'friend', id: me.id, name: me.name } });
    return json({ ok: true });
  }

  if (path === '/fr/remove') {
    if (!isId(body.id)) return bad();
    await db.batch(unlink(db, me.id, body.id));
    return json({ ok: true });
  }

  if (path === '/fr/block') {
    if (!isId(body.id)) return bad();
    if (body.id === me.id) return json({ error: 'self' });
    const n = await db.prepare('SELECT COUNT(*) AS n FROM fblocks WHERE pid = ?1').bind(me.id).first();
    if (n.n >= MAX_BLOCKS) return json({ error: 'full' });
    await db.batch([...unlink(db, me.id, body.id), db.prepare('INSERT OR IGNORE INTO fblocks (pid, target, ts) VALUES (?1, ?2, ?3)').bind(me.id, body.id, now)]);
    return json({ ok: true });
  }

  if (path === '/fr/unblock') {
    if (!isId(body.id)) return bad();
    await db.prepare('DELETE FROM fblocks WHERE pid = ?1 AND target = ?2').bind(me.id, body.id).run();
    return json({ ok: true });
  }

  if (path === '/fr/list') {
    const L = `LIMIT ${LIST_CAP}`;
    const [fr, inc, out, blk] = await db.batch([
      db.prepare(`SELECT p.id, p.name, p.seen FROM fships f JOIN players p ON p.id = f.b WHERE f.a = ?1
        UNION ALL SELECT p.id, p.name, p.seen FROM fships f JOIN players p ON p.id = f.a WHERE f.b = ?1 ${L}`).bind(me.id),
      db.prepare(`SELECT p.id, p.name FROM freqs r JOIN players p ON p.id = r.frm WHERE r."to" = ?1 ORDER BY r.ts DESC ${L}`).bind(me.id),
      db.prepare(`SELECT p.id, p.name FROM freqs r JOIN players p ON p.id = r."to" WHERE r.frm = ?1 ORDER BY r.ts DESC ${L}`).bind(me.id),
      db.prepare(`SELECT p.id, p.name FROM fblocks b JOIN players p ON p.id = b.target WHERE b.pid = ?1 ORDER BY b.ts DESC LIMIT ${MAX_BLOCKS}`).bind(me.id),
    ]);
    const pres = fr.results.length ? ((await hub(env, '/i/status', { ids: fr.results.map(x => x.id) })) || {}).on || {} : {};
    const friends = fr.results.map(x => {
      const p = pres[x.id];
      return p ? { id: x.id, name: x.name, on: 1, st: p.st, song: p.song, seen: x.seen || 0 } : { id: x.id, name: x.name, on: 0, st: 'home', song: null, seen: x.seen || 0 };
    }).sort((x, y) => y.on - x.on || x.name.localeCompare(y.name));
    return json({ friends, incoming: inc.results, outgoing: out.results, blocked: blk.results });
  }

  if (path === '/fr/invite') {
    const { id, room, song, d } = body;
    if (!isId(id) || typeof room !== 'string' || !ROOM.test(room) || typeof song !== 'string' || !SONG.test(song) || !Number.isInteger(d) || d < 0 || d > 2) return bad();
    if (!(await areFriends(db, me.id, id))) return json({ error: 'notfriend' });
    const r = await hub(env, '/i/invite', { from: mine, to: id, room, song, d });
    if (!r) return json({ error: 'busy' }, 503);
    if (r.limited) return json({ error: 'slow' }, 429, { 'Retry-After': '5' });
    return json({ ok: true, delivered: !!r.delivered });
  }

  if (path === '/fr/decline') {                       // tell the inviter "no thanks"
    if (!isId(body.id)) return bad();
    if (!(await areFriends(db, me.id, body.id))) return json({ error: 'notfriend' });
    await hub(env, '/i/push', { to: body.id, msg: { t: 'invno', from: mine } });
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

// ---- Presence hub: one Durable Object, hibernating WebSockets, one attachment per socket ----
// Attachment: { pid: 0 until authenticated, st, song, sa (when st last changed), seen (last message, or accept time before auth) }.
const MAX_MSG = 256;                    // legitimate messages are < 100 bytes
const BUCKET = 10, REFILL = 2, MAX_DROPS = 30;
const AUTH_MS = 10000, IDLE_MS = 75000, SWEEP_MS = 30000, MAX_SOCKS = 5;

export class Hub {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.rate = new Map(); this.pairs = new Map(); this.sent = new Map(); }
  socks() { return this.ctx.getWebSockets().filter(w => w.readyState === 1); }
  info(w) { try { return w.deserializeAttachment() || {}; } catch (e) { return {}; } }
  send(w, o) { try { w.send(JSON.stringify(o)); } catch (e) {} }
  of(pid) { return this.socks().filter(w => this.info(w).pid === pid); }
  push(pid, o) { const s = this.of(pid); for (const w of s) this.send(w, o); return s.length; }
  async seen(pid) { try { await this.env.LB.prepare('UPDATE players SET seen = ?1 WHERE id = ?2').bind(Date.now(), pid).run(); } catch (e) {} }
  kick(ws, why) {
    this.rate.delete(ws);
    const a = this.info(ws); if (a.pid) this.ctx.waitUntil(this.seen(a.pid));
    try { ws.close(1008, why); } catch (e) {}
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get('Upgrade') === 'websocket') {       // the Worker only forwards /fr/ws here; /i/* is internal
      const pair = new WebSocketPair(), [client, server] = Object.values(pair), now = Date.now();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ pid: 0, seen: now });
      const al = await this.ctx.storage.getAlarm();
      if (!al || al > now + AUTH_MS) await this.ctx.storage.setAlarm(now + AUTH_MS + 50);   // unauthenticated sockets are dropped after AUTH_MS
      return new Response(null, { status: 101, webSocket: client });
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/i/')) return new Response('not found', { status: 404 });
    let b; try { b = await req.json(); } catch (e) { return Response.json({ error: 'bad' }, { status: 400 }); }
    if (url.pathname === '/i/status') {                     // { ids } -> { on: { id: { st, song } } } for the ones online
      const want = new Set(Array.isArray(b.ids) ? b.ids : []), on = {};
      for (const w of this.socks()) {
        const a = this.info(w); if (!a.pid || !want.has(a.pid)) continue;
        if (!on[a.pid] || (a.sa || 0) > on[a.pid].sa) on[a.pid] = { st: a.st, song: a.song, sa: a.sa || 0 };   // several devices: newest status wins
      }
      for (const k of Object.keys(on)) delete on[k].sa;
      return Response.json({ on });
    }
    if (url.pathname === '/i/push') return Response.json({ n: this.push(b.to, b.msg) });
    if (url.pathname === '/i/invite') {
      const now = Date.now(), pk = b.from.id + ':' + b.to;
      const mins = (this.sent.get(b.from.id) || []).filter(t => now - t < 60000);
      if (now - (this.pairs.get(pk) || 0) < INV_PAIR_MS || mins.length >= INV_MIN) return Response.json({ limited: true });
      mins.push(now); this.sent.set(b.from.id, mins); this.pairs.set(pk, now);
      if (this.pairs.size > 2000) for (const [k, t] of this.pairs) if (now - t > INV_PAIR_MS) this.pairs.delete(k);   // keep the memory bounded
      const n = this.push(b.to, { t: 'inv', from: b.from, room: b.room, song: b.song, d: b.d, exp: now + INV_TTL });
      return Response.json({ delivered: n > 0 });
    }
    return new Response('not found', { status: 404 });
  }

  allow(ws) {                                               // token bucket per socket, like Room.allow
    const now = Date.now(); let b = this.rate.get(ws);
    if (!b) { b = { tok: BUCKET, t: now, drops: 0 }; this.rate.set(ws, b); }
    b.tok = Math.min(BUCKET, b.tok + (now - b.t) / 1000 * REFILL); b.t = now;
    if (b.tok >= 1) { b.tok -= 1; return true; }
    if (++b.drops > MAX_DROPS) this.kick(ws, 'flood');
    return false;
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_MSG) { this.kick(ws, 'bad message'); return; }
    if (!this.allow(ws)) return;
    let d; try { d = JSON.parse(msg); } catch (e) { return; }
    if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.t !== 'string') return;
    const a = this.info(ws), now = Date.now();
    if (!a.pid) {                                           // only {t:'auth'} is accepted before authentication
      if (d.t !== 'auth') return;
      if (!isPk(d.pk)) { this.kick(ws, 'auth'); return; }
      let pl = null; try { pl = await this.env.LB.prepare('SELECT id, name FROM players WHERE ph = ?1').bind(await sha(d.pk)).first(); } catch (e) {}
      if (!pl) { this.kick(ws, 'auth'); return; }
      const mine = this.of(pl.id).filter(w => w !== ws);    // cap devices per player: the least recently active one goes
      if (mine.length >= MAX_SOCKS) { mine.sort((x, y) => (this.info(x).seen || 0) - (this.info(y).seen || 0)); this.kick(mine[0], 'replaced'); }
      ws.serializeAttachment({ pid: pl.id, st: 'home', song: null, sa: now, seen: now });
      this.send(ws, { t: 'hi', id: pl.id, name: pl.name });
      return;
    }
    if (now - (a.seen || 0) > 15000) { a.seen = now; ws.serializeAttachment(a); }   // throttled liveness stamp
    if (d.t === 'ping') { this.send(ws, { t: 'pong' }); return; }
    if (d.t === 'st') {
      const song = d.song == null ? null : d.song;
      if (!ST.includes(d.s) || (song !== null && !(typeof song === 'string' && SONG.test(song)))) return;
      a.st = d.s; a.song = song; a.sa = now; a.seen = now; ws.serializeAttachment(a);
    }
  }
  async webSocketClose(ws) {
    this.rate.delete(ws);
    const a = this.info(ws);
    try { ws.close(1000, 'bye'); } catch (e) {}
    if (a.pid) await this.seen(a.pid);                      // "last seen" for the friends' lists
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }
  async alarm() {                                           // drop unauthenticated and idle sockets
    const now = Date.now(); let next = now + SWEEP_MS;
    for (const w of this.socks()) {
      const a = this.info(w);
      if (!a.pid) { const due = (a.seen || 0) + AUTH_MS; if (now >= due) this.kick(w, 'auth timeout'); else next = Math.min(next, due + 50); }
      else if (now - (a.seen || 0) > IDLE_MS) this.kick(w, 'idle');
    }
    if (this.socks().length) await this.ctx.storage.setAlarm(next);
  }
}
