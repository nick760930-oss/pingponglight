// In-app purchases: the server checks Apple's StoreKit 2 signed transactions (JWS) itself, no third-party service.
//
// A signedTransaction is a JWS: header.payload.signature (base64url). The header carries the certificate chain (x5c:
// leaf, Apple's intermediate, Apple Root CA - G3); the leaf key signed header.payload with ES256. We trust it when
//   1. the chain ends at the pinned Apple Root CA - G3 (APPLE_ROOT_G3_B64 below, checked against Apple's published
//      SHA-256 fingerprint before it is ever used), every certificate is signed by the next one, every one is valid
//      at the time the transaction was signed, and the leaf and the intermediate carry Apple's marker extensions;
//   2. the ES256 signature over the JWS checks out with the leaf's public key;
//   3. bundleId and productId are ours, the environment is Sandbox or Production, and the transaction is new.
// Certificates are parsed here (a small DER reader) and verified with WebCrypto: no libraries.
//
// /iap/verify is switched on with IAP_ON=1 (shop.js; any other value answers 503 {error:'off'}). Even then, when
// APPLE_ROOT_G3_B64 is empty (or does not match the fingerprint) it answers 503: nothing is ever granted without a root we
// can vouch for. Tests (and local development with ALLOW_LOCAL=1) can inject their own root through env.IAP_TEST_ROOT_B64.
// Sandbox transactions (testers, App Review) are recorded as src = 'sbx': the buyer owns and wears them, nobody else sees them
// and they add nothing to the sponsor total. Restoring a purchase on another account moves it (see iapProcess).
import { CATALOG } from './catalog.js';
import { grantStmts, sponsorSync } from './cos.js';

export const BUNDLE_ID = 'com.nocticat.pingponglight';
// Apple Root CA - G3 (https://www.apple.com/certificateauthority/AppleRootCA-G3.cer), base64 of the DER file.
export const APPLE_ROOT_G3_B64 = 'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==';
// published SHA-256 fingerprint of that certificate
export const APPLE_ROOT_G3_SHA256 = '63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179';
const LEAF_OID = '1.2.840.113635.100.6.11.1', INTER_OID = '1.2.840.113635.100.6.2.1';   // Apple's marker extensions
const MAX_CHAIN = 5, SKEW_MS = 5 * 60000, MAX_JWS = 16384;

