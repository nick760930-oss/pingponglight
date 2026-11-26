// Levels, experience and light energy (光能). Everything is computed here, never on the phone: the phone only says which
// multiplier (m, 1..4) it wants when a run starts. The constants below are the ones the game copies (docs: 等級光能實作規格).
//
// - A player is a row of prog keyed by ph (SHA-256 of the phone's key), so players without a nickname have progress too.
// - A run is settled once: /lb/submit and /lb/end first take the ticket with useRun (an atomic UPDATE), then call settle().
//   settle() itself is a compare-and-set on the prog row (retried), so two runs finishing together cannot lose or double an update.
// - Light is kept as three pools: nat (natural, refills 1 per 6 minutes up to a cap), sub (monthly-pass gifts) and paid (bought).
//   Spending takes nat first, then sub, then paid. sub and paid have no cap and never expire. Nothing here can go below 0.
// - In-app light purchases (light.s / .m / .l and the monthly pass) are granted by lightTx(), called from iap.js.
import { CHARTS } from './charts.js';
import { CATALOG } from './catalog.js';
import { grantStmts } from './cos.js';

export const XP_BASE = [30, 45, 70, 20, 90];            // by difficulty index (DIFFS order: 簡單 普通 困難 入門 專家)
export const MULT_COST = { 1: 0, 2: 5, 3: 10, 4: 15 };
export const LIGHT_CAP = 60, PASS_CAP = 120, LIGHT_MS = 360000, DAY_SPEND_CAP = 200, HALF_AFTER_S = 3600, NEED_FLAT = 40492;
export const DAY_SHIFT_MS = 4 * 3600e3, DAY_MS = 86400e3;
export const dayOf = now => Math.floor((now + DAY_SHIFT_MS) / DAY_MS);   // the game day turns over at 04:00 Taiwan time
export const needAt = n => n >= 100 ? NEED_FLAT : 100 + 12 * n + 4 * n * n;   // experience from level n to n + 1 (Lv100 on: flat)
export const lenF = (song, d) => { const c = CHARTS[song]; return Math.max(0.6, Math.min(1.5, c.dur / c.spd[d] / 120)); };
export const playSecs = (song, d) => CHARTS[song].dur / CHARTS[song].spd[d];
export const xpClear = (song, d, acc, mult, half) => Math.round(XP_BASE[d] * (0.5 + 0.5 * acc / 10000) * lenF(song, d) * mult * half);
export const xpFail = (song, d, accSo, frac, half) => Math.round(XP_BASE[d] * (0.5 + 0.5 * accSo) * lenF(song, d) * frac * 0.5 * half);

// products (store id -> what it gives)
export const LIGHT_PRODUCTS = {
  'com.nocticat.pingponglight.light.s': { id: 'light.s', pts: 90, pool: 'paid', type: 'Consumable' },
  'com.nocticat.pingponglight.light.m': { id: 'light.m', pts: 300, pool: 'paid', type: 'Consumable' },
  'com.nocticat.pingponglight.light.l': { id: 'light.l', pts: 1080, pool: 'paid', type: 'Consumable' },
  // the 30-day light pass: a consumable (no renewal). It adds 30 x quantity pending days (prog.pleft); each game day 30 light goes to the pass pool by itself (accrue()).
  // pts = 900 is the value of one pass (the Sandbox cap counts it whole); it is not given at once.
  'com.nocticat.pingponglight.pass': { id: 'pass', pts: 900, pool: 'sub', type: 'Consumable', alt: 'Non-Renewing Subscription', pass: true },   // alt: a second StoreKit type accepted for the pass (in case App Review asks for it)
};
export const PASS_DAYS = 30, PASS_DAILY = 30, SBX_CAP = 3000, MAX_QTY = 10, OVERLAP_SLACK_MS = 2000;   // SBX_CAP: most light a player's Sandbox purchases can ever give
// wrong settings (purchases on while the free test period is still on): every request is refused. ALLOW_LOCAL=1 (local development and the tests, never set in production) is exempt.
export const misconfigured = env => env.IAP_ON === '1' && env.SHOP_TEST === '1' && env.ALLOW_LOCAL !== '1';

