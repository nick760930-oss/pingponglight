// Achievements the server decides (the ones without a mark in the design catalog's ACH list).
//
// Everything is computed from data the server already verified: the leaderboard's scores table (one best run per song and
// difficulty, with its beat log), the number of accepted runs (scores.n), running totals (pstats), friends and the items
// earned so far. A phone can only ask the server to look again (/ach/sync); it cannot say what it has achieved, except for
// the ones marked "local": those are only recorded, and nothing other players can see is given for them.
// An achievement, once earned, is never taken back (the one exception: the 19 duel achievements a voided round no longer supports, see duelVoid) (achs rows stay; a row whose id is no longer in the list, e.g. the removed 四十九, is kept but ignored: no points, never listed), and its rewards are items in ents (src = 'ach').
//
// Achievement id = its name in the design list (achdata.js); the ten "星座完成" ones are <constellation name>完成, e.g. 古老旋律座完成.
// Run data beyond the beat log: a new single-use ticket (lb.js) also brings the run's star-time ranges and lets the server replay the
// life, and /lb/end records runs that failed or were quit (tries table: ends, fails per player, song and difficulty). With that the server
// decides 拾級而上, 試聽, 遍聽 (巡遍星空), 百折不撓, 屢敗屢戰, 一線生機, 不滅, 星光初拾, 星光全收 (星河盡收), 金色時刻 and 新曲嘗鮮.
// The single-run ones (the life ones, the star ones, 金色時刻, 屢敗屢戰) are only given at the submit of a new-ticket run; a run
// on a legacy ticket earns nothing. NA (not decidable, never granted) is empty now.
// The 21 duel and social achievements (DUEL_IDS) come from the rounds the Arena settled (src/duel.js -> duels, duelp: only valid, unvoided rounds count), the friends
// table (引路人) and the room invites the Arena recorded directly (邀約). See docs/design/ach-duel-spec.md.
import { ACHDATA } from './achdata.js';
import { CHARTS, CONS } from './charts.js';
import { CATALOG } from './catalog.js';
import { grantStmts } from './cos.js';

export const ACHS = {};
const CID = i => CONS[i][0] + '完成';                  // the ten "○○座完成" achievements: 古老旋律座完成 ... 霓虹座完成 (the names cosmetics.js uses)
// points of a "○○座完成" follow the number of songs of its constellation: up to 5 songs 10, 6 to 8 songs 15, 9 or more 20
const consPts = n => n <= 5 ? 10 : n <= 8 ? 15 : 20;
for (const [cat, tier, name, pts, chk, title] of ACHDATA) {
  if (name.startsWith('○○座完成')) { for (let i = 0; i < 10; i++) ACHS[CID(i)] = { cat, tier, pts: consPts(CONS[i][1].length), chk, title: 0 }; continue; }
  ACHS[name] = { cat, tier, pts, chk, title };
}
// not decidable on the server: left out of every sync, shown as "coming soon" by the app
export const NA = [];
// Songs added after the App was released (the 新曲嘗鮮 list): put their keys here. While it is empty nobody can earn 新曲嘗鮮, but the achievement is open.
export const NEW_SONGS = [];
const isServer = id => ACHS[id] && ACHS[id].chk === 's' && !NA.includes(id);
export const SERVER_IDS = Object.keys(ACHS).filter(isServer);
export const LOCAL_IDS = Object.keys(ACHS).filter(id => ACHS[id].chk === 'l');

// Rewards come from the catalog (cosmetics.js): an item whose how is ach:<id> (titles, achievement-only items; a theme brings its parts)
// or whose also is ach:<id> (bought items that this achievement gives for free too).
// HOLD: achievements whose catalogue items are not released yet (the art is waiting for approval): they give points only.
// The items are already in cosmetics.js with how = ach:<id>; to release them, remove the id from HOLD (the sync the app sends at every start then
// gives them to everybody who already earned the achievement) and fix the reward text in the design catalogue.
const HOLD = [];
const REW = {};
for (const [item, it] of Object.entries(CATALOG)) for (const h of [it.how, it.also]) if (h && h.startsWith('ach:') && !HOLD.includes(h.slice(4))) (REW[h.slice(4)] = REW[h.slice(4)] || []).push(item);
export const rewardsOf = id => ACHS[id] ? REW[id] || [] : [];
// the "限定" items (only obtainable by achievement) that some server-decided achievement gives; 秘藏 and 萬象 count them
export const LIM = SERVER_IDS.flatMap(rewardsOf).filter(x => CATALOG[x].lim);

