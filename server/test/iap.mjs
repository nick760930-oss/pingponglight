// StoreKit JWS verification tests (no server needed): node test/iap.mjs   (npm run test:iap)
// A throw-away certificate chain (test/pki.mjs) stands in for Apple's; its root is handed to verifyJws directly.
import { verifyJws, parseCert, loadRoot, pinOk, APPLE_ROOT_G3_B64, APPLE_ROOT_G3_SHA256 } from '../src/iap.js';
import { chain, jws, tx, key } from './pki.mjs';
import crypto from 'node:crypto';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const good = chain(), R = parseCert(good.root), t = () => tx();
(async () => {
  let v = await verifyJws(jws(good, t()), R); ok(v.ok && v.payload.bundleId === 'com.nocticat.pingponglight', 'valid chain without the root in x5c');
  v = await verifyJws(jws(good, t(), { withRoot: true }), R); ok(v.ok, 'valid chain with the root included');
  // the chain's root must be the pinned one
  const other = chain(); v = await verifyJws(jws(good, t()), parseCert(other.root)); ok(!v.ok && v.why === 'chain', 'chain from another root refused: ' + v.why);
  v = await verifyJws(jws(other, t()), R); ok(!v.ok, 'foreign chain refused');
  v = await verifyJws(jws(good, t(), { x5c: [good.leaf, good.inter, other.root].map(x => x.toString('base64')) }), R); ok(!v.ok, 'foreign root attached refused');
  // signature
  const j = jws(good, t()), [h, p, s] = j.split('.');
  const p2 = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), productId: 'com.nocticat.pingponglight.full' })).toString('base64url');
  v = await verifyJws(h + '.' + p2 + '.' + s, R); ok(!v.ok && v.why === 'signature', 'tampered payload refused: ' + v.why);
  v = await verifyJws(jws(good, t(), { signKey: key('P-256').privateKey }), R); ok(!v.ok && v.why === 'signature', 'signed by another key refused');
  v = await verifyJws(h + '.' + p + '.' + s.slice(0, -4) + 'AAAA', R); ok(!v.ok, 'damaged signature refused');
  v = await verifyJws(h + '.' + p + '.', R); ok(!v.ok, 'empty signature refused');
  v = await verifyJws(jws(good, t(), { alg: 'none' }), R); ok(!v.ok && v.why === 'header', 'alg none refused');
  v = await verifyJws(jws(good, t(), { alg: 'HS256' }), R); ok(!v.ok, 'alg HS256 refused');
  v = await verifyJws(jws(good, t(), { x5c: [] }), R); ok(!v.ok, 'no certificates refused');
  v = await verifyJws(jws(good, t(), { x5c: [good.leaf.toString('base64')] }), R); ok(!v.ok, 'leaf alone refused');
  v = await verifyJws(jws(good, t(), { x5c: [good.inter, good.leaf].map(x => x.toString('base64')) }), R); ok(!v.ok, 'chain in the wrong order refused');
  v = await verifyJws('a.b', R); ok(!v.ok, 'two parts refused'); v = await verifyJws('', R); ok(!v.ok, 'empty refused'); v = await verifyJws(null, R); ok(!v.ok, 'null refused');
  v = await verifyJws(jws(good, t()), null); ok(!v.ok, 'no root: nothing is accepted');
  // Apple's marker extensions
  const nl = chain({ noLeafOid: true }); v = await verifyJws(jws(nl, t()), parseCert(nl.root)); ok(!v.ok && v.why === 'apple', 'leaf without the Apple marker refused: ' + v.why);
  const ni = chain({ noInterOid: true }); v = await verifyJws(jws(ni, t()), parseCert(ni.root)); ok(!v.ok && v.why === 'apple', 'intermediate without the Apple marker refused: ' + v.why);
  // a leaf signed by something other than the intermediate
  const ls = chain({ leafSigner: key('P-384').privateKey }); v = await verifyJws(jws(ls, t()), parseCert(ls.root)); ok(!v.ok && v.why === 'chain', 'leaf not signed by the intermediate refused: ' + v.why);
  // SHA-256 certificate signatures under a P-384 issuer work too
  const s2 = chain({ leafHash: 'sha256' }); v = await verifyJws(jws(s2, t()), parseCert(s2.root)); ok(v.ok, 'ecdsa-with-SHA256 certificate signature accepted');
  // validity is judged at the transaction's signing time
  const now = Date.now(), Y = 365 * 86400e3;
  const old = chain({ from: now - 3 * Y, to: now - Y });
  v = await verifyJws(jws(old, t()), parseCert(old.root), now); ok(!v.ok && v.why === 'expired', 'expired chain refused: ' + v.why);
  v = await verifyJws(jws(old, tx({ signedDate: now - 2 * Y })), parseCert(old.root), now); ok(v.ok, 'an old receipt is judged at its own signing time');
  const lt = chain({ leafTo: now - Y }); v = await verifyJws(jws(lt, t()), parseCert(lt.root)); ok(!v.ok && v.why === 'expired', 'expired leaf refused: ' + v.why);
  const nf = chain({ from: now + Y, to: now + 3 * Y }); v = await verifyJws(jws(nf, t()), parseCert(nf.root)); ok(!v.ok && v.why === 'expired', 'chain not yet valid refused: ' + v.why);
  v = await verifyJws(jws(old, tx({ signedDate: now + 10 * 86400e3 })), parseCert(old.root), now); ok(!v.ok, 'a signing date in the future does not buy extra validity');
  v = await verifyJws(jws(good, { ...t(), pad: 'x'.repeat(20000) }), R); ok(!v.ok, 'oversized refused');
  // the pinned root
  ok(APPLE_ROOT_G3_SHA256 === '63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179', 'fingerprint constant is Apple Root CA - G3 (63:34:3A:BF:...:E9:17:9)');
  ok(!(await pinOk(good.root)), 'a certificate with another fingerprint is not the pinned root');
  ok(!(await pinOk(crypto.randomBytes(500))), 'random bytes are not the pinned root');
  if (!APPLE_ROOT_G3_B64) ok((await loadRoot({})) === null, 'root not filled in: loadRoot gives null (iap off)');
  else ok((await loadRoot({})) !== null, 'the pinned Apple root loads (fingerprint matches)');
  if (!APPLE_ROOT_G3_B64) ok((await loadRoot({ IAP_TEST_ROOT_B64: good.rootB64 })) === null, 'a test root is ignored unless ALLOW_LOCAL=1');
  ok((await loadRoot({ ALLOW_LOCAL: '1', IAP_TEST_ROOT_B64: good.rootB64 })) !== null, 'a test root is used with ALLOW_LOCAL=1');
  console.log(fail ? 'FAILED' : 'iap tests passed', pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
