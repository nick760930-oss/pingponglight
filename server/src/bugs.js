// Bug reports from testers: POST /bug/send with { pk?, kind, body, meta, imgs: [base64 JPEG/PNG, up to 3] }.
// Nothing here is shown to other players; only the admin reads reports (/lb/admin ops 'bugs', 'bugimg', 'bugdone').
// Limits: 5 reports a day per network and per player, 3 images of at most 400 KB each, 1000 characters of text.
// The images share the game's D1 database, so the whole server also takes at most 300 reports and 40 MB of images
// a day and keeps at most 150 MB of images; past that, reports with images are refused (text still goes through).
// Cheap checks and the daily caps run before any image is decoded. Images are checked by their first bytes
// (JPEG or PNG only). Kept 180 days (bugSweep, hourly).
const KINDS = ['bug', 'gfx', 'audio', 'net', 'friend', 'idea', 'other'];
const MAX_IMG = 400_000, MAX_IMGS = 3, MAX_TEXT = 1000, DAY = 86400e3, PER_DAY = 5, KEEP_MS = 180 * DAY;
const ALL_DAY = 300, BYTES_DAY = 40e6, BYTES_ALL = 150e6;
const MAX_B64 = Math.ceil(MAX_IMG * 4 / 3) + 4, MAX_BODY = (MAX_B64 + 40) * MAX_IMGS + 16384;
const enc = new TextEncoder();
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const isPk = v => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);
const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, n)
  .replace(/[\uD800-\uDBFF]$/, '');   // never leave half an emoji

// device details: whitelisted keys, short strings or numbers only
const META = { v: 40, pf: 10, ua: 300, scr: 20, dpr: 6, lat: 8, song: 40, d: 2, st: 12, err: 300, lang: 20, at: 8, sa: 30 };
function cleanMeta(m) {
  const out = {};
  if (!m || typeof m !== 'object' || Array.isArray(m)) return out;
  for (const k of Object.keys(META)) if (m[k] != null && (typeof m[k] === 'string' || typeof m[k] === 'number')) out[k] = txt(m[k], META[k]);
  return out;
}
function decodeImg(s) {   // base64 (optionally a data: URL) -> { mime, bytes } or null
  if (typeof s !== 'string') return null;
  const b = s.replace(/^data:image\/(jpeg|png);base64,/, '');
  if (b.length > MAX_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b)) return null;
  let bin; try { bin = atob(b); } catch (e) { return null; }
  const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  if (u.length < 64 || u.length > MAX_IMG) return null;
  if (u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff) return { mime: 'image/jpeg', bytes: u };
  if (u[0] === 0x89 && u[1] === 0x50 && u[2] === 0x4e && u[3] === 0x47) return { mime: 'image/png', bytes: u };
  return null;
}

