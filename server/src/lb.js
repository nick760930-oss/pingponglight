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
// - a new ticket names the player and works once (runs table); /lb/end closes a run that did not finish (failed or quit; a quit needs a quarter of the
//   song's length) and the challenge counts (tries table) feed some achievements; a legacy ticket (no player) only updates the best score and is
//   judged with the looser base limit; a new ticket also limits shields and star ranges to the power-ups that could have appeared;
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
import { bugAdmin, bugWipe } from './bugs.js';
import { withCos, shopWipe } from './cos.js';
import { achRecalc, logFeats, ftOf, rankOf, statsStmt } from './ach.js';

const DIFFS = 5, TICKET_MAX_MS = 3 * 3600e3, MAX_BODY = 16384, TOP = 100, HIDE_AT = 3, BOARD_CACHE_S = 30;
const MAX_ERR = 400, MISS = null;                      // ms; a missed beat is null in the log (0 = a miss the shield absorbed)
// Run tickets: new ones are song.d.ts.nonce.pid.sig (6 parts, single use, recorded in the runs table); old ones have 5 parts (no pid).
// A legacy ticket can still be used (it only updates the best score: no run count, no totals, no achievements). Set this to false to stop accepting them.
const LEGACY_TICKETS = true;
const END_MIN_MS = 10e3, FAIL_MIN_MS = 3e3, STAR_MAX = 50, RUNS_KEEP_MS = TICKET_MAX_MS;   // /lb/end: a quit must be at least 10 s old, a fail 3 s (missing every beat from the start ends the fastest charts after about 3.4 s); at most 50 star-time ranges per log
const LIFE0 = 30, DMG = [3, 4, 7, 2, 8], HEAL = [2, 1, 1, 0];   // game.js: opening life (= cap); damage per miss by difficulty index (DIFFS order, same as CHARTS); life a hit of tier 0..3 gives back
const TIER_MS = [45, 90, 150], TIER_W20 = [20, 16, 10, 5];   // integer tier weights (x20, a miss is 0): the sum does not depend on the order of the hits
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

// Star time (the x2 power-up): the phone sends the beat index ranges [[from, to), ...] that were played during it. A hit inside one must
// have earned at least the smallest doubled base, a hit outside one at most the largest undoubled base. Returns the ranges, or null when invalid.
export function parseStar(star, len) {
  if (star === undefined || star === null) return [];
  if (!Array.isArray(star) || star.length > STAR_MAX) return null;
  let prev = 0;
  for (const s of star) {
    if (!Array.isArray(s) || s.length !== 2 || !Number.isInteger(s[0]) || !Number.isInteger(s[1])) return null;
    if (s[0] < prev || s[1] <= s[0] || s[1] > len) return null;   // sorted, not overlapping, inside the log, at least one beat
    prev = s[1];
  }
  return star;
}

// How many power-ups a run can pick up at most (game.js: the first appears at 9 s, then one every 8 s at the earliest, +1 slack). Shields (0 entries) and star ranges
// each need one pickup, so neither can outnumber this. dur / spd is the song's length in seconds at that difficulty; the run lasts 3.8 s longer.
const itemCap = (song, d) => Math.max(1, 2 + Math.floor((CHARTS[song].dur / CHARTS[song].spd[d] + 3.8 - 9) / 8));

