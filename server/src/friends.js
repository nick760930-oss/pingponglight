// Friends: friend codes, requests, blocks, invites and online presence.
//
// Data lives in D1 (migrations/0002_friends.sql); presence lives in ONE Durable Object ("Hub") that holds every
// player's WebSocket, so "is X online / what are they doing" and "send this to X" are single-object calls.
// Presence is only ever shown to friends, and a block is never revealed (add answers 'nocode' either way).
//
// Players are the ones /lb/name registered; the phone's secret key pk is hashed and looked up like in lb.js.
// Responses never contain pk or ph.
import { cleanMsg, msgProblem } from './names.js';
import { moderate, mutedUntil } from './moderate.js';
import { cosOf, NOCOS } from './cos.js';

export async function friendSweep(env) {    // hourly (cron): expired messages; reports older than a year; strikes 180 days old
  if (!env.LB) return;
  const now = Date.now(), old = now - 180 * 86400e3;
  await env.LB.batch([env.LB.prepare('DELETE FROM fmsgs WHERE ts < ?1').bind(now - FMSG_KEEP), env.LB.prepare('DELETE FROM freports WHERE ts < ?1').bind(now - 365 * 86400e3),
    env.LB.prepare('DELETE FROM fmutes WHERE until < ?1 AND ts < ?1').bind(old)]);
}

export const friendWipe = (db, id) => [        // every friends row about a player, in both directions (see lb.js wipe)
  db.prepare('DELETE FROM fcodes WHERE pid = ?1').bind(id),
  db.prepare('DELETE FROM fships WHERE a = ?1').bind(id), db.prepare('DELETE FROM fships WHERE b = ?1').bind(id),
  db.prepare('DELETE FROM freqs WHERE frm = ?1').bind(id), db.prepare('DELETE FROM freqs WHERE "to" = ?1').bind(id),
  db.prepare('DELETE FROM fblocks WHERE pid = ?1').bind(id), db.prepare('DELETE FROM fblocks WHERE target = ?1').bind(id),
  db.prepare('DELETE FROM fmsgs WHERE frm = ?1').bind(id), db.prepare('DELETE FROM fmsgs WHERE "to" = ?1').bind(id),
  db.prepare('DELETE FROM freports WHERE rp = ?1').bind(id), db.prepare('DELETE FROM freports WHERE target = ?1').bind(id),
  db.prepare('DELETE FROM fmutes WHERE pid = ?1').bind(id),
];

const ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';          // no 0/O/1/I/L (same as duel room codes)
const MAX_BODY = 2048, MAX_FRIENDS = 100, MAX_OUT = 50, MAX_BLOCKS = 200, LIST_CAP = 100;
const ST = ['home', 'menu', 'play', 'duel'];
const SONG = /^[a-z0-9]{1,24}$/, ROOM = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;
const INV_PAIR_MS = 5000, INV_MIN = 20, INV_TTL = 60000;
const FMSG_KEEP = 7 * 86400e3, FMSG_PAGE = 50, FMSG_RAW = 400, FREP_DAY = 30;   // friend messages: kept 7 days, last 50 shown; reports per reporter per day
const FSAY_N = 64, SAY_PAIR_MS = 3000, SAY_MIN = 20;    // friend phrases: highest index accepted (the client's append-only list holds the text), per-pair gap, per-minute cap
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
// Messages are NOT removed with the friendship: /fr/msgs needs a friendship, so neither side can read them any more,
// but a message stays reportable (and is copied into a report) until it expires after FMSG_KEEP.

