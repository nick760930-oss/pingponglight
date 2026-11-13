// PingPongLight multiplayer (protocol v2, 2..8 players): Arena = one room, Lobby = room list + quick match.
// See docs/multiplayer-protocol.md. Same hardening style as the two-player Room in index.js:
// per-socket token bucket, 512-byte messages, idle sweep, reserved codes, everything rebuilt from clamped fields.
import { CHARTS } from './charts.js';
import { cleanName, nameProblem } from './names.js';
import { friendRequest, relations, pidOf, blockedBy } from './friends.js';

const SONGS = Object.keys(CHARTS);
const MAX_MSG = 512;
const BUCKET = 30, REFILL = 8, MAX_DROPS = 60;
const IDLE_MS = 75000, SWEEP_MS = 30000;
const RESERVE_MS = 30 * 60000;
const ATK_GAP = 2000, CFG_GAP = 400, BOARD_GAP = 250, STUCK_MS = 20000;
const START_DELAY = 4500, FULL_WAIT = 3000, QM_WAIT = 15000;
const MAX_ROUND_MS = 15 * 60000;          // a round nobody finished in 15 min is closed by the sweep
const MAX_SCORE_STEP = 30000;
const LOBBY_TTL = 120000, LIST_MAX = 30, LOBBY_CAP = 500;
const PH_TTL = 15000, PEND_TTL = 10000, PH_CAP = 1000, UPSERT_GAP = 1000;   // placeholder life, pending-join life, placeholder cap, rename upsert throttle
const RANKS = ['S', 'A', 'B', 'C', 'D', '—'];
const SAY_N = 64, SAY_GAP = 2200, REL_GAP = 800, FADD_GAP = 600;   // room phrases: highest index accepted (the client's append-only list holds the text); per-socket gaps
const int = (v, lo, hi) => { v = Math.floor(Number(v)); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo; };
const rndSong = () => SONGS[crypto.getRandomValues(new Uint32Array(1))[0] % SONGS.length];
const isSong = v => typeof v === 'string' && Object.prototype.hasOwnProperty.call(CHARTS, v);
const lobby = env => env.LOBBY.get(env.LOBBY.idFromName('lobby'));
const post = (stub, path, o) => stub.fetch('https://x' + path, { method: 'POST', body: JSON.stringify(o) });

