// Leaderboard: one board per song and difficulty, ranked by accuracy, then by score.
//
// Accuracy comes from the timing of every beat, so the server recomputes it from the submitted beat log.
// The score breaks ties between equally accurate players (steering the ball into power-ups is a skill), but it
// also depends on ball speed, touch pressure and power-ups that only the phone sees. So each hit sends its base
// points (before the combo bonus); the server checks each against the most that hit could earn and adds the
// combo bonus and the total itself. A phone can still claim the best possible base on every hit; that is the
// limit of what a server can check without watching the game.
//
// Checks on every submitted run (a phone can always lie, so these raise the cost of cheating; they cannot remove it):
// - the run must start with a ticket signed by this server (HMAC), and the result may only arrive after the song
//   could really have been played (ticket age >= song length at that difficulty), and within 3 hours;
// - the beat log must have exactly as many entries as the game asks for (src/charts.js, generated from game.js);
// - every timing error must be in the hit window;
// - only full runs from the first beat count; the server keeps each player's best run per board, with its beat
//   log, so a reported or flagged run (machine-steady timing is flagged, never refused) can be checked by hand.
// Players have no account: the phone makes a random 128-bit key and the server stores only its SHA-256.
// That key is needed to submit, see your own rank, and delete your records. Every player registers a nickname
// first (/lb/name): unique (ignoring case, spaces and symbols), filtered, can be reported, and hidden
// automatically after reports from 3 different networks.
import { CHARTS } from './charts.js';
import { cleanName, nameProblem, nameKey } from './names.js';
import { friendWipe } from './friends.js';

const DIFFS = 3, TICKET_MAX_MS = 3 * 3600e3, MAX_BODY = 16384, TOP = 100, HIDE_AT = 3, BOARD_CACHE_S = 30;
const MAX_ERR = 400, MISS = null;                      // ms; a missed beat is null in the log
const TIER_MS = [45, 90, 150], TIER_W = [1, .8, .5, .25];
// game.js bounce(): base = round(100 * TIER_M * speed^1.1 * (1 + .3 * pressure) * (power-up ? 2 : 1)), then + combo * 5;
// speed factor is clamped to [.3, 8] there, pressure to [0, 1]
const TIER_M = [3, 2, 1.2, 1], Q_MIN = Math.pow(.3, 1.1) * .99, Q_MAX = Math.pow(8, 1.1) * 1.3 * 2 * 1.01, SCORE_CAP = 999999999;
const enc = new TextEncoder();
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const b64u = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)))));
}
function same(a, b) {                                 // constant-time string compare
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0;
}
const isPk = v => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
const board = (song, d) => song + '-' + d;
const songOk = (song, d) => typeof song === 'string' && Object.prototype.hasOwnProperty.call(CHARTS, song) && Number.isInteger(d) && d >= 0 && d < DIFFS;

// Accuracy and the rest, recomputed from the beat log. Returns null when the log is malformed.
export function judge(song, d, log) {
  const N = CHARTS[song].n[d];
  if (!Array.isArray(log) || log.length !== N) return null;
  const tiers = [0, 0, 0, 0]; let miss = 0, w = 0, sumAbs = 0, sum = 0, sum2 = 0, hits = 0, combo = 0, maxCombo = 0, score = 0;
  for (const x of log) {                              // each entry: null (missed) or [timing error ms, base points]
    if (x === MISS) { miss++; combo = 0; continue; }
    if (!Array.isArray(x) || x.length !== 2) return null;
    const [e, base] = x;
    if (!Number.isInteger(e) || Math.abs(e) > MAX_ERR || !Number.isInteger(base)) return null;
    const a = Math.abs(e), t = a < TIER_MS[0] ? 0 : a < TIER_MS[1] ? 1 : a < TIER_MS[2] ? 2 : 3;
    const q = base / (100 * TIER_M[t]); if (q < Q_MIN || q > Q_MAX) return null;   // more than this hit could earn
    tiers[t]++; w += TIER_W[t]; hits++; sumAbs += a; sum += e; sum2 += e * e;
    combo = t <= 2 ? combo + 1 : 0; maxCombo = Math.max(maxCombo, combo);
    score += base + combo * 5;
  }
  if (!hits) return null;
  const mean = sum / hits, sd = Math.sqrt(Math.max(0, sum2 / hits - mean * mean)), err = Math.round(sumAbs / hits);
  const sus = hits >= 20 && (sumAbs / hits < 4 || sd < 3) ? 1 : 0;   // unusually steady: kept, but listed for review
  const acc = Math.floor(w / N * 10000);                         // basis points: 9842 = 98.42 %
  const rank = acc >= 9500 && !miss ? 'S' : acc >= 8500 ? 'A' : acc >= 7000 ? 'B' : acc >= 5000 ? 'C' : 'D';
  score = Math.min(SCORE_CAP, score);
  return { acc, err, maxCombo, miss, tiers, rank, sus, score, key: acc * 1e9 + score };   // < 2^53, exact in JS and SQLite
}

