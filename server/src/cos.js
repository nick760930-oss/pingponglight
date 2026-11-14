// Ownership and what other players see (avatar, name plate, title). Shared by lb.js, friends.js, arena.js and shop.js.
//
// Ownership is the ents table (migrations/0008_shop.sql). Rows with src = 'test' were handed out during the free test
// period; they only count while the Worker runs with SHOP_TEST=1. Items others can see are therefore checked every time
// they are read: an equipped item that is not (or no longer) owned shows as the default one ('').
// src = 'sbx' rows are App Store Sandbox purchases (testers, App Review): the owner may own and wear them (self = true), but
// everybody else sees the default item instead.
import { CATALOG } from './catalog.js';

export const testMode = env => env.SHOP_TEST === '1';
export const SLOTS = ['avatar', 'plate', 'title'];
const CHUNK = 80;                                      // D1 allows 100 bound values per query

// Valid equipped items and the career best combo of the given player ids (self = the owner's own view: Sandbox items count): Map id -> { avatar, plate, title, cmc }.
// cmc colours the default avatar (the best combo of the player's verified runs).
export async function cosOf(db, env, ids, self = false) {
  const out = new Map(), want = [...new Set(ids.filter(x => Number.isInteger(x) && x > 0))], t = testMode(env) ? 1 : 0;
  const nosbx = self ? '' : ` AND e.src <> 'sbx'`;      // what others see never rests on a Sandbox purchase
  const ok = c => `CASE WHEN p.${c} <> '' AND EXISTS (SELECT 1 FROM ents e WHERE e.pid = p.id AND e.item = p.${c} AND (e.src <> 'test' OR ?1 = 1)${nosbx}) THEN p.${c} ELSE '' END AS ${c}`;
  for (let i = 0; i < want.length; i += CHUNK) {
    const part = want.slice(i, i + CHUNK), q = part.map((_, k) => '?' + (k + 2)).join(',');
    const rows = (await db.prepare(`SELECT p.id, ${ok('avatar')}, ${ok('plate')}, ${ok('title')}, COALESCE((SELECT MAX(s.combo) FROM scores s WHERE s.pid = p.id), 0) AS mc
      FROM players p WHERE p.id IN (${q})`).bind(t, ...part).all()).results;
    for (const r of rows) {
      const c = { cmc: r.mc };
      for (const s of SLOTS) { const it = CATALOG[r[s]]; c[s] = it && it.cat === s && it.vis ? r[s] : ''; }
      out.set(r.id, c);
    }
  }
  return out;
}
export const NOCOS = { avatar: '', plate: '', title: '', cmc: 0 };
// rows with an id get avatar, plate, title and cmc added (one query for the whole list)
export async function withCos(db, env, rows) {
  if (!rows.length) return rows;
  let m; try { m = await cosOf(db, env, rows.map(r => r.id)); } catch (e) { m = new Map(); }
  return rows.map(r => ({ ...r, ...(m.get(r.id) || NOCOS) }));
}
// does the player own this item (the default ones are everybody's)?
export async function owns(db, env, pid, item) {
  const it = CATALOG[item]; if (!it) return false;
  if (it.how === 'default') return true;
  return !!(await db.prepare(`SELECT 1 FROM ents WHERE pid = ?1 AND item = ?2 AND (src <> 'test' OR ?3 = 1) LIMIT 1`).bind(pid, item, testMode(env) ? 1 : 0).first());
}
// every item that goes with this one (a theme brings its parts)
export const expand = item => { const it = CATALOG[item]; return it ? [item, ...it.parts] : [item]; };
// statements that give items (with their theme parts); INSERT OR IGNORE, so giving twice is harmless
export const grantStmts = (db, pid, items, src, ref, now) => [...new Set(items.flatMap(expand))].filter(x => CATALOG[x])
  .map(x => db.prepare('INSERT OR IGNORE INTO ents (pid, item, src, ref, ts) VALUES (?1, ?2, ?3, ?4, ?5)').bind(pid, x, src, ref, now));
// the sponsor reward follows the total of unrefunded sponsor packs: title from the first pack, plate from NT$300
export const SPONSOR_TITLE = 'title.lamplighter', SPONSOR_AVATAR = 'avatar.gold', SPONSOR_AVATAR_AT = 90, SPONSOR_PLATE = 'plate.beacon', SPONSOR_PLATE_AT = 300;
export async function sponsorSync(db, pid, now) {
  const total = ((await db.prepare('SELECT COALESCE(SUM(amt), 0) AS s FROM iaptx WHERE pid = ?1 AND revoked = 0').bind(pid).first()) || { s: 0 }).s;
  const st = [db.prepare(`DELETE FROM ents WHERE pid = ?1 AND src = 'sponsor'`).bind(pid)];
  if (total > 0) st.push(...grantStmts(db, pid, [SPONSOR_TITLE], 'sponsor', '', now));
  if (total >= SPONSOR_AVATAR_AT) st.push(...grantStmts(db, pid, [SPONSOR_AVATAR], 'sponsor', '', now));
  if (total >= SPONSOR_PLATE_AT) st.push(...grantStmts(db, pid, [SPONSOR_PLATE], 'sponsor', '', now));
  await db.batch(st);
  return total;
}
// a player's shop data goes with the rest of their data. Transactions are kept anonymously (pid 0) so a receipt cannot be reused.
export const shopWipe = (db, pid) => [
  db.prepare('DELETE FROM ents WHERE pid = ?1').bind(pid), db.prepare('DELETE FROM achs WHERE pid = ?1').bind(pid),
  db.prepare('DELETE FROM pstats WHERE pid = ?1').bind(pid), db.prepare('UPDATE iaptx SET pid = 0 WHERE pid = ?1').bind(pid),
];