export class Arena {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.rate = new Map(); this.lastBoard = 0; this.lastUp = 0; this.upTimer = null; }
  // quick-match wait; only shortenable on a local dev server (ALLOW_LOCAL=1), production is always 15 s
  wait() { const v = +this.env.QM_WAIT_MS; return this.env.ALLOW_LOCAL === '1' && Number.isFinite(v) && v >= 300 && v <= QM_WAIT ? v : QM_WAIT; }
  info(w) { try { return w.deserializeAttachment() || {}; } catch (e) { return {}; } }
  socks() { return this.ctx.getWebSockets().filter(w => w.readyState === 1 && !this.info(w).gone); }
  get(k, d) { return this.ctx.storage.get(k).then(v => v === undefined ? d : v); }
  send(w, o) { try { w.send(JSON.stringify(o)); } catch (e) {} }
  all(o) { for (const w of this.socks()) this.send(w, o); }
  hostOf(s) { return s.length ? Math.min(...s.map(w => this.info(w).i)) : -1; }

  async fetch(req) {
    const url = new URL(req.url), now = Date.now();
    if (url.pathname === '/claim') {                  // called by /m/new and /m/match only
      const held = await this.get('resv');
      if (this.socks().length || (held && now - held < RESERVE_MS)) return Response.json({ ok: false });
      let o = {}; try { o = await req.json(); } catch (e) {}
      const qm = !!o.qm, cfg = { song: rndSong(), di: int(o.di, 0, 4), pub: qm || !!o.pub, max: int(o.max, 2, 8), vote: false, qm };
      await this.ctx.storage.put({ resv: now, cfg, phase: 'lobby', auto: null, gone: [] });
      return Response.json({ ok: true });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const live = this.socks();
    if (!live.length) {                               // empty room: only joinable if reserved recently
      const resv = await this.get('resv');
      if (!resv || now - resv > RESERVE_MS) return new Response('no such room', { status: 404 });
      await this.ctx.storage.put({ phase: 'lobby', auto: null, gone: [] });
    }
    const cfg = await this.get('cfg'); if (!cfg) return new Response('no such room', { status: 404 });
    const mc = url.pathname.match(/\/m\/ws\/([A-Z0-9]{4})$/); if (mc && mc[1] !== await this.get('code')) await this.ctx.storage.put('code', mc[1]);   // /claim does not carry the code; remember it from the first upgrade
    if ((await this.get('phase', 'lobby')) === 'play' && live.length) return new Response('round in progress', { status: 423 });
    if (live.length >= Math.min(8, cfg.max)) return new Response('room full', { status: 409 });
    await this.ctx.storage.put('resv', now);
    const used = live.map(w => this.info(w).i); let i = 0; while (used.includes(i)) i++;
    const pair = new WebSocketPair(), [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ i, name: '玩家' + (i + 1), ready: false, back: true, vote: null, fin: null, st: null, seen: now });
    await this.afterChange(now);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- state broadcast helpers ----
  // this socket's relation to every other signed-in seat: { seat: 'f' | 'o' | 'i' | 'b' | 'n' }; guests are left out (no menu)
  async rels(ws) {
    const a = this.info(ws), r = {};
    if (a.pid && this.env.LB) {
      const others = this.socks().map(w => this.info(w)).filter(x => x.pid && x.i !== a.i && x.pid !== a.pid);
      let m = {}; try { m = await relations(this.env.LB, a.pid, [...new Set(others.map(x => x.pid))]); } catch (e) { return; }
      for (const x of others) r[x.i] = m[x.pid] || 'n';
    }
    this.send(ws, { t: 'rel', r });
  }
  async room(only) {
    const s = this.socks(); if (!s.length) return;
    const cfg = await this.get('cfg'), phase = await this.get('phase', 'lobby'), auto = await this.get('auto', null);
    const host = this.hostOf(s), votes = {};
    const players = s.map(w => { const a = this.info(w); if (cfg.vote && a.vote) votes[a.vote] = (votes[a.vote] || 0) + 1; return { i: a.i, name: a.name, ready: !!a.ready, back: !!a.back, vote: cfg.vote ? a.vote || null : null }; }).sort((a, b) => a.i - b.i);
    for (const w of only ? [only] : s) this.send(w, { t: 'room', code: await this.code(), you: this.info(w).i, host, players, cfg, votes, phase, auto: auto ? { at: auto.at } : null });
  }
  async summary() {
    const s = this.socks(), cfg = await this.get('cfg'); if (!cfg) return null;
    const h = s.find(w => this.info(w).i === this.hostOf(s));
    return { host: h ? this.info(h).name : '', song: cfg.song, di: cfg.di, n: s.length, max: cfg.max, phase: await this.get('phase', 'lobby'), qm: cfg.qm, pub: cfg.pub };
  }
  async code() { return this.ctx.id.name || await this.get('code', ''); }
  async upsert() {
    this.lastUp = Date.now();
    try {
      const code = await this.code(), sm = await this.summary();
      if (this.socks().length && sm) await post(lobby(this.env), '/upsert', { code, ...sm });
      else await post(lobby(this.env), '/remove', { code });
    } catch (e) {}
  }
  async upsertSoon(now) {                             // at most one upsert per second; the last change is always sent
    const wait = UPSERT_GAP - (now - this.lastUp);
    if (wait <= 0) { await this.upsert(); return; }
    if (this.upTimer) return;
    this.upTimer = setTimeout(() => { this.upTimer = null; this.upsert(); }, wait);
  }
  board(force) {
    const now = Date.now(); if (!force && now - this.lastBoard < BOARD_GAP) return; this.lastBoard = now;
    const rows = this.socks().map(w => this.info(w)).sort((a, b) => a.i - b.i).map(a => a.fin ? [a.i, a.fin.s, a.st ? a.st[1] : 0, a.st ? a.st[2] : 0, a.st ? a.st[4] : 0, 1, a.fin.ok ? 1 : 0] : a.st ? [a.i, a.st[0], a.st[1], a.st[2], a.st[4], 0, 1] : [a.i, 0, 0, 0, 0, 0, 1]);
    this.all({ t: 'board', p: rows });
  }
  // after a join/leave/config change: quick-match timers, alarm, lobby summary, room broadcast
  async afterChange(now) {
    await this.autoUpdate(now); await this.sched(now); await this.room(); await this.upsert();
  }
  async autoUpdate(now) {
    const cfg = await this.get('cfg'), phase = await this.get('phase', 'lobby'), s = this.socks(), n = s.filter(w => this.info(w).back).length, all = n === s.length;   // quick match counts only players back in the room
    if (!cfg || !cfg.qm || phase !== 'lobby' || n < 2) { await this.ctx.storage.put('auto', null); return; }
    const auto = (await this.get('auto', null)) || { t2: now };
    if (n >= cfg.max && all) { if (!auto.full) auto.full = now; } else delete auto.full;
    auto.at = auto.t2 + this.wait(); if (auto.full) auto.at = Math.min(auto.at, auto.full + FULL_WAIT);
    await this.ctx.storage.put('auto', auto);
  }
  async sched(now) {
    if (!this.socks().length) return;
    const auto = await this.get('auto', null); let at = now + SWEEP_MS;
    if (auto && auto.at < at) at = Math.max(auto.at, now + 50);
    await this.ctx.storage.setAlarm(at);
  }

  // ---- round control ----
  async startRound(now) {
    const cfg = await this.get('cfg'), s = this.socks(); let song = cfg.song;
    if (!cfg.qm && cfg.vote) {                        // most votes wins; ties are random; no votes -> host's song
      const tally = {}; for (const w of s) { const v = this.info(w).vote; if (isSong(v)) tally[v] = (tally[v] || 0) + 1; }
      const top = Math.max(0, ...Object.values(tally)), best = Object.keys(tally).filter(k => tally[k] === top);
      if (best.length) song = best[crypto.getRandomValues(new Uint32Array(1))[0] % best.length];
    }
    const seed = crypto.getRandomValues(new Uint32Array(1))[0], at = now + START_DELAY;
    await this.ctx.storage.put({ phase: 'play', auto: null, gone: [], round: { at, song } });
    if (cfg.qm) await this.ctx.storage.put('cfg', { ...cfg, song: rndSong() });   // next round's song
    for (const w of s) { const a = this.info(w); a.ready = false; a.fin = null; a.st = null; a.vote = null; a.finAt = 0; w.serializeAttachment(a); }
    this.lastBoard = 0;
    this.all({ t: 'start', at, seed, song, di: cfg.di, n: s.length });
    await this.room(); await this.upsert(); await this.sched(now);
  }
  async finishRound(now) {
    const recs = this.socks().map(w => { const a = this.info(w); return { i: a.i, name: a.name, fin: a.fin, s: a.fin ? a.fin.s : (a.st ? a.st[0] : 0), off: false }; });
    for (const g of await this.get('gone', [])) recs.push({ ...g, off: true });
    const row = x => x.fin ? { i: x.i, name: x.name, s: x.fin.s, ok: x.fin.ok, acc: x.fin.acc, rank: x.fin.rank, mc: x.fin.mc } : { i: x.i, name: x.name, s: x.s, ok: false, acc: 0, rank: '—', mc: 0 };
    const grp = x => x.fin ? (x.fin.ok ? 0 : 1) : (x.off ? 3 : 2);   // finished, failed, still-online unfinished, offline unfinished
    recs.sort((a, b) => grp(a) - grp(b) || b.s - a.s || a.i - b.i);
    const cfg = await this.get('cfg');
    await this.ctx.storage.put({ phase: 'lobby', gone: [], round: null });
    for (const w of this.socks()) { const a = this.info(w); a.ready = false; a.fin = null; a.st = null; a.finAt = 0; if (cfg.qm) a.back = false; w.serializeAttachment(a); }
    this.all({ t: 'res', r: recs.map(row) });
    await this.afterChange(now);
  }
  allFin() { const s = this.socks(); return s.length > 0 && s.every(w => this.info(w).fin); }

  // ---- socket lifecycle ----
  async allow(ws) {
    const now = Date.now(); let b = this.rate.get(ws);
    if (!b) { b = { tok: BUCKET, t: now, drops: 0, atk: 0, cfg: 0 }; this.rate.set(ws, b); }
    b.tok = Math.min(BUCKET, b.tok + (now - b.t) / 1000 * REFILL); b.t = now;
    if (b.tok >= 1) { b.tok -= 1; return b; }
    if (++b.drops > MAX_DROPS) await this.drop(ws, 'flood');
    return null;
  }
  async drop(ws, why) {                               // the single place a player leaves (kick, close, error, idle)
    const a = this.info(ws); if (a.gone) return;
    a.gone = true; try { ws.serializeAttachment(a); } catch (e) {}
    this.rate.delete(ws); try { ws.close(why ? 1008 : 1000, why || 'bye'); } catch (e) {}
    const now = Date.now(), phase = await this.get('phase', 'lobby');
    if (phase === 'play') {
      const gone = await this.get('gone', []); gone.push({ i: a.i, name: a.name, fin: a.fin || null, s: a.fin ? a.fin.s : (a.st ? a.st[0] : 0) });
      await this.ctx.storage.put('gone', gone);
    }
    this.all({ t: 'left', i: a.i });
    if (!this.socks().length) {
      await this.ctx.storage.put({ phase: 'lobby', auto: null, gone: [], round: null, resv: now });
      await this.upsert(); return;
    }
    await this.ctx.storage.put('resv', now);
    if (phase === 'play' && this.allFin()) { await this.finishRound(now); return; }
    if (phase === 'lobby') {                          // the one who was not ready left: the rest may all be ready now
      const cfg = await this.get('cfg'), s = this.socks();
      if (cfg && !cfg.qm && s.length >= 2 && s.every(w => this.info(w).ready)) { await this.startRound(now); return; }
    }
    await this.afterChange(now);
  }
  async webSocketClose(ws) { await this.drop(ws, ''); }
  async webSocketError(ws) { await this.drop(ws, ''); }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_MSG) { await this.drop(ws, 'bad message'); return; }
    const b = await this.allow(ws); if (!b) return;
    let d; try { d = JSON.parse(msg); } catch (e) { return; }
    if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.t !== 'string') return;
    const a = this.info(ws), now = Date.now(); if (a.gone) return;
    if (now - (a.seen || 0) > 15000) { a.seen = now; ws.serializeAttachment(a); }
    if (d.t === 'ping') { this.send(ws, { t: 'pong', c: Number.isFinite(+d.c) ? +d.c : 0, s: now }); return; }
    const phase = await this.get('phase', 'lobby'), cfg = await this.get('cfg');
    switch (d.t) {
      case 'hello': {
        if (phase !== 'lobby') return;
        const n = cleanName(d.name); if (!n || n === a.name || nameProblem(n)) return;
        a.name = n; ws.serializeAttachment(a); await this.room();
        if (a.i === this.hostOf(this.socks())) await this.upsertSoon(now);   // only the host's name is in the lobby summary
        return;
      }
      // ---- friends from a room: the account id stays on the server (never in any message to other players) ----
      case 'auth': {                                  // { pk }: which account this seat is, once per socket
        if (a.pid || (a.authN || 0) >= 3 || !this.env.LB) return;
        a.authN = (a.authN || 0) + 1; ws.serializeAttachment(a);
        let pl = null; try { pl = await pidOf(this.env.LB, d.pk); } catch (e) {}
        if (!pl) return;
        const b2 = this.info(ws); b2.pid = pl.id; b2.acct = pl.name; ws.serializeAttachment(b2);
        for (const w of this.socks()) if (w === ws || this.info(w).pid) await this.rels(w);   // everyone signed in gets this seat's relation
        return;
      }
      case 'rel': { if (now - (b.rel || 0) < REL_GAP) return; b.rel = now; await this.rels(ws); return; }
      case 'fadd': {                                  // { i }: ask the player in seat i to be friends
        if (!a.pid || !this.env.LB || now - (b.fadd || 0) < FADD_GAP) return; b.fadd = now;
        if (!Number.isInteger(d.i) || d.i < 0 || d.i > 7) return;
        const t = this.socks().map(w => this.info(w)).find(x => x.i === d.i && x.pid && x.pid !== a.pid);
        if (!t) return;
        let r = { error: 'busy' };
        try {
          const db = this.env.LB;
          if (await db.prepare('SELECT 1 FROM fblocks WHERE (pid = ?1 AND target = ?2) OR (pid = ?2 AND target = ?1)').bind(a.pid, t.pid).first()) r = { error: 'blocked' };
          else r = await friendRequest(db, this.env, { id: a.pid, name: a.acct || a.name }, t.pid, now);
        } catch (e) {}
        this.send(ws, { t: 'fadd', i: t.i, r: r.friends ? 'f' : r.pending ? 'o' : r.error === 'already' ? 'f' : 'x' });
        return;
      }
      case 'say': {                                   // { k }: a preset phrase (never free text), shown over the seat
        if (phase !== 'lobby' || now - (b.say || 0) < SAY_GAP) return;
        const k = Number.isInteger(d.k) && d.k >= 0 && d.k < SAY_N ? d.k : -1; if (k < 0) return;
        b.say = now;
        const s = this.socks();
        let hide = new Set();
        if (a.pid && this.env.LB) { const others = s.map(w => this.info(w).pid).filter(x => x && x !== a.pid); try { hide = await blockedBy(this.env.LB, a.pid, others); } catch (e) {} }
        for (const w of s) { const x = this.info(w); if (!x.pid || !hide.has(x.pid)) this.send(w, { t: 'say', i: a.i, k }); }
        return;
      }
      case 'cfg': {
        if (phase !== 'lobby' || cfg.qm || a.i !== this.hostOf(this.socks())) return;
        if (now - b.cfg < CFG_GAP) { await this.room(ws); return; }
        b.cfg = now;
        const n = { ...cfg };
        if (d.song !== undefined) { if (!isSong(d.song)) { await this.room(ws); return; } n.song = d.song; }
        if (d.di !== undefined) n.di = int(d.di, 0, 4);
        if (d.pub !== undefined) n.pub = !!d.pub;
        if (d.vote !== undefined) n.vote = !!d.vote;
        if (d.max !== undefined) { n.max = int(d.max, 2, 8); if (n.max < this.socks().length) { await this.room(ws); return; } }
        if (JSON.stringify(n) === JSON.stringify(cfg)) { await this.room(ws); return; }
        await this.ctx.storage.put('cfg', n);
        for (const w of this.socks()) {
          const x = this.info(w);
          if (n.song !== cfg.song || n.di !== cfg.di) x.ready = false;
          if (!n.vote) x.vote = null;
          w.serializeAttachment(x);
        }
        await this.room(); await this.upsert(); return;
      }
      case 'vote': {
        if (phase !== 'lobby' || !cfg.vote || !isSong(d.song) || a.vote === d.song) return;
        a.vote = d.song; ws.serializeAttachment(a); await this.room(); return;
      }
      case 'ready': {
        if (phase !== 'lobby' || cfg.qm) return;
        const v = !!d.v; if (v === !!a.ready) { await this.room(ws); return; }
        a.ready = v; ws.serializeAttachment(a);
        const s = this.socks();
        if (s.length >= 2 && s.every(w => this.info(w).ready)) { await this.startRound(now); return; }
        await this.room(); return;
      }
      case 'st': {
        if (phase !== 'play' || a.fin) return;
        const s = int(d.s, 0, 1e8), prev = a.st ? a.st[0] : 0;
        if (s < prev) return;
        a.st = [Math.min(s, prev + MAX_SCORE_STEP), int(d.c, 0, 1e5), int(d.l, 0, 100), int(d.r, 0, 1e5), int(d.j, -1, 4)]; b.lastSt = now;
        ws.serializeAttachment(a); this.board(false); return;
      }
      case 'atk': {
        if (phase !== 'play' || a.fin || !['bump', 'shrink', 'fog'].includes(d.k)) return;
        if (now - b.atk < ATK_GAP) return;
        const alive = this.socks().map(w => ({ w, a: this.info(w) })).filter(x => !x.a.fin)
          .sort((x, y) => (y.a.st ? y.a.st[0] : 0) - (x.a.st ? x.a.st[0] : 0) || x.a.i - y.a.i);
        const k = alive.findIndex(x => x.a.i === a.i), t = alive[k === 0 ? 1 : k - 1];
        if (k < 0 || !t) return;
        b.atk = now; this.send(t.w, { t: 'atk', from: a.i, k: d.k }); return;
      }
      case 'fin': {
        if (phase !== 'play' || a.fin) return;
        a.fin = { s: int(d.s, 0, 1e8), ok: !!d.ok, acc: Math.max(0, Math.min(100, +d.acc || 0)), rank: RANKS.includes(d.rank) ? d.rank : '—', mc: int(d.mc, 0, 1e5) };
        a.finAt = now; ws.serializeAttachment(a); this.board(true);
        if (this.allFin()) await this.finishRound(now);
        return;
      }
      case 'again': {
        if (phase === 'play') {
          if (!a.fin || now - (a.finAt || 0) < STUCK_MS) return;
          for (const w of this.socks()) { const x = this.info(w), xb = this.rate.get(w); if (!x.fin && xb && now - (xb.lastSt || 0) < 15000) return; }   // someone is still playing
          await this.finishRound(now); return;
        }
        if (cfg.qm && !a.back) { a.back = true; ws.serializeAttachment(a); await this.afterChange(now); return; }   // quick match: back in the room, counts toward the next countdown
        await this.room(ws); return;
      }
    }
  }

  async alarm() {
    const now = Date.now();
    for (const w of this.socks()) if (now - (this.info(w).seen || 0) > IDLE_MS) await this.drop(w, 'idle');
    const s = this.socks(); if (!s.length) return;
    const phase = await this.get('phase', 'lobby'), auto = await this.get('auto', null), round = await this.get('round', null);
    if (phase === 'lobby' && auto && now >= auto.at - 20 && s.filter(w => this.info(w).back).length >= 2) { await this.startRound(now); }
    else if (phase === 'play' && round && now - round.at > MAX_ROUND_MS) await this.finishRound(now);
    else { await this.ctx.storage.put('resv', now); await this.upsert(); await this.sched(now); }
    if (this.socks().length) await this.sched(now);
  }
}