export function levelOf(xp) {
  xp = Math.max(0, Math.floor(xp) || 0);
  let lv = 1;
  while (lv < 100) { const n = needAt(lv); if (xp < n) return { lv, cur: xp, need: n }; xp -= n; lv++; }
  const k = Math.floor(xp / NEED_FLAT);
  return { lv: 100 + k, cur: xp - k * NEED_FLAT, need: NEED_FLAT };
}

// level rewards: catalog items whose how is 'lv:N' (sorted by N); the catalog may have none yet
let LV_ITEMS = null;
export function lvItems() {
  if (LV_ITEMS) return LV_ITEMS;
  const m = new Map();
  for (const [id, it] of Object.entries(CATALOG)) { const x = /^lv:(\d{1,4})$/.exec(it.how || ''); if (x) { const n = +x[1]; if (!m.has(n)) m.set(n, []); m.get(n).push(id); } }
  return LV_ITEMS = [...m.entries()].sort((a, b) => a[0] - b[0]);
}
export const titleOf = lv => { let t = ''; for (const [n, ids] of lvItems()) { if (n > lv) break; for (const id of ids) if (id.startsWith('title.')) t = id; } return t; };

// ---- light ----
export const capOf = (row, now) => row.pass > now ? PASS_CAP : LIGHT_CAP;
// the natural pool brought up to date: { nat, nts, cap }. Above the cap (the pass ran out) nothing is taken away, it just stops refilling.
export function lightAt(row, now) {
  const cap = capOf(row, now); let nat = row.nat, nts = row.nts;
  if (nat < cap) {
    const k = Math.max(0, Math.floor((now - nts) / LIGHT_MS));
    if (k > 0) { if (nat + k >= cap) { nat = cap; nts = now; } else { nat += k; nts += k * LIGHT_MS; } }
  }
  return { nat, nts, cap };
}
function lightObj(row, now) {
  const L = lightAt(row, now), today = dayOf(now);
  return { nat: L.nat, sub: row.sub, paid: row.paid, total: L.nat + row.sub + row.paid, cap: L.cap,
    next: L.nat >= L.cap ? 0 : Math.max(0, Math.min(LIGHT_MS, L.nts + LIGHT_MS - now)), spent: row.day === today ? row.dspend : 0, dayCap: DAY_SPEND_CAP,
    pday: row.pleft };   // pday: how many daily pass payouts are still to come (whole days; 0 = none). Today's has already been paid when the state is built.
}
// the state object the game shows
export function lvState(row, now) {
  const L = levelOf(row.xp), today = dayOf(now), dsec = row.day === today ? row.dsec : 0;
  return { lv: L.lv, xp: row.xp, cur: L.cur, need: L.need, star: L.lv > 100 ? L.lv - 100 : 0, title: titleOf(L.lv), light: lightObj(row, now),
    pass: row.pass > now ? row.pass : 0, dsec, half: dsec >= HALF_AFTER_S, mult: row.mult };
}

export const getProg = (db, ph) => db.prepare('SELECT * FROM prog WHERE ph = ?1').bind(ph).first();
export async function ensureProg(db, ph, now) {
  await db.prepare('INSERT OR IGNORE INTO prog (ph, nts, created, day) VALUES (?1, ?2, ?2, ?3)').bind(ph, now, dayOf(now)).run();
  return accrue(db, ph, now);
}
// The pass pays 30 light into the pass pool for every game day (04:00 Taiwan) while pending days are left, whether or not the player opens the game: whoever reads the row
// first catches up. k = min(pending days, today - the last paid day); pleft -= k, pday = today, sub += 30 k, one lightlog row for the production days (pass_day) and one for the Sandbox days (sbx_pass_day), if any. The UPDATE carries the old
// pleft and pday, so two readers at once pay once (the loser re-reads and finds nothing owed). -> the row (null: none)
export async function accrue(db, ph, now) {
  for (let i = 0; i < 6; i++) {
    const row = await getProg(db, ph); if (!row || !(row.pleft > 0)) return row;
    const today = dayOf(now), k = Math.min(row.pleft, today - row.pday); if (!(k > 0)) return row;
    const prodLeft = row.pleft - Math.min(row.psbx, row.pleft), kp = Math.min(k, prodLeft), ks = k - kp;   // the production days are paid first, then the Sandbox ones
    const res = await db.batch([
      db.prepare('UPDATE prog SET sub = sub + ?2, pleft = pleft - ?3, pday = ?4, psbx = psbx - ?7 WHERE ph = ?1 AND pleft = ?5 AND pday = ?6 AND psbx = ?8').bind(ph, PASS_DAILY * k, k, today, row.pleft, row.pday, ks, row.psbx),
      db.prepare(`INSERT INTO lightlog (ph, ts, kind, pool, amt, ref) SELECT ?1, ?2, 'pass_day', 'sub', ?3, '' WHERE changes() = 1 AND ?3 > 0
        UNION ALL SELECT ?1, ?2, 'sbx_pass_day', 'sub', ?4, '' WHERE changes() = 1 AND ?4 > 0`).bind(ph, now, PASS_DAILY * kp, PASS_DAILY * ks),
    ]);
    if (res[0].meta && res[0].meta.changes === 1) return getProg(db, ph);
  }
  return getProg(db, ph);
}
// state for a key hash (creates the row), or null when the table is not there yet
export async function progState(db, ph, now, create = true) {
  try { const row = create ? await ensureProg(db, ph, now) : await accrue(db, ph, now); return row ? lvState(row, now) : null; } catch (e) { return null; }
}

