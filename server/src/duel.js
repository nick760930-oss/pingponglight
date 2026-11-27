// Duel results the server decides (see docs/design/ach-duel-spec.md). Pure functions: no I/O except the two D1 helpers at the end.
//
// Every seat that is signed in sends its beat log once at the end of its round ({"t":"lg"}, arena.js). duelJudge recomputes score, accuracy, combo
// and a "points per hit" figure (q) from it. At the end of the round Arena asks `ordering` for the result screen (everything from the recomputed
// values), then `settle` turns the round into the rows that the achievements read (duels, duelp; src/ach.js duelFacts).
//
// What a phone can still lie about is the same as on the leaderboard (a log that looks plausible but was never played). What this adds:
// - the sprint (the last fifth of the song, every hit worth x2) only loosens the base limit for the beats it really applies to;
// - q (the mean of base / the most a hit of that tier earns at speed 1) is compared across the seats of one round: a seat far above the others is "sus"
//   and its win does not count;
// - a round only counts when at least 2 seats are valid (signed in, not duplicated, a log of at least 30 % of the song, or a 30 % loser that left).
import { CHARTS } from './charts.js';
import { rankOf } from './ach.js';
import { scan, lifeScan, itemCap, starCount, parseStar, parseSeq, NB, TIER_M, tierAt, SCORE_CAP } from './lb.js';

export const LG_MAX = 16384;                 // a beat-log message, characters and bytes
export const MIN_FRAC = .3;                  // a seat needs this share of the beats settled to be valid
export const SPRINT_FRAC = .8;               // game.js: from 80 % of the beats resolved, every hit is worth x2
export const CG_DAY = 30, WIN_PAIR_DAY = 3, OPP_SONGS = 3;
export const SUS_ABS = 300, SUS_REL = 2;     // q above SUS_ABS and above SUS_REL x the median of the other valid seats' q (see the report: measured against game.js speeds)
const DAY_MS = 86400000, TZ_MS = 8 * 3600e3;
export const dayOf = ts => Math.floor((ts + TZ_MS) / DAY_MS);    // Taiwan day number
export const sprintAt = (N, d) => Math.max(0, Math.floor(N * SPRINT_FRAC) - NB[d]);


// One seat's log, whole (N entries) or partial (1..N: it ended early). seq = the order beats were settled in (like the leaderboard's).
// Returns null when the log is not acceptable; otherwise
//   { s score, acc basis points (over N for a whole log, over the settled beats for a partial one), mc max combo, fc full combo, ok whole log and life never reached 0,
//     n settled beats, hit hits, q, t90 score up to beat floor(.9N) (beat order), rk rank }
export function duelJudge(song, d, log, star, seq) {
  const c = CHARTS[song]; if (!c || !Number.isInteger(d) || d < 0 || d >= 5) return null;
  const N = c.n[d];
  if (!Array.isArray(log) || log.length < 1 || log.length > N) return null;
  const segs = parseStar(star, log.length); if (!segs) return null;
  const sp = sprintAt(N, d), s = scan(d, log, segs, true, sp); if (!s) return null;
  if (s.zeros > itemCap(song, d) || starCount(segs, d) > itemCap(song, d)) return null;
  const whole = log.length === N;
  let order = parseSeq(seq, d, log.length, whole);
  if (order === false) return null;
  if (order === null) order = Array.from({ length: log.length }, (_, i) => i);
  else if (!whole) {                                                          // a partial log ends at the highest settled beat; the others are null placeholders
    if (!order.length || Math.max(...order) !== log.length - 1) return null;
    const set = new Set(order); for (let i = 0; i < log.length; i++) if (!set.has(i) && log[i] !== null) return null;
  }
  const life = lifeScan(d, log, order), nb = NB[d], lo = Math.floor(N * SPRINT_FRAC) - nb, hi = Math.floor(N * SPRINT_FRAC) + nb, cut = Math.floor(N * .9);
  const inStar = new Uint8Array(log.length); for (const [a, b] of segs) for (let i = a; i < b; i++) inStar[i] = 1;
  let combo = 0, t90 = 0, qs = 0, qn = 0;
  for (let i = 0; i < log.length; i++) {
    const x = log[i];
    if (x === null || x === 0) { combo = 0; continue; }
    const t = tierAt(d, Math.abs(x[0]));
    combo = t <= 2 ? combo + 1 : 0;
    if (i < cut) t90 += x[1] + combo * 5;
    if (i >= lo && i <= hi) continue;                                         // around the sprint border it is not clear which beats were doubled
    qs += x[1] / (100 * TIER_M[t] * (inStar[i] ? 2 : 1) * (i > hi ? 2 : 1)); qn++;
  }
  const n = order.length, acc = Math.floor(s.w * 500 / (whole ? N : Math.max(1, n))), ok = whole && life.dead < 0 ? 1 : 0;
  return { s: Math.min(SCORE_CAP, s.score), acc, mc: s.maxCombo, fc: whole && s.maxCombo === N ? 1 : 0, ok, n, hit: s.hits, q: qn ? Math.round(qs / qn * 100) : 0,
    t90: Math.min(SCORE_CAP, t90), rk: rankOf(acc, s.miss, s.tiers[2], s.tiers[3]) };
}
// the {"t":"lg","log":[...],"star":[...],"seq":[...]} message -> { log, star, seq } (null: malformed)
export function parseLg(msg) {
  let d; try { d = JSON.parse(msg); } catch (e) { return null; }
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.t !== 'lg' || !Array.isArray(d.log)) return null;
  return { log: d.log, star: d.star, seq: d.seq };
}