// Lobby: summaries pushed by the rooms; list, and quick-match placement. Only reachable through index.js.
// Memory only (no storage writes): after a restart the rooms refill within 30 s from the Arenas' own refresh.
// Placeholders (quick-match rooms nobody joined yet) live 15 s and do not count toward LOBBY_CAP; `pend` holds the
// times of players sent to a room but not yet connected (10 s), so the real count n + pend decides free seats.
export class Lobby {
  constructor(ctx) { this.ctx = ctx; this.rooms = {}; }
  prune(now) {
    for (const k of Object.keys(this.rooms)) {
      const r = this.rooms[k];
      if (r.ph ? now - r.ts > PH_TTL : now - r.ts > LOBBY_TTL) { delete this.rooms[k]; continue; }
      if (r.pend.length) r.pend = r.pend.filter(t => now - t < PEND_TTL);
    }
  }
  evict() {                                          // over the cap: drop the emptiest, then oldest, real room
    const real = Object.values(this.rooms).filter(x => !x.ph);
    if (real.length < LOBBY_CAP) return;
    real.sort((a, b) => a.n - b.n || a.ts - b.ts); delete this.rooms[real[0].code];
  }
  async fetch(req) {
    const url = new URL(req.url), now = Date.now(); this.prune(now);
    if (url.pathname === '/list') {
      const di = int(url.searchParams.get('di') ?? -1, -1, 4), space = url.searchParams.get('space') === '1';
      const r = Object.values(this.rooms).filter(x => !x.ph && x.pub && x.n > 0 && (di < 0 || x.di === di) && (!space || (x.phase === 'lobby' && x.n < x.max)))
        .sort((a, b) => b.n - a.n || b.ts - a.ts).slice(0, LIST_MAX)
        .map(x => ({ code: x.code, host: x.host, song: x.song, di: x.di, n: x.n, max: x.max, phase: x.phase, qm: x.qm }));
      return Response.json({ rooms: r });
    }
    if (url.pathname === '/match') {                 // synchronous with the in-memory map, so two callers cannot pick the same new code
      const di = int(url.searchParams.get('di') ?? -1, -1, 4), max = int(url.searchParams.get('max') ?? 4, 2, 8);
      const eff = x => x.n + x.pend.length;
      const c = Object.values(this.rooms).filter(x => x.qm && x.phase === 'lobby' && eff(x) < x.max && x.max === max && (di < 0 || x.di === di))
        .sort((a, b) => eff(b) - eff(a) || b.ts - a.ts)[0];
      if (c) { c.pend.push(now); return Response.json({ code: c.code, create: false }); }
      const phs = Object.values(this.rooms).filter(x => x.ph);
      if (phs.length >= PH_CAP) { phs.sort((a, b) => a.ts - b.ts); delete this.rooms[phs[0].code]; }
      const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let code;
      do code = Array.from(crypto.getRandomValues(new Uint8Array(4)), x => ALPH[x % ALPH.length]).join(''); while (this.rooms[code]);
      this.rooms[code] = { code, host: '', song: '', di: di < 0 ? 1 : di, n: 0, pend: [now], max, phase: 'lobby', qm: true, pub: true, ph: true, ts: now };   // placeholder; the first real upsert replaces it
      return Response.json({ code, create: true, di: this.rooms[code].di, max });
    }
    let o = {}; try { o = await req.json(); } catch (e) { return new Response('bad', { status: 400 }); }
    if (typeof o.code !== 'string' || !/^[A-Z0-9]{4}$/.test(o.code)) return new Response('bad', { status: 400 });
    if (url.pathname === '/remove') { delete this.rooms[o.code]; return Response.json({ ok: true }); }
    if (url.pathname === '/upsert') {
      const old = this.rooms[o.code], n = int(o.n, 0, 8);
      if (!old) this.evict();
      const pend = old ? old.pend.slice() : [];
      for (let k = Math.max(0, n - (old && !old.ph ? old.n : 0)); k > 0 && pend.length; k--) pend.shift();   // players that really connected are no longer pending
      this.rooms[o.code] = { code: o.code, host: cleanName(o.host), song: isSong(o.song) ? o.song : '', di: int(o.di, 0, 4), n, pend, max: int(o.max, 2, 8), phase: o.phase === 'play' ? 'play' : 'lobby', qm: !!o.qm, pub: !!o.pub, ts: now };
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }
}