// items of the level rewards from level `after` (exclusive) up to `upto`
const rewardIds = (after, upto) => lvItems().filter(([n]) => n > after && n <= upto).flatMap(([, ids]) => ids);
const rewardStmts = (db, pid, after, upto, now) => lvItems().filter(([n]) => n > after && n <= upto).flatMap(([n, ids]) => grantStmts(db, pid, ids, 'lv', String(n), now));
// a player who just registered a nickname gets every reward their level already earned (idempotent)
export async function lvBackfill(db, ph, pid, now) {
  const row = await getProg(db, ph); if (!row) return;
  const lv = levelOf(row.xp).lv, st = rewardStmts(db, pid, 0, lv, now);
  st.push(db.prepare('UPDATE prog SET lvr = MAX(lvr, ?2) WHERE ph = ?1').bind(ph, lv));
  await db.batch(st);
}
// registered players: hand out what an earlier settle did not (e.g. the player was anonymous when the level was reached)
export async function lvCatchUp(db, ph, pid, now) {
  const row = await getProg(db, ph); if (!row) return;
  const lv = levelOf(row.xp).lv; if (row.lvr >= lv) return;
  const st = rewardStmts(db, pid, row.lvr, lv, now); st.push(db.prepare('UPDATE prog SET lvr = MAX(lvr, ?2) WHERE ph = ?1').bind(ph, lv));
  await db.batch(st);
}