// Ask y to be x's friend (x = { id, name }). Shared by /fr/add (friend code) and the room's seat menu (Arena 'fadd').
// The caller has already checked blocks; answers { ok, pending } / { ok, friends } / { error: 'already' | 'full' }.
export async function friendRequest(db, env, x, y, now) {
  if (await areFriends(db, x.id, y)) return { error: 'already' };
  if (await db.prepare('SELECT 1 FROM freqs WHERE frm = ?1 AND "to" = ?2').bind(x.id, y).first()) return { ok: true, pending: true };   // asked before: nothing new
  const mutual = await db.prepare('SELECT 1 FROM freqs WHERE frm = ?1 AND "to" = ?2').bind(y, x.id).first();
  if (mutual) {                                      // they already asked me: adding them accepts
    if ((await friendCount(db, x.id)) >= MAX_FRIENDS || (await friendCount(db, y)) >= MAX_FRIENDS) return { error: 'full' };
    await db.batch(becomeFriends(db, x.id, y, now));
    await hub(env, '/i/push', { to: y, msg: { t: 'friend', id: x.id, name: x.name } });
    return { ok: true, friends: true };
  }
  const out = await db.prepare('SELECT COUNT(*) AS n FROM freqs WHERE frm = ?1').bind(x.id).first();
  if ((await friendCount(db, x.id)) >= MAX_FRIENDS || out.n >= MAX_OUT) return { error: 'full' };
  await db.prepare('INSERT OR IGNORE INTO freqs (frm, "to", ts) VALUES (?1, ?2, ?3)').bind(x.id, y, now).run();
  await hub(env, '/i/push', { to: y, msg: { t: 'req', from: x } });
  return { ok: true, pending: true };
}
// How x relates to each of ids, for the room's seat tags: 'f' friend, 'o' x asked them, 'i' they asked x, 'b' x blocked them.
// A block by THEM is never revealed (that player just looks like anyone else).
export async function relations(db, x, ids) {
  const r = {}; if (!ids.length) return r;
  const q = ids.map((_, k) => '?' + (k + 2)).join(',');
  const [fa, fb, o, i, b] = await db.batch([
    db.prepare(`SELECT b AS id FROM fships WHERE a = ?1 AND b IN (${q})`).bind(x, ...ids),
    db.prepare(`SELECT a AS id FROM fships WHERE b = ?1 AND a IN (${q})`).bind(x, ...ids),
    db.prepare(`SELECT "to" AS id FROM freqs WHERE frm = ?1 AND "to" IN (${q})`).bind(x, ...ids),
    db.prepare(`SELECT frm AS id FROM freqs WHERE "to" = ?1 AND frm IN (${q})`).bind(x, ...ids),
    db.prepare(`SELECT target AS id FROM fblocks WHERE pid = ?1 AND target IN (${q})`).bind(x, ...ids),
  ]);
  for (const row of i.results) r[row.id] = 'i';
  for (const row of o.results) r[row.id] = 'o';
  for (const row of [...fa.results, ...fb.results]) r[row.id] = 'f';
  for (const row of b.results) r[row.id] = 'b';
  return r;
}
export const pidOf = async (db, pk) => isPk(pk) ? await db.prepare('SELECT id, name FROM players WHERE ph = ?1').bind(await sha(pk)).first() : null;
export const blockedBy = async (db, x, ids) => {     // which of ids have blocked x (their screens should not show x's phrases)
  if (!ids.length) return new Set();
  const q = ids.map((_, k) => '?' + (k + 2)).join(',');
  return new Set((await db.prepare(`SELECT pid FROM fblocks WHERE target = ?1 AND pid IN (${q})`).bind(x, ...ids).all()).results.map(r => r.pid));
};