const median = a => { const b = a.slice().sort((x, y) => x - y), k = b.length; return !k ? 0 : k % 2 ? b[(k - 1) >> 1] : (b[k / 2 - 1] + b[k / 2]) / 2; };

// ---- the round's result screen and who is valid (no database needed) ----
// round = { at, song, di, id, kind, host, seats: [{ i, pid, dup? }], fr0 }; recs = [{ i, name, cos, fin, vr, n, s, off }]
//   fin = what the seat reported, vr = duelJudge's result for its log (null: none), n = settled beats of its last 'st', s = its last score, off = it left.
// Returns { rows: [{ i, name, cos, s, ok, acc (0..1), rank, mc, v }] in result order, seatInfo: Map(i -> { place, eff, valid, pid, vr }), valid: valid seats, counts: the round is worth writing }
export function ordering(round, recs, now) {
  const c = CHARTS[round.song], N = c ? c.n[round.di] : 0, need = N * MIN_FRAC;
  const snap = new Map(((round && round.seats) || []).map(x => [x.i, x]));
  const eff = recs.map(r => {
    const vr = r.vr || null; let o;
    if (vr) o = { s: vr.s, ok: !!(r.fin && r.fin.ok && vr.ok), acc: vr.acc / 10000, rank: null, mc: vr.mc };
    else if (r.fin) o = { s: r.fin.s, ok: !!r.fin.ok, acc: r.fin.acc, rank: r.fin.rank, mc: r.fin.mc };
    else o = { s: r.s || 0, ok: false, acc: 0, rank: '—', mc: 0 };
    if (vr) o.rank = o.ok ? vr.rk : '—';
    const sn = snap.get(r.i), pid = sn && !sn.dup && sn.pid ? sn.pid : 0;
    const valid = !!pid && (vr ? vr.n >= need : (!r.fin && !!r.off && (r.n || 0) >= need));   // no log: only a seat that left without finishing (a legacy phone with a fin is never valid)
    const grp = r.fin ? (o.ok ? 0 : 1) : (r.off ? 3 : 2);
    return { r, o, vr, pid, valid, grp };
  });
  eff.sort((a, b) => a.grp - b.grp || b.o.s - a.o.s || a.r.i - b.r.i);
  const valid = eff.filter(e => e.valid).length;
  const dur = c ? c.dur / c.spd[round.di] * 900 : Infinity;
  const counts = valid >= 2 && now - round.at >= dur;
  const seatInfo = new Map(eff.map((e, k) => [e.r.i, { place: k + 1, eff: e.o, valid: e.valid, pid: e.pid, vr: e.vr, fin: e.r.fin, off: !!e.r.off, n: e.r.n || 0, ls: e.r.s || 0 }]));
  return { rows: eff.map(e => ({ i: e.r.i, name: e.r.name, cos: e.r.cos, ...e.o, v: counts && e.valid ? 1 : 0 })), seatInfo, valid, counts, N };
}