// Settle one finished run. o: { song, d, kind: 'clear' | 'fail' | 'quit' | 'duel', m, acc (clear / duel: basis points), accSo (fail: 0..1), frac (fail: settled beats / N),
//   mult (duel: the duel multiplier), start (ms the run began: a run that began before the last settled run ended earns nothing), noxp (this ticket was replaced by a newer one: nothing) }.
// pid > 0 for a registered player (level rewards are granted at once), 0 for an anonymous one (granted when they register).
// Returns the state plus { gain, base, used, cost, from, ups, rewards }, or null when the player has no row / the table is missing.
export async function settle(db, ph, pid, now, o) {
  try { await ensureProg(db, ph, now); } catch (e) { return null; }
  for (let attempt = 0; attempt < 6; attempt++) {
    const row = await getProg(db, ph); if (!row) return null;
    const today = dayOf(now), dsec0 = row.day === today ? row.dsec : 0, dsp0 = row.day === today ? row.dspend : 0, half = dsec0 >= HALF_AFTER_S ? 0.5 : 1;
    const L = lightAt(row, now), from = levelOf(row.xp);
    let gain = 0, base = 0, used = 1, cost = 0, secs = 0, mult = row.mult, kind = o.kind;
    // a ticket a newer one replaced (o.noxp), or a run that started before the last experience run ended: no experience, no light
    // Overlap = the two time spans [lst, len] (the last run) and [start, end] (this one) cross, each shortened by the slack. A single run ends at now; a duel round at the end of the song
    // (the server settles it later). A run that began after the last one ended, or ended before it began, is not an overlap. lst = 0 (unknown): only the end of the last run counts.
    const myEnd = o.kind === 'duel' && o.start ? Math.min(now, o.start + Math.round(playSecs(o.song, o.d) * 1000)) : now;
    if (kind !== 'quit' && (o.noxp || (o.start && row.len > o.start + OVERLAP_SLACK_MS && (!row.lst || row.lst < myEnd - OVERLAP_SLACK_MS)))) kind = 'quit';
    if (kind === 'clear') {
      const m = Number.isInteger(o.m) && o.m >= 1 && o.m <= 4 ? o.m : 1, total = L.nat + row.sub + row.paid;
      for (used = m; used > 1; used--) if (MULT_COST[used] <= total && dsp0 + MULT_COST[used] <= DAY_SPEND_CAP) break;   // the highest multiplier that can be paid for (x1 is free)
      cost = MULT_COST[used]; mult = m;
      gain = xpClear(o.song, o.d, o.acc, used, half); base = xpClear(o.song, o.d, o.acc, 1, half); secs = playSecs(o.song, o.d);
    } else if (kind === 'duel') {                              // a duel round the server judged: x2..x3.5, no light spent
      gain = base = xpClear(o.song, o.d, o.acc, o.mult, half); secs = playSecs(o.song, o.d);
    } else if (kind === 'fail') {
      gain = base = xpFail(o.song, o.d, Math.max(0, Math.min(1, o.accSo)), Math.max(0, Math.min(1, o.frac)), half); secs = playSecs(o.song, o.d) * Math.max(0, Math.min(1, o.frac));
    }
    gain = Math.max(0, gain); base = Math.max(0, base);
    const n = { xp: row.xp + gain, nat: L.nat, nts: L.nts, sub: row.sub, paid: row.paid, day: today, dsec: dsec0 + Math.round(secs), dspend: dsp0 + cost };
    const spend = { nat: 0, sub: 0, paid: 0 };
    if (cost > 0) {
      let left = cost;
      spend.nat = Math.min(left, n.nat); left -= spend.nat; spend.sub = Math.min(left, n.sub); left -= spend.sub; spend.paid = Math.min(left, n.paid); left -= spend.paid;
      if (left > 0) continue;                                  // cannot happen (checked above), but never go below 0
      if (spend.nat > 0 && L.nat >= L.cap) n.nts = now;        // leaving a full pool: the refill clock starts now
      n.nat -= spend.nat; n.sub -= spend.sub; n.paid -= spend.paid;
    }
    const to = levelOf(n.xp), ups = []; for (let k = from.lv + 1; k <= to.lv && ups.length < 200; k++) ups.push(k);
    const next = { ...row, ...n, mult };
    const res = { ...lvState(next, now), gain, base, used, cost, from: { lv: from.lv, cur: from.cur, need: from.need }, ups, rewards: rewardIds(from.lv, to.lv) };
    if (kind === 'quit') return res;                           // nothing to write
    const w = await db.prepare(`UPDATE prog SET xp = ?2, nat = ?3, nts = ?4, sub = ?5, paid = ?6, day = ?7, dsec = ?8, dspend = ?9, mult = ?10, lst = ?19, len = ?20
      WHERE ph = ?1 AND xp = ?11 AND nat = ?12 AND nts = ?13 AND sub = ?14 AND paid = ?15 AND day = ?16 AND dsec = ?17 AND dspend = ?18 AND len = ?21`)
      .bind(ph, n.xp, n.nat, n.nts, n.sub, n.paid, n.day, n.dsec, n.dspend, mult, row.xp, row.nat, row.nts, row.sub, row.paid, row.day, row.dsec, row.dspend, o.start || now, kind === 'duel' ? Math.max(row.len, Math.min(now, (o.start || now) + Math.round(secs * 1000))) : now, row.len).run();   // a duel round does not move the single-player clock (lst / len): its server settle time says nothing about when this player stopped
    if (!w.meta || w.meta.changes !== 1) continue;             // somebody else changed the row meanwhile: read it again
    const st = [];
    for (const p of ['nat', 'sub', 'paid']) if (spend[p] > 0) st.push(db.prepare(`INSERT INTO lightlog (ph, ts, kind, pool, amt, ref) VALUES (?1, ?2, 'spend', ?3, ?4, ?5)`).bind(ph, now, p, -spend[p], o.song + '.' + o.d));
    if (pid > 0 && to.lv > row.lvr) { st.push(...rewardStmts(db, pid, row.lvr, to.lv, now)); st.push(db.prepare('UPDATE prog SET lvr = MAX(lvr, ?2) WHERE ph = ?1').bind(ph, to.lv)); }
    if (st.length) { try { await db.batch(st); } catch (e) { /* the run is settled; a missing reward is repaired by lvCatchUp */ } }
    return res;
  }
  return null;
}