const te = new TextEncoder();
const b64 = s => { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const hexOf = u => Array.from(u, b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---- DER ----
function node(buf, off) {                                // { tag, s (value start), e (value end), o (start of the whole element) }
  if (off + 2 > buf.length) throw new Error('der');
  const tag = buf[off]; let len = buf[off + 1], p = off + 2;
  if (len & 0x80) { const n = len & 0x7f; if (!n || n > 3 || p + n > buf.length) throw new Error('der'); len = 0; for (let i = 0; i < n; i++) len = len * 256 + buf[p++]; }
  if (p + len > buf.length) throw new Error('der');
  return { tag, s: p, e: p + len, o: off };
}
function kids(buf, n) { const out = []; for (let p = n.s; p < n.e;) { const k = node(buf, p); out.push(k); p = k.e; } return out; }
function oid(buf, n) {
  const b = buf.subarray(n.s, n.e); if (!b.length) throw new Error('oid');
  const parts = [Math.floor(b[0] / 40), b[0] % 40]; let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join('.');
}
function oidBytes(s) {                                    // dotted -> DER content bytes
  const a = s.split('.').map(Number), out = [a[0] * 40 + a[1]];
  for (const x of a.slice(2)) { const t = [x & 0x7f]; for (let y = x >> 7; y; y >>= 7) t.unshift((y & 0x7f) | 0x80); out.push(...t); }
  return new Uint8Array(out);
}
const has = (hay, needle) => { outer: for (let i = 0; i + needle.length <= hay.length; i++) { for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer; return true; } return false; };
function time(buf, n) {
  const t = String.fromCharCode(...buf.subarray(n.s, n.e)); let m;
  if (n.tag === 0x17 && (m = t.match(/^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/))) return Date.UTC(+m[1] >= 50 ? 1900 + +m[1] : 2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (n.tag === 0x18 && (m = t.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/))) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  throw new Error('time');
}
const CURVES = { '1.2.840.10045.3.1.7': ['P-256', 32], '1.3.132.0.34': ['P-384', 48], '1.3.132.0.35': ['P-521', 66] };
const SIGHASH = { '1.2.840.10045.4.3.2': 'SHA-256', '1.2.840.10045.4.3.3': 'SHA-384', '1.2.840.10045.4.3.4': 'SHA-512' };
export function parseCert(der) {
  const c = node(der, 0), [tbs, alg, sig] = kids(der, c);
  if (c.tag !== 0x30 || !tbs || !alg || !sig || sig.tag !== 0x03 || c.e !== der.length) throw new Error('cert');
  const f = kids(der, tbs); let i = 0; if (f[0].tag === 0xa0) i++;
  const [, sigAlg, issuer, validity, subject, spki] = [f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5]];
  const v = kids(der, validity), sa = oid(der, kids(der, sigAlg)[0]);
  const sp = kids(der, spki), ap = kids(der, sp[0]);
  if (oid(der, ap[0]) !== '1.2.840.10045.2.1') throw new Error('key');
  const curve = CURVES[oid(der, ap[1])]; if (!curve || !SIGHASH[sa]) throw new Error('alg');
  return {
    raw: der, tbs: der.subarray(tbs.o, tbs.e), hash: SIGHASH[sa], sig: der.subarray(sig.s + 1, sig.e),
    issuer: der.subarray(issuer.o, issuer.e), subject: der.subarray(subject.o, subject.e), spki: der.subarray(spki.o, spki.e),
    from: time(der, v[0]), to: time(der, v[1]), curve: curve[0], size: curve[1],
  };
}
function rawSig(der, size) {                              // ECDSA-Sig-Value (DER SEQUENCE of two INTEGERs) -> r || s
  const s = node(der, 0), [r, q] = kids(der, s); if (s.tag !== 0x30 || !r || !q || r.tag !== 0x02 || q.tag !== 0x02) throw new Error('sig');
  const out = new Uint8Array(size * 2), put = (x, at) => { let b = der.subarray(x.s, x.e); while (b.length > size && b[0] === 0) b = b.subarray(1); if (b.length > size) throw new Error('sig'); out.set(b, at + size - b.length); };
  put(r, 0); put(q, size); return out;
}
const keyCache = new Map();
async function keyOf(cert) {
  const k = hexOf(cert.spki); if (keyCache.has(k)) return keyCache.get(k);
  const key = await crypto.subtle.importKey('spki', cert.spki, { name: 'ECDSA', namedCurve: cert.curve }, false, ['verify']);
  if (keyCache.size > 20) keyCache.clear(); keyCache.set(k, key); return key;
}
async function signedBy(cert, parent) {                   // was cert signed by parent's key?
  if (!eq(cert.issuer, parent.subject)) return false;
  try { return await crypto.subtle.verify({ name: 'ECDSA', hash: cert.hash }, await keyOf(parent), rawSig(cert.sig, parent.size), cert.tbs); } catch (e) { return false; }
}

// ---- the pinned root ----
export const pinOk = der => crypto.subtle.digest('SHA-256', der).then(h => hexOf(new Uint8Array(h)) === APPLE_ROOT_G3_SHA256.replace(/:/g, '').toUpperCase());
let rootMemo = null;
// -> parsed root certificate, or null when none can be trusted (not filled in yet, or the fingerprint does not match)
export async function loadRoot(env) {
  const test = env && env.ALLOW_LOCAL === '1' && env.IAP_TEST_ROOT_B64;   // tests / local development only
  const b = test || APPLE_ROOT_G3_B64;
  if (!b) return null;
  if (rootMemo && rootMemo.b === b) return rootMemo.root;
  let root = null;
  try {
    const der = b64(b);
    if (test || await pinOk(der)) root = parseCert(der);
  } catch (e) { root = null; }
  rootMemo = { b, root }; return root;
}

// ---- the JWS ----
// -> { ok: true, payload } or { ok: false, why }. now = the time to judge certificate validity at (the transaction's own signing time is used when present).
export async function verifyJws(jws, root, now = Date.now()) {
  const bad = why => ({ ok: false, why });
  try {
    if (typeof jws !== 'string' || jws.length > MAX_JWS || !root) return bad('input');
    const p = jws.split('.'); if (p.length !== 3 || p.some(x => !/^[A-Za-z0-9_-]+$/.test(x))) return bad('format');
    const head = JSON.parse(new TextDecoder().decode(b64(p[0]))), payload = JSON.parse(new TextDecoder().decode(b64(p[1])));
    if (!head || head.alg !== 'ES256' || !Array.isArray(head.x5c) || head.x5c.length < 1 || head.x5c.length > MAX_CHAIN) return bad('header');
    if (!payload || typeof payload !== 'object') return bad('payload');
    let at = now; const sd = payload.signedDate; if (Number.isFinite(sd) && sd > 0 && sd <= now + SKEW_MS) at = sd;   // judged when it was signed, so old receipts stay valid
    let chain = head.x5c.map(x => parseCert(b64(x)));
    if (eq(chain[chain.length - 1].raw, root.raw)) chain = chain.slice(0, -1);   // the root itself came along: we use ours
    if (chain.length < 2) return bad('chain');
    if (!has(chain[0].raw, oidBytes(LEAF_OID)) || !has(chain[1].raw, oidBytes(INTER_OID))) return bad('apple');
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i], parent = i + 1 < chain.length ? chain[i + 1] : root;
      if (at < c.from || at > c.to) return bad('expired');
      if (!(await signedBy(c, parent))) return bad('chain');
    }
    if (at < root.from || at > root.to) return bad('expired');
    const leaf = chain[0]; if (leaf.curve !== 'P-256') return bad('alg');
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await keyOf(leaf), (() => { const s = b64(p[2]); if (s.length !== 64) throw new Error('sig'); return s; })(), te.encode(p[0] + '.' + p[1]));
    return ok ? { ok: true, payload } : bad('signature');
  } catch (e) { return bad('bad'); }
}

