// Test helper: builds an Apple-like certificate chain (root P-384, intermediate P-384, leaf P-256) with Node's crypto and a
// tiny DER writer, and signs StoreKit-style JWS transactions with it. Only for tests.
import crypto from 'node:crypto';

const len = n => n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
const tlv = (tag, b) => Buffer.concat([Buffer.from([tag, ...len(b.length)]), b]);
const seq = (...x) => tlv(0x30, Buffer.concat(x)), set = (...x) => tlv(0x31, Buffer.concat(x));
const int = n => { let h = n.toString(16); if (h.length % 2) h = '0' + h; let b = Buffer.from(h, 'hex'); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return tlv(0x02, b); };
const oid = s => { const a = s.split('.').map(Number), o = [a[0] * 40 + a[1]]; for (const x of a.slice(2)) { const t = [x & 0x7f]; for (let y = x >> 7; y; y >>= 7) t.unshift((y & 0x7f) | 0x80); o.push(...t); } return tlv(0x06, Buffer.from(o)); };
const utc = d => { const p = n => String(n).padStart(2, '0'), x = new Date(d); return tlv(0x17, Buffer.from(p(x.getUTCFullYear() % 100) + p(x.getUTCMonth() + 1) + p(x.getUTCDate()) + p(x.getUTCHours()) + p(x.getUTCMinutes()) + p(x.getUTCSeconds()) + 'Z')); };
const name = cn => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const SIGALG = { sha256: '1.2.840.10045.4.3.2', sha384: '1.2.840.10045.4.3.3' };

export const APPLE_LEAF = '1.2.840.113635.100.6.11.1', APPLE_INTER = '1.2.840.113635.100.6.2.1';
export function key(curve) { return crypto.generateKeyPairSync('ec', { namedCurve: curve }); }
// a certificate for pub, signed by issuerPriv (the issuer's name is issuer)
export function cert({ cn, pub, issuer, issuerPriv, hash = 'sha384', from, to, exts = [], serial = 1 }) {
  const alg = seq(oid(SIGALG[hash]));
  const e = exts.length ? tlv(0xa3, seq(...exts.map(x => seq(oid(x), tlv(0x04, Buffer.from([0x05, 0x00])))))) : Buffer.alloc(0);
  const tbs = seq(tlv(0xa0, int(2)), int(serial), alg, name(issuer), seq(utc(from), utc(to)), name(cn), pub.export({ type: 'spki', format: 'der' }), e);
  const sig = crypto.sign(hash, tbs, { key: issuerPriv, dsaEncoding: 'der' });
  return seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
}
const b64u = b => Buffer.from(b).toString('base64url');
// a chain; options break things on purpose
export function chain(o = {}) {
  const now = Date.now(), Y = 365 * 86400e3, from = o.from ?? now - Y, to = o.to ?? now + 5 * Y;
  const rk = key('P-384'), ik = key('P-384'), lk = key('P-256');
  const root = cert({ cn: 'Test Root G3', pub: rk.publicKey, issuer: 'Test Root G3', issuerPriv: rk.privateKey, from, to });
  const inter = cert({ cn: 'Test WWDR', pub: ik.publicKey, issuer: 'Test Root G3', issuerPriv: rk.privateKey, from, to: o.interTo ?? to, exts: o.noInterOid ? [] : [APPLE_INTER], serial: 2 });
  const leaf = cert({ cn: 'Test Leaf', pub: lk.publicKey, issuer: 'Test WWDR', issuerPriv: o.leafSigner ?? ik.privateKey, from, to: o.leafTo ?? to, exts: o.noLeafOid ? [] : [APPLE_LEAF], serial: 3, hash: o.leafHash ?? 'sha384' });
  return { root, inter, leaf, leafPriv: lk.privateKey, rootB64: root.toString('base64'), x5c: (withRoot = false) => [leaf, inter, ...(withRoot ? [root] : [])].map(x => x.toString('base64')) };
}
export function jws(c, payload, o = {}) {
  const head = { alg: o.alg ?? 'ES256', x5c: o.x5c ?? c.x5c(!!o.withRoot) };
  const h = b64u(JSON.stringify(head)), p = b64u(JSON.stringify(payload)), msg = Buffer.from(h + '.' + p);
  const sig = crypto.sign('sha256', msg, { key: o.signKey ?? c.leafPriv, dsaEncoding: 'ieee-p1363' });
  return h + '.' + p + '.' + b64u(sig);
}
let n = 1000;
export const tx = (o = {}) => ({ transactionId: String(++n) + String(Math.floor(Math.random() * 1e9)), originalTransactionId: '1', bundleId: 'com.nocticat.pingponglight',
  productId: 'com.nocticat.pingponglight.orb.star', purchaseDate: Date.now(), signedDate: Date.now(), type: 'Non-Consumable', environment: 'Production', quantity: 1, ...o });