// ---- wipe ----
// everything about a key hash goes (the unspent bought light is only remembered, by hash, for a year: a purchase can still be refunded within 30 days)
export async function levelWipe(db, ph, now) {
  try {
    let row = await getProg(db, ph); const st = [];
    try { row = await accrue(db, ph, now) || row; } catch (e) {}   // pass days that are due are paid first
    // what is still owed to the player is remembered (by hash, a year): bought light, light from a pass not yet spent (sub), and the pass days not yet paid (pleft), for a manual compensation
    if (row && (row.paid > 0 || row.sub > 0 || row.pleft > 0)) st.push(db.prepare('INSERT INTO wiped (ph, ts, paid, sub, pleft) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(ph) DO UPDATE SET ts = ?2, paid = paid + ?3, sub = sub + ?4, pleft = pleft + ?5').bind(ph, now, row.paid, row.sub, row.pleft));
    st.push(db.prepare('DELETE FROM prog WHERE ph = ?1').bind(ph), db.prepare('DELETE FROM lightlog WHERE ph = ?1').bind(ph), db.prepare('DELETE FROM runs WHERE ph = ?1 AND pid = 0').bind(ph),
      db.prepare('DELETE FROM wiped WHERE ts < ?1').bind(now - 365 * 86400e3));
    await db.batch(st);
  } catch (e) {}                                              // a database without migration 0012 must still delete the account
}
// hourly: wiped rows after 1 year, light log after 2 years, handled notifications after 90 days, and the progress of a key that never chose a nickname,
// has no light left and has not played for a year (anonymous rows must not pile up)
export async function levelSweep(env) {
  if (!env.LB) return; const db = env.LB, now = Date.now();
  for (const [q, a] of [['DELETE FROM wiped WHERE ts < ?1', now - 365 * 86400e3], ['DELETE FROM lightlog WHERE ts < ?1', now - 2 * 365 * 86400e3], ['DELETE FROM iapnote WHERE ts < ?1', now - 90 * 86400e3]]) { try { await db.prepare(q).bind(a).run(); } catch (e) {} }
  try {
    const old = (await db.prepare('SELECT ph FROM prog WHERE paid = 0 AND sub = 0 AND MAX(created, len) < ?1 AND ph NOT IN (SELECT ph FROM players) LIMIT 500').bind(now - 365 * 86400e3).all()).results;
    for (const r of old) await db.batch([db.prepare('DELETE FROM prog WHERE ph = ?1').bind(r.ph), db.prepare('DELETE FROM lightlog WHERE ph = ?1').bind(r.ph), db.prepare('DELETE FROM runs WHERE ph = ?1 AND pid = 0').bind(r.ph)]);
  } catch (e) {}
}