// ---- constellations ----
const NORM = CONS.filter(c => !c[2]), RW = CONS.filter(c => c[2]);   // 10 regular constellations (71 songs), 6 reward ones
const NORM_SONGS = NORM.flatMap(c => c[1]);
const RW_DI = [3, 0, 1, 2, 4];                                          // 初聲 入門, 鄉謠 簡單, 名曲 普通, 疾風 困難, 炫技 專家 (game.js DIFFS order); 至高 = 專家 with S

// ---- one run, in detail ----
const TIER_MS = [45, 90, 150];
export function logFeats(log, N) {                     // log: the validated beat log (null = missed, 0 = missed but the shield held, [error ms, base points])
  let combo = 0, mx = 0, run = 0, pr = 0, miss = 0, perf = 0, good = 0, ok = 0, f5 = N >= 50 ? 1 : 0, l5 = N >= 50 ? 1 : 0;
  for (let i = 0; i < log.length; i++) {
    const x = log[i]; let t = 4;
    if (x === null || x === 0) miss++; else { const a = Math.abs(x[0]); t = a < TIER_MS[0] ? 0 : a < TIER_MS[1] ? 1 : a < TIER_MS[2] ? 2 : 3; }
    if (t === 2) good++; else if (t === 3) ok++;
    combo = t <= 2 ? combo + 1 : 0; if (combo > mx) mx = combo;
    run = t === 0 ? run + 1 : 0; if (run > pr) pr = run;
    if (t === 0) perf++;
    if (t !== 0 && i < 50) f5 = 0;
    if (t !== 0 && i >= N - 50) l5 = 0;
  }
  return { miss, good, ok, maxCombo: mx, hits: N - miss, perf, pr, f5, l5, ec: combo, fm: log[0] === null || log[0] === 0 ? 1 : 0, fc: mx === N ? 1 : 0 };
}
// Nine ranks, low to high. acc in basis points; miss / good (良好) / ok (尚可) are counts of the run.
//   SSS every beat perfect · SS acc>=9800, no miss, no good, no ok · S acc>=9500, no miss, no ok · A 9000 · B 8000 · C 7000 · D 6000 · E 5000 · F rest
// good / ok left out (rows that only have a stored accuracy): the old rule, so at most S.
export const RANKS = ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];
export const rankIdx = r => RANKS.indexOf(r);          // -1 for anything else (e.g. the old '—')
export const atLeastS = r => rankIdx(r) >= 6;
export const atLeastA = r => rankIdx(r) >= 5;          // A is 90 % accuracy (rankOf): 起步 A and 五顆 A use the same rank as the result screen
export function rankOf(acc, miss, good, ok) {
  const known = good !== undefined && ok !== undefined;
  if (acc >= 10000 && known && !miss && !good && !ok) return 'SSS';
  if (acc >= 9800 && known && !miss && !good && !ok) return 'SS';
  if (acc >= 9500 && !miss && (!known || !ok)) return 'S';
  return acc >= 9000 ? 'A' : acc >= 8000 ? 'B' : acc >= 7000 ? 'C' : acc >= 6000 ? 'D' : acc >= 5000 ? 'E' : 'F';
}
export const ftOf = (F, acc) => JSON.stringify({ r: rankOf(acc, F.miss, F.good, F.ok), fc: F.fc, pr: F.pr, f5: F.f5, l5: F.l5, ec: F.ec, fm: F.fm });
const parseFt = s => { try { const o = JSON.parse(s); return o && typeof o === 'object' ? o : null; } catch (e) { return null; } };

