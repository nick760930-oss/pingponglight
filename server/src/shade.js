// Starshade (星影) and invitations. Routed from lb.js (every call is a POST with the player's key, like the rest of /lb/).
//
//  /lb/shade     { pk, k, d }   one other player's best run on that song and difficulty, to replay beside the player's own run:
//                               { name, lv, score, log } (log = the stored beat log, [error ms, base points] per beat, null / 0 for a miss),
//                               or { none: true }. The run whose score is closest to the player's own best on that board (no own best:
//                               the median of the board). Never the player's own run, a hidden nickname, a player who turned it off, or a run without a log.
//  /lb/shadeset  { pk, v? }     read (no v) or set (v = 0 / 1) players.shade, "my records may be a starshade". Off = never picked again, at once.
//  /lb/inv       { pk }         my invitation code (made on the first call, then fixed), how many I invited and how many of them finished,
//                               and whether somebody already invited me (used).
//  /lb/redeem    { pk, code }   enter a friend's code: needs a nickname; not my own code; once per player; only before my first clear.
//  inviteDone()                 called by lb.js on a player's first clear: marks the invitation done and gives 同行星芒 to both sides.
import { CHARTS } from './charts.js';
import { CATALOG } from './catalog.js';
import { grantStmts } from './cos.js';
import { levelOf } from './level.js';

const DIFFS = 5, ALPH = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';        // no 0/O/1/I/L
export const INV_CAP = 20, COMPANION = 'hit.companion', INV_SRC = 'invite';
const enc = new TextEncoder();
const sha = async s => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))), b => b.toString(16).padStart(2, '0')).join('');
const isPk = v => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
const songOk = (song, d) => typeof song === 'string' && Object.prototype.hasOwnProperty.call(CHARTS, song) && Number.isInteger(d) && d >= 0 && d < DIFFS;
export const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ALPH[b % ALPH.length]).join('');
export const cleanCode = v => { const c = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, ''); return c.length === 6 && [...c].every(ch => ALPH.includes(ch)) ? c : ''; };

// a log is only handed out when it is a whole, well-formed run of this chart (the same shape lb.js judge accepts)
function logOk(log, n) {
  if (!Array.isArray(log) || log.length !== n) return false;
  return log.every(x => x === null || x === 0 || (Array.isArray(x) && x.length === 2 && Number.isInteger(x[0]) && Number.isInteger(x[1]) && Math.abs(x[0]) <= 400 && x[1] >= 0 && x[1] < 1e6));
}

