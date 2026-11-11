// Song sources -> game note lists. A note is [startCs, durCs, midiPitch, kind]:
// kind 1 = tune (the player plays it), 3 = counter-melody, 0 = accompaniment, 2 = drum.
import { readFileSync } from 'node:fs';

/* ---------------- MIDI (Standard MIDI File, format 0 or 1) ---------------- */
export function readMidi(path) {
  const b = readFileSync(path);
  let p = 0;
  const u32 = () => (b[p++] << 24 | b[p++] << 16 | b[p++] << 8 | b[p++]) >>> 0, u16 = () => b[p++] << 8 | b[p++];
  const vlq = () => { let v = 0, c; do { c = b[p++]; v = v * 128 + (c & 127) } while (c & 128); return v };
  if (b.toString('latin1', 0, 4) !== 'MThd') throw new Error(path + ': not a MIDI file');
  p = 4; const hl = u32(), fmt = u16(), ntr = u16(), div = u16(); p = 8 + hl;
  if (div & 0x8000) throw new Error(path + ': SMPTE timing is not supported');
  const tracks = [], tempos = [];
  for (let t = 0; t < ntr && p < b.length; t++) {
    const id = b.toString('latin1', p, p + 4); p += 4; const len = u32(), end = p + len;
    if (id !== 'MTrk') { p = end; t--; continue }
    let tick = 0, run = 0, name = '';
    const on = new Map(), notes = [], prog = new Set();
    while (p < end) {
      tick += vlq();
      let st = b[p];
      if (st & 0x80) p++; else st = run;
      if (st === 0xff) {
        const ty = b[p++], l = vlq();
        if (ty === 0x51) tempos.push([tick, b[p] << 16 | b[p + 1] << 8 | b[p + 2]]);
        if (ty === 0x03 && !name) name = b.toString('latin1', p, p + l);
        p += l; continue;
      }
      if (st === 0xf0 || st === 0xf7) { p += vlq(); continue }
      run = st;
      const hi = st & 0xf0, ch = st & 15;
      if (hi === 0xc0 || hi === 0xd0) { if (hi === 0xc0) prog.add(b[p]); p++; continue }
      const d1 = b[p++], d2 = b[p++];
      if (hi === 0x90 && d2 > 0) { const k = ch * 128 + d1; if (!on.has(k)) on.set(k, []); on.get(k).push([tick, d2]) }
      else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) {
        const k = ch * 128 + d1, q = on.get(k);
        if (q && q.length) { const [t0, v] = q.shift(); notes.push({ t0, t1: tick, pitch: d1, ch, vel: v }) }
      }
    }
    p = end;
    tracks.push({ name, notes, ch: [...new Set(notes.map(n => n.ch))], prog: [...prog] });
  }
  tempos.sort((a, c) => a[0] - c[0]);
  if (!tempos.length || tempos[0][0] > 0) tempos.unshift([0, 500000]);
  // ticks -> seconds through the tempo map
  const seg = []; let sec = 0;
  for (let i = 0; i < tempos.length; i++) {
    const [tk, us] = tempos[i];
    if (i) sec += (tk - tempos[i - 1][0]) * tempos[i - 1][1] / 1e6 / div;
    seg.push([tk, sec, us]);
  }
  const toSec = tick => { let s = seg[0]; for (const x of seg) { if (x[0] <= tick) s = x; else break } return s[1] + (tick - s[0]) * s[2] / 1e6 / div };
  for (const tr of tracks) for (const n of tr.notes) { n.s = toSec(n.t0); n.e = toSec(n.t1) }
  return { fmt, div, tracks: tracks.map((t, i) => ({ ...t, i })) };
}

// the top voice of a set of notes: at each onset keep the highest note, and cut it where the next tune note starts
export function skyline(notes, gap = 0.03) {
  const s = [...notes].sort((a, b) => a.s - b.s || b.pitch - a.pitch), out = [];
  for (const n of s) {
    const last = out[out.length - 1];
    if (last && n.s - last.s < gap) { if (n.pitch > last.pitch) out[out.length - 1] = n; continue }
    if (last && n.s < last.e && n.pitch < last.pitch - 2 && last.e - n.s > 0.08) continue;   // an inner voice under a held tune note
    out.push(n);
  }
  return out.map((n, i) => { const nx = out[i + 1]; return { ...n, e: nx ? Math.min(n.e, nx.s) : n.e } });
}