// One pass over a beat log (whole or partial). Each entry: null (a miss that cost life), 0 (a miss the shield absorbed: no life lost)
// or [timing error ms, base points]. Accuracy, score and combo follow the beat order. strict (new tickets): a hit outside star time may earn at most
// half the largest base; otherwise (legacy tickets, whose phones may not report star time) the full largest base. Returns null when an entry is malformed
// or earns more than a hit could.
function scan(d, log, segs, strict) {
  const L = log.length, inStar = new Uint8Array(L);
  for (const [a, b] of segs) for (let i = a; i < b; i++) inStar[i] = 1;
  const tiers = [0, 0, 0, 0]; let miss = 0, w = 0, sumAbs = 0, sum = 0, sum2 = 0, hits = 0, combo = 0, maxCombo = 0, score = 0, gold = 0, zeros = 0;
  const outMax = strict ? Q_MAX / 2 : Q_MAX;
  for (let i = 0; i < L; i++) {
    const x = log[i];
    if (x === MISS || x === 0) { miss++; combo = 0; if (x === 0) zeros++; continue; }
    if (!Array.isArray(x) || x.length !== 2) return null;
    const [e, base] = x;
    if (!Number.isInteger(e) || Math.abs(e) > MAX_ERR || !Number.isInteger(base)) return null;
    const a = Math.abs(e), t = a < TIER_MS[0] ? 0 : a < TIER_MS[1] ? 1 : a < TIER_MS[2] ? 2 : 3;
    const q = base / (100 * TIER_M[t]);
    if (inStar[i] ? (q < Q_MIN * 2 || q > Q_MAX) : (q < Q_MIN || q > outMax)) return null;   // more (or less) than this hit could earn
    tiers[t]++; w += TIER_W20[t]; hits++; sumAbs += a; sum += e; sum2 += e * e;
    combo = t <= 2 ? combo + 1 : 0; maxCombo = Math.max(maxCombo, combo);
    if (inStar[i] && combo >= 100) gold = 1;
    score += base + combo * 5;
  }
  let clean = 0;   // star ranges without a single miss
  for (const [a, b] of segs) { let c = 1; for (let i = a; i < b; i++) if (log[i] === MISS || log[i] === 0) { c = 0; break; } clean += c; }
  return { tiers, miss, w, sumAbs, sum, sum2, hits, maxCombo, score, gold, zeros, sg: segs.length, sc: clean };
}

// Life, replayed in the order the beats were settled (order = beat indices). Opening 30 (also the cap); a hit heals [2,1,1,0] by tier; a null costs the
// difficulty's damage; a 0 (shield) nothing. dead = position in the order where life first reached 0 (-1: never).
function lifeScan(d, log, order) {
  let life = LIFE0, lmin = LIFE0, dead = -1;
  for (let k = 0; k < order.length; k++) {
    const x = log[order[k]];
    if (x === MISS) life = Math.max(0, life - DMG[d]);
    else if (x !== 0) { const a = Math.abs(x[0]); life = Math.min(LIFE0, life + HEAL[a < TIER_MS[0] ? 0 : a < TIER_MS[1] ? 1 : a < TIER_MS[2] ? 2 : 3]); }
    if (life < lmin) lmin = life; if (life <= 0 && dead < 0) dead = k;
  }
  return { end: life, min: lmin, dead };
}

// The order beats were settled in (seq), for phones with several balls at once: a list of beat indices. A whole run: a permutation of 0..len-1; a failed run:
// distinct indices below len (the beats settled so far). Beat k-th settled can only be one of the beats within nb of k (nb = balls at that difficulty, game.js DIFFS).
// Without seq the order is the beat order. Returns the order, or null when invalid.
const NB = [1, 2, 2, 1, 3];
// how many star power-ups a log shows: with several balls beats can settle out of order, so one power-up may come out as ranges a beat or two apart; ranges closer than the number of balls count as one
const starCount = (segs, d) => segs.reduce((n, g, i) => n + (i && g[0] - segs[i - 1][1] < NB[d] ? 0 : 1), 0);
export function parseSeq(seq, d, len, whole) {
  if (seq === undefined || seq === null) return null;                       // (the caller decides what a missing one means)
  if (!Array.isArray(seq) || seq.length > len || (whole && seq.length !== len)) return false;
  const used = new Uint8Array(len);
  for (let k = 0; k < seq.length; k++) {
    const i = seq[k];
    if (!Number.isInteger(i) || i < 0 || i >= len || used[i] || Math.abs(i - k) >= NB[d]) return false;
    used[i] = 1;
  }
  return seq;
}