// achievements one run can earn by itself. R = { d, acc, maxCombo, r (rank), fc, pr, f5, l5, ec, fm }, and for a run on a new ticket
// also { lok (life never <= 0), lend (life at the end), lmin (lowest life), sg (star ranges), sc (star ranges without a miss), gold, pfail (fails of this chart before the run) }
export function singles(R) {
  const out = [], hard = R.d === 2 || R.d === 4;
  const add = (c, id) => { if (c) out.push(id); };
  add(atLeastA(R.r), '起步 A'); add(atLeastS(R.r), '第一顆 S'); add(R.acc >= 9500, '九成準'); add(R.acc >= 9900, '九成九');
  add(R.acc === 10000, '零誤差'); add(R.acc === 10000 && hard, '分毫不差'); add(R.pr >= 100, '百發百中');
  add(R.maxCombo >= 20, '二十連'); add(R.maxCombo >= 50, '五十連'); add(R.maxCombo >= 100, '彩虹橋'); add(R.maxCombo >= 200, '長虹'); add(R.maxCombo >= 400, '千鈞一線');
  add(R.fc, '一氣呵成'); add(R.f5, '完美開場'); add(R.l5, '完美收尾'); add(R.fm, '出師不利');
  add(R.lok && R.lend < 3, '一線生機');                                   // finished with less than 10 % of the 30 life (only when the life was never gone)
  add(R.lok && R.lmin === 1 && atLeastA(R.r), '不滅');
  add(R.sc >= 1, '星光初拾'); add(R.sg >= 1 && R.sc === R.sg, '星光全收'); add(R.gold, '金色時刻');
  add(R.pfail >= 5, '屢敗屢戰');
  return out;
}

// ---- duel and social achievements ----
export const DUEL_IDS = ['初次交手', '熱身賽', '擂台常駐', '百戰', '首勝', '初露鋒芒', '凱旋曲', '常勝樂章', '同台', '再會', '知音', '最終樂章', '八方之冠', '全場最佳',
  '開張', '指揮家', '引路人', '好夥伴', '合奏團', '八音和鳴', '邀約'];