/* spec.midi = { file, mel: trackIndex | [tracks], ctr?: track, drop?: [tracks], crop?: [startSec, endSec],
                 transpose?: semitones, melShift?: semitones (tune only), speed?: 1, minDur?: seconds } */
export function fromMidi(spec, root) {
  const m = spec.midi, mid = readMidi(root + '/' + m.file);
  const melT = [].concat(m.mel), drop = new Set(m.drop || []), [c0, c1] = m.crop || [0, 1e9], sp = m.speed || 1;
  const inCrop = n => n.s >= c0 - 1e-3 && n.s < c1;
  const pick = ts => mid.tracks.filter(t => ts.includes(t.i)).flatMap(t => t.notes).filter(n => n.ch !== 9 && inCrop(n));
  const mel = skyline(pick(melT)), melSet = new Set(mel.map(n => n.s.toFixed(3) + ':' + n.pitch));
  const ctr = m.ctr != null ? skyline(pick([].concat(m.ctr))) : [];
  const ctrT = [].concat(m.ctr ?? []), bk = [];
  for (const t of mid.tracks) {   // everything else accompanies, including the inner voices of the tune's own track
    if (drop.has(t.i) || ctrT.includes(t.i)) continue;
    for (const n of t.notes) {
      if (n.ch === 9 || !inCrop(n)) continue;
      if (melT.includes(t.i) && melSet.has(n.s.toFixed(3) + ':' + n.pitch)) continue;
      bk.push(n);
    }
  }
  const tr = m.transpose || 0, ms = m.melShift || 0, minD = m.minDur || 0.06;
  const cs = x => Math.round((x - c0) / sp * 100);
  const out = [];
  for (const n of mel) if (n.e - n.s >= 0.02) out.push([cs(n.s), Math.max(Math.round(minD * 100), cs(n.e) - cs(n.s)), n.pitch + tr + ms, 1]);
  for (const n of ctr) out.push([cs(n.s), Math.max(4, cs(n.e) - cs(n.s)), n.pitch + tr, 3]);
  for (const n of bk) out.push([cs(n.s), Math.max(4, cs(n.e) - cs(n.s)), n.pitch + tr, 0]);
  return out;
}