// ---- light purchases ----
// take up to n from one pool of the player, never below 0; returns what was really taken (logged)
async function deduct(db, ph, pool, n, now, ref) {
  for (let i = 0; i < 6; i++) {
    const row = await getProg(db, ph); if (!row) return 0;
    const take = Math.min(row[pool], n); if (take <= 0) return 0;
    const r = await db.prepare(`UPDATE prog SET ${pool} = ${pool} - ?2 WHERE ph = ?1 AND ${pool} >= ?2`).bind(ph, take).run();   // pool is 'sub' or 'paid'
    if (r.meta && r.meta.changes === 1) { await db.prepare(`INSERT INTO lightlog (ph, ts, kind, pool, amt, ref) VALUES (?1, ?2, 'refund', ?3, ?4, ?5)`).bind(ph, now, pool, -take, ref).run(); return take; }
  }
  return 0;
}
// A refunded pass: the pending days it added go first (pleft, never below 0; the pass end moves back with them but not before now), and the light it already paid out
// (30 for each of its days that were not still pending) comes back from the pass pool, down to 0 at most.
async function refundPass(db, ph, D, now, tx, sbx) {
  await accrue(db, ph, now);
  for (let i = 0; i < 6; i++) {
    const row = await getProg(db, ph); if (!row) return;
    const r = Math.min(row.pleft, D), left = row.pleft - r;
    const u = await db.prepare(`UPDATE prog SET pleft = ?2, psbx = MIN(?2, CASE WHEN ?6 = 1 THEN MAX(0, psbx - ?7) ELSE psbx END), pass = CASE WHEN pass > ?3 THEN MAX(?3, (pday + ?2 + 1) * 86400000 - 14400000) ELSE pass END WHERE ph = ?1 AND pleft = ?4 AND pday = ?5`).bind(ph, left, now, row.pleft, row.pday, sbx ? 1 : 0, r).run();
    if (!u.meta || u.meta.changes !== 1) continue;
    if (r > 0) await db.prepare(`INSERT INTO lightlog (ph, ts, kind, pool, amt, ref) VALUES (?1, ?2, 'refund_days', 'pleft', ?3, ?4)`).bind(ph, now, -r, tx).run();
    if (D > r) await deduct(db, ph, 'sub', PASS_DAILY * (D - r), now, tx);
    return;
  }
}
// One verified light transaction t (a signedTransaction payload whose product is in LIGHT_PRODUCTS, already checked for bundle, environment and type).
// pid, ph: the player it belongs to. mode: '' (a purchase; a revocationDate in t makes it a refund), 'revoke' (App Store REFUND / REVOKE: refunded even without a revocationDate),
// 'reverse' (REFUND_REVERSED: give it back). The amount is multiplied by t.quantity (1..10).
// Sandbox purchases give light too (so App Review sees it), but a player's Sandbox purchases give at most SBX_CAP in total; the rest is 'sbxcap' and gives nothing. Their log rows are kind sbx_buy / sbx_pass.
// -> { status: 'granted' | 'dup' | 'revoked' | 'taken' | 'sbxcap' | 'bad', product, tx, pts }
export async function lightTx(db, ph, pid, t, now, mode = '') {
  const spec = LIGHT_PRODUCTS[t.productId], tx = String(t.transactionId), otx = /^\d{1,32}$/.test(String(t.originalTransactionId || '')) ? String(t.originalTransactionId) : '';
  const qty = Number.isInteger(t.quantity) ? Math.max(1, Math.min(MAX_QTY, t.quantity)) : 1, pts = spec.pts * qty, days = spec.pass ? PASS_DAYS * qty : 0;   // days: pending pass days this transaction adds
  const r = { product: spec.id, tx, pts }, sbx = t.environment === 'Sandbox' ? 1 : 0, env = sbx ? 'Sandbox' : 'Production';
  const revoked = mode === 'revoke' || (mode !== 'reverse' && Number.isFinite(t.revocationDate) && t.revocationDate > 0);
  const today = dayOf(now);
  // what a purchase does to prog. A pass adds pending days (no light at once; accrue() pays the first day right after); with none pending the last paid day is set to yesterday so
  // nothing old is paid. pass (the end of the last pay day, ms) follows from pday + pleft. Plain light adds to its pool. The SET list reads the old row, so the CASEs see pleft before the change.
  const addSql = (n, gate) => spec.pass
    ? `UPDATE prog SET pleft = pleft + ?2, pass = ((CASE WHEN pleft = 0 THEN MAX(pday, ?3 - 1) ELSE pday END) + pleft + ?2 + 1) * 86400000 - 14400000, pday = CASE WHEN pleft = 0 THEN MAX(pday, ?3 - 1) ELSE pday END,
        psbx = psbx + ?4 WHERE ph = ?1${gate}`
    : `UPDATE prog SET ${spec.pool} = ${spec.pool} + ?2 WHERE ph = ?1${gate}`;   // pool is 'paid' here
  const addArgs = spec.pass ? [days, today, sbx ? days : 0] : [pts];   // ?4: how many of the added days are Sandbox days (psbx)
  for (let i = 0; i < 2; i++) {
    const known = await db.prepare('SELECT pid, revoked FROM iaptx WHERE txid = ?1').bind(tx).first();
    if (mode === 'reverse') {                                  // the refund was taken back: give it again (only a transaction we refunded ourselves)
      if (!known || known.pid !== pid || !ph) return { ...r, status: 'bad' };
      if (!known.revoked) return { ...r, status: 'dup' };
      const u = await db.prepare('UPDATE iaptx SET revoked = 0 WHERE txid = ?1 AND revoked = 1').bind(tx).run();
      if (u.meta && u.meta.changes === 1) {
        await ensureProg(db, ph, now);
        if (spec.pass) {                                       // give back what the refund took: the pending days it removed, and the light it took back
          const sum = async (k1, k2, pool) => -((await db.prepare('SELECT COALESCE(SUM(amt), 0) AS s FROM lightlog WHERE ph = ?1 AND kind IN (?2, ?3) AND ref = ?4 AND pool = ?5').bind(ph, k1, k2, tx, pool).first()).s);   // refunds minus reversals so far
          const rd = await sum('refund_days', 'reverse_days', 'pleft'), rl = await sum('refund', 'reverse', 'sub'), st = [];
          if (rd > 0) st.push(db.prepare(addSql(0, '')).bind(ph, rd, today, sbx ? rd : 0), db.prepare(`INSERT INTO lightlog (ph, ts, kind, pool, amt, ref) VALUES (?1, ?2, 'reverse_days', 'pleft', ?3, ?4)`).bind(ph, now, rd, tx));
          if (rl > 0) st.push(db.prepare('UPDATE prog SET sub = sub + ?2 WHERE ph = ?1').bind(ph, rl), db.prepare(`INSERT INTO lightlog (ph, ts, kind, pool, amt, ref) VALUES (?1, ?2, 'reverse', 'sub', ?3, ?4)`).bind(ph, now, rl, tx));
          if (st.length) await db.batch(st);
          await accrue(db, ph, now);
        } else {                                               // only what the refund really took (it takes no more than was left) minus what was already given back
          const back = -((await db.prepare("SELECT COALESCE(SUM(amt), 0) AS s FROM lightlog WHERE ph = ?1 AND kind IN ('refund', 'reverse') AND ref = ?2 AND pool = ?3").bind(ph, tx, spec.pool).first()).s);
          if (back > 0) await db.batch([db.prepare(addSql(0, '')).bind(ph, back),
            db.prepare(`INSERT INTO lightlog (ph, ts, kind, pool, amt, ref) VALUES (?1, ?2, 'reverse', ?3, ?4, ?5)`).bind(ph, now, spec.pool, back, tx)]);
        }
      }
      return { ...r, status: 'granted' };
    }
    if (!known) {
      if (revoked) { await db.prepare('INSERT OR IGNORE INTO iaptx (txid, pid, product, env, ts, revoked, amt, otx) VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, ?6)').bind(tx, pid, spec.id, env, now, otx).run(); return { ...r, status: 'revoked' }; }
      if (!ph) return { ...r, status: 'bad' };
      await ensureProg(db, ph, now);
      const kind = (sbx ? 'sbx_' : '') + (spec.pass ? 'pass' : 'buy');
      // one batch: the transaction row (INSERT OR IGNORE) gates the log row (and, for Sandbox, the cap), and the log row gates the pool change (changes() = rows of the statement before)
      const res = await db.batch([
        db.prepare('INSERT OR IGNORE INTO iaptx (txid, pid, product, env, ts, revoked, amt, otx) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6)').bind(tx, pid, spec.id, env, now, otx),
        // a pass is logged as the days it gives (pool 'pleft', amt = days): it is a right, not light, so the 'sub' sums of lightlog stay equal to what was really paid in. The Sandbox cap counts a pass day as PASS_DAILY.
        db.prepare(`INSERT INTO lightlog (ph, ts, kind, pool, amt, ref) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE changes() = 1
          AND (?7 = 0 OR (SELECT COALESCE(SUM(CASE WHEN kind = 'sbx_pass' THEN amt * ?9 ELSE amt END), 0) FROM lightlog WHERE ph = ?1 AND kind IN ('sbx_buy', 'sbx_pass')) + ?10 <= ?8)`).bind(ph, now, kind, spec.pass ? 'pleft' : spec.pool, spec.pass ? days : pts, tx, sbx, SBX_CAP, PASS_DAILY, pts),
        db.prepare(addSql(0, ' AND changes() = 1')).bind(ph, ...addArgs),
      ]);
      const ins = res[0].meta && res[0].meta.changes === 1, lg = res[1].meta && res[1].meta.changes === 1;
      if (ins && lg) { if (spec.pass) await accrue(db, ph, now); return { ...r, status: 'granted' }; }   // a pass pays its first day at once
      if (ins) { await db.prepare('DELETE FROM iaptx WHERE txid = ?1').bind(tx).run(); return { ...r, status: 'sbxcap' }; }   // over the Sandbox cap: nothing given, the transaction is not kept
      continue;                                                // somebody inserted the same transaction first: look at it again
    }
    if (known.pid !== pid) return { ...r, status: known.revoked || revoked ? 'revoked' : 'taken' };   // light never moves to another player
    if (revoked && !known.revoked) {
      const u = await db.prepare('UPDATE iaptx SET revoked = 1 WHERE txid = ?1 AND revoked = 0').bind(tx).run();
      if (u.meta && u.meta.changes === 1 && ph) {
        if (spec.pass) await refundPass(db, ph, days, now, tx, sbx); else await deduct(db, ph, spec.pool, pts, now, tx);
      }
      return { ...r, status: 'revoked' };
    }
    return { ...r, status: known.revoked || revoked ? 'revoked' : 'dup' };
  }
  return { ...r, status: 'dup' };
}

