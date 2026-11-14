// Shop API: /shop/state, /shop/claim, /shop/equip, /iap/verify, /ach/sync (all POST, JSON; the player is the phone's secret key
// pk, like everywhere else: it is hashed and looked up, and the player must have a nickname first).
//
// Mode: SHOP_TEST=1 -> 'test' (every purchasable item is free to take with /shop/claim, recorded as src = 'test'); anything else
// -> 'web'. The iOS app is always 'iap' on its own side and sends its purchases to /iap/verify (only answers when IAP_ON=1).
// Items other players see (avatar, plate, title) are only worn when owned: checked when equipping and again on every read (cos.js).
import { CATALOG } from './catalog.js';
import { testMode, cosOf, owns, grantStmts, SLOTS } from './cos.js';
import { NA, achRecalc, achLocal, achList } from './ach.js';
import { loadRoot, iapProcess } from './iap.js';

const MAX_BODY = 16384, MAX_IAP_BODY = 90000, MAX_JWS = 16;
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const isPk = v => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v);

// everything the app needs about this player's shop in one answer
export async function shopState(db, env, pl) {
  const t = testMode(env) ? 1 : 0;
  const [own, eq, sp] = await Promise.all([
    db.prepare(`SELECT DISTINCT item FROM ents WHERE pid = ?1 AND (src <> 'test' OR ?2 = 1)`).bind(pl.id, t).all(),
    cosOf(db, env, [pl.id], true),
    db.prepare('SELECT COALESCE(SUM(amt), 0) AS s FROM iaptx WHERE pid = ?1 AND revoked = 0').bind(pl.id).first(),
  ]);
  const owned = own.results.map(r => r.item).filter(i => CATALOG[i]), c = eq.get(pl.id) || { avatar: '', plate: '', title: '', cmc: 0 };
  const a = await achList(db, pl.id);
  return {
    mode: t ? 'test' : 'web', id: pl.id, owned, full: owned.includes('full'), sponsor: sp ? sp.s : 0,
    equip: { avatar: c.avatar, plate: c.plate, title: c.title }, cmc: c.cmc,
    ach: a.list, pts: a.pts, na: NA,
  };
}

export async function handleShop(req, env, path, who, H, limited) {
  // Error answers carry only the error (never owned / equip / anything that looks like real data: the app would believe it).
  // /shop/state also says which mode the shop is in (the app needs it even without a nickname yet): { error, mode, noname?: true }.
  const mode = testMode(env) ? 'test' : 'web';
  const json = (o, s = 200, extra) => Response.json(path === '/shop/state' && s >= 400 ? { ...o, mode, ...(o.error === 'noname' ? { noname: true } : {}) } : o, { status: s, headers: { ...H, ...extra } });
  if (!env.LB) return json({ error: 'off' }, 503);
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  const iap = path === '/iap/verify';
  if (iap && env.IAP_ON !== '1') return json({ error: 'off' }, 503);   // purchases are switched on with IAP_ON=1 (wrangler.toml / secret var)
  if (!iap && path !== '/shop/state' && path !== '/shop/claim' && path !== '/shop/equip' && path !== '/ach/sync') return json({ error: 'not found' }, 404);
  if (await limited(env, (iap ? 'iap:' : 'shop:') + who)) return json({ error: 'slow' }, 429, { 'Retry-After': '60' });
  const cap = iap ? MAX_IAP_BODY : MAX_BODY;
  if (+(req.headers.get('Content-Length') || 0) > cap) return json({ error: 'big' }, 413);
  let body; try { const t = await req.text(); if (t.length > cap) return json({ error: 'big' }, 413); body = JSON.parse(t); } catch (e) { return json({ error: 'bad' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !isPk(body.pk)) return json({ error: 'bad' }, 400);
  const db = env.LB, now = Date.now();
  const pl = await db.prepare('SELECT id, name FROM players WHERE ph = ?1').bind(await sha(body.pk)).first();
  if (!pl) return json({ error: 'noname' }, 400);

  if (path === '/shop/state') return json(await shopState(db, env, pl));

  if (path === '/shop/claim') {                       // the free test period: any item with a price, once SHOP_TEST=1
    if (!testMode(env)) return json({ error: 'off' }, 403);
    const it = CATALOG[body.item];
    if (!it || it.how !== 'buy' || it.cat === 'sponsor') return json({ error: 'item' }, 400);
    await db.batch(grantStmts(db, pl.id, [body.item], 'test', '', now));
    return json({ ok: true, state: await shopState(db, env, pl) });
  }

  if (path === '/shop/equip') {                       // { slot: avatar | plate | title, item: id or '' (the default) }
    const slot = body.slot, item = body.item == null ? '' : body.item;
    if (!SLOTS.includes(slot) || typeof item !== 'string' || item.length > 64) return json({ error: 'bad' }, 400);
    let val = '';
    if (item) {
      const it = CATALOG[item];
      if (!it || it.cat !== slot || !it.vis) return json({ error: 'item' }, 400);
      if (it.how !== 'default') { if (!(await owns(db, env, pl.id, item))) return json({ error: 'notowned' }, 403); val = item; }
    }
    await db.prepare(`UPDATE players SET ${slot} = ?2 WHERE id = ?1`).bind(pl.id, val).run();   // slot is one of the three names above
    return json({ ok: true, equip: { ...(await shopState(db, env, pl)).equip } });
  }

  if (path === '/ach/sync') {                         // { local?: [ids the phone decided] } -> what the server decides, recorded and rewarded
    let fresh = [];
    if (body.local !== undefined) { if (!Array.isArray(body.local) || body.local.length > 200) return json({ error: 'bad' }, 400); await achLocal(db, pl.id, body.local, now); }
    try { fresh = (await achRecalc(db, pl.id, now, null, true)).fresh; } catch (e) { return json({ error: 'busy' }, 503); }
    const a = await achList(db, pl.id), st = await shopState(db, env, pl);
    return json({ ok: true, fresh, ach: a.list, pts: a.pts, owned: st.owned, equip: st.equip, na: NA });
  }

  if (iap) {                                          // { jws: signedTransaction | [signedTransaction, ...] } -> one result each
    const list = typeof body.jws === 'string' ? [body.jws] : Array.isArray(body.jws) ? body.jws : null;
    if (!list || !list.length || list.length > MAX_JWS) return json({ error: 'bad' }, 400);
    const root = await loadRoot(env);
    if (!root) return json({ error: 'off' }, 503);    // no Apple root certificate we can vouch for: nothing is granted
    const results = await iapProcess(db, root, pl.id, list, now);
    return json({ ok: true, results, state: await shopState(db, env, pl) });
  }
  return json({ error: 'not found' }, 404);
}
