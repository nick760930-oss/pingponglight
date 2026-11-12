// Song sources -> game note lists. A note is [startCs, durCs, midiPitch, kind]:
// kind 1 = tune (the player plays it), 3 = counter-melody, 0 = accompaniment, 2 = drum.
import { readFileSync } from 'node:fs';
import { loadScore, secAt, MODE_SCALE } from './scorelib.mjs';

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
                 transpose?: semitones, melShift?: semitones (tune only), speed?: 1, minDur?: seconds, minMel?: seconds (tune-track notes shorter than this, e.g. grace notes, stay accompaniment) } */
export function fromMidi(spec, root) {
  const m = spec.midi, mid = readMidi(root + '/' + m.file);
  const melT = [].concat(m.mel), drop = new Set(m.drop || []), [c0, c1] = m.crop || [0, 1e9], sp = m.speed || 1;
  const inCrop = n => n.s >= c0 - 1e-3 && n.s < c1;
  const pick = ts => mid.tracks.filter(t => ts.includes(t.i)).flatMap(t => t.notes).filter(n => n.ch !== 9 && inCrop(n));
  const mel = skyline(pick(melT).filter(n => n.e - n.s >= (m.minMel || 0))), melSet = new Set(mel.map(n => n.s.toFixed(3) + ':' + n.pitch));
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
export function comp(style, c, t, len, meter) {
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

/* ---------------- score sources (ABC / LilyPond fragment / MusicXML), see scorelib.mjs ----------------
   spec.score = { file, part?: voice/part index (default 0), repeats?: false to ignore repeat signs, crop?: [startBeat, endBeat] (quarter-note beats
                  from the first note, after repeats are unfolded), cropBars?: [firstBar, lastBar] (1-based, a pickup bar is bar 0),
                  transpose?, melShift?, bpm?: quarter notes per minute (overrides the source tempo), style?: block|waltz|march|arp|pad|none,
                  chords?: "C:4 G7:4 ..." (beats are quarter-note beats counted from the cropped start; overrides the source chords),
                  chordEvery?: quarter-note beats per inferred chord (default one per bar), pulse?: quarter-note beats per accompaniment pulse }
   The tune notes are the melody; the accompaniment comes from the chords in the source if it has any, else a triad per bar picked from the melody. */
function toChordObj(name) {
  try { return chord(name) } catch (e) {
    const m = /^([A-G][#b]?)(m(?!aj))?(.*)$/.exec(name.split('/')[0]);
    if (m) {
      const q = (m[2] ? 'm' : '') + (/7/.test(m[3]) && !/maj7/.test(m[3]) ? '7' : '');
      try { return chord(m[1] + q) } catch (e2) { try { return chord(m[1] + (m[2] || '')) } catch (e3) { /* give up */ } }
    }
  }
  return null;
}
const PCN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const chordLabel = c => PCN[c.root] + (c.iv[1] === 3 ? (c.iv[2] === 6 ? 'dim' : 'm') : '') + (c.iv[3] === 10 ? '7' : '') + (c.bass !== c.root ? '/' + PCN[c.bass] : '');
function inferChord(w, key, prev, last) {
  const sc = MODE_SCALE[key.mode] || MODE_SCALE.major, minorish = (sc[2] === 3);
  const cands = [], prior = [0.6, 0.1, 0.05, 0.35, 0.5, 0.25, minorish ? 0.05 : -0.3];
  for (let d = 0; d < 7; d++) {
    const i3 = (sc[(d + 2) % 7] - sc[d] + 12) % 12, i5 = (sc[(d + 4) % 7] - sc[d] + 12) % 12;
    cands.push({ root: (key.tonic + sc[d]) % 12, iv: [0, i3, i5], p: prior[d] });
  }
  if (minorish) cands.push({ root: (key.tonic + 7) % 12, iv: [0, 4, 7], p: 0.45 });
  const total = w.reduce((a, b) => a + b, 0);
  if (total < 1e-9) return prev || { root: key.tonic, bass: key.tonic, iv: [0, minorish ? 3 : 4, 7] };
  let best = null, bs = -1e9;
  for (const c of cands) {
    let s = 0;
    for (let pc = 0; pc < 12; pc++) {
      if (!w[pc]) continue;
      const k = (pc - c.root + 12) % 12;
      s += w[pc] * (k === 0 ? 3 : k === c.iv[1] ? 2.5 : k === c.iv[2] ? 2 : -1.2);
    }
    s = s / total + c.p + (prev && prev.root === c.root && prev.iv[1] === c.iv[1] ? 0.15 : 0);
    if (last && c.root === key.tonic && c.iv[1] === (minorish ? 3 : 4) && w[key.tonic] > 0) s += 0.6;
    if (s > bs) { bs = s; best = c }
  }
  return { root: best.root, bass: best.root, iv: best.iv };
}
export function fromScore(spec, root) {
  const S = spec.score, r = loadScore(root + '/' + S.file, { part: S.part || 0, repeats: S.repeats !== false });
  const bb = r.barBeats, pk = r.pickup, tr = S.transpose || 0, ms = S.melShift || 0;
  let c0 = 0, c1 = Infinity;
  if (S.crop) [c0, c1] = S.crop;
  else if (S.cropBars) { const [a, b] = S.cropBars; c0 = a <= 0 ? 0 : pk + (a - 1) * bb; c1 = pk + b * bb }
  const mel = r.notes.filter(n => n.b >= c0 - 1e-4 && n.b < c1 - 1e-4).map(n => ({ b: n.b - c0, db: Math.min(n.db, c1 - n.b), p: n.p }));
  if (!mel.length) throw new Error('score: no notes in the crop range');
  const T = S.bpm ? [{ b: 0, qpm: S.bpm }] : r.tempos, s0 = secAt(T, c0);
  const at = bq => Math.round((secAt(T, c0 + bq) - s0) * 100);
  const end = Math.max(...mel.map(n => n.b + n.db));
  const info = { bpm: S.bpm || r.bpm, meter: r.meter.join('/'), pickup: pk, key: r.key, sourceWarnings: r.warnings, bars: Math.ceil((end - pk) / bb - 1e-6) };
  const out = [];
  for (const n of mel) out.push([at(n.b), Math.max(8, at(n.b + n.db) - at(n.b) - 2), n.p + tr + ms, 1]);
  const [mn, md] = r.meter, pulse = S.pulse || (md === 8 && mn >= 6 && mn % 3 === 0 ? 1.5 : 4 / md), meterP = bb / pulse;
  const style = S.style || (Math.abs(meterP - 3) < 1e-6 ? 'waltz' : md === 8 && mn >= 6 ? 'arp' : 'block');
  info.style = style; info.pulse = pulse;
  if (style !== 'none') {
    // chord segments covering [0, end)
    let segs = [];
    if (S.chords) {
      let t = 0, len = bb;
      for (const tok of S.chords.trim().split(/\s+/)) {
        if (!tok || tok === '|') continue;
        const [nm, l] = tok.split(':'); if (l != null) len = Number(l);
        const c = toChordObj(nm); if (!c) throw new Error('score.chords: bad chord "' + tok + '"');
        segs.push({ b0: t, b1: t + len, c }); t += len;
      }
      if (segs.length) segs[segs.length - 1].b1 = Math.max(segs[segs.length - 1].b1, end);
      info.chordSource = 'spec';
    } else {
      const src = (r.chords || []).map(x => ({ b: x.b - c0, c: toChordObj(x.name) })).filter(x => x.c);
      const inside = src.filter(x => x.b < end - 1e-6);
      if (inside.length >= Math.max(2, mel.length / 40)) {
        const ev = inside.filter(x => x.b >= 0), pre = src.filter(x => x.b < 0).pop();
        if (pre && (!ev.length || ev[0].b > 1e-6)) ev.unshift({ b: 0, c: pre.c });
        if (ev[0].b > 1e-6) ev[0] = { ...ev[0], b: 0 };
        segs = ev.map((x, i) => ({ b0: x.b, b1: i + 1 < ev.length ? ev[i + 1].b : end, c: x.c }));
        info.chordSource = 'source';
      } else {
        const every = S.chordEvery || bb;
        let cuts = [0];
        const first = ((pk - c0) % bb + bb) % bb;        // distance from the (cropped) start to the next bar line
        for (let x = first > 1e-6 ? first : bb; x < end - 1e-6; x += bb) cuts.push(x);
        cuts.push(end);
        if (S.chordEvery) {
          const all = [];
          for (let i = 0; i + 1 < cuts.length; i++) for (let x = cuts[i]; x < cuts[i + 1] - 1e-6; x += every) all.push(x);
          cuts = [...all, end];
        }
        let prev = null;
        for (let i = 0; i + 1 < cuts.length; i++) {
          const a = cuts[i], b = cuts[i + 1], w = new Array(12).fill(0);
          for (const n of mel) {
            const ov = Math.min(b, n.b + n.db) - Math.max(a, n.b);
            if (ov > 1e-6) w[n.p % 12] += ov * (Math.abs(n.b - a) < 1e-6 ? 1.5 : Number.isInteger(n.b) ? 1.2 : 1);
          }
          const c = inferChord(w, r.key, prev, i + 2 === cuts.length); prev = c; segs.push({ b0: a, b1: b, c });
        }
        info.chordSource = 'inferred';
      }
    }
    for (const sg of segs) sg.c = { root: (sg.c.root + tr + 12) % 12, bass: (sg.c.bass + tr + 12) % 12, iv: sg.c.iv };
    info.chords = segs.map(s => chordLabel(s.c) + ':' + +(s.b1 - s.b0).toFixed(3)).join(' ');
    const phase = ((c0 - pk) % bb + bb) % bb;
    for (const sg of segs) {
      const len = (sg.b1 - sg.b0) / pulse;
      for (const [bt, d, p] of comp(style, sg.c, (sg.b0 + phase) / pulse, len, meterP)) {
        const a = bt * pulse - phase, z = (bt + d) * pulse - phase;
        if (a < -1e-6) continue;
        out.push([at(a), Math.max(6, at(z) - at(a)), p, 0]);
      }
    }
  }
  out.info = info;
  return out;
}
