// Builds ach-data.js (the achievement list the game's achievement page draws) from
//   - server/src/achdata.js   category, tier, name (= the achievement id, never changes), points, who decides it, title  (read only)
//   - server/src/ach.js       which ones are not decided yet (NA) and which items each one gives (rewardsOf)
//   - docs/design/cosmetics-catalog.html   the condition and reward texts (the ACH array of the design catalogue)
// The page is completely data driven: when the rating rules or the list change, edit those sources and run this again.
//
//   node tools/achdata.mjs           writes ach-data.js
//   node tools/achdata.mjs --check   fails (exit 1) when ach-data.js is not what the sources give now
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'ach-data.js');
const imp = p => import(pathToFileURL(join(ROOT, p)).href);

// stderr noise about the server package not being "type: module" is harmless here
const { ACHDATA } = await imp('server/src/achdata.js');
const { ACHS, NA, rewardsOf } = await imp('server/src/ach.js');
const { CONS } = await imp('server/src/charts.js');

// the design catalogue's ACH array: [] = a page title, otherwise [tier, id, condition, reward html, points, mark, title?, shown name?]
//   id = the achievement id (stored in players' data: never rename it); the shown name is the 8th element when it differs from the id.
//   RWN (number of reward songs) and CONSPTS (points of the ten "○○座完成") are constants of that page: they are checked against the server data here.
const html = readFileSync(join(ROOT, 'docs/design/cosmetics-catalog.html'), 'utf8');
const a0 = html.indexOf('const ACH=['), a1 = html.indexOf('\n];', a0);
if (a0 < 0 || a1 < 0) throw new Error('the ACH array was not found in docs/design/cosmetics-catalog.html');
const rwn = CONS.filter(c => c[2]).reduce((n, c) => n + c[1].length, 0);
const m1 = html.match(/const RWN=(\d+);/), m2 = html.match(/const CONSPTS=(\[[\d,]+\]);/);
if (!m1 || +m1[1] !== rwn) throw new Error(`design page says RWN=${m1 && m1[1]}, the data has ${rwn} reward songs`);
if (!m2) throw new Error('design page has no CONSPTS');
const DESIGN = new Function('RWN', 'CONSPTS', 'return ' + html.slice(a0 + 'const ACH='.length, a1 + 2))(rwn, JSON.parse(m2[1])).filter(x => x.length > 1);
const cosSrc = readFileSync(join(ROOT, 'cosmetics.js'), 'utf8');
if (!cosSrc.includes(`全部 ${rwn} 首獎勵曲`)) throw new Error(`cosmetics.js: the title "拾遺" should say ${rwn} reward songs`);

if (DESIGN.length !== ACHDATA.length) throw new Error(`design list has ${DESIGN.length} achievements, server/src/achdata.js has ${ACHDATA.length}`);
const plain = s => String(s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const list = [], cats = [];
ACHDATA.forEach(([cat, tier, name, pts, chk, title], i) => {
  const [dt, dn, cond, rew, dp, , dtitle, dnm] = DESIGN[i], grp = name.startsWith('○○座完成');
  if (dn !== name || dt !== tier || (!grp && dp !== pts)) throw new Error(`#${i} differs: server "${name}" t${tier} ${pts}p, design "${dn}" t${dt} ${dp}p`);
  if (title && dtitle !== title) throw new Error(`#${i} "${name}": title ${JSON.stringify(title)} on the server, ${JSON.stringify(dtitle)} in the design`);
  if (!title && dtitle) throw new Error(`#${i} "${name}": the design has a title, server/src/achdata.js has none`);
  if (!cats.includes(cat)) cats.push(cat);
  const make = (id, nm, desc, reward, p = pts) => ({
    id, cat: cats.indexOf(cat), tier, name: nm, desc, reward, pts: p, chk,               // chk: s = the server decides, l = this device decides, v = needs verified duel results (not open yet)
    ...(NA.includes(id) ? { na: 1 } : {}),                                              // not decidable yet: shown as "coming soon"
    ...(/限定/.test(rew) ? { lim: 1 } : {}),                                            // only obtainable by this achievement
    rw: rewardsOf(id),                                                                  // catalogue ids of the items it gives (titles: title.*)
  });
  if (name.startsWith('○○座完成')) {                                                    // one achievement per constellation
    CONS.slice(0, 10).forEach((c, k) => {
      const id = c[0] + '完成';
      if (!ACHS[id]) throw new Error('server has no achievement ' + id);
      if (JSON.parse(m2[1])[k] !== ACHS[id].pts) throw new Error(`design CONSPTS[${k}] = ${JSON.parse(m2[1])[k]}, the server gives ${ACHS[id].pts} points for ${id}`);
      list.push(make(id, id, `通關「${c[0]}」的全部曲目`, '限定：該星座的徽章頭像', ACHS[id].pts));
    });
    return;
  }
  if (!ACHS[name]) throw new Error('server has no achievement ' + name);
  list.push(make(name, dnm || name, plain(cond), plain(rew)));
});
for (const id of Object.keys(ACHS)) if (!list.some(x => x.id === id)) throw new Error('achievement ' + id + ' is on the server but not in the list');

const tabs = cats.map(c => c.replace(/（.*）/, ''));
const body = `/* GENERATED by tools/achdata.mjs from server/src/achdata.js, server/src/ach.js and docs/design/cosmetics-catalog.html.
   Do not edit by hand: change the sources and run \`node tools/achdata.mjs\` (\`--check\` compares). */
window.PPLACH=${JSON.stringify({ tabs, list })};
`;
if (process.argv.includes('--check')) {
  let cur = ''; try { cur = readFileSync(OUT, 'utf8'); } catch (e) { /* missing */ }
  if (cur !== body) { console.error('ach-data.js is out of date: run  node tools/achdata.mjs'); process.exit(1); }
  console.log(`ach-data.js is up to date (${list.length} achievements, ${tabs.length} pages)`);
} else {
  writeFileSync(OUT, body);
  console.log(`ach-data.js written: ${list.length} achievements, ${tabs.length} pages, ${list.filter(x => x.chk === 'l').length} decided on the device, ${list.filter(x => x.na || x.chk === 'v').length} coming soon`);
}