// ---- duel experience ----
// duel multiplier: 2 + min(1, 0.25 x (players - 2)) + 0.5 for first place, + 0.25 for second place when there are 3 or more players: x2 .. x3.5
export const duelMult = (n, place) => 2 + Math.min(1, 0.25 * Math.max(0, n - 2)) + (place === 1 ? 0.5 : n >= 3 && place === 2 ? 0.25 : 0);
// res = duel.js settle()'s result (a round that counted), start = when the round began. Gives each registered, valid seat that finished the whole song with accuracy >= 50 % (and is not
// flagged "sus") experience: base x duelMult, no light spent, half after the day's first hour. Once per round and player (duelxp). -> [{ pid, lv, duel: { n, place, mult } }]
export async function duelXp(db, res, start, now) {
  const out = [], D = res.duel, n = D.valid;
  for (const r of res.rows) {
    if (!r.pid || !r.ok || r.sus || r.acc < 5000) continue;
    try {
      const p = await db.prepare('SELECT ph FROM players WHERE id = ?1').bind(r.pid).first(); if (!p) continue;
      const g = await db.prepare('INSERT OR IGNORE INTO duelxp (did, pid, ts) VALUES (?1, ?2, ?3)').bind(D.id, r.pid, now).run();
      if (!g.meta || g.meta.changes !== 1) continue;           // this round already gave this player experience
      const place = 1 + res.rows.filter(x => x.pid && x.place < r.place).length, mult = duelMult(n, place), lv = await settle(db, p.ph, r.pid, now, { song: D.song, d: D.d, kind: 'duel', acc: r.acc, mult, start });
      if (!lv) { await db.prepare('DELETE FROM duelxp WHERE did = ?1 AND pid = ?2').bind(D.id, r.pid).run(); continue; }
      out.push({ pid: r.pid, lv, duel: { n, place, mult } });
    } catch (e) { try { await db.prepare('DELETE FROM duelxp WHERE did = ?1 AND pid = ?2').bind(D.id, r.pid).run(); } catch (e2) {} }   // not settled: free the round for a retry
  }
  return out;
}

