// PingPongLight online duel server: one Durable Object per 4-character room code.
// The server never runs the game: it relays events, gives both phones the same start time and seed,
// and answers clock pings so the two devices can start the music at the same instant.
//
// Hardening (everything a client sends is treated as hostile):
// - only pages from the game's own origin may open rooms or connect (Origin required; localhost only when ALLOW_LOCAL=1);
// - per-client rate limits on /new and /ws (Workers Rate Limiting binding); IPv6 clients are keyed by their /64;
// - a room code can only be joined after /new reserved it, so guessing codes cannot create rooms;
// - per-socket message budget; floods are dropped and repeat offenders disconnected;
// - every relayed message is rebuilt from whitelisted, range-clamped fields (nothing is passed through);
// - phase rules: config/ready only in the lobby, state/attacks only while playing, one result per round;
// - config changes are throttled (they are the only lobby message that writes storage);
// - idle sockets (no ping for 75 s) are closed so dead or parked connections cannot hold a room.
const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';          // no 0/O/1/I/L
// the website, plus the iOS store app (Capacitor serves its bundled files from capacitor://localhost)
const PROD = /^(https:\/\/pingponglight\.vercel\.app|capacitor:\/\/localhost)$/, LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;
const okOrigin = (o, env) => !!o && (PROD.test(o) || (env.ALLOW_LOCAL === '1' && LOCAL.test(o)));
const BASE_H = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const cors = o => ({ ...BASE_H, 'Access-Control-Allow-Origin': o, Vary: 'Origin' });
const code4 = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => ALPH[b % ALPH.length]).join('');
const MAX_MSG = 512;                 // largest legitimate message is ~120 bytes
const BUCKET = 30, REFILL = 8;       // per socket: burst 30, then 8 messages/s (normal peak is ~3/s)
const MAX_DROPS = 60;                // dropped messages before the socket is closed
const IDLE_MS = 75000, SWEEP_MS = 30000;
const RESERVE_MS = 30 * 60000;       // an empty room stays joinable this long after /new or the last join
const ATK_GAP = 2000;                // a real attack needs 10 perfect hits in a row (>= 3 s)
const CFG_GAP = 400;
const STUCK_MS = 20000;              // a round with one result recorded this long ago may be reset by 'again'
const RANKS = ['S', 'A', 'B', 'C', 'D', '—'];
const int = (v, lo, hi) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo; };
const cleanName = v => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
function clientKey(req) {             // IPv6 users own a whole /64, so limit by prefix
  const ip = req.headers.get('CF-Connecting-IP') || 'x';
  if (!ip.includes(':')) return ip;
  const v4 = ip.match(/(\d{1,3}(\.\d{1,3}){3})$/); if (v4) return v4[1];   // IPv4-mapped / NAT64: key by the IPv4 part
  let h = ip.split('::'), head = h[0] ? h[0].split(':') : [];
  if (h.length > 1) { const tail = h[1] ? h[1].split(':') : []; head = head.concat(Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), tail); }
  return head.slice(0, 4).map(x => (parseInt(x, 16) || 0).toString(16)).join(':') + '::/64';
}
async function limited(env, key) {    // true when this key is over its limit
  if (!env.RL) return false;
  try { const { success } = await env.RL.limit({ key }); return !success; } catch (e) { return false; }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin');
    if (req.method !== 'GET') return new Response('method not allowed', { status: 405, headers: BASE_H });
    if (url.pathname === '/' || url.pathname === '/health') return new Response('PingPongLight duel server', { headers: BASE_H });
    if (!okOrigin(origin, env)) return new Response('forbidden', { status: 403, headers: BASE_H });
    const who = clientKey(req);
    if (url.pathname === '/new') {                    // pick a code whose room is empty and reserve it
      if (await limited(env, 'new:' + who)) return Response.json({ error: 'slow down' }, { status: 429, headers: { ...cors(origin), 'Retry-After': '60' } });
      for (let i = 0; i < 4; i++) {
        const c = code4(), r = await env.ROOMS.get(env.ROOMS.idFromName(c)).fetch('https://room/claim');
        if ((await r.json()).ok) return Response.json({ code: c }, { headers: cors(origin) });
      }
      return Response.json({ error: 'busy' }, { status: 503, headers: cors(origin) });
    }
    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{4})$/);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426, headers: BASE_H });
      if (await limited(env, 'ws:' + who)) return new Response('slow down', { status: 429, headers: { ...BASE_H, 'Retry-After': '60' } });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }
    return new Response('not found', { status: 404, headers: BASE_H });
  }
};