// Accuracy and the rest, recomputed from the beat log. Returns null when the log is malformed.
// A whole run whose life was ever <= 0 is still accepted (older phones), but r.life.dead >= 0 and its life achievements are not given.
// strict = a new ticket: the tighter base limit outside star time, the shield and star-range caps, and the settle order (seq) honoured.
export function judge(song, d, log, star, strict, seq) {
  const N = CHARTS[song].n[d];
  if (!Array.isArray(log) || log.length !== N) return null;
  const segs = parseStar(star, log.length); if (!segs) return null;
  const s = scan(d, log, segs, !!strict); if (!s || !s.hits) return null;
  // Checks that only guard achievements never refuse a run (they cannot affect the score): a bad seq or too many shields -> lifeBad (no life achievements);
  // too many star ranges -> starBad (no star achievements; the ranges still bound the base points above).
  let order = null, lifeBad = false, starBad = false;
  if (strict) {
    if (s.zeros > itemCap(song, d)) lifeBad = true;
    if (starCount(segs, d) > itemCap(song, d)) starBad = true;
    order = parseSeq(seq, d, N, true); if (order === false) { order = null; lifeBad = true; }
  }
  const life = lifeScan(d, log, order || Array.from({ length: N }, (_, i) => i));
  const { tiers, miss, w, sumAbs, sum, sum2, hits } = s;
  const mean = sum / hits, sd = Math.sqrt(Math.max(0, sum2 / hits - mean * mean)), err = Math.round(sumAbs / hits);
  const sus = hits >= 20 && (sumAbs / hits < 4 || sd < 3) ? 1 : 0;   // unusually steady: kept, but listed for review
  const acc = Math.floor(w * 500 / N);                           // basis points, integer arithmetic (w is x20): 9842 = 98.42 %; same formula as game.js bpOf
  const rank = rankOf(acc, miss, tiers[2], tiers[3]);
  const score = Math.min(SCORE_CAP, s.score);
  return { acc, err, maxCombo: s.maxCombo, miss, tiers, rank, sus, score, key: acc * 1e9 + score, life, lifeBad, starBad, sg: starBad ? 0 : s.sg, sc: starBad ? 0 : s.sc, gold: starBad ? 0 : s.gold };   // key < 2^53, exact in JS and SQLite
}

// A run that ended in failure (new tickets only, so always strict): the log has 1 to N beats. Life, replayed in settle order, must be above 0 until the
// last settled beat and reach 0 exactly there, and that beat is a real (unshielded) miss. With seq the log runs up to the highest settled beat; beats
// of it that were not settled yet are null placeholders and cost nothing. Without seq every beat of the log counts, in beat order.
export function failCheck(song, d, log, star, seq) {
  const N = CHARTS[song].n[d];
  if (!Array.isArray(log) || log.length < 1 || log.length > N) return false;
  const segs = parseStar(star, log.length); if (!segs) return false;
  const s = scan(d, log, segs, true);
  if (!s || s.zeros > itemCap(song, d) || starCount(segs, d) > itemCap(song, d)) return false;
  let order = parseSeq(seq, d, log.length, false);
  if (order === false) return false;
  if (order === null) order = Array.from({ length: log.length }, (_, i) => i);
  else {
    if (!order.length || Math.max(...order) !== log.length - 1) return false;   // the log ends at the highest settled beat
    const set = new Set(order); for (let i = 0; i < log.length; i++) if (!set.has(i) && log[i] !== MISS) return false;   // unsettled beats are null placeholders
  }
  const l = lifeScan(d, log, order);
  return l.dead === order.length - 1 && log[order[order.length - 1]] === MISS;
}