// returns a Response, or null when the path is not one of ours
export async function shadeRoute(path, body, env, db, json, now, who, limited) {
  if (path !== '/lb/shade' && path !== '/lb/shadeset' && path !== '/lb/inv' && path !== '/lb/redeem') return null;
  const { pk } = body; if (!isPk(pk)) return json({ error: 'bad' }, 400);
  const ph = await sha(pk), me = await db.prepare('SELECT id, name FROM players WHERE ph = ?1').bind(ph).first();
  if (!me) return json({ error: 'noname' }, 400);

  if (path === '/lb/shade') {
    const k = body.k, d = body.d; if (!songOk(k, d)) return json({ error: 'song' }, 400);
    const b = k + '-' + d, mine = await db.prepare('SELECT score FROM scores WHERE board = ?1 AND pid = ?2').bind(b, me.id).first();
    const ok = `s.board = ?1 AND s.pid <> ?2 AND s.hid = 0 AND p.hidden = 0 AND p.shade = 1 AND s.log IS NOT NULL AND s.log <> '' AND s.score > 0`;
    let picks = [];
    if (mine) picks = (await db.prepare(`SELECT s.pid, s.score FROM scores s JOIN players p ON p.id = s.pid WHERE ${ok} ORDER BY ABS(s.score - ?3), s.ts DESC LIMIT 5`).bind(b, me.id, mine.score).all()).results || [];
    else {
      const c = await db.prepare(`SELECT COUNT(*) AS n FROM scores s JOIN players p ON p.id = s.pid WHERE ${ok}`).bind(b, me.id).first();
      if (c && c.n) picks = (await db.prepare(`SELECT s.pid, s.score FROM scores s JOIN players p ON p.id = s.pid WHERE ${ok} ORDER BY s.score, s.ts LIMIT 5 OFFSET ?3`).bind(b, me.id, Math.floor(c.n / 2)).all()).results || [];
    }
    // the nearest ones first; a run whose stored log is not a whole log of this chart is skipped for the next
    let pick = null, row = null, log = null;
    for (const c of picks) {
      const r = await db.prepare('SELECT s.log, p.name, p.ph FROM scores s JOIN players p ON p.id = s.pid WHERE s.board = ?1 AND s.pid = ?2').bind(b, c.pid).first();
      let l = null; try { l = JSON.parse(r.log); } catch (e) {}
      if (logOk(l, CHARTS[k].n[d])) { pick = c; row = r; log = l; break; }
    }
    if (!pick) return json({ none: true });
    let lv = 1; try { const pr = await db.prepare('SELECT xp FROM prog WHERE ph = ?1').bind(row.ph).first(); if (pr) lv = levelOf(pr.xp).lv; } catch (e) {}
    return json({ name: row.name, lv, score: pick.score, log });
  }

  if (path === '/lb/shadeset') {
    if (body.v !== undefined) {
      if (body.v !== 0 && body.v !== 1 && body.v !== true && body.v !== false) return json({ error: 'bad' }, 400);
      await db.prepare('UPDATE players SET shade = ?2 WHERE id = ?1').bind(me.id, body.v ? 1 : 0).run();
    }
    const r = await db.prepare('SELECT shade FROM players WHERE id = ?1').bind(me.id).first();
    return json({ ok: true, shade: r && r.shade ? 1 : 0 });
  }

  if (path === '/lb/inv') {
    let c = await db.prepare('SELECT code FROM invcodes WHERE pid = ?1').bind(me.id).first();
    for (let i = 0; !c && i < 8; i++) {                // a clash with somebody else's code (unique) simply tries another; a clash on pid means another call made it first
      try { await db.prepare('INSERT OR IGNORE INTO invcodes (pid, code, created) VALUES (?1, ?2, ?3)').bind(me.id, newCode(), now).run(); } catch (e) {}
      c = await db.prepare('SELECT code FROM invcodes WHERE pid = ?1').bind(me.id).first();
    }
    if (!c) return json({ error: 'busy' }, 503);
    const t = await db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(done), 0) AS m FROM invites WHERE inviter = ?1').bind(me.id).first();
    const u = await db.prepare('SELECT done FROM invites WHERE invitee = ?1').bind(me.id).first();
    return json({ ok: true, code: c.code, n: t ? t.n : 0, m: t ? t.m : 0, used: !!u, done: !!(u && u.done) });
  }

  // /lb/redeem
  if (limited && await limited(env, 'invr:' + who)) return json({ error: 'slow' }, 429, { 'Retry-After': '60' });
  const code = cleanCode(body.code); if (!code) return json({ error: 'code' }, 400);
  const inv = await db.prepare('SELECT pid FROM invcodes WHERE code = ?1').bind(code).first();
  if (!inv) return json({ error: 'nocode' }, 404);
  if (inv.pid === me.id) return json({ error: 'self' }, 400);
  if (await db.prepare('SELECT 1 FROM invites WHERE invitee = ?1').bind(me.id).first()) return json({ error: 'already' }, 409);
  if (await db.prepare('SELECT 1 FROM scores WHERE pid = ?1 LIMIT 1').bind(me.id).first()) return json({ error: 'cleared' }, 409);   // only before the first clear
  const r = await db.prepare('INSERT OR IGNORE INTO invites (invitee, inviter, created) VALUES (?1, ?2, ?3)').bind(me.id, inv.pid, now).run();
  if (!r.meta || r.meta.changes !== 1) return json({ error: 'already' }, 409);   // a second call at the same moment: the primary key let only one through
  return json({ ok: true });
}

// The invitee's first clear: done = 1 (once), the invitee gets 同行星芒, and the inviter too while they have at most INV_CAP finished invitations.
// The inviter's row is per invitee (ref), so the cap is a plain count; the invitee's row has no ref (one per player, however many times they clear).
export async function inviteDone(db, pid, now) {
  if (!CATALOG[COMPANION]) return false;
  const r = await db.prepare('UPDATE invites SET done = 1, done_ts = ?2 WHERE invitee = ?1 AND done = 0').bind(pid, now).run();
  if (!r.meta || r.meta.changes !== 1) return false;
  const row = await db.prepare('SELECT inviter FROM invites WHERE invitee = ?1').bind(pid).first(); if (!row) return false;
  const c = await db.prepare('SELECT COUNT(*) AS n FROM invites WHERE inviter = ?1 AND done = 1').bind(row.inviter).first();
  const st = grantStmts(db, pid, [COMPANION], INV_SRC, '', now);
  if (c && c.n <= INV_CAP) st.push(...grantStmts(db, row.inviter, [COMPANION], INV_SRC, 'by:' + pid, now));
  await db.batch(st);
  return true;
}

// a player's invitation data goes with the rest of their data (their code, the invitation they used, and the ones they sent).
// The cosmetic an inviter got for this player (ents.ref = 'by:<pid>') stays with the inviter, but loses the reference to the deleted player
// (OR IGNORE: if the inviter already holds the same row with an empty ref, the leftover by:<pid> row is simply dropped).
export const inviteWipe = (db, pid) => [
  db.prepare('DELETE FROM invcodes WHERE pid = ?1').bind(pid),
  db.prepare('DELETE FROM invites WHERE invitee = ?1 OR inviter = ?1').bind(pid),
  db.prepare("UPDATE OR IGNORE ents SET ref = '' WHERE ref = ?1").bind('by:' + pid),
  db.prepare('DELETE FROM ents WHERE ref = ?1').bind('by:' + pid),
];