export const DUEL_CALC = DUEL_IDS.filter(x => x !== '邀約' && x !== '引路人');       // the ones the duel tables can decide again (邀約 is only recorded by the Arena, 引路人 reads the friends table: a void never takes those back)
const DUEL_ZERO = { cg: 0, cw: 0, beat: 0, again: 0, same: 0, eq: 0, cb: 0, s8w: 0, s8fc: 0, host: 0, fr1: 0, fr2: 0, f8: 0, guide: 0 };
// What one player's valid, unvoided rounds add up to (one batch). A database without migration 0011 (or any failure) reads as zeros.
export async function duelFacts(db, pid, strict) {   // strict: a failure is thrown instead of read as zeros (voiding a round must not take achievements away because of a database error)
  try {
    const [a, b, c, g] = await db.batch([
      db.prepare(`SELECT COALESCE(SUM(p.cg), 0) AS cg, COALESCE(SUM(p.cw), 0) AS cw,
          COALESCE(MAX(p.cg AND d.valid >= 4), 0) AS same, COALESCE(MAX(p.cg AND p.eq), 0) AS eq, COALESCE(MAX(p.cg AND p.cb), 0) AS cb,
          COALESCE(MAX(p.cw AND p.s8), 0) AS s8w, COALESCE(MAX(p.cw AND p.s8 AND p.fc), 0) AS s8fc,
          COALESCE(SUM(p.cg AND d.kind = 'room' AND d.host = p.pid), 0) AS host, COALESCE(SUM(p.cg AND p.fr >= 1), 0) AS fr1,
          COALESCE(SUM(p.cg AND d.valid >= 4 AND p.fr >= 2), 0) AS fr2, COALESCE(MAX(p.cg AND p.f8), 0) AS f8
        FROM duelp p JOIN duels d ON d.id = p.did WHERE p.pid = ?1 AND d.void = 0`).bind(pid),
      db.prepare(`SELECT COUNT(DISTINCT o.pid) AS n FROM duelp p JOIN duels d ON d.id = p.did JOIN duelp o ON o.did = p.did AND o.pid <> p.pid AND o.qual = 1
        WHERE p.pid = ?1 AND p.cw = 1 AND d.void = 0`).bind(pid),
      db.prepare(`SELECT COUNT(*) AS n FROM duelp p JOIN duels d ON d.id = p.did JOIN duelp o ON o.did = p.did AND o.pid <> p.pid
        WHERE p.pid = ?1 AND p.cg = 1 AND d.void = 0 GROUP BY o.pid ORDER BY n DESC LIMIT 1`).bind(pid),
      db.prepare(`SELECT 1 AS x FROM fships f WHERE f."by" = ?1 AND f.fresh = 1 AND EXISTS (SELECT 1 FROM scores s WHERE s.pid = CASE WHEN f.a = ?1 THEN f.b ELSE f.a END) LIMIT 1`).bind(pid),
    ]);
    const r = a.results[0] || {};
    return { ...DUEL_ZERO, ...r, beat: (b.results[0] || {}).n || 0, again: (c.results[0] || {}).n || 0, guide: g.results.length ? 1 : 0 };
  } catch (e) { if (strict) throw e; return { ...DUEL_ZERO }; }
}
export function duelEval(f) {
  const E = [], add = (c, id) => { if (c) E.push(id); };
  add(f.cg >= 1, '初次交手'); add(f.cg >= 10, '熱身賽'); add(f.cg >= 50, '擂台常駐'); add(f.cg >= 200, '百戰');
  add(f.cw >= 1, '首勝'); add(f.cw >= 10 && f.beat >= 3, '初露鋒芒'); add(f.cw >= 50 && f.beat >= 10, '凱旋曲'); add(f.cw >= 200 && f.beat >= 20, '常勝樂章');
  add(f.same, '同台'); add(f.again >= 3, '再會'); add(f.eq, '知音'); add(f.cb, '最終樂章'); add(f.s8w, '八方之冠'); add(f.s8fc, '全場最佳');
  add(f.host >= 1, '開張'); add(f.host >= 30, '指揮家'); add(f.guide, '引路人'); add(f.fr1 >= 20, '好夥伴'); add(f.fr2 >= 10, '合奏團'); add(f.f8, '八音和鳴');
  return E;
}
// Admin (lb.js /lb/admin): 'duels' = the last 200 rounds, 'duel' { did } = one round with its rows and the winner's log, 'duelvoid' { did } = take the round back.
// Voiding is the only time an achievement is taken back: for every player of that round the 19 DUEL_CALC achievements are decided again from the remaining
// rounds; the ones no longer supported lose their achs row and the items they gave (ents with src = 'ach' and that achievement as ref); a worn item that is
// gone goes back to the default. Every other achievement stays.
export async function duelAdmin(db, body, json) {
  if (body.op !== 'duels' && body.op !== 'duel' && body.op !== 'duelvoid') return null;
  try { return await duelAdminRun(db, body, json); }
  catch (e) { return json({ error: 'nodb' }, 500); }   // no duels / duelp tables (migration 0011 not applied): an error answer, never an exception
}
async function duelAdminRun(db, body, json) {
  if (body.op === 'duels') return json({ rows: (await db.prepare(`SELECT d.id, d.ts, d.song, d.d, d.kind, d.seats, d.valid, d.void, p.pid, n.name, p.q, p.sus
    FROM duels d LEFT JOIN duelp p ON p.did = d.id AND p.place = 1 LEFT JOIN players n ON n.id = p.pid ORDER BY d.ts DESC LIMIT 200`).all()).results });
  if (body.op === 'duel' || body.op === 'duelvoid') {
    if (typeof body.did !== 'string' || body.did.length > 64) return json({ error: 'bad' }, 400);
    if (body.op === 'duel') {
      const d = await db.prepare('SELECT * FROM duels WHERE id = ?1').bind(body.did).first(); if (!d) return json({ error: 'nodata' }, 404);
      const rows = (await db.prepare('SELECT p.*, n.name FROM duelp p LEFT JOIN players n ON n.id = p.pid WHERE p.did = ?1 ORDER BY p.place').bind(body.did).all()).results;
      return json({ duel: d, rows });
    }
    const r = await duelVoid(db, body.did); if (!r) return json({ error: 'nodata' }, 404);
    return json({ ok: true, ...r });
  }
  return null;
}
export async function duelVoid(db, did) {
  if (!(await db.prepare('SELECT 1 FROM duels WHERE id = ?1').bind(did).first())) return null;
  await db.prepare('UPDATE duels SET void = 1 WHERE id = ?1').bind(did).run();
  const pids = (await db.prepare('SELECT pid FROM duelp WHERE did = ?1').bind(did).all()).results.map(r => r.pid), revoked = [];
  for (const pid of pids) {
    const still = new Set(duelEval(await duelFacts(db, pid, true)));
    const have = (await db.prepare('SELECT ach FROM achs WHERE pid = ?1 AND loc = 0').bind(pid).all()).results.map(r => r.ach).filter(id => DUEL_CALC.includes(id));
    const lose = have.filter(id => !still.has(id)); if (!lose.length) continue;
    const st = [], items = new Set();
    for (const id of lose) {
      st.push(db.prepare('DELETE FROM achs WHERE pid = ?1 AND ach = ?2 AND loc = 0').bind(pid, id), db.prepare(`DELETE FROM ents WHERE pid = ?1 AND src = 'ach' AND ref = ?2`).bind(pid, id));
      for (const it of rewardsOf(id).flatMap(x => CATALOG[x] ? [x, ...CATALOG[x].parts] : [])) items.add(it);
      revoked.push({ pid, ach: id });
    }
    await db.batch(st);
    for (const it of items) for (const slot of ['avatar', 'plate', 'title'])   // a worn item that is not owned any more: back to the default
      await db.prepare(`UPDATE players SET ${slot} = '' WHERE id = ?1 AND ${slot} = ?2 AND NOT EXISTS (SELECT 1 FROM ents e WHERE e.pid = ?1 AND e.item = ?2)`).bind(pid, it).run();
  }
  return { players: pids.length, revoked };
}