export async function handleLb(req, env, path, who, origin, H, limited) {
  const json = (o, s = 200, extra) => Response.json(o, { status: s, headers: { ...H, ...extra } });
  if (!env.LB || !env.LB_SECRET) return json({ error: 'off' }, 503);
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  // runs get their own budget, so browsing boards cannot use up the requests a finished run needs
  const bucket = path === '/lb/start' || path === '/lb/submit' || path === '/lb/end' ? 'lbr:' : 'lb:';
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

  if (path === '/lb/start') {                         // a signed ticket: song, difficulty, issue time (and the player, when the phone sent its key)
    const { song, d, pk } = body; if (!songOk(song, d)) return json({ error: 'song' }, 400);
    const nonce = hex(crypto.getRandomValues(new Uint8Array(8)));
    let pid = null;
    if (isPk(pk)) {                                   // a registered player gets a single-use ticket that names them; anyone else the old kind
      const pl = await db.prepare('SELECT id FROM players WHERE ph = ?1').bind(await sha(pk)).first();
      if (pl) {
        try {
          await db.batch([db.prepare('INSERT INTO runs (nonce, pid, song, d, ts, done) VALUES (?1, ?2, ?3, ?4, ?5, 0)').bind(nonce, pl.id, song, d, now),
            db.prepare('DELETE FROM runs WHERE nonce IN (SELECT nonce FROM runs WHERE ts < ?1 LIMIT 50)').bind(now - RUNS_KEEP_MS)]);   // tickets older than their lifetime are gone anyway
          pid = pl.id;
        } catch (e) { pid = null; }                   // e.g. the migration is not applied yet: fall back to the old ticket
      }
    }
    const p = [song, d, now, nonce, ...(pid === null ? [] : [pid])].join('.');
    return json({ run: p + '.' + await hmac(env.LB_SECRET, p) });
  }

  if (path === '/lb/submit') {
    const { run, pk, log } = body;
    if (typeof run !== 'string' || run.length > 200 || !isPk(pk)) return json({ error: 'bad' }, 400);
    const tk = await readTicket(env, run); if (!tk || (tk.legacy && !LEGACY_TICKETS)) return json({ error: 'ticket' }, 400);
    const { song, d, issued } = tk;
    const c = CHARTS[song], minMs = c.dur / c.spd[d] * 900;
    if (!(now - issued >= minMs && now - issued <= TICKET_MAX_MS)) return json({ error: 'ticket' }, 400);
    const r = judge(song, d, log, body.star, !tk.legacy, body.seq); if (!r) return json({ error: 'log' }, 400);
    const b = board(song, d), pf = ['web', 'ios', 'android'].includes(body.pf) ? body.pf : 'web';
    const pl = await db.prepare('SELECT id, hidden FROM players WHERE ph = ?1').bind(await sha(pk)).first();
    if (!pl) return json({ error: 'noname' }, 400);
    if (!tk.legacy) {                                 // a new ticket is used once, and only by the player it was issued to
      if (tk.pid !== pl.id || !(await useRun(db, tk.nonce))) return json({ error: 'ticket' }, 400);
    }
    const prev = await db.prepare('SELECT key FROM scores WHERE board = ?1 AND pid = ?2').bind(b, pl.id).first();
    const seen = await db.prepare('SELECT 1 FROM scores WHERE pid = ?1 AND board LIKE ?2').bind(pl.id, song + '-%').first();   // any difficulty of this song cleared before? (越級者)
    const improved = !prev || r.key > prev.key, F = logFeats(log, CHARTS[song].n[d]);
    // the run count (n: 百回, 迴聲) only grows with a new, single-use ticket; a legacy ticket only updates the best score (a new row then starts at 0)
    const bump = tk.legacy ? 0 : 1;
    if (improved) await db.prepare(`INSERT INTO scores (board, pid, key, acc, err, combo, ts, hid, log, pf, sus, score, ft, n) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
      ON CONFLICT(board, pid) DO UPDATE SET key = ?3, acc = ?4, err = ?5, combo = ?6, ts = ?7, log = ?9, pf = ?10, sus = ?11, score = ?12, ft = ?13, n = n + ?14`)
      .bind(b, pl.id, r.key, r.acc, r.err, r.maxCombo, now, pl.hidden, JSON.stringify(log), pf, r.sus, r.score, ftOf(F, r.acc), bump).run();
    else if (bump) await db.prepare('UPDATE scores SET n = n + 1 WHERE board = ?1 AND pid = ?2').bind(b, pl.id).run();
    if (improved) await dropCache(b);
    const me = await myRank(db, b, pl.id);
    // achievements (src/ach.js): the try counts, running totals, then whatever this run and the player's records earn; a failure here never costs the player their score
    let ach = [];
    if (!tk.legacy) try {
      const pt = await db.prepare('SELECT fails FROM tries WHERE pid = ?1 AND song = ?2 AND d = ?3').bind(pl.id, song, d).first();   // fails before this run (屢敗屢戰)
      await bumpTries(db, pl.id, song, d, 0).run();
      await statsStmt(db, pl.id, F).run();
      const life = r.life, R = { d, acc: r.acc, maxCombo: F.maxCombo, r: r.rank, fc: F.fc, pr: F.pr, f5: F.f5, l5: F.l5, ec: F.ec, fm: F.fm,
        lok: life.dead < 0 && !r.lifeBad ? 1 : 0, lend: life.end, lmin: life.min, sg: r.sg, sc: r.sc, gold: r.gold, pfail: pt ? pt.fails : 0 };   // single-run achievements only exist for a new ticket
      ach = (await achRecalc(db, pl.id, now, { song, d, R, first: !seen }, false)).fresh;
    } catch (e) {}
    return json({ ok: true, improved, acc: r.acc, err: r.err, score: r.score, rank: r.rank, me, total: await total(db, b), ach });
  }

  if (path === '/lb/end') {                           // a run that did not finish: { run, pk, kind: 'fail' | 'quit', log (fail only), star }
    const { run, pk, kind } = body;
    if (typeof run !== 'string' || run.length > 200 || !isPk(pk) || (kind !== 'fail' && kind !== 'quit')) return json({ error: 'bad' }, 400);
    const tk = await readTicket(env, run); if (!tk || tk.legacy) return json({ error: 'ticket' }, 400);
    const cc = CHARTS[tk.song], minEnd = kind === 'fail' ? FAIL_MIN_MS : Math.max(END_MIN_MS, cc.dur / cc.spd[tk.d] * 250);   // a quit: at least a quarter of the song's length
    if (!(now - tk.issued >= minEnd && now - tk.issued <= TICKET_MAX_MS)) return json({ error: 'ticket' }, 400);
    if (kind === 'fail' && !failCheck(tk.song, tk.d, body.log, body.star, body.seq)) return json({ error: 'log' }, 400);
    const pl = await db.prepare('SELECT id FROM players WHERE ph = ?1').bind(await sha(pk)).first();
    if (!pl) return json({ error: 'noname' }, 400);
    if (tk.pid !== pl.id || !(await useRun(db, tk.nonce))) return json({ error: 'ticket' }, 400);
    await bumpTries(db, pl.id, tk.song, tk.d, kind === 'fail' ? 1 : 0).run();
    let ach = []; try { ach = (await achRecalc(db, pl.id, now, null, false)).fresh; } catch (e) {}
    return json({ ok: true, ach });
  }

  if (path === '/lb/board') {
    const { song, d, pk } = body; if (!songOk(song, d)) return json({ error: 'song' }, 400);
    const b = board(song, d), top = await topList(db, env, b);
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
    const bug = await bugAdmin(db, body, json); if (bug) return bug;   // bug reports: 'bugs', 'bugimg', 'bugdone'
    if (body.op === 'flagged') return json({ rows: (await db.prepare(`SELECT s.board, s.pid AS id, p.name, s.acc, s.err, s.pf, s.ts
      FROM scores s JOIN players p ON p.id = s.pid WHERE s.sus = 1 ORDER BY s.ts DESC LIMIT 200`).all()).results });
    if (body.op === 'run') { if (!Number.isInteger(id)) return json({ error: 'bad' }, 400); const x = await db.prepare('SELECT acc, err, combo, score, pf, ts, log FROM scores WHERE board = ?1 AND pid = ?2').bind(String(body.board), id).first(); return json({ run: x }); }
    if (body.op === 'reports') return json({ rows: (await db.prepare(`SELECT p.id, p.name, p.hidden, COUNT(r.by) AS n, MAX(r.ts) AS last
      FROM reports r JOIN players p ON p.id = r.pid GROUP BY p.id ORDER BY n DESC LIMIT 200`).all()).results });
    if (body.op === 'dmreports') return json({ rows: (await db.prepare(`SELECT r.id, r.rp, a.name AS rpname, r.target, p.name, r.mid, r.body, r.ts, r.status, r.verdict,
      m.strikes, m.until FROM freports r LEFT JOIN players p ON p.id = r.target LEFT JOIN players a ON a.id = r.rp LEFT JOIN fmutes m ON m.pid = r.target
      ${body.status ? 'WHERE r.status = ?1' : ''} ORDER BY r.ts DESC LIMIT 200`).bind(...(body.status ? [String(body.status)] : [])).all()).results });
    if (!Number.isInteger(id)) return json({ error: 'bad' }, 400);
    if (body.op === 'hide' || body.op === 'unhide') { await setHidden(db, id, body.op === 'hide' ? 1 : 0); if (body.op === 'unhide') await db.prepare('DELETE FROM reports WHERE pid = ?1').bind(id).run(); return json({ ok: true }); }
    if (body.op === 'delete') { await wipe(db, id); return json({ ok: true }); }
    if (body.op === 'unmute') { await db.prepare('UPDATE fmutes SET until = 0, strikes = MAX(strikes - pts, 0) WHERE pid = ?1').bind(id).run(); return json({ ok: true }); }   // id = player: overrule the AI's last decision (ts is kept, so more reports about the same messages do not mute again)
    if (body.op === 'mute') { const d = Number.isInteger(body.days) && body.days > 0 && body.days <= 3650 ? body.days : 7, now = Date.now();
      await db.prepare('INSERT INTO fmutes (pid, strikes, until, ts, pts) VALUES (?1, 1, ?2, ?3, 1) ON CONFLICT (pid) DO UPDATE SET strikes = strikes + 1, until = ?2, ts = ?3, pts = 1').bind(id, now + d * 86400e3, now).run(); return json({ ok: true }); }
    // report: relabel one report (id = report). 'new' sends it to the AI again; 'upheld'/'clear' only record a decision
    // (to act by hand use 'mute' / 'unmute'; the reported messages are kept in the report body)
    if (body.op === 'report') { const st =['clear', 'upheld', 'review', 'new'].includes(body.status) ? body.status : null; if (!st) return json({ error: 'bad' }, 400);   // id = report
      await db.prepare('UPDATE freports SET status = ?2, tries = 0, verdict = CASE WHEN verdict LIKE \'%(人工)\' THEN verdict ELSE COALESCE(verdict, \'\') || \' (人工)\' END WHERE id = ?1').bind(id, st).run(); return json({ ok: true }); }
    return json({ error: 'op' }, 400);
  }
  return json({ error: 'not found' }, 404);
}

