// Cross-check two sources of the same melody (ABC / LilyPond / MusicXML / MIDI track): align the pitch sequences and report how well they agree.
//   node tools/melcheck.mjs <A> <B> [--limit N] [--all] [--json]
//   <A>/<B> = path[#part=N][#track=N][#norepeat][#crop=startBeat:endBeat][#skip=N]
//     part  : voice (ABC) / melodic voice (LilyPond) / part (MusicXML) index, default 0;  track: MIDI track number (same as part)
//     crop  : only notes whose start beat (quarter notes from the first note) lies in [start, end)
//     skip  : drop the first N notes (e.g. an extra pickup)
// Method: each melody becomes (pitch, inter-onset interval in beats). B is moved by whole semitones (-24..24, starting from the median-pitch
// difference and the first long note) and its beats are scaled by 1/4..4 so a 2/4 and a 4/4 notation can meet; the pair of settings with the best
// semi-global Needleman-Wunsch score wins. Reported: pitch agreement (same pitch over aligned pairs, and over the longer melody) and rhythm
// agreement (same inter-onset interval over aligned pairs), then every disagreement with its bar number and the notes on both sides.
import { readFileSync } from 'node:fs';
import { loadScore, noteName } from './scorelib.mjs';
import { readMidi, skyline } from './songlib.mjs';
import { pathToFileURL } from 'node:url';

function midiTimeSig(path) {
  const b = readFileSync(path);
  for (let i = 0; i + 7 < b.length; i++) if (b[i] === 0xff && b[i + 1] === 0x58 && b[i + 2] === 0x04) return [b[i + 3], 2 ** b[i + 4]];
  return [4, 4];
}
export function loadMelody(spec) {
  const [path, ...opts] = spec.split('#'), o = {};
  for (const x of opts) { const [k, v] = x.split('='); o[k] = v === undefined ? true : v }
  const part = +(o.part ?? o.track ?? 0);
  let notes, meter, pickup = 0, info = '';
  if (/\.midi?$/i.test(path)) {
    const m = readMidi(path), t = m.tracks.find(x => x.i === part);
    if (!t) throw new Error(path + ': no track ' + part + ' (tracks: ' + m.tracks.map(x => x.i + ':' + x.notes.length).join(' ') + ')');
    const sky = skyline(t.notes.filter(n => n.ch !== 9));
    notes = sky.map(n => ({ b: n.t0 / m.div, db: (n.t1 - n.t0) / m.div, p: n.pitch }));
    const f = notes[0] ? notes[0].b : 0; notes.forEach(n => n.b -= f);
    meter = midiTimeSig(path); info = 'midi track ' + part;
  } else {
    const r = loadScore(path, { part, repeats: !o.norepeat });
    notes = r.notes.map(n => ({ b: n.b, db: n.db, p: n.p })); meter = r.meter; pickup = r.pickup; info = r.format + ' part ' + part;
    if (r.warnings.length) info += ' (' + r.warnings.length + ' warnings)';
  }
  if (o.crop) { const [a, b] = String(o.crop).split(':').map(Number); notes = notes.filter(n => n.b >= a - 1e-6 && n.b < b - 1e-6).map(n => ({ ...n, b: n.b - a })) }
  if (o.skip) { const k = +o.skip; const f = notes[k] ? notes[k].b : 0; notes = notes.slice(k).map(n => ({ ...n, b: n.b - f })) }
  return { path, notes, meter, pickup, barBeats: meter[0] * 4 / meter[1], info };
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0 };
function seqOf(m) {
  return m.notes.map((n, i) => ({ p: n.p, b: n.b, db: n.db, ioi: i + 1 < m.notes.length ? m.notes[i + 1].b - n.b : n.db }));
}
const sameIoi = (x, y) => Math.abs(x - y) <= Math.max(0.06, 0.08 * Math.max(x, y));
function align(A, B, shift, scale) {
  const n = A.length, m = B.length, G = -1.2, W = m + 1;
  const H = new Float32Array((n + 1) * W), D = new Uint8Array((n + 1) * W);   // 1 diag, 2 up (A only), 3 left (B only)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const a = A[i - 1], b = B[j - 1];
      const s = (a.p === b.p + shift ? 2 : -1) + (sameIoi(a.ioi, b.ioi * scale) ? 0.5 : 0);
      let best = H[(i - 1) * W + j - 1] + s, d = 1;
      const up = H[(i - 1) * W + j] + G, lf = H[i * W + j - 1] + G;
      if (up > best) { best = up; d = 2 }
      if (lf > best) { best = lf; d = 3 }
      H[i * W + j] = best; D[i * W + j] = d;
    }
  }
  // free end gaps: best cell on the last row / column
  let bi = n, bj = m, bs = -1e9;
  for (let j = 0; j <= m; j++) if (H[n * W + j] > bs) { bs = H[n * W + j]; bi = n; bj = j }
  for (let i = 0; i <= n; i++) if (H[i * W + m] > bs) { bs = H[i * W + m]; bi = i; bj = m }
  const ops = [];
  let i = bi, j = bj;
  while (i > 0 && j > 0) {
    const d = D[i * W + j];
    if (d === 1) { ops.push([i - 1, j - 1]); i--; j-- } else if (d === 2) { ops.push([i - 1, -1]); i-- } else { ops.push([-1, j - 1]); j-- }
  }
  while (i > 0) { ops.push([i - 1, -1]); i-- }
  while (j > 0) { ops.push([-1, j - 1]); j-- }
  ops.reverse();
  return { score: bs, ops };
}
const barOf = (m, b) => { const x = b - m.pickup; return x < -1e-6 ? 0 : Math.floor(x / m.barBeats + 1e-6) + 1 };
const beatIn = (m, b) => { const x = ((b - m.pickup) % m.barBeats + m.barBeats) % m.barBeats; return +(x + 1).toFixed(2) };
const fmt = (m, n) => n ? `${noteName(n.p)} 第${barOf(m, n.b)}小節第${beatIn(m, n.b)}拍(${+n.db.toFixed(2)}拍)` : '（無）';

