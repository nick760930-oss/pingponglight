// Starshade (/lb/shade, /lb/shadeset) and invitations (/lb/inv, /lb/redeem, inviteDone, delete). No server needed: node test/shade.mjs
// handleLb runs in this process against an in-memory SQLite (node:sqlite) wrapped like D1; every migration is applied to it.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { handleLb } from '../src/lb.js';
import { inviteDone, INV_CAP, cleanCode } from '../src/shade.js';
import { CHARTS } from '../src/charts.js';

const SRV = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const sql = new DatabaseSync(':memory:');
for (const f of readdirSync(join(SRV, 'migrations')).filter(f => f.endsWith('.sql')).sort()) sql.exec(readFileSync(join(SRV, 'migrations', f), 'utf8'));
class Stmt {
  constructor(q, a = []) { this.q = q; this.a = a; }
  bind(...a) { return new Stmt(this.q, a); }
  async first() { return sql.prepare(this.q).get(...this.a) ?? null; }
  async all() { return { results: sql.prepare(this.q).all(...this.a) }; }
  async run() { const r = sql.prepare(this.q).run(...this.a); return { success: true, meta: { changes: Number(r.changes) } }; }
}
const DB = { prepare: q => new Stmt(q), async batch(list) { const out = []; sql.exec('BEGIN'); try { for (const s of list) out.push(await s.run()); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } return out; } };
const env = { LB: DB, LB_SECRET: 'shade-test-secret' };
let net = 0;
async function post(path, body, who = '203.0.113.' + (++net % 250 + 1), limited = async () => false) {
  const r = await handleLb(new Request('http://t' + path, { method: 'POST', body: JSON.stringify(body) }), env, path, who, null, {}, limited);
  return { s: r.status, j: await r.json() };
}
const q1 = (s, ...a) => sql.prepare(s).get(...a), qa = (s, ...a) => sql.prepare(s).all(...a);
let pn = 0;
const nick = n => 'Nn' + n.toString(2).padStart(7, '0').replace(/0/g, 'r').replace(/1/g, 'l');
async function player(named = true) { const pk = crypto.randomBytes(16).toString('hex'); if (!named) return { pk }; const r = await post('/lb/name', { pk, name: nick(++pn) }); if (!r.j.id) throw new Error('nickname refused'); return { pk, id: r.j.id, name: nick(pn) }; }
const S = 'twinkle', D = 1, N = CHARTS[S].n[D], BOARD = S + '-' + D;
const goodLog = () => Array.from({ length: N }, (_, i) => [(i % 7) - 3, 100]);
// a stored best run for a player (what /lb/submit leaves behind), with a given score
function seed(p, score, o = {}) {
  sql.prepare('INSERT OR REPLACE INTO scores (board, pid, key, acc, err, combo, ts, hid, log, score) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(o.board || BOARD, p.id, 9000e9 + score, 9000, 20, 10, o.ts || Date.now(), o.hid || 0, o.log === undefined ? JSON.stringify(goodLog()) : o.log, score);
}

// ---- starshade: who is picked ----
{
  const me = await player(), a = await player(), b = await player(), c = await player(), noLog = await player(), hid = await player(), off = await player(), cut = await player();
  seed(me, 5000); seed(a, 1000); seed(b, 4800); seed(c, 9000);
  seed(noLog, 5001, { log: null }); seed(hid, 5002); seed(off, 5003); seed(cut, 5004, { log: JSON.stringify(goodLog().slice(1)) });
  sql.prepare('UPDATE players SET hidden = 1 WHERE id = ?').run(hid.id);
  await post('/lb/shadeset', { pk: off.pk, v: 0 });
  let r = await post('/lb/shade', { pk: me.pk, k: S, d: D });
  ok(r.j.name === b.name && r.j.score === 4800, 'the nearest score to mine is picked, never mine / hidden / switched off / no log / short log (got ' + JSON.stringify([r.j.name, r.j.score]) + ')');
  ok(Array.isArray(r.j.log) && r.j.log.length === N && typeof r.j.lv === 'number' && r.j.lv >= 1, 'answer has the whole log and a level');
  ok(!('pk' in r.j) && !('id' in r.j) && !('ph' in r.j), 'no identity in the answer');
  await post('/lb/shadeset', { pk: b.pk, v: 0 });
  r = await post('/lb/shade', { pk: me.pk, k: S, d: D });
  ok(r.j.name === a.name || r.j.name === c.name, 'a player who switches it off is not picked again, at once (' + r.j.name + ')');
  ok(r.j.name === c.name, 'then the next nearest (9000 is 4000 away, 1000 is 4000 away: the newer one wins a tie, or either) ' + r.j.name);
  const r2 = await post('/lb/shadeset', { pk: b.pk });
  ok(r2.j.shade === 0, 'read back: off');
  ok((await post('/lb/shadeset', { pk: b.pk, v: 1 })).j.shade === 1, 'and on again');
  ok((await post('/lb/shadeset', { pk: b.pk, v: 7 })).s === 400, 'a bad value is refused');
}
// no record of my own: the median of the board; nobody: none
{
  const me = await player(), e = await player();
  const far = [await player(), await player(), await player()];
  ok((await post('/lb/shade', { pk: me.pk, k: 'prelude', d: 2 })).j.none === true, 'a board nobody played: none');
  seed(far[0], 100, { board: 'prelude-2' }); seed(far[1], 500, { board: 'prelude-2', log: JSON.stringify(Array.from({ length: CHARTS.prelude.n[2] }, () => [0, 50])) }); seed(far[2], 900, { board: 'prelude-2' });
  const lg = JSON.stringify(Array.from({ length: CHARTS.prelude.n[2] }, () => [1, 60]));
  for (const f of far) sql.prepare('UPDATE scores SET log = ? WHERE pid = ?').run(lg, f.id);
  const r = await post('/lb/shade', { pk: me.pk, k: 'prelude', d: 2 });
  ok(r.j.score === 500 && r.j.name === far[1].name, 'no record of my own: the median one (got ' + r.j.score + ')');
  ok((await post('/lb/shade', { pk: e.pk, k: 'nosuchsong', d: 2 })).s === 400, 'unknown song: refused');
  ok((await post('/lb/shade', { pk: e.pk, k: S, d: 9 })).s === 400, 'unknown difficulty: refused');
  ok((await post('/lb/shade', { pk: 'zz', k: S, d: D })).s === 400, 'bad key: refused');
}
// no nickname
{
  const anon = await player(false);
  const r = await post('/lb/shade', { pk: anon.pk, k: S, d: D });
  ok(r.s === 400 && r.j.error === 'noname', 'no nickname: noname');
  ok((await post('/lb/inv', { pk: anon.pk })).j.error === 'noname', 'invite code needs a nickname');
  ok((await post('/lb/redeem', { pk: anon.pk, code: 'ABCDEF' })).j.error === 'noname', 'redeem needs a nickname');
}

// ---- invitations ----
const codeOf = async p => (await post('/lb/inv', { pk: p.pk })).j.code;
{
  const A = await player(), B = await player(), C = await player();
  const r1 = await post('/lb/inv', { pk: A.pk }), r2 = await post('/lb/inv', { pk: A.pk });
  ok(r1.j.ok && /^[A-HJKMNP-Z2-9]{6}$/.test(r1.j.code), 'a 6 character code without 0 O 1 I L (' + r1.j.code + ')');
  ok(r1.j.code === r2.j.code, 'the code is fixed once made');
  ok(r1.j.n === 0 && r1.j.m === 0 && r1.j.used === false, 'nothing yet');
  const codes = new Set(); for (let i = 0; i < 30; i++) codes.add(await codeOf(await player()));
  ok(codes.size === 30, 'codes are unique');
  ok(cleanCode(' ab-cd ef ') === 'ABCDEF' && cleanCode('ABCDE0') === '' && cleanCode('ABC') === '', 'cleanCode: case, separators, forbidden characters, length');
  ok((await post('/lb/redeem', { pk: A.pk, code: r1.j.code })).j.error === 'self', 'not my own code');
  ok((await post('/lb/redeem', { pk: B.pk, code: 'ABC' })).j.error === 'code', 'a malformed code');
  ok((await post('/lb/redeem', { pk: B.pk, code: 'AAAAAA' })).s === 404, 'an unknown code');
  ok((await post('/lb/redeem', { pk: B.pk, code: r1.j.code.toLowerCase() })).j.ok === true, 'B redeems A (lower case is fine)');
  ok((await post('/lb/redeem', { pk: B.pk, code: r1.j.code })).j.error === 'already', 'once per player');
  ok((await post('/lb/redeem', { pk: B.pk, code: await codeOf(C) })).j.error === 'already', 'not a second inviter either');
  const ia = await post('/lb/inv', { pk: A.pk }), ib = await post('/lb/inv', { pk: B.pk });
  ok(ia.j.n === 1 && ia.j.m === 0 && ib.j.used === true && ib.j.done === false, 'A invited 1, none done; B used a code');
  // already cleared: refused
  const Z = await player(); seed(Z, 700);
  ok((await post('/lb/redeem', { pk: Z.pk, code: r1.j.code })).j.error === 'cleared', 'a player with a clear is refused');
  ok((await post('/lb/redeem', { pk: C.pk, code: r1.j.code }, '198.51.100.9', async () => true)).s === 429, 'the rate limit answers 429');
  // the first clear finishes it, once, both sides get the cosmetic once
  ok(await inviteDone(DB, B.id, 1000) === true, 'B first clear: done');
  ok(await inviteDone(DB, B.id, 2000) === false, 'a second clear does nothing');
  const own = id => qa("SELECT item, src, ref FROM ents WHERE pid = ? AND item = 'hit.companion'", id);
  ok(own(B.id).length === 1 && own(B.id)[0].src === 'invite', 'B got hit.companion once');
  ok(own(A.id).length === 1 && own(A.id)[0].ref === 'by:' + B.id, 'A got hit.companion once for B');
  const ia2 = await post('/lb/inv', { pk: A.pk });
  ok(ia2.j.n === 1 && ia2.j.m === 1 && (await post('/lb/inv', { pk: B.pk })).j.done === true, 'counts: invited 1, done 1');
  ok(await inviteDone(DB, C.id, 1) === false && own(C.id).length === 0, 'no invitation: nothing granted');
}
// a real first clear through /lb/submit finishes the invitation (the answer says inv: 1), a second clear does not
{
  const b64u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const ticket = (song, d, ageMs) => { const p = [song, d, Date.now() - ageMs, crypto.randomBytes(8).toString('hex')].join('.'); return p + '.' + b64u(crypto.createHmac('sha256', env.LB_SECRET).update(p).digest()); };
  function humanLog(n, spread = 30, seed = 1) {
    let x = seed; const rnd = () => (x = (x * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: n }, () => { const e = Math.round((rnd() + rnd() + rnd() - 1.5) * spread * 1.6), a = Math.abs(e); const m = a < 45 ? 3 : a < 90 ? 2 : a < 150 ? 1.2 : 1; return [e, Math.round(100 * m * (1 + rnd()))]; });
  }
  const A = await player(), B = await player(); await post('/lb/redeem', { pk: B.pk, code: await codeOf(A) });
  const r1 = await post('/lb/submit', { run: ticket(S, D, 120e3), pk: B.pk, log: humanLog(N, 30, 7) });
  ok(r1.j.ok === true && r1.j.inv === 1, 'first clear through /lb/submit: inv 1 (' + JSON.stringify(r1.j).slice(0, 120) + ')');
  const has = id => qa("SELECT 1 FROM ents WHERE pid = ? AND item = 'hit.companion'", id).length;
  ok(has(A.id) === 1 && has(B.id) === 1, 'both got hit.companion');
  const r2 = await post('/lb/submit', { run: ticket(S, D, 120e3), pk: B.pk, log: humanLog(N, 30, 9) });
  ok(r2.j.ok === true && !r2.j.inv, 'a second clear: no inv flag');
  ok(q1('SELECT done FROM invites WHERE invitee = ?', B.id).done === 1, 'invitation done');
}
// the inviter cap: the first INV_CAP finished invitations give the inviter a row each (ref by:<invitee>), the 21st gives nothing
{
  const A = await player(), code = await codeOf(A), inv = [];
  for (let i = 0; i < INV_CAP + 1; i++) { const p = await player(); inv.push(p); await post('/lb/redeem', { pk: p.pk, code }); }
  for (const p of inv) await inviteDone(DB, p.id, Date.now());
  const own = id => qa("SELECT 1 FROM ents WHERE pid = ? AND item = 'hit.companion'", id).length;
  ok(inv.every(p => own(p.id) === 1), 'every invitee got the cosmetic, also the 21st');
  const refs = qa("SELECT ref FROM ents WHERE pid = ? AND item = 'hit.companion' AND src = 'invite'", A.id).map(r => r.ref);
  ok(refs.length === INV_CAP, 'the inviter has ' + INV_CAP + ' grant rows (got ' + refs.length + ')');
  ok(!refs.includes('by:' + inv[INV_CAP].id) && refs.includes('by:' + inv[0].id), 'the 21st invitee gave the inviter nothing, the first did');
  const info = await post('/lb/inv', { pk: A.pk });
  ok(info.j.n === INV_CAP + 1 && info.j.m === INV_CAP + 1, 'the numbers still count the 21st (' + info.j.n + '/' + info.j.m + ')');
}
// delete my online data
{
  const A = await player(), B = await player(), C = await player(), code = await codeOf(A);
  await post('/lb/redeem', { pk: B.pk, code }); await codeOf(B); await post('/lb/redeem', { pk: A.pk, code: await codeOf(C) });
  await post('/lb/delete', { pk: A.pk });
  ok(!q1('SELECT 1 AS x FROM invcodes WHERE pid = ?', A.id), 'A: code gone');
  ok(!q1('SELECT 1 AS x FROM invites WHERE invitee = ? OR inviter = ?', A.id, A.id), 'A: invitations (both directions) gone');
  ok(!!q1('SELECT 1 AS x FROM invcodes WHERE pid = ?', B.id), 'B keeps its own code');
  await post('/lb/delete', { pk: B.pk });
  ok(!q1('SELECT 1 AS x FROM invcodes WHERE pid = ?', B.id), 'B: code gone');
}
// deleting the invitee clears the reference on the inviter's cosmetic, the cosmetic stays
{
  const A = await player(), B = await player(), C = await player(), D2 = await player();
  await post('/lb/redeem', { pk: B.pk, code: await codeOf(A) });
  await inviteDone(DB, B.id, Date.now());
  const refs = id => qa("SELECT ref FROM ents WHERE pid = ? AND item = 'hit.companion'", id).map(r => r.ref);
  ok(refs(A.id).length === 1 && refs(A.id)[0] === 'by:' + B.id, 'A holds the cosmetic for B');
  await post('/lb/delete', { pk: B.pk });
  ok(refs(A.id).length === 1 && refs(A.id)[0] === '', 'B deleted: A keeps the cosmetic, ref cleared (' + JSON.stringify(refs(A.id)) + ')');
  // a clash: D2 holds the cosmetic with an empty ref already (D2 was invited by C) and also invited C2 -> the by: row folds into the existing one
  await post('/lb/redeem', { pk: D2.pk, code: await codeOf(C) });
  await inviteDone(DB, D2.id, Date.now());
  const E = await player(); await post('/lb/redeem', { pk: E.pk, code: await codeOf(D2) });
  await inviteDone(DB, E.id, Date.now());
  ok(refs(D2.id).length === 2, 'D2 holds both an empty-ref row and a by: row before the delete');
  await post('/lb/delete', { pk: E.pk });
  ok(refs(D2.id).length === 1 && refs(D2.id)[0] === '', 'E deleted: D2 still has the cosmetic once (' + JSON.stringify(refs(D2.id)) + ')');
}
console.log(`shade/invites: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