// A ticket: song.d.ts.nonce.sig (legacy) or song.d.ts.nonce.pid.sig. Returns null when it is malformed or the signature is wrong.
async function readTicket(env, run) {
  const parts = run.split('.'); if (parts.length !== 5 && parts.length !== 6) return null;
  const legacy = parts.length === 5, sig = parts.pop(), [song, ds, ts, nonce, ps] = parts, d = +ds, issued = +ts;
  if (!legacy && !(/^\d{1,15}$/.test(ps) && /^[0-9a-f]{16}$/.test(nonce))) return null;
  if (!same(sig, await hmac(env.LB_SECRET, parts.join('.'))) || !songOk(song, d)) return null;
  return { song, d, issued, nonce, legacy, pid: legacy ? null : +ps };
}
const useRun = async (db, nonce) => { const r = await db.prepare('UPDATE runs SET done = 1 WHERE nonce = ?1 AND done = 0').bind(nonce).run(); return !!(r && r.meta && r.meta.changes === 1); };   // false: used already (or never issued)
const bumpTries = (db, pid, song, d, fail) => db.prepare('INSERT INTO tries (pid, song, d, ends, fails) VALUES (?1, ?2, ?3, 1, ?4) ON CONFLICT(pid, song, d) DO UPDATE SET ends = ends + 1, fails = fails + ?4').bind(pid, song, d, fail);
const cacheKey = b => new Request('https://lb.cache/' + encodeURIComponent(b));
async function dropCache(b) { try { if (typeof caches !== 'undefined') await caches.default.delete(cacheKey(b)); } catch (e) {} }
async function wipe(db, id) {                         // a player and everything about them; their boards refresh at once
  const bs = (await db.prepare('SELECT board FROM scores WHERE pid = ?1').bind(id).all()).results;
  await db.batch([db.prepare('DELETE FROM scores WHERE pid = ?1').bind(id), db.prepare('DELETE FROM reports WHERE pid = ?1').bind(id),
    ...friendWipe(db, id), ...bugWipe(db, id), ...shopWipe(db, id), db.prepare('DELETE FROM players WHERE id = ?1').bind(id)]);
  for (const t of ['runs', 'tries']) { try { await db.prepare('DELETE FROM ' + t + ' WHERE pid = ?1').bind(id).run(); } catch (e) {} }   // (each on its own: a database without migration 0010 must still delete the account)
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
async function topList(db, env, b) {                       // shared by every viewer: cached for a short while
  const cache = typeof caches !== 'undefined' ? caches.default : null, ck = cacheKey(b);
  if (cache) { const hit = await cache.match(ck); if (hit) return hit.json(); }
  const rows = (await db.prepare(`SELECT s.pid AS id, p.name, s.acc, s.err, s.combo, s.score FROM scores s JOIN players p ON p.id = s.pid
    WHERE s.board = ?1 AND s.hid = 0 ORDER BY s.key DESC, s.ts ASC LIMIT ${TOP}`).bind(b).all()).results.map((x, i) => ({ r: i + 1, ...x }));
  const out = { rows: await withCos(db, env, rows), total: await total(db, b) };
  if (cache) await cache.put(ck, new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=' + BOARD_CACHE_S } }));
  return out;
}