export async function handleFr(req, env, path, who, origin, H, limited, ctx) {
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
    return json(await friendRequest(db, env, mine, hit.id, now));
  }

  if (path === '/fr/say') {                           // a preset phrase to a friend (never free text); not stored
    const { id, k } = body;
    if (!isId(id) || !Number.isInteger(k) || k < 0 || k >= FSAY_N) return bad();
    if (!(await areFriends(db, me.id, id))) return json({ error: 'notfriend' });
    const r = await hub(env, '/i/say', { from: mine, to: id, k });
    if (!r) return json({ error: 'busy' }, 503);
    if (r.limited) return json({ error: 'slow' }, 429, { 'Retry-After': '3' });
    return json({ ok: true, delivered: !!r.delivered });
  }

  if (path === '/fr/msg') {                           // free text to a friend: filtered, rate-limited, kept FMSG_KEEP
    const { id, text } = body, k = body.k;
    if (!isId(id) || typeof text !== 'string' || text.length > FMSG_RAW || (k !== undefined && (!Number.isInteger(k) || k < 0 || k >= FSAY_N))) return bad();
    const t = cleanMsg(text);
    if (!t) return bad();
    if (!(await areFriends(db, me.id, id))) return json({ error: 'notfriend' });
    const mu = await mutedUntil(db, me.id, now);
    if (mu) return json({ error: 'muted', until: mu });     // a report against this player was upheld (moderate.js)
    const r = await hub(env, '/i/rate', { from: me.id, to: id });
    if (!r) return json({ error: 'busy' }, 503);
    if (r.limited) return json({ error: 'slow' }, 429, { 'Retry-After': '2' });
    const why = msgProblem(t);
    if (why) return json({ error: 'filtered', why: why === 'link' ? 'link' : 'words' });
    const row = await db.prepare('INSERT INTO fmsgs (frm, "to", body, ts) VALUES (?1, ?2, ?3, ?4) RETURNING id').bind(me.id, id, t, now).first();
    const m = { id: row.id, text: t, ts: now };
    const p = await hub(env, '/i/dm', { to: id, msg: { t: 'fmsg', from: mine, m }, alt: k === undefined ? null : { t: 'fsay', from: mine, k, ts: now } });
    return json({ ok: true, m, delivered: !!(p && p.n) });
  }

  if (path === '/fr/msgs') {                          // the last FMSG_PAGE messages with one friend, oldest first
    if (!isId(body.id)) return bad();
    if (!(await areFriends(db, me.id, body.id))) return json({ error: 'notfriend' });
    const fs = await db.prepare('SELECT ts FROM fships WHERE a = ?1 AND b = ?2').bind(Math.min(me.id, body.id), Math.max(me.id, body.id)).first();
    const since = Math.max(now - FMSG_KEEP, (fs && fs.ts) || now);   // only since this friendship began: an old chat is not shown again after re-adding
    const r = await db.prepare(`SELECT id, frm, body, ts FROM fmsgs WHERE ((frm = ?1 AND "to" = ?2) OR (frm = ?2 AND "to" = ?1)) AND ts >= ?3
      ORDER BY id DESC LIMIT ${FMSG_PAGE}`).bind(me.id, body.id, since).all();
    return json({ msgs: r.results.reverse().map(x => ({ id: x.id, me: x.frm === me.id ? 1 : 0, text: x.body, ts: x.ts })) });
  }

  if (path === '/fr/report') {                        // report a player, optionally one message they sent me (a copy is kept for review)
    const { id } = body, mid = body.mid === undefined ? 0 : body.mid;
    if (!isId(id) || id === me.id || !Number.isInteger(mid) || mid < 0) return bad();
    let copy = null, fts = 0, mts = 0;                 // fts..mts: times of the oldest and newest reported message
    if (mid) {
      const x = await db.prepare('SELECT body, ts FROM fmsgs WHERE id = ?1 AND frm = ?2 AND "to" = ?3').bind(mid, id, me.id).first();
      if (!x) return json({ error: 'nomsg' });
      copy = x.body; fts = mts = x.ts;
    } else {
      const rows = (await db.prepare('SELECT body, ts FROM fmsgs WHERE frm = ?1 AND "to" = ?2 AND ts > ?3 ORDER BY id DESC LIMIT 20').bind(id, me.id, now - FMSG_KEEP).all()).results;
      if (!rows.length && !(await areFriends(db, me.id, id))) return json({ error: 'nomsg' });   // only someone who is (or recently wrote to) me
      if (rows.length) { mts = rows[0].ts; fts = rows[rows.length - 1].ts; copy = rows.reverse().map(x => x.body).join('\n'); }
    }
    // a repeat report makes a new row only when it covers messages newer than the last one (judged rows are never rewritten);
    // a mid=0 report still waiting for its turn is just extended
    const last = await db.prepare('SELECT id, status, mts FROM freports WHERE rp = ?1 AND target = ?2 AND mid = ?3 ORDER BY id DESC LIMIT 1').bind(me.id, id, mid).first();
    if (last && last.mts >= mts) return json({ ok: true });
    if (last && last.status === 'new' && !mid) {
      const u = await db.prepare(`UPDATE freports SET body = ?2, fts = ?3, mts = ?4 WHERE id = ?1 AND status = 'new'`).bind(last.id, copy, fts, mts).run();
      if (u.meta && u.meta.changes) return json({ ok: true });   // (claimed meanwhile: a new row below)
    }
    const n = await db.prepare('SELECT COUNT(*) AS n FROM freports WHERE rp = ?1 AND ts > ?2').bind(me.id, now - 86400e3).first();
    if (n.n < FREP_DAY) {
      await db.prepare('INSERT INTO freports (rp, target, mid, body, fts, mts, ts) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(me.id, id, mid, copy, fts, mts, now).run();
      if (ctx && env.AI) ctx.waitUntil(moderate(env, 3));   // judged right away; the hourly cron picks up anything left
    }
    return json({ ok: true });
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
    const [fr, inc, out, blk, lm] = await db.batch([
      db.prepare(`SELECT p.id, p.name, p.seen FROM fships f JOIN players p ON p.id = f.b WHERE f.a = ?1
        UNION ALL SELECT p.id, p.name, p.seen FROM fships f JOIN players p ON p.id = f.a WHERE f.b = ?1 ${L}`).bind(me.id),
      db.prepare(`SELECT p.id, p.name FROM freqs r JOIN players p ON p.id = r.frm WHERE r."to" = ?1 ORDER BY r.ts DESC ${L}`).bind(me.id),
      db.prepare(`SELECT p.id, p.name FROM freqs r JOIN players p ON p.id = r."to" WHERE r.frm = ?1 ORDER BY r.ts DESC ${L}`).bind(me.id),
      db.prepare(`SELECT p.id, p.name FROM fblocks b JOIN players p ON p.id = b.target WHERE b.pid = ?1 ORDER BY b.ts DESC LIMIT ${MAX_BLOCKS}`).bind(me.id),
      db.prepare(`SELECT m.id, m.frm, m."to", m.body, m.ts FROM fmsgs m JOIN (SELECT MAX(id) AS id FROM fmsgs WHERE (frm = ?1 OR "to" = ?1) AND ts > ?2
        AND ts >= COALESCE((SELECT f.ts FROM fships f WHERE f.a = MIN(frm, "to") AND f.b = MAX(frm, "to")), 9e15)
        GROUP BY CASE WHEN frm = ?1 THEN "to" ELSE frm END) x ON x.id = m.id`).bind(me.id, now - FMSG_KEEP),   // last message with each friend, this friendship only
    ]);
    const last = {};
    for (const x of lm.results) last[x.frm === me.id ? x.to : x.frm] = { id: x.id, me: x.frm === me.id ? 1 : 0, text: x.body, ts: x.ts };
    const pres = fr.results.length ? ((await hub(env, '/i/status', { ids: fr.results.map(x => x.id) })) || {}).on || {} : {};
    const friends = fr.results.map(x => {
      const p = pres[x.id];
      const f = p ? { id: x.id, name: x.name, on: 1, st: p.st, song: p.song, seen: x.seen || 0 } : { id: x.id, name: x.name, on: 0, st: 'home', song: null, seen: x.seen || 0 };
      if (last[x.id]) f.lm = last[x.id];
      return f;
    }).sort((x, y) => y.on - x.on || x.name.localeCompare(y.name));
    // what each of them wears: avatar, plate, title, and cmc (best combo: colours the default avatar); see cos.js
    let cm = new Map(); try { cm = await cosOf(db, env, [...friends.map(x => x.id), ...inc.results.map(x => x.id), ...out.results.map(x => x.id)]); } catch (e) {}
    const dress = x => ({ ...x, ...(cm.get(x.id) || NOCOS) });
    return json({ friends: friends.map(dress), incoming: inc.results.map(dress), outgoing: out.results.map(dress), blocked: blk.results });
  }

  if (path === '/fr/invite') {
    const { id, room, song, d, v } = body;
    if (v !== undefined && v !== 2) return bad();     // optional protocol version; only 2 (multiplayer rooms) exists
    if (!isId(id) || typeof room !== 'string' || !ROOM.test(room) || typeof song !== 'string' || !SONG.test(song) || !Number.isInteger(d) || d < 0 || d > 4) return bad();
    if (!(await areFriends(db, me.id, id))) return json({ error: 'notfriend' });
    const r = await hub(env, '/i/invite', { from: mine, to: id, room, song, d, v });
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
const MSG_PAIR_MS = 1000, MSG_MIN = 20;
const AUTH_MS = 10000, IDLE_MS = 75000, SWEEP_MS = 30000, MAX_SOCKS = 5;

export class Hub {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.rate = new Map(); this.pairs = new Map(); this.sent = new Map(); this.said = new Map(); this.msgd = new Map(); }
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
    if (url.pathname === '/i/dm') {                         // a friend message: new apps get the text, old ones (v1) the preset phrase if there is one
      let n = 0;
      for (const w of this.of(b.to)) { if ((this.info(w).v || 1) >= 2) { this.send(w, b.msg); n++; } else if (b.alt) { this.send(w, b.alt); n++; } }
      return Response.json({ n });
    }
    if (url.pathname === '/i/say') {                        // a friend's preset phrase: same limits style as invites
      const now = Date.now(), pk = 's' + b.from.id + ':' + b.to;
      const mins = (this.said.get(b.from.id) || []).filter(t => now - t < 60000);
      if (now - (this.pairs.get(pk) || 0) < SAY_PAIR_MS || mins.length >= SAY_MIN) return Response.json({ limited: true });
      mins.push(now); this.said.set(b.from.id, mins); this.pairs.set(pk, now);
      if (this.said.size > 2000) for (const [k, v] of this.said) if (!v.some(t => now - t < 60000)) this.said.delete(k);
      if (this.pairs.size > 2000) for (const [k, t] of this.pairs) if (now - t > Math.max(INV_PAIR_MS, SAY_PAIR_MS)) this.pairs.delete(k);   // keep the memory bounded
      const n = this.push(b.to, { t: 'fsay', from: b.from, k: b.k, ts: now });
      return Response.json({ delivered: n > 0 });
    }
    if (url.pathname === '/i/rate') {                       // friend messages: per-pair gap and a per-minute cap (the Worker stores and pushes)
      const now = Date.now(), pk = 'm' + b.from + ':' + b.to;
      const mins = (this.msgd.get(b.from) || []).filter(t => now - t < 60000);
      if (now - (this.pairs.get(pk) || 0) < MSG_PAIR_MS || mins.length >= MSG_MIN) return Response.json({ limited: true });
      mins.push(now); this.msgd.set(b.from, mins); this.pairs.set(pk, now);
      if (this.msgd.size > 2000) for (const [k, v] of this.msgd) if (!v.some(t => now - t < 60000)) this.msgd.delete(k);
      if (this.pairs.size > 2000) for (const [k, t] of this.pairs) if (now - t > Math.max(INV_PAIR_MS, SAY_PAIR_MS)) this.pairs.delete(k);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/i/invite') {
      const now = Date.now(), pk = b.from.id + ':' + b.to;
      const mins = (this.sent.get(b.from.id) || []).filter(t => now - t < 60000);
      if (now - (this.pairs.get(pk) || 0) < INV_PAIR_MS || mins.length >= INV_MIN) return Response.json({ limited: true });
      mins.push(now); this.sent.set(b.from.id, mins); this.pairs.set(pk, now);
      if (this.pairs.size > 2000) for (const [k, t] of this.pairs) if (now - t > Math.max(INV_PAIR_MS, SAY_PAIR_MS)) this.pairs.delete(k);   // keep the memory bounded
      const n = this.push(b.to, { t: 'inv', from: b.from, room: b.room, song: b.song, d: b.d, ...(b.v === 2 ? { v: 2 } : {}), exp: now + INV_TTL });
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
      ws.serializeAttachment({ pid: pl.id, st: 'home', song: null, sa: now, seen: now, v: d.v === 2 ? 2 : 1 });   // v2 = knows 'fmsg' (free text)
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