/* ---------------- hand-written tunes ----------------
   spec.tune = { bpm, meter: beats per bar, swing?: 0..1, transpose?, style: 'block'|'waltz'|'arp'|'march'|'pad'|'none',
                 parts: { A: { mel: "E5:1 E5 E5:2 | ...", chords: "C:4 G7:2 C:2" }, ... }, form: ["A","A","B","A"] }
   Tune tokens: <pitch>[:beats]; pitch like C4, F#5, Bb3, or r for a rest; '|' bar lines are ignored (checked).
   A missing length repeats the previous length. Chord tokens: <name>[:beats], name like C, Am, G7, Fmaj7, Bdim, Dsus4, F/A. */
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function pitch(tok) {
  const m = /^([A-G])(#{1,2}|b{1,2})?(-?\d)$/.exec(tok);
  if (!m) throw new Error('bad pitch "' + tok + '"');
  const acc = !m[2] ? 0 : m[2][0] === '#' ? m[2].length : -m[2].length;
  return 12 * (+m[3] + 1) + PC[m[1]] + acc;
}
const Q = { '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], dim: [0, 3, 6], dim7: [0, 3, 6, 9],
  aug: [0, 4, 8], sus4: [0, 5, 7], sus2: [0, 2, 7], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 9: [0, 4, 7, 10, 14], m7b5: [0, 3, 6, 10] };
export function chord(name) {
  const [main, bass] = name.split('/');
  const m = /^([A-G])(#|b)?(.*)$/.exec(main);
  if (!m || !(m[3] in Q)) throw new Error('bad chord "' + name + '"');
  const r = PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  let b = r;
  if (bass) { const bm = /^([A-G])(#|b)?$/.exec(bass); if (!bm) throw new Error('bad bass "' + name + '"'); b = PC[bm[1]] + (bm[2] === '#' ? 1 : bm[2] === 'b' ? -1 : 0) }
  return { root: (r + 12) % 12, bass: (b + 12) % 12, iv: Q[m[3]] };
}
function seqOf(str, parse) {
  const out = []; let t = 0, len = 1;
  for (const tok of str.trim().split(/\s+/)) {
    if (!tok || tok === '|') continue;
    const [a, l] = tok.split(':');
    if (l != null) { len = Number(l); if (!(len > 0)) throw new Error('bad length "' + tok + '"') }
    out.push({ t, len, v: a === 'r' ? null : parse(a) });
    t += len;
  }
  return { list: out, beats: t };
}
// accompaniment for one chord of `len` beats starting at beat t (times in beats)
function comp(style, c, t, len, meter) {
  const out = [], bass = 36 + ((c.bass - 36 % 12 + 12) % 12) + (c.bass < 5 ? 12 : 0);   // E2..E3 range
  const voicing = c.iv.map(x => 55 + ((c.root + x - 55 % 12 + 24) % 12));             // close chord above G3
  voicing.sort((a, b) => a - b);
  const N = (bt, dur, p) => out.push([bt, dur, p]);
  for (let b = 0; b < len; b += (style === 'arp' ? .5 : 1)) {
    const beat = (t + b) % meter, strong = beat === 0 || (meter === 4 && beat === 2);
    if (style === 'block') { if (strong) N(t + b, 1, bass); voicing.forEach(p => N(t + b, .9, p)) }
    else if (style === 'waltz') { if (beat === 0) N(t + b, meter * .9, bass); else voicing.forEach(p => N(t + b, .8, p)) }
    else if (style === 'march') { if (beat % 2 === 0) N(t + b, .9, beat === 0 ? bass : bass + 7); else voicing.forEach(p => N(t + b, .6, p)) }
    else if (style === 'arp') { const k = Math.round(b * 2); if (k === 0 || beat === 0 && Number.isInteger(t + b)) N(t + b, 1.8, bass); const arp = [voicing[0], voicing[1], voicing[2] ?? voicing[0] + 12, voicing[1]]; N(t + b, .9, arp[k % 4]) }
    else if (style === 'pad') { if (b === 0) { N(t, len * .95, bass); voicing.forEach(p => N(t, len * .95, p)) } }
  }
  return out;
}
export function fromTune(spec) {
  const T = spec.tune, spb = 60 / T.bpm, tr = T.transpose || 0, sw = T.swing || 0, out = [];
  const at = beats => { const w = beats % 1; const x = sw && Math.abs(w - .5) < 1e-6 ? beats + sw / 6 : beats; return Math.round(x * spb * 100) };
  let t0 = 0;
  for (const name of T.form) {
    const P = T.parts[name];
    if (!P) throw new Error('form names an unknown part "' + name + '"');
    const mel = seqOf(P.mel, pitch), ch = P.chords ? seqOf(P.chords, chord) : { list: [], beats: 0 };
    if (P.chords && Math.abs(ch.beats - mel.beats) > 1e-6) throw new Error('part ' + name + ': tune has ' + mel.beats + ' beats, chords have ' + ch.beats);
    if (!P.free && Math.abs(mel.beats % T.meter) > 1e-6) throw new Error('part ' + name + ': ' + mel.beats + ' beats is not whole bars of ' + T.meter + ' (mark a pickup or odd part with free: true)');
    for (const n of mel.list) if (n.v != null) out.push([at(t0 + n.t), Math.max(8, at(t0 + n.t + n.len) - at(t0 + n.t) - 2), n.v + tr, 1]);
    if (T.style !== 'none') for (const c of ch.list) if (c.v) for (const [bt, d, p] of comp(T.style, c.v, t0 + c.t, c.len, T.meter)) out.push([at(bt), Math.max(6, Math.round(d * spb * 100)), p + tr, 0]);
    t0 += mel.beats;
  }
  return out;
}

// sort, start the first note at 0 (like the pieces already in songs.js), and work out the length (last note end + 1.2 s)
export function finish(n) {
  n.sort((a, b) => a[0] - b[0] || a[3] - b[3] || a[2] - b[2]);
  const shift = n.length ? n[0][0] : 0;
  for (const x of n) x[0] -= shift;
  const end = Math.max(...n.map(x => x[0] + x[1])) / 100;
  return { n, dur: Math.round((end + 1.2) * 10) / 10 };
}