export async function handleBug(req, env, path, who, H, limited) {
  const json = (o, s = 200, extra) => Response.json(o, { status: s, headers: { ...H, ...extra } });
  if (!env.LB || !env.LB_SECRET) return json({ error: 'off' }, 503);
  if (path !== '/bug/send') return json({ error: 'not found' }, 404);
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (await limited(env, 'bug:' + who)) return json({ error: 'slow' }, 429, { 'Retry-After': '60' });
  if (+(req.headers.get('Content-Length') || 0) > MAX_BODY) return json({ error: 'big' }, 413);
  let body; try { const t = await req.text(); if (t.length > MAX_BODY) return json({ error: 'big' }, 413); body = JSON.parse(t); } catch (e) { return json({ error: 'bad' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'bad' }, 400);
  const kind = KINDS.includes(body.kind) ? body.kind : null; if (!kind) return json({ error: 'bad' }, 400);
  const text = txt(String(body.body == null ? '' : body.body).trim(), MAX_TEXT).trim();
  const raw = Array.isArray(body.imgs) ? body.imgs : [];
  if (raw.length > MAX_IMGS) return json({ error: 'bad' }, 400);
  let est = 0;   // cheap size check now; decoding waits until the daily caps have passed
  for (const s of raw) { if (typeof s !== 'string') return json({ error: 'img' }, 400); if (s.length > MAX_B64 + 40) return json({ error: 'big' }, 413); est += Math.floor(s.length * 3 / 4); }
  if (!text && !raw.length) return json({ error: 'empty' }, 400);   // a kind alone says nothing
  const db = env.LB, now = Date.now(), since = now - DAY, by = await sha('bug:' + who + ':' + env.LB_SECRET);
  let pid = null;
  if (isPk(body.pk)) { const pl = await db.prepare('SELECT id FROM players WHERE ph = ?1').bind(await sha(body.pk)).first(); if (pl) pid = pl.id; }
  const [mine, day, all] = (await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM bugs WHERE ts > ?1 AND (by = ?2 OR (?3 IS NOT NULL AND pid = ?3))').bind(since, by, pid),
    db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(sz), 0) AS s FROM bugs WHERE ts > ?1').bind(since),
    db.prepare('SELECT COALESCE(SUM(sz), 0) AS s FROM bugs'),
  ])).map(r => (r.results && r.results[0]) || {});
  if (mine.n >= PER_DAY) return json({ error: 'daily' }, 429);
  if (day.n >= ALL_DAY) return json({ error: 'busy' }, 503);
  if (raw.length && (day.s + est > BYTES_DAY || all.s + est > BYTES_ALL)) return json({ error: 'full' }, 503);
  const imgs = []; for (const s of raw) { const im = decodeImg(s); if (!im) return json({ error: 'img' }, 400); imgs.push(im); }
  const sz = imgs.reduce((a, im) => a + im.bytes.length, 0);
  // the caps are checked again inside the insert, so reports sent at the same moment cannot slip past them
  const row = await db.prepare(`INSERT INTO bugs (pid, by, kind, body, meta, n, sz, ts) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
    WHERE (SELECT COUNT(*) FROM bugs WHERE ts > ?9 AND (by = ?2 OR (?1 IS NOT NULL AND pid = ?1))) < ?10
      AND (SELECT COUNT(*) FROM bugs WHERE ts > ?9) < ?11 RETURNING id`)
    .bind(pid, by, kind, text, JSON.stringify(cleanMeta(body.meta)), imgs.length, sz, now, since, PER_DAY, ALL_DAY).first();
  if (!row) return json({ error: 'daily' }, 429);
  if (imgs.length) {
    try { await db.batch(imgs.map((im, i) => db.prepare('INSERT INTO bugimgs (bug, i, mime, data) VALUES (?1, ?2, ?3, ?4)').bind(row.id, i, im.mime, im.bytes))); }
    catch (e) {   // all or nothing: the player keeps the draft and can try again
      try { await db.batch([db.prepare('DELETE FROM bugimgs WHERE bug = ?1').bind(row.id), db.prepare('DELETE FROM bugs WHERE id = ?1').bind(row.id)]); } catch (_) {}
      return json({ error: 'store' }, 503);
    }
  }
  return json({ ok: true, id: row.id });
}

// admin ops, called from /lb/admin after the token check
export async function bugAdmin(db, body, json) {
  if (body.op === 'bugs') {   // newest first, 200 at a time; status filter optional; after / before = only ids above / below it
    const where = [], args = [];
    if (typeof body.status === 'string') { args.push(body.status); where.push('b.status = ?' + args.length); }
    if (Number.isInteger(body.after)) { args.push(body.after); where.push('b.id > ?' + args.length); }
    if (Number.isInteger(body.before)) { args.push(body.before); where.push('b.id < ?' + args.length); }
    return json({ rows: (await db.prepare(`SELECT b.id, b.pid, p.name, b.kind, b.body, b.meta, b.n, b.ts, b.status FROM bugs b LEFT JOIN players p ON p.id = b.pid
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.id DESC LIMIT 200`).bind(...args).all()).results });
  }
  if (body.op === 'bugimg') {
    if (!Number.isInteger(body.id) || !Number.isInteger(body.i)) return json({ error: 'bad' }, 400);
    const r = await db.prepare('SELECT mime, data FROM bugimgs WHERE bug = ?1 AND i = ?2').bind(body.id, body.i).first();
    if (!r) return json({ img: null });
    const u = new Uint8Array(r.data); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return json({ img: 'data:' + r.mime + ';base64,' + btoa(s) });
  }
  if (body.op === 'bugdone') {   // mark handled ('done') or back to 'new'
    if (!Number.isInteger(body.id)) return json({ error: 'bad' }, 400);
    await db.prepare('UPDATE bugs SET status = ?2 WHERE id = ?1').bind(body.id, body.status === 'new' ? 'new' : 'done').run();
    return json({ ok: true });
  }
  return null;
}

// a player's reports go with the rest of their data
export const bugWipe = (db, pid) => [
  db.prepare('DELETE FROM bugimgs WHERE bug IN (SELECT id FROM bugs WHERE pid = ?1)').bind(pid),
  db.prepare('DELETE FROM bugs WHERE pid = ?1').bind(pid),
];

export async function bugSweep(env) {
  if (!env.LB) return;
  const old = Date.now() - KEEP_MS, db = env.LB;
  try { await db.batch([db.prepare('DELETE FROM bugimgs WHERE bug IN (SELECT id FROM bugs WHERE ts < ?1)').bind(old), db.prepare('DELETE FROM bugs WHERE ts < ?1').bind(old)]); } catch (e) {}
}
