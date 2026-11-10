// PingPongLight online duel server: one Durable Object per 4-character room code.
// The server never runs the game: it relays events, gives both phones the same start time and seed,
// and answers clock pings so the two devices can start the music at the same instant.
const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';          // no 0/O/1/I/L
const ORIGINS = [/^https:\/\/pingponglight\.vercel\.app$/, /^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];
const okOrigin = o => !o || ORIGINS.some(r => r.test(o));
const cors = o => ({ 'Access-Control-Allow-Origin': okOrigin(o) && o ? o : 'https://pingponglight.vercel.app', 'Cache-Control': 'no-store' });
const code4 = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => ALPH[b % ALPH.length]).join('');

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get('Origin');
    if (!okOrigin(origin)) return new Response('forbidden', { status: 403 });
    if (url.pathname === '/new') {                    // pick a code whose room is empty
      for (let i = 0; i < 6; i++) {
        const c = code4(), r = await env.ROOMS.get(env.ROOMS.idFromName(c)).fetch('https://room/info');
        if ((await r.json()).n === 0) return Response.json({ code: c }, { headers: cors(origin) });
      }
      return Response.json({ error: 'busy' }, { status: 503, headers: cors(origin) });
    }
    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{4})$/);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }
    return new Response('PingPongLight duel server', { headers: cors(origin) });
  }
};

export class Room {
  constructor(ctx) { this.ctx = ctx; }
  socks() { return this.ctx.getWebSockets().filter(w => w.readyState === 1); }
  info(w) { return w.deserializeAttachment() || {}; }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/info') return Response.json({ n: this.socks().length });
    const live = this.socks();
    if (live.length >= 2) return new Response('room full', { status: 409 });
    const used = live.map(w => this.info(w).i), i = used.includes(0) ? 1 : 0;
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ i, name: '玩家' + (i + 1), ready: false, fin: null });
    if (live.length === 0) await this.ctx.storage.put('phase', 'lobby');
    await this.room();
    return new Response(null, { status: 101, webSocket: client });
  }
  send(w, o) { try { w.send(JSON.stringify(o)); } catch (e) {} }
  other(ws) { return this.socks().find(w => w !== ws); }
  async room() {
    const s = this.socks(), cfg = (await this.ctx.storage.get('cfg')) || { song: 0, di: 1 }, phase = (await this.ctx.storage.get('phase')) || 'lobby';
    const host = Math.min(...s.map(w => this.info(w).i));
    const players = s.map(w => { const a = this.info(w); return { i: a.i, name: a.name, ready: a.ready }; }).sort((a, b) => a.i - b.i);
    for (const w of s) this.send(w, { t: 'room', you: this.info(w).i, host, players, cfg, phase });
  }
  async webSocketMessage(ws, msg) {
    let d; try { d = JSON.parse(msg); } catch (e) { return; }
    if (!d || typeof d.t !== 'string' || msg.length > 2000) return;
    const a = this.info(ws), phase = (await this.ctx.storage.get('phase')) || 'lobby';
    switch (d.t) {
      case 'ping': this.send(ws, { t: 'pong', c: d.c, s: Date.now() }); return;
      case 'hello': a.name = String(d.name || '').replace(/[<>]/g, '').slice(0, 12) || a.name; ws.serializeAttachment(a); await this.room(); return;
      case 'cfg': {
        const host = Math.min(...this.socks().map(w => this.info(w).i));
        if (a.i !== host || phase !== 'lobby') return;
        await this.ctx.storage.put('cfg', { song: d.song | 0, di: Math.max(0, Math.min(2, d.di | 0)) });
        for (const w of this.socks()) { const b = this.info(w); b.ready = false; w.serializeAttachment(b); }
        await this.room(); return;
      }
      case 'ready': {
        if (phase !== 'lobby') return;
        a.ready = !!d.v; ws.serializeAttachment(a);
        const s = this.socks();
        if (s.length === 2 && s.every(w => this.info(w).ready)) {
          const cfg = (await this.ctx.storage.get('cfg')) || { song: 0, di: 1 };
          await this.ctx.storage.put('phase', 'play');
          const start = { t: 'start', at: Date.now() + 4500, seed: crypto.getRandomValues(new Uint32Array(1))[0], song: cfg.song, di: cfg.di };
          for (const w of s) { const b = this.info(w); b.ready = false; b.fin = null; w.serializeAttachment(b); this.send(w, start); }
        }
        await this.room(); return;
      }
      case 'st': case 'atk': {                        // live state / attack: relay to the opponent
        if (phase !== 'play') return;
        const o = this.other(ws); if (o) this.send(o, Object.assign({}, d, { from: a.i })); return;
      }
      case 'fin': {
        a.fin = { s: d.s | 0, ok: !!d.ok, acc: +d.acc || 0, rank: String(d.rank || '').slice(0, 2), mc: d.mc | 0 }; ws.serializeAttachment(a);
        const o = this.other(ws); if (o) this.send(o, { t: 'fin', from: a.i, ...a.fin });
        if (this.socks().every(w => this.info(w).fin)) await this.ctx.storage.put('phase', 'lobby');
        return;
      }
      case 'again': await this.ctx.storage.put('phase', 'lobby'); await this.room(); return;
    }
  }
  async webSocketClose(ws) {
    try { ws.close(1000, 'bye'); } catch (e) {}
    const o = this.other(ws); if (o) this.send(o, { t: 'left' });
    if (this.socks().length < 2) await this.ctx.storage.put('phase', 'lobby');
    await this.room();
  }
  async webSocketError(ws) { await this.webSocketClose(ws); }
}