export class Room {
  constructor(ctx) { this.ctx = ctx; this.rate = new Map(); }
  socks() { return this.ctx.getWebSockets().filter(w => w.readyState === 1); }
  info(w) { try { return w.deserializeAttachment() || {}; } catch (e) { return {}; } }
  async fetch(req) {
    const url = new URL(req.url), now = Date.now();
    if (url.pathname === '/claim') {                  // called by /new only
      const held = await this.ctx.storage.get('resv');
      if (this.socks().length || (held && now - held < RESERVE_MS)) return Response.json({ ok: false });   // never hand out a live code
      await this.ctx.storage.put('resv', now); await this.ctx.storage.delete('cfg'); await this.ctx.storage.put('phase', 'lobby');
      return Response.json({ ok: true });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const live = this.socks();
    if (live.length >= 2) return new Response('room full', { status: 409 });
    if (!live.length) {                               // empty room: only joinable if /new reserved it recently
      const resv = await this.ctx.storage.get('resv');
      if (!resv || now - resv > RESERVE_MS) return new Response('no such room', { status: 404 });
      await this.ctx.storage.put('phase', 'lobby');
    }
    await this.ctx.storage.put('resv', now);          // rejoining after a refresh keeps working
    const used = live.map(w => this.info(w).i), i = used.includes(0) ? 1 : 0;
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ i, name: '玩家' + (i + 1), ready: false, fin: null, seen: now });
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(now + SWEEP_MS);
    await this.room();
    return new Response(null, { status: 101, webSocket: client });
  }
  send(w, o) { try { w.send(JSON.stringify(o)); } catch (e) {} }
  other(ws) { return this.socks().find(w => w !== ws); }
  kick(ws, why) { this.rate.delete(ws); try { ws.close(1008, why); } catch (e) {} }
  // Token bucket per socket (kept in memory; a hibernation wake simply starts a fresh bucket).
  allow(ws) {
    const now = Date.now(); let b = this.rate.get(ws);
    if (!b) { b = { tok: BUCKET, t: now, drops: 0, atk: 0, cfg: 0 }; this.rate.set(ws, b); }
    b.tok = Math.min(BUCKET, b.tok + (now - b.t) / 1000 * REFILL); b.t = now;
    if (b.tok >= 1) { b.tok -= 1; return b; }
    if (++b.drops > MAX_DROPS) this.kick(ws, 'flood');
    return null;
  }
  async room(only) {
    const s = this.socks(); if (!s.length) return;
    const cfg = (await this.ctx.storage.get('cfg')) || { song: 0, di: 1 }, phase = (await this.ctx.storage.get('phase')) || 'lobby';
    const host = Math.min(...s.map(w => this.info(w).i));
    const players = s.map(w => { const a = this.info(w); return { i: a.i, name: a.name, ready: !!a.ready }; }).sort((a, b) => a.i - b.i);
    for (const w of only ? [only] : s) this.send(w, { t: 'room', you: this.info(w).i, host, players, cfg, phase });
  }
  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_MSG) { this.kick(ws, 'bad message'); return; }
    const b = this.allow(ws); if (!b) return;
    let d; try { d = JSON.parse(msg); } catch (e) { return; }
    if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.t !== 'string') return;
    const a = this.info(ws), now = Date.now();
    if (now - (a.seen || 0) > 15000) { a.seen = now; ws.serializeAttachment(a); }   // throttled liveness stamp
    if (d.t === 'ping') { this.send(ws, { t: 'pong', c: Number.isFinite(+d.c) ? +d.c : 0, s: now }); return; }
    const phase = (await this.ctx.storage.get('phase')) || 'lobby';
    switch (d.t) {
      case 'hello': {
        if (phase !== 'lobby') return;
        const n = cleanName(d.name); if (!n || n === a.name) return;
        a.name = n; ws.serializeAttachment(a); await this.room(); return;
      }
      case 'cfg': {
        const host = Math.min(...this.socks().map(w => this.info(w).i));
        if (a.i !== host || phase !== 'lobby') return;
        if (now - b.cfg < CFG_GAP) { await this.room(ws); return; }   // too fast: just resync the sender
        b.cfg = now;
        const cfg = { song: int(d.song, 0, 199), di: int(d.di, 0, 2) }, old = (await this.ctx.storage.get('cfg')) || { song: 0, di: 1 };
        if (cfg.song === old.song && cfg.di === old.di) { await this.room(ws); return; }
        await this.ctx.storage.put('cfg', cfg);
        for (const w of this.socks()) { const x = this.info(w); x.ready = false; w.serializeAttachment(x); }
        await this.room(); return;
      }
      case 'ready': {
        if (phase !== 'lobby') return;
        const v = !!d.v; if (v === !!a.ready) { await this.room(ws); return; }
        a.ready = v; ws.serializeAttachment(a);
        const s = this.socks();
        if (s.length === 2 && s.every(w => this.info(w).ready)) {
          const cfg = (await this.ctx.storage.get('cfg')) || { song: 0, di: 1 };
          await this.ctx.storage.put('phase', 'play');
          const start = { t: 'start', at: now + 4500, seed: crypto.getRandomValues(new Uint32Array(1))[0], song: cfg.song, di: cfg.di };
          for (const w of s) { const x = this.info(w); x.ready = false; x.fin = null; w.serializeAttachment(x); this.send(w, start); }
        }
        await this.room(); return;
      }
      case 'st': {                                    // live state: rebuilt from clamped fields, then relayed
        if (phase !== 'play' || a.fin) return;
        b.lastSt = now;
        const o = this.other(ws); if (!o) return;
        this.send(o, { t: 'st', from: a.i, s: int(d.s, 0, 1e8), c: int(d.c, 0, 1e5), l: int(d.l, 0, 100), r: int(d.r, 0, 1e5), j: int(d.j, -1, 4) });
        return;
      }
      case 'atk': {
        if (phase !== 'play' || a.fin || !['bump', 'shrink', 'fog'].includes(d.k)) return;
        if (now - b.atk < ATK_GAP) return; b.atk = now;
        const o = this.other(ws); if (o) this.send(o, { t: 'atk', from: a.i, k: d.k });
        return;
      }
      case 'fin': {
        if (phase !== 'play' || a.fin) return;
        a.fin = { s: int(d.s, 0, 1e8), ok: !!d.ok, acc: Math.max(0, Math.min(100, +d.acc || 0)), rank: RANKS.includes(d.rank) ? d.rank : '—', mc: int(d.mc, 0, 1e5) };
        a.finAt = now; ws.serializeAttachment(a);
        const o = this.other(ws); if (o) this.send(o, { t: 'fin', from: a.i, ...a.fin });
        if (this.socks().every(w => this.info(w).fin)) await this.ctx.storage.put('phase', 'lobby');
        return;
      }
      case 'again': {
        // Normally the round is already over. If the other result never arrived, a player who finished
        // a while ago may still return the room to the lobby (so a lost message cannot lock the room).
        if (phase === 'play') {
          if (!a.fin || now - (a.finAt || 0) < STUCK_MS) return;
          const o = this.other(ws), ob = o && this.rate.get(o);
          if (o && !this.info(o).fin && ob && now - (ob.lastSt || 0) < 15000) return;   // opponent is still playing: wait for their result
          await this.ctx.storage.put('phase', 'lobby');
        }
        await this.room(); return;
      }
    }
  }
  async webSocketClose(ws) {
    this.rate.delete(ws);
    try { ws.close(1000, 'bye'); } catch (e) {}
    const o = this.other(ws); if (o) this.send(o, { t: 'left' });
    if (this.socks().length < 2) await this.ctx.storage.put('phase', 'lobby');
    await this.ctx.storage.put('resv', Date.now());   // whoever is left (or both, after a drop) can rejoin for another 30 min
    await this.room();
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }
  async alarm() {                                     // close sockets that stopped pinging
    const now = Date.now(); let gone = 0;
    for (const w of this.socks()) if (now - (this.info(w).seen || 0) > IDLE_MS) { this.kick(w, 'idle'); gone++; }
    const left = this.socks();
    if (gone && left.length) {
      for (const w of left) this.send(w, { t: 'left' });
      await this.ctx.storage.put('phase', 'lobby'); await this.room();
    }
    if (left.length) { await this.ctx.storage.put('resv', now); await this.ctx.storage.setAlarm(now + SWEEP_MS); }
  }
}