// What a settled round needs from the database (settle's `facts`):
//   games: Map(pid -> rounds that counted today)   wins: Map('x:y' -> rounds x won (cw) today in which y was also valid)
//   songs: Map(pid -> distinct songs with a leaderboard score)   pairs: Set('a:b', a < b: friends now)
export const pk = (x, y) => Math.min(x, y) + ':' + Math.max(x, y);
// -> { duel, rows } to write (the duels row and the duelp rows), or null when the round does not count. log1 = the first place's log message.
export function settle(round, ord, facts, now, log1) {
  if (!ord.counts) return null;
  const { seatInfo, N } = ord, V = [...seatInfo.entries()].filter(([, s]) => s.valid).map(([i, s]) => ({ i, ...s }));
  const nv = V.length, today = k => facts.games.get(k) || 0;
  const withLog = V.filter(s => s.vr);
  // qualified opponent: 3+ songs on the leaderboard and either a log covering 30% hits, or (no log) left the room after settling 30% of the beats with a last score above 0
  const qualified = s => (facts.songs.get(s.pid) || 0) >= OPP_SONGS && (s.vr ? s.vr.hit >= N * MIN_FRAC : (!s.fin && s.off && s.n >= N * MIN_FRAC && s.ls > 0));
  const rows = V.map(s => {
    const others = V.filter(x => x.i !== s.i), vr = s.vr, ok = s.eff.ok ? 1 : 0;
    const cg = today(s.pid) < CG_DAY ? 1 : 0;
    const medOthers = median(others.filter(x => x.vr).map(x => x.vr.q));
    const sus = vr && vr.q > SUS_ABS && others.some(x => x.vr) && vr.q > SUS_REL * medOthers ? 1 : 0;
    const cw = cg && s.place === 1 && ok && !sus && nv >= 2 && others.some(x => qualified(x) && (facts.wins.get(s.pid + ':' + x.pid) || 0) < WIN_PAIR_DAY) ? 1 : 0;
    const fr = others.filter(x => facts.pairs.has(pk(s.pid, x.pid))).length;
    const eq = ok && vr && others.some(x => x.eff.ok && x.vr && x.vr.acc === vr.acc) ? 1 : 0;
    const cb = vr && ok && withLog.length >= 3 && s.place === 1 && withLog.every(x => x.i === s.i || x.vr.t90 > vr.t90) ? 1 : 0;
    const s8 = round.seats.length === 8 && nv - 1 >= 6 ? 1 : 0;
    const snapOthers = round.seats.filter(x => x.i !== s.i), fr0 = new Set(round.fr0 || []);
    const f8 = s8 && snapOthers.length === 7 && snapOthers.every(x => x.pid && !x.dup && fr0.has(pk(s.pid, x.pid))) ? 1 : 0;
    return { did: round.id, pid: s.pid, place: s.place, acc: vr ? vr.acc : 0, score: s.eff.s, ok, fc: ok && vr && vr.fc ? 1 : 0, q: vr ? vr.q : 0, sus, cg, cw, fr, eq, cb, s8, f8, qual: qualified(s) ? 1 : 0 };
  });
  const first = [...seatInfo.entries()].find(([, s]) => s.place === 1);
  const hostSeat = round.host;
  return { duel: { id: round.id, ts: now, day: dayOf(now), song: round.song, d: round.di, kind: round.kind, host: hostSeat || null, seats: round.seats.length, valid: nv, void: 0, log1: rows.some(r => r.place === 1) && log1 || null }, rows, first: first ? first[0] : -1 };
}

// ---- database: what settle needs, and the write ----
export async function duelFactsFor(db, round, ord, now) {
  const pids = [...new Set([...ord.seatInfo.values()].filter(s => s.valid).map(s => s.pid))], day = dayOf(now);
  const facts = { games: new Map(), wins: new Map(), songs: new Map(), pairs: new Set() };
  if (!pids.length) return facts;
  const q = pids.map((_, k) => '?' + (k + 2)).join(','), q1 = pids.map((_, k) => '?' + (k + 1)).join(',');
  const [g, w, s, f] = await db.batch([
    db.prepare(`SELECT p.pid, COUNT(*) AS n FROM duelp p JOIN duels d ON d.id = p.did WHERE d.day = ?1 AND d.void = 0 AND p.cg = 1 AND p.pid IN (${q}) GROUP BY p.pid`).bind(day, ...pids),
    db.prepare(`SELECT p.pid AS x, o.pid AS y, COUNT(*) AS n FROM duelp p JOIN duels d ON d.id = p.did JOIN duelp o ON o.did = p.did AND o.pid <> p.pid
      WHERE d.day = ?1 AND d.void = 0 AND p.cw = 1 AND p.pid IN (${q}) AND o.pid IN (${q}) GROUP BY p.pid, o.pid`).bind(day, ...pids),
    db.prepare(`SELECT pid, COUNT(DISTINCT substr(board, 1, length(board) - 2)) AS n FROM scores WHERE pid IN (${q1}) GROUP BY pid`).bind(...pids),
    db.prepare(`SELECT a, b FROM fships WHERE a IN (${q1}) AND b IN (${q1})`).bind(...pids),
  ]);
  for (const r of g.results) facts.games.set(r.pid, r.n);
  for (const r of w.results) facts.wins.set(r.x + ':' + r.y, r.n);
  for (const r of s.results) facts.songs.set(r.pid, r.n);
  for (const r of f.results) facts.pairs.add(pk(r.a, r.b));
  return facts;
}
export async function duelWrite(db, res) {
  const d = res.duel;
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO duels (id, ts, day, song, d, kind, host, seats, valid, void, log1) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)')
      .bind(d.id, d.ts, d.day, d.song, d.d, d.kind, d.host, d.seats, d.valid, d.log1),
    ...res.rows.map(r => db.prepare('INSERT OR IGNORE INTO duelp (did, pid, place, acc, score, ok, fc, q, sus, cg, cw, fr, eq, cb, s8, f8, qual) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)')
      .bind(r.did, r.pid, r.place, r.acc, r.score, r.ok, r.fc, r.q, r.sus, r.cg, r.cw, r.fr, r.eq, r.cb, r.s8, r.f8, r.qual)),
  ]);
}