const splitBoard = b => { const i = b.lastIndexOf('-'); return [b.slice(0, i), +b.slice(i + 1)]; };
const count = (set, n) => set.size >= n;

// everything the stored data says is earned (ids). rows: [{ song, d, acc, combo, n, R }]
function evaluate(rows, ps, friends, extra, tries) {
  const E = new Set(extra || []);
  const add = (c, id) => { if (c) E.add(id); };
  const song = new Map();                               // song -> Map(d -> row)
  const byD = [0, 1, 2, 3, 4].map(() => new Set());
  let clears = 0, A = 0, S = 0, FC = 0, FCH = 0, FC4 = 0, FLAWLESS = 0;
  for (const r of rows) {
    if (!song.has(r.song)) song.set(r.song, new Map());
    song.get(r.song).set(r.d, r); byD[r.d].add(r.song); clears += r.n;
    for (const id of singles(r.R)) E.add(id);
    if (atLeastA(r.R.r)) A++; if (atLeastS(r.R.r)) S++;
    if (r.R.fc) { FC++; if (r.d === 2 || r.d === 4) FCH++; if (r.d === 4) FC4++; }
    if (r.acc === 10000 && (r.d === 2 || r.d === 4)) FLAWLESS++;
  }
  const cleared = new Set(song.keys());
  add(cleared.size >= 1, '新星'); add(cleared.size >= 3, '起程'); add(cleared.size >= 5, '暖身'); add(cleared.size >= 10, '拾音');
  add(cleared.size >= 20, '小有心得'); add(cleared.size >= 30, '星軌'); add(cleared.size >= 50, '追光人');
  add(NORM_SONGS.filter(k => cleared.has(k)).length >= 36, '半程'); add(NORM_SONGS.every(k => cleared.has(k)), '七十一夜');
  add(clears >= 100, '百回'); add(clears >= 1000, '千回百轉');
  let maxRepeat = 0; for (const m of song.values()) { let t = 0; for (const r of m.values()) t += r.n; if (t > maxRepeat) maxRepeat = t; }
  add(maxRepeat >= 3, '再來一次'); add(maxRepeat >= 20, '迴聲');
  // difficulty (game.js DIFFS: 0 簡單, 1 普通, 2 困難, 3 入門, 4 專家)
  add(count(byD[3], 10), '入門結業'); add(count(byD[0], 10), '簡單上手'); add(count(byD[1], 1), '普通入門'); add(count(byD[2], 1), '初探困難');
  add(count(byD[1], 20), '穩拍'); add(count(byD[2], 10), '逆風'); add(count(byD[2], 40), '疾風勁草'); add(count(byD[4], 1), '三光初現'); add(count(byD[4], 10), '三光並行');
  add(byD.every(s => s.size >= 5), '五階遊歷'); add(byD.every(s => s.size >= 20), '五線全能');
  let two = false, five = false; for (const m of song.values()) { if (m.size >= 2) two = true; if (m.size >= 5) five = true; }
  add(two, '換個難度'); add(five, '五弦俱全');
  let steps = false; for (const m of song.values()) if ([...m.values()].filter(r => atLeastA(r.R.r)).length >= 3) steps = true;
  add(steps, '拾級而上');                                                         // one song with 3 different difficulties at A or better
  // challenge records: every song with a try (tries) or a best score (scores)
  const tried = new Set(cleared); let sumEnds = new Map();
  for (const t of tries || []) { tried.add(t.song); sumEnds.set(t.song, (sumEnds.get(t.song) || 0) + t.ends); }
  add(tried.size >= 10, '試聽'); add(NORM_SONGS.every(k => tried.has(k)), '遍聽');
  add([...sumEnds.values()].some(n => n >= 30), '百折不撓');                      // one song, any difficulty, 30 runs ended
  add(NEW_SONGS.length >= 5 && NEW_SONGS.filter(k => cleared.has(k)).length >= 5, '新曲嘗鮮');
  // constellations
  let lit = 0, done = 0, three = false;
  NORM.forEach(([, keys], i) => {
    const c = keys.filter(k => cleared.has(k)).length;
    if (c > 0) lit++;
    if (c >= 3) three = true;                                                      // 第一顆星: 3 songs of one constellation
    add(keys.length && c * 2 >= keys.length, '半座');
    if (keys.length && c === keys.length) { done++; E.add(CID(i)); }
    for (let d = 0; d < 5; d++) if (keys.length && keys.every(k => { const r = song.has(k) && song.get(k).get(d); return r && atLeastS(r.R.r); })) E.add('一座皆 S');
  });
  const at = (k, d) => song.has(k) && song.get(k).get(d);
  const upTo = (keys, ds) => keys.every(k => ds.some(d => at(k, d)));     // every song cleared on one of these difficulties (0 簡單, 1 普通, 2 困難, 3 入門, 4 專家)
  add(three, '第一顆星'); add(lit >= 3, '連星'); add(done >= 5, '星座旅人');
  add(upTo(NORM[3][1], [2, 4]), '墨上聽潮');                                      // 浪漫座, all songs on 困難 or 專家
  add(upTo(NORM_SONGS, [1, 2, 4]), '摘星者');                                     // all 71 songs on 普通 or higher
  add(NORM.some(([, keys]) => keys.length && keys.every(k => at(k, 4))), '超新星'); // one regular constellation entirely on 專家
  add(NORM_SONGS.every(k => at(k, 3)), '初聲'); add(NORM_SONGS.every(k => at(k, 0)), '鄉謠'); add(NORM_SONGS.every(k => at(k, 1)), '名曲');
  add(NORM_SONGS.every(k => at(k, 2)), '疾風'); add(NORM_SONGS.every(k => at(k, 4)), '炫技');
  add(NORM_SONGS.every(k => { const r = at(k, 4); return r && atLeastS(r.R.r); }), '至高');
  add(RW.every(([, keys, o]) => keys.every(k => at(k, o.di))), '拾遺');
  // 天籟: the 10 regular constellations complete (any difficulty) and all 6 reward constellations risen (their six unlocking achievements)
  add(done >= NORM.length && ['初聲', '鄉謠', '名曲', '疾風', '炫技', '至高'].every(x => E.has(x)), '天籟');
  // grades and streaks
  add(A >= 5, '五顆 A'); add(S >= 10, '拾星'); add(S >= 30, '繁星滿袖'); add(S >= 100, '滿天星斗');
  add(FC >= 10, '十全'); add(FC >= 30, '流星雨'); add(FCH >= 10, '全連擊大師'); add(FC4 >= 10, '三光無缺'); add(FLAWLESS >= 10, '絕對音準');
  add(NORM_SONGS.every(k => [2, 4].some(d => { const r = at(k, d); return r && atLeastS(r.R.r); })), '不朽樂章');
  add(ps.hits >= 1000, '千擊'); add(ps.hits >= 10000, '萬擊'); add(ps.hits >= 100000, '十萬光年'); add(ps.perf >= 100, '百次完美');
  add(friends >= 1, '雙星相遇'); add(friends >= 3, '三五好友'); add(friends >= 10, '朋友圈');
  return E;
}
// the collection achievements look at the items earned by achievements (cosmetics only: no titles); 初得 is decided on the phone (first time an achievement item is worn)
function collection(owned) {
  const E = [], cos = [...owned].filter(x => !x.startsWith('title.')), lim = LIM.filter(x => owned.has(x));
  const badge = x => /^avatar\.cons\d$/.test(x);
  if (cos.length >= 5) E.push('小有收藏'); if (cos.length >= 25) E.push('珍藏家');
  if (cos.filter(badge).length >= 8) E.push('徽章半冊');
  if (lim.filter(x => !badge(x)).length >= 5) E.push('秘藏'); if (lim.length === LIM.length) E.push('萬象');   // 秘藏 does not count the constellation badges
  return E;
}