// ---- HTTP: /lv/me ----
const MAX_BODY = 2048;
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const isPk = v => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
// POST /lv/me { pk } -> { lv: state }. Creates the row (a new player starts with full natural light). A registered player also gets level rewards they are owed.
export async function handleLv(req, env, path, who, H, limited) {
  const json = (o, s = 200, extra) => Response.json(o, { status: s, headers: { ...H, ...extra } });
  if (!env.LB) return json({ error: 'off' }, 503);
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (path !== '/lv/me') return json({ error: 'not found' }, 404);
  if (await limited(env, 'lv:' + who)) return json({ error: 'slow' }, 429, { 'Retry-After': '60' });
  if (+(req.headers.get('Content-Length') || 0) > MAX_BODY) return json({ error: 'big' }, 413);
  let body; try { const t = await req.text(); if (t.length > MAX_BODY) return json({ error: 'big' }, 413); body = JSON.parse(t); } catch (e) { return json({ error: 'bad' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !isPk(body.pk)) return json({ error: 'bad' }, 400);
  const db = env.LB, now = Date.now(), ph = await sha(body.pk);
  try {
    const row = await ensureProg(db, ph, now);
    const pl = await db.prepare('SELECT id FROM players WHERE ph = ?1').bind(ph).first();
    if (pl) { try { await lvCatchUp(db, ph, pl.id, now); } catch (e) {} }
    return json({ lv: lvState(row, now) });
  } catch (e) { return json({ error: 'off' }, 503); }
}