export function melcheck(a, b, o = {}) {
  const A = seqOf(a), B0 = seqOf(b);
  if (!A.length || !B0.length) throw new Error('empty melody');
  const medDiff = Math.round(median(A.map(x => x.p)) - median(B0.map(x => x.p)));
  const longA = A.find(x => x.db >= 1.5) || A[0], longB = B0.find(x => x.db >= 1.5) || B0[0];
  const hint = [medDiff, longA.p - longB.p];
  let best = null;
  for (const scale of [1, 2, 0.5, 4, 0.25]) {
    const B = B0.map(x => ({ ...x, ioi: x.ioi * scale, db: x.db * scale, b: x.b * scale }));
    for (let shift = -24; shift <= 24; shift++) {
      const r = align(A, B, shift, 1);
      const bonus = hint.includes(shift) ? 0.01 : 0;
      if (!best || r.score + bonus > best.score) best = { ...r, score: r.score + bonus, shift, scale, B };
    }
  }
  const { ops, shift, scale, B } = best;
  let pairs = 0, same = 0, rhy = 0; const diffs = [];
  for (const [i, j] of ops) {
    if (i >= 0 && j >= 0) {
      pairs++;
      const x = A[i], y = B[j], ps = x.p === y.p + shift, rs = sameIoi(x.ioi, y.ioi);
      if (ps) same++; if (rs) rhy++;
      if (!ps) diffs.push({ type: '音高不同', a: x, b: y, ai: i, bj: j });
      else if (!rs) diffs.push({ type: '節奏不同', a: x, b: y, ai: i, bj: j, detail: `A間隔${+x.ioi.toFixed(2)}拍 B間隔${+(y.ioi / scale).toFixed(2)}拍` });
    } else if (i >= 0) diffs.push({ type: '只有A有', a: A[i], ai: i });
    else diffs.push({ type: '只有B有', b: B[j], bj: j });
  }
  const bm = { ...b, notes: b.notes, pickup: b.pickup, barBeats: b.barBeats };
  const res = {
    A: a.path, B: b.path, notesA: A.length, notesB: B0.length, shiftSemitones: shift, medianDiff: medDiff, beatScaleB: scale,
    alignedPairs: pairs, samePitch: same, sameRhythm: rhy,
    pitchRate: pairs ? same / pairs : 0, pitchRateStrict: same / Math.max(A.length, B0.length), rhythmRate: pairs ? rhy / pairs : 0, coverage: pairs / Math.max(A.length, B0.length),
    differences: diffs.map(d => ({ type: d.type, barA: d.a ? barOf(a, d.a.b) : null, barB: d.b ? barOf(bm, d.b.b / scale) : null, A: d.a ? noteName(d.a.p) : null, B: d.b ? noteName(d.b.p + shift) + '(移調後)' : null, detail: d.detail })),
  };
  res._text = () => {
    const L = [];
    L.push(`A: ${a.path}  [${a.info}] ${A.length} 音，${a.meter.join('/')} 拍`);
    L.push(`B: ${b.path}  [${b.info}] ${B0.length} 音，${b.meter.join('/')} 拍`);
    L.push(`正規化：B 移調 ${shift >= 0 ? '+' : ''}${shift} 半音（中位數差 ${medDiff}），B 的拍長 x${scale}`);
    L.push(`對齊 ${pairs} 對（涵蓋率 ${(100 * res.coverage).toFixed(1)}%）`);
    L.push(`音高一致率：${(100 * res.pitchRate).toFixed(1)}%（${same}/${pairs} 對齊音；以較長旋律為分母 ${(100 * res.pitchRateStrict).toFixed(1)}%）`);
    L.push(`節奏一致率：${(100 * res.rhythmRate).toFixed(1)}%（${rhy}/${pairs}，以到下一個音的間隔比較）`);
    const lim = o.all ? Infinity : (o.limit ?? 40);
    L.push(diffs.length ? `不一致 ${diffs.length} 處${diffs.length > lim ? '（只列前 ' + lim + ' 筆，--all 看全部）' : ''}：` : '兩份旋律完全一致。');
    for (const d of diffs.slice(0, lim)) {
      const bb2 = d.b ? { ...b, notes: [], pickup: b.pickup } : null;
      const ba = d.a ? fmt(a, d.a) : null, bbs = d.b ? fmt(bb2, { ...d.b, p: d.b.p + shift, b: d.b.b / scale, db: d.b.db / scale }) : null;
      L.push(`  ${d.type.padEnd(4, '　')} A=${ba ?? '（無）'}  B=${bbs ?? '（無）'}${d.detail ? '  ' + d.detail : ''}`);
    }
    return L.join('\n');
  };
  return res;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const a = process.argv.slice(2), files = a.filter((x, i) => !x.startsWith('--') && a[i - 1] !== '--limit');
  if (files.length !== 2) { console.log('usage: node tools/melcheck.mjs <A> <B> [--limit N] [--all] [--json]   (path[#part=N][#track=N][#norepeat][#crop=a:b][#skip=N])'); process.exit(1) }
  const res = melcheck(loadMelody(files[0]), loadMelody(files[1]), { limit: a.includes('--limit') ? +a[a.indexOf('--limit') + 1] : 40, all: a.includes('--all') });
  if (a.includes('--json')) { const t = res._text; delete res._text; console.log(JSON.stringify(res, null, 1)); void t } else console.log(res._text());
}