// ---- products ----
export const PRODUCTS = {};                                // store product id -> catalog item id (the ones that can be bought)
for (const [id, it] of Object.entries(CATALOG)) if (it.pid && (it.how === 'buy' || it.cat === 'sponsor')) PRODUCTS[it.pid] = id;
const isSponsor = id => CATALOG[id] && CATALOG[id].cat === 'sponsor';

// Verifies the transactions and gives what they bought. -> per transaction { status, product?, tx?, err? }
//   granted: new purchase; dup: seen before (same player); revoked: refunded; bad: refused (err says why);
//   moved: the transaction belonged to another player (or to nobody, after a data deletion) and now belongs to this one;
//   taken: belongs to another player and may not move (a sponsor pack, or it already moved within the last 24 h)
const MOVE_GAP = 24 * 3600e3;                            // one transfer per transaction per day: a leaked receipt cannot be grabbed back and forth
// give what a transaction bought; Sandbox purchases are 'sbx' (see cos.js)
const srcOf = env => env === 'Sandbox' ? 'sbx' : 'iap';
export async function iapProcess(db, root, pid, list, now = Date.now()) {
  const out = [];
  for (const jws of list) {
    const v = await verifyJws(jws, root, now);
    if (!v.ok) { out.push({ status: 'bad', err: v.why }); continue; }
    const t = v.payload, item = PRODUCTS[t.productId], tx = typeof t.transactionId === 'string' ? t.transactionId : t.transactionId != null ? String(t.transactionId) : '';
    if (t.bundleId !== BUNDLE_ID) { out.push({ status: 'bad', err: 'bundle' }); continue; }
    if (!item) { out.push({ status: 'bad', err: 'product' }); continue; }
    if (!/^\d{1,32}$/.test(tx)) { out.push({ status: 'bad', err: 'tx' }); continue; }
    if (t.environment !== 'Sandbox' && t.environment !== 'Production') { out.push({ status: 'bad', err: 'env' }); continue; }
    if (t.type !== (isSponsor(item) ? 'Consumable' : 'Non-Consumable')) { out.push({ status: 'bad', err: 'type' }); continue; }
    const q = isSponsor(item) ? Math.max(1, Math.min(10, Number.isInteger(t.quantity) ? t.quantity : 1)) : 1, amt = isSponsor(item) && t.environment === 'Production' ? CATALOG[item].price * q : 0;   // Sandbox money is not money: no sponsor total, no reward
    const revoked = Number.isFinite(t.revocationDate) && t.revocationDate > 0 ? 1 : 0, r = { product: item, tx };
    const known = await db.prepare('SELECT pid, revoked, mvts FROM iaptx WHERE txid = ?1').bind(tx).first(), src = srcOf(t.environment);
    if (known && known.pid !== pid) {                    // restore on another account (or after the old one deleted its data: pid 0)
      if (known.revoked || revoked) { out.push({ ...r, status: 'revoked' }); continue; }
      if (isSponsor(item) || now - (known.mvts || 0) < MOVE_GAP) { out.push({ ...r, status: 'taken' }); continue; }   // consumables never move: the sponsor total would count twice
      const was = known.pid, mv = await db.prepare('UPDATE iaptx SET pid = ?1, mvts = ?2 WHERE txid = ?3 AND pid = ?4 AND mvts = ?5').bind(pid, now, tx, was, known.mvts || 0).run();
      if (mv.meta && mv.meta.changes === 0) { out.push({ ...r, status: 'taken' }); continue; }   // somebody else moved it first
      const st = [db.prepare(`UPDATE ents SET pid = ?1 WHERE pid = ?2 AND ref = ?3 AND src IN ('iap', 'sbx')`).bind(pid, was, tx)];
      if (was > 0) for (const c of ['avatar', 'plate', 'title'])   // the one who lost it stops wearing it (unless it is still theirs another way)
        st.push(db.prepare(`UPDATE players SET ${c} = '' WHERE id = ?1 AND ${c} <> '' AND NOT EXISTS (SELECT 1 FROM ents e WHERE e.pid = players.id AND e.item = players.${c})`).bind(was));
      st.push(...grantStmts(db, pid, [item], src, tx, now));   // also repairs rows that were never written
      await db.batch(st);
      out.push({ ...r, status: 'moved' }); continue;
    }
    if (!known) {
      const ins = await db.prepare('INSERT OR IGNORE INTO iaptx (txid, pid, product, env, ts, revoked, amt) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(tx, pid, item, t.environment, now, revoked, amt).run();
      if (ins.meta && ins.meta.changes === 0) { const k2 = await db.prepare('SELECT pid FROM iaptx WHERE txid = ?1').bind(tx).first(); if (!k2 || k2.pid !== pid) { out.push({ ...r, status: 'taken' }); continue; } }
      if (revoked) { out.push({ ...r, status: 'revoked' }); continue; }   // a refund seen first: nothing was ever given
    } else if (revoked && !known.revoked) {
      await db.batch([db.prepare('UPDATE iaptx SET revoked = 1 WHERE txid = ?1').bind(tx), db.prepare(`DELETE FROM ents WHERE pid = ?1 AND src IN ('iap', 'sbx') AND ref = ?2`).bind(pid, tx)]);
      if (isSponsor(item)) await sponsorSync(db, pid, now);
      out.push({ ...r, status: 'revoked' }); continue;
    } else if (known.revoked || revoked) { out.push({ ...r, status: 'revoked' }); continue; }   // once refunded, always refunded (an old copy of the receipt cannot bring it back)
    // give (idempotent: also repairs a purchase whose first give was cut short)
    if (isSponsor(item)) await sponsorSync(db, pid, now);
    else await db.batch(grantStmts(db, pid, [item], src, tx, now));
    out.push({ ...r, status: known ? 'dup' : 'granted' });
  }
  return out;
}