export async function handleLb(req, env, path, who, origin, H, limited) {
  const json = (o, s = 200, extra) => Response.json(o, { status: s, headers: { ...H, ...extra } });
  if (!env.LB || !env.LB_SECRET) return json({ error: 'off' }, 503);
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  // runs get their own budget, so browsing boards cannot use up the requests a finished run needs
  const bucket = path === '/lb/start' || path === '/lb/submit' ? 'lbr:' : 'lb:';
  if (await limited(env, bucket + who)) return json({ error: 'slow' }, 429, { 'Retry-After': '60' });
  const len = +(req.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) return json({ error: 'big' }, 413);
  let body; try { const t = await req.text(); if (t.length > MAX_BODY) return json({ error: 'big' }, 413); body = JSON.parse(t); } catch (e) { return json({ error: 'bad' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad' }, 400);
  const db = env.LB, now = Date.now();

  if (path === '/lb/name') {                          // register or change the nickname: unique and filtered
    const { pk } = body; if (!isPk(pk)) return json({ error: 'bad' }, 400);
    const name = cleanName(body.name), bad = nameProblem(name);
    if (bad) return json({ error: 'name', why: bad }, 400);
    const ph = await sha(pk), nk = nameKey(name);
    const owner = await db.prepare('SELECT ph FROM players WHERE nkey = ?1').bind(nk).first();
    if (owner && owner.ph !== ph) return json({ error: 'name', why: 'taken' }, 409);
    try {
      await db.prepare('INSERT INTO players (ph, name, nkey, created, seen) VALUES (?1, ?2, ?3, ?4, ?4) ON CONFLICT(ph) DO UPDATE SET name = ?2, nkey = ?3').bind(ph, name, nk, now).run();
    } catch (e) { return json({ error: 'name', why: 'taken' }, 409); }   // lost a race for the same name
    const pl = await db.prepare('SELECT id FROM players WHERE ph = ?1').bind(ph).first();
    const bs = (await db.prepare('SELECT board FROM scores WHERE pid = ?1').bind(pl.id).all()).results;
    for (const r of bs) await dropCache(r.board);   // boards show the new name at once
    return json({ ok: true, id: pl.id, name });
  }

  if (path === '/lb/me') {                            // the nickname this key registered (null: none yet)
    const { pk } = body; if (!isPk(pk)) return json({ error: 'bad' }, 400);
    const pl = await db.prepare('SELECT id, name FROM players WHERE ph = ?1').bind(await sha(pk)).first();
    return json({ me: pl ? { id: pl.id, name: pl.name } : null });
  }

  if (path === '/lb/start') {                         // a signed ticket: song, difficulty, issue time
    const { song, d } = body; if (!songOk(song, d)) return json({ error: 'song' }, 400);
    const p = [song, d, now, hex(crypto.getRandomValues(new Uint8Array(8)))].join('.');
    return json({ run: p + '.' + await hmac(env.LB_SECRET, p) });
  }

  if (path === '/lb/submit') {
    const { run, pk, log } = body;
    if (typeof run !== 'string' || run.length > 200 || !isPk(pk)) return json({ error: 'bad' }, 400);
    const parts = run.split('.'); if (parts.length !== 5) return json({ error: 'ticket' }, 400);
    const [song, ds, ts, nonce, sig] = parts, d = +ds, issued = +ts;
    if (!same(sig, await hmac(env.LB_SECRET, [song, ds, ts, nonce].join('.'))) || !songOk(song, d)) return json({ error: 'ticket' }, 400);
    const c = CHARTS[song], minMs = c.dur / c.spd[d] * 900;
    if (!(now - issued >= minMs && now - issued <= TICKET_MAX_MS)) return json({ error: 'ticket' }, 400);
    const r = judge(song, d, log); if (!r) return json({ error: 'log' }, 400);
    const b = board(song, d), pf = ['web', 'ios', 'android'].includes(body.pf) ? body.pf : 'web';
    const pl = await db.prepare('SELECT id, hidden FROM players WHERE ph = ?1').bind(await sha(pk)).first();
    if (!pl) return json({ error: 'noname' }, 400);
    const prev = await db.prepare('SELECT key FROM scores WHERE board = ?1 AND pid = ?2').bind(b, pl.id).first();
    const improved = !prev || r.key > prev.key;
    if (improved) await db.prepare(`INSERT INTO scores (board, pid, key, acc, err, combo, ts, hid, log, pf, sus, score) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
      ON CONFLICT(board, pid) DO UPDATE SET key = ?3, acc = ?4, err = ?5, combo = ?6, ts = ?7, log = ?9, pf = ?10, sus = ?11, score = ?12`)
      .bind(b, pl.id, r.key, r.acc, r.err, r.maxCombo, now, pl.hidden, JSON.stringify(log), pf, r.sus, r.score).run();
    if (improved) await dropCache(b);
    const me = await myRank(db, b, pl.id);
    return json({ ok: true, improved, acc: r.acc, err: r.err, score: r.score, rank: r.rank, me, total: await total(db, b) });
  }

  if (path === '/lb/board') {
    const { song, d, pk } = body; if (!songOk(song, d)) return json({ error: 'song' }, 400);
    const b = board(song, d), top = await topList(db, b);
    let me = null;
    if (isPk(pk)) { const pl = await db.prepare('SELECT id FROM players WHERE ph = ?1').bind(await sha(pk)).first(); if (pl) me = await myRank(db, b, pl.id); }
    return json({ top: top.rows, total: top.total, me });
  }

  if (path === '/lb/report') {   // registered players only; one report per network and per reporter; hidden after HIDE_AT
    const id = body.id, { pk } = body; if (!Number.isInteger(id) || id < 1 || !isPk(pk)) return json({ error: 'bad' }, 400);
    const rp = await db.prepare('SELECT id FROM players WHERE ph = ?1').bind(await sha(pk)).first();
    if (!rp) return json({ error: 'noname' }, 400);
    if (rp.id === id || !(await db.prepare('SELECT 1 FROM players WHERE id = ?1').bind(id).first())) return json({ ok: true });
    const by = await sha('rep:' + who + ':' + env.LB_SECRET);
    await db.prepare('INSERT OR IGNORE INTO reports (pid, by, ts, rp) VALUES (?1, ?2, ?3, ?4)').bind(id, by, now, rp.id).run();
    const n = await db.prepare('SELECT COUNT(*) AS n FROM reports WHERE pid = ?1').bind(id).first();
    if (n && n.n >= HIDE_AT) await setHidden(db, id, 1);
    return json({ ok: true });
  }

  if (path === '/lb/delete') {                        // the player removes everything kept about them
    const { pk } = body; if (!isPk(pk)) return json({ error: 'bad' }, 400);
    const pl = await db.prepare('SELECT id FROM players WHERE ph = ?1').bind(await sha(pk)).first();
    if (pl) await wipe(db, pl.id);
    return json({ ok: true });
  }

  if (path === '/lb/admin') {                         // moderation, with the LB_ADMIN secret (curl, no page)
    if (!env.LB_ADMIN || !same(body.token, env.LB_ADMIN)) return json({ error: 'forbidden' }, 403);
    const id = body.id;
    if (body.op === 'flagged') return json({ rows: (await db.prepare(`SELECT s.board, s.pid AS id, p.name, s.acc, s.err, s.pf, s.ts
      FROM scores s JOIN players p ON p.id = s.pid WHERE s.sus = 1 ORDER BY s.ts DESC LIMIT 200`).all()).results });
    if (body.op === 'run') { if (!Number.isInteger(id)) return json({ error: 'bad' }, 400); const x = await db.prepare('SELECT acc, err, combo, score, pf, ts, log FROM scores WHERE board = ?1 AND pid = ?2').bind(String(body.board), id).first(); return json({ run: x }); }
    if (body.op === 'reports') return json({ rows: (await db.prepare(`SELECT p.id, p.name, p.hidden, COUNT(r.by) AS n, MAX(r.ts) AS last
      FROM reports r JOIN players p ON p.id = r.pid GROUP BY p.id ORDER BY n DESC LIMIT 200`).all()).results });
    if (!Number.isInteger(id)) return json({ error: 'bad' }, 400);
    if (body.op === 'hide' || body.op === 'unhide') { await setHidden(db, id, body.op === 'hide' ? 1 : 0); if (body.op === 'unhide') await db.prepare('DELETE FROM reports WHERE pid = ?1').bind(id).run(); return json({ ok: true }); }
    if (body.op === 'delete') { await wipe(db, id); return json({ ok: true }); }
    return json({ error: 'op' }, 400);
  }
  return json({ error: 'not found' }, 404);
}

const cacheKey = b => new Request('https://lb.cache/' + encodeURIComponent(b));
async function dropCache(b) { try { if (typeof caches !== 'undefined') await caches.default.delete(cacheKey(b)); } catch (e) {} }
async function wipe(db, id) {                         // a player and everything about them; their boards refresh at once
  const bs = (await db.prepare('SELECT board FROM scores WHERE pid = ?1').bind(id).all()).results;
  await db.batch([db.prepare('DELETE FROM scores WHERE pid = ?1').bind(id), db.prepare('DELETE FROM reports WHERE pid = ?1').bind(id),
    ...friendWipe(db, id), db.prepare('DELETE FROM players WHERE id = ?1').bind(id)]);
  for (const r of bs) await dropCache(r.board);
}
async function setHidden(db, id, v) {
  await db.batch([db.prepare('UPDATE players SET hidden = ?2 WHERE id = ?1').bind(id, v), db.prepare('UPDATE scores SET hid = ?2 WHERE pid = ?1').bind(id, v)]);
  const bs = (await db.prepare('SELECT board FROM scores WHERE pid = ?1').bind(id).all()).results;
  for (const r of bs) await dropCache(r.board);
}
const total = async (db, b) => ((await db.prepare('SELECT COUNT(*) AS n FROM scores WHERE board = ?1 AND hid = 0').bind(b).first()) || { n: 0 }).n;
async function myRank(db, b, pid) {
  const s = await db.prepare('SELECT key, acc, err, combo, score, ts, hid FROM scores WHERE board = ?1 AND pid = ?2').bind(b, pid).first();
  if (!s) return null;
  if (s.hid) return { hidden: true, acc: s.acc, err: s.err, score: s.score };
  const ahead = await db.prepare('SELECT COUNT(*) AS n FROM scores WHERE board = ?1 AND hid = 0 AND (key > ?2 OR (key = ?2 AND ts < ?3))').bind(b, s.key, s.ts).first();
  return { r: ahead.n + 1, id: pid, acc: s.acc, err: s.err, combo: s.combo, score: s.score };
}
async function topList(db, b) {                       // shared by every viewer: cached for a short while
  const cache = typeof caches !== 'undefined' ? caches.default : null, ck = cacheKey(b);
  if (cache) { const hit = await cache.match(ck); if (hit) return hit.json(); }
  const rows = (await db.prepare(`SELECT s.pid AS id, p.name, s.acc, s.err, s.combo, s.score FROM scores s JOIN players p ON p.id = s.pid
    WHERE s.board = ?1 AND s.hid = 0 ORDER BY s.key DESC, s.ts ASC LIMIT ${TOP}`).bind(b).all()).results.map((x, i) => ({ r: i + 1, ...x }));
  const out = { rows, total: await total(db, b) };
  if (cache) await cache.put(ck, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + BOARD_CACHE_S } }));
  return out;
}