// Fill in scores.ft for old rows (from the stored beat log); returns the rows with their run details.
async function loadRows(db, pid) {
  const raw = (await db.prepare('SELECT board, acc, combo, n, ft FROM scores WHERE pid = ?1').bind(pid).all()).results, rows = [];
  // rows without ft: read their stored beat logs in a few queries and write the results back in one batch (not one query per row)
  const need = raw.filter(x => { const [song, d] = splitBoard(x.board); return !x.ft && CHARTS[song] && d >= 0 && d < 5; }).slice(0, 100), made = new Map(), upd = [];
  for (let i = 0; i < need.length; i += 20) {
    const part = need.slice(i, i + 20), q = part.map((_, k) => '?' + (k + 2)).join(',');
    const logs = (await db.prepare(`SELECT board, log FROM scores WHERE pid = ?1 AND board IN (${q})`).bind(pid, ...part.map(x => x.board)).all()).results;
    for (const l of logs) {
      const x = part.find(y => y.board === l.board), [song, d] = splitBoard(l.board), c = CHARTS[song];
      let log = null; try { log = JSON.parse(l.log); } catch (e) {}
      if (Array.isArray(log) && log.length === c.n[d]) {
        const F = logFeats(log, c.n[d]), ft = parseFt(ftOf(F, x.acc)); made.set(l.board, ft);
        upd.push(db.prepare('UPDATE scores SET ft = ?3 WHERE board = ?1 AND pid = ?2').bind(l.board, pid, JSON.stringify(ft)));
      }
    }
  }
  for (let i = 0; i < upd.length; i += 90) await db.batch(upd.slice(i, i + 90));
  for (const x of raw) {
    const [song, d] = splitBoard(x.board), c = CHARTS[song]; if (!c || !(d >= 0 && d < 5)) continue;
    let ft = x.ft ? parseFt(x.ft) : made.get(x.board) || null;
    if (!ft) ft = { r: rankOf(x.acc, 1), fc: 0, pr: 0, f5: 0, l5: 0, ec: 0, fm: 0 };   // no log to read: nothing beyond the columns is claimed
    rows.push({ song, d, acc: x.acc, combo: x.combo, n: x.n, R: { d, acc: x.acc, maxCombo: x.combo, r: ft.r, fc: ft.fc === 1 || x.combo === c.n[d] ? 1 : 0, pr: ft.pr, f5: ft.f5, l5: ft.l5, ec: ft.ec, fm: ft.fm } });
  }
  return rows;
}

// Looks at everything again and records what is new. run = the run that was just accepted (lb.js submit):
// { song, d, R, first } adds what that single run earned even when it was not the player's best.
// Returns { fresh: ids newly earned, ids: every server-decided achievement the player has }.
// ensure = also re-give the rewards of everything already earned (the sync the app sends once at every start; submit only gives new ones).
// more = ids the caller has already verified (邀約, recorded by the Arena): treated as earned.
export async function achRecalc(db, pid, now, run, ensure, more) {
  const [rows, ps, fr, have, own, tr, df] = await Promise.all([
    loadRows(db, pid),
    db.prepare('SELECT hits, perf FROM pstats WHERE pid = ?1').bind(pid).first(),
    db.prepare('SELECT (SELECT COUNT(*) FROM fships WHERE a = ?1) + (SELECT COUNT(*) FROM fships WHERE b = ?1) AS n').bind(pid).first(),
    db.prepare('SELECT ach FROM achs WHERE pid = ?1 AND loc = 0').bind(pid).all(),
    db.prepare(`SELECT item FROM ents WHERE pid = ?1 AND src = 'ach'`).bind(pid).all(),
    db.prepare('SELECT song, ends FROM tries WHERE pid = ?1').bind(pid).all().catch(() => ({ results: [] })),   // (an older database without the table: no records)
    duelFacts(db, pid),                                 // (an older database without the duel tables: zeros)
  ]);
  const had = new Set(have.results.map(x => x.ach).filter(id => ACHS[id])), owned = new Set(own.results.map(x => x.item));
  const extra = [...(run ? [...singles(run.R), ...(run.first && (run.d === 2 || run.d === 4) ? ['越級者'] : [])] : []), ...(more || []), ...duelEval(df)];
  const earned = new Set([...evaluate(rows, ps || { hits: 0, perf: 0 }, fr ? fr.n : 0, extra, tr.results)].filter(isServer));
  for (const x of had) earned.add(x);
  const fresh = [], give = id => {
    const st = [];
    if (!had.has(id)) { st.push(db.prepare('INSERT OR IGNORE INTO achs (pid, ach, ts, loc) VALUES (?1, ?2, ?3, 0)').bind(pid, id, now)); had.add(id); fresh.push(id); }
    st.push(...grantStmts(db, pid, rewardsOf(id), 'ach', id, now)); for (const it of rewardsOf(id).flatMap(x => CATALOG[x] ? [x, ...CATALOG[x].parts] : [])) owned.add(it);
    return st;
  };
  const st = [];
  for (const id of earned) if (ensure || !had.has(id)) st.push(...give(id));
  for (let pass = 0; pass < 3; pass++) {               // collection achievements depend on the rewards just given
    const more = collection(owned).filter(id => isServer(id) && !had.has(id));
    if (!more.length) break;
    for (const id of more) st.push(...give(id));
  }
  for (let i = 0; i < st.length; i += 90) await db.batch(st.slice(i, i + 90));
  return { fresh, ids: [...had] };
}

// the phone says it decided these ("local" achievements): only recorded; unknown or server-decided ids are ignored
export async function achLocal(db, pid, ids, now) {
  const ok = [...new Set(ids)].filter(id => typeof id === 'string' && ACHS[id] && ACHS[id].chk === 'l').slice(0, 60);
  for (let i = 0; i < ok.length; i += 90) await db.batch(ok.slice(i, i + 90).map(id => db.prepare('INSERT OR IGNORE INTO achs (pid, ach, ts, loc) VALUES (?1, ?2, ?3, 1)').bind(pid, id, now)));
  return ok;
}
export async function achList(db, pid) {
  const rows = (await db.prepare('SELECT ach, ts, loc FROM achs WHERE pid = ?1 ORDER BY ts').bind(pid).all()).results;
  const list = rows.filter(r => ACHS[r.ach]).map(r => ({ id: r.ach, ts: r.ts, l: r.loc }));
  return { list, pts: list.reduce((s, r) => s + ACHS[r.id].pts, 0) };
}
// a player's best combo and cumulative totals after an accepted run (lb.js submit)
export const statsStmt = (db, pid, F) => db.prepare('INSERT INTO pstats (pid, hits, perf) VALUES (?1, ?2, ?3) ON CONFLICT(pid) DO UPDATE SET hits = hits + ?2, perf = perf + ?3').bind(pid, F.hits, F.perf);
