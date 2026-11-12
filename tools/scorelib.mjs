// Score sources (ABC / LilyPond fragment / MusicXML) -> one melody as a note list. No dependencies, no network.
//
//   const r = loadScore('tools/src2/dannyboy/danny-boy.abc', { part: 0, repeats: true });
//   r = { format, notes: [{ b, db, p, t, d }], tempos: [{ b, qpm }], bpm, meter: [n, d], barBeats, pickup, key: { fifths, mode, tonic },
//         chords: [{ b, name }], warnings: [] }
//     b / db : start and length in quarter-note beats counted from the first note (repeats already unfolded)
//     t / d  : the same in seconds (through the tempo map)      p : MIDI pitch
//     pickup : beats of the opening short bar (0 if none)        bpm : first tempo in quarter notes per minute
// CLI:  node tools/scorelib.mjs <file> [--part N] [--norepeat] [--json]
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const EPS = 1e-6, r6 = x => Math.round(x * 1e6) / 1e6;
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const noteName = p => NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);

/* ---------------- keys ---------------- */
const FIFTHS_IDX = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };
const MODE_OFF = { major: 0, minor: -3, dorian: -2, phrygian: -4, lydian: 1, mixolydian: -1, locrian: -5 };
const MODE_PC = { major: 0, minor: 9, dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7, locrian: 11 };
export const MODE_SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10], locrian: [0, 1, 3, 5, 6, 8, 10] };
export function normMode(m) {
  m = String(m || 'major').toLowerCase();
  if (m === 'm' || m.startsWith('min') || m.startsWith('aeo')) return 'minor';
  for (const k of ['dor', 'phr', 'lyd', 'mix', 'loc']) if (m.startsWith(k)) return Object.keys(MODE_OFF).find(x => x.startsWith(k));
  return 'major';
}
export function keyFrom(letter, alt, mode) {
  mode = normMode(mode);
  return { fifths: FIFTHS_IDX[letter] + 7 * alt + MODE_OFF[mode], mode, tonic: ((LETTER_PC[letter] + alt) % 12 + 12) % 12 };
}
export function keyFromFifths(f, mode) {
  mode = normMode(mode);
  return { fifths: f, mode, tonic: (((f * 7 + MODE_PC[mode]) % 12) + 12) % 12 };
}

/* ---------------- repeats (shared by ABC and MusicXML) ----------------
   bars: [{ rs: repeat starts here, re: repeat ends here, volta: [numbers] | null, ... }] -> the played order of the bars */
export function unfoldBars(bars) {
  const out = [], used = new Set();
  let i = 0, start = 0, pass = 1, guard = 0;
  while (i < bars.length && guard++ < 100000) {
    const b = bars[i];
    if (b.rs && !used.has('s' + i) && pass === 1) start = i;
    if (b.volta && !b.volta.includes(pass)) { i++; continue }
    out.push(b);
    if (b.re) {
      if (!used.has(i)) { used.add(i); i = start; pass++; continue }
      pass = 1; start = i + 1;
    }
    i++;
  }
  return out;
}

/* ---------------- result assembly ---------------- */
export function secAt(tempos, b) {
  let s = 0;
  for (let i = 0; i < tempos.length; i++) {
    const nb = i + 1 < tempos.length ? tempos[i + 1].b : Infinity;
    if (b <= nb) return s + (b - tempos[i].b) * 60 / tempos[i].qpm;
    s += (nb - tempos[i].b) * 60 / tempos[i].qpm;
  }
  return s;
}
function mergeTies(list) {          // list of { b, db, p, tie }: a tied note extends the open note of the same pitch that ends where it starts
  const out = [], open = new Map();
  for (const n of list) {
    const o = open.get(n.p);
    if (o && Math.abs(o.b + o.db - n.b) < 1e-4) { o.db = r6(o.db + n.db); if (!n.tie) open.delete(n.p); continue }
    const x = { b: n.b, db: n.db, p: n.p }; out.push(x);
    if (n.tie) open.set(n.p, x); else open.delete(n.p);
  }
  return out;
}
function assemble(r) {
  r.warnings ||= [];
  r.meter ||= [4, 4];
  r.barBeats = r.meter[0] * 4 / r.meter[1];
  r.pickup = r.pickup && r.pickup > EPS && r.pickup < r.barBeats - EPS ? r.pickup : 0;
  let tp = (r.tempos || []).filter(x => x.qpm > 0).sort((a, c) => a.b - c.b);
  if (!tp.length) { tp = [{ b: 0, qpm: 100 }]; r.warnings.push('no tempo found; assuming 100 quarter notes per minute') }
  if (tp[0].b > EPS) tp.unshift({ b: 0, qpm: tp[0].qpm });
  r.tempos = tp; r.bpm = tp[0].qpm;
  r.notes = r.notes.filter(n => n.db > EPS).sort((a, c) => a.b - c.b || c.p - a.p);
  for (const n of r.notes) { n.b = r6(n.b); n.db = r6(n.db); n.t = r6(secAt(tp, n.b)); n.d = r6(secAt(tp, n.b + n.db) - n.t) }
  r.chords ||= [];
  return r;
}

/* ================= ABC ================= */
function abcKeyAcc(fifths) {
  const acc = {}, sharps = 'FCGDAEB', flats = 'BEADGCF';
  if (fifths > 0) for (let i = 0; i < Math.min(7, fifths); i++) acc[sharps[i]] = 1;
  else for (let i = 0; i < Math.min(7, -fifths); i++) acc[flats[i]] = -1;
  return acc;
}
function readLen(s, i) {
  let num = 1, den = 1, m = /^\d+/.exec(s.slice(i, i + 8));
  if (m) { num = +m[0]; i += m[0].length }
  if (s[i] === '/') {
    let c = 0; while (s[i] === '/') { c++; i++ }
    m = /^\d+/.exec(s.slice(i, i + 8));
    if (m && c === 1) { den = +m[0]; i += m[0].length } else den = 2 ** c;
  }
  return [num / den, i];
}
export function parseAbc(text, opt = {}) {
  const W = [], warn = m => { if (!W.includes(m) && W.length < 60) W.push(m) };
  const all = text.replace(/\r/g, '').split('\n');
  let s0 = all.findIndex(l => /^X:/.test(l)); if (s0 < 0) s0 = 0;
  let e0 = all.length;
  for (let i = s0 + 1; i < all.length; i++) if (/^X:/.test(all[i])) { e0 = i; warn('file holds several tunes; only the first is read'); break }
  const lines = all.slice(s0, e0);
  const want = opt.part || 0;
  let M = [4, 4], Lq = null, key = keyFromFifths(0, 'major'), keyAcc = {}, meta = {}, qpm = null, header = true, title = '';
  const voices = []; let cur = null;
  const newBar = () => ({ ev: [], rs: false, re: false, volta: null });
  let bars = [], bar = newBar();
  let barAcc = {}, last = null, tup = { left: 0, f: 1 }, brk = 1, chordName = null, tempoPending = null;
  const barBeats = () => M[0] * 4 / M[1];
  const emitting = () => voices.length === 0 || cur === voices[want];

  function setKey(v) {
    const m = /^\s*([A-G])([#b]?)\s*([A-Za-z]*)/.exec(v);
    if (!m) { if (/^\s*(none|hp|hpipe)/i.test(v)) { key = keyFromFifths(/hp/i.test(v) ? 2 : 0, 'major'); keyAcc = {} } return }
    key = keyFrom(m[1], m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0, m[3]);
    keyAcc = abcKeyAcc(key.fifths);
    const ex = /(?:exp\s+)?((?:[_^=]+[a-gA-G]\s*)+)/.exec(v.slice(m[0].length));
    if (ex) for (const t of ex[1].matchAll(/([_^=]+)([a-gA-G])/g)) keyAcc[t[2].toUpperCase()] = t[1][0] === '^' ? t[1].length : t[1][0] === '_' ? -t[1].length : 0;
  }
  function field(ch, val) {
    switch (ch) {
      case 'T': if (!title) title = val.trim(); break;
      case 'M': {
        const v = val.trim(); let m;
        if (v === 'C') M = [4, 4]; else if (v === 'C|') M = [2, 2];
        else if ((m = /^(\d+)\s*\/\s*(\d+)/.exec(v))) M = [+m[1], +m[2]];
        if (meta.meter && (meta.meter[0] !== M[0] || meta.meter[1] !== M[1])) warn('time signature changes inside the tune; bar numbers assume the first one');
        meta.meter ||= M.slice();
        break;
      }
      case 'L': { const m = /(\d+)\s*\/\s*(\d+)/.exec(val); if (m) Lq = 4 * m[1] / m[2]; break }
      case 'Q': {
        const v = val.replace(/"[^"]*"/g, ' '); let m;
        if ((m = /(\d+)\s*\/\s*(\d+)\s*=\s*(\d+(?:\.\d+)?)/.exec(v))) qpm = 4 * m[1] / m[2] * +m[3];
        else if ((m = /(?:^|\s)(\d+(?:\.\d+)?)\s*$/.exec(v))) qpm = +m[1];
        if (qpm) { if (emitting()) tempoPending = qpm }
        break;
      }
      case 'K':
        setKey(val); meta.key ||= { ...key };
        if (Lq == null) Lq = M[0] / M[1] < 0.75 ? 0.25 : 0.5;
        header = false; break;
      case 'V': {
        const id = val.trim().split(/\s+/)[0]; if (!id) break;
        if (!voices.includes(id)) voices.push(id);
        cur = id; break;
      }
    }
  }
  function barline(re, rs, volta) {
    if (bar.ev.length) { bar.re ||= re; bars.push(bar); bar = newBar() }
    else if (re && bars.length) bars[bars.length - 1].re = true;
    if (rs) bar.rs = true;
    if (volta) bar.volta = volta;
    barAcc = {};
  }
  const parseVolta = str => { const out = []; for (const p of str.split(',')) { const m = /^(\d+)(?:-(\d+))?$/.exec(p); if (m) for (let k = +m[1]; k <= +(m[2] || m[1]); k++) out.push(k) } return out.length ? out : null };
  const push = ev => {
    if (!emitting()) return;
    if (tempoPending) { ev.tempo = tempoPending; tempoPending = null }
    if (chordName && ev.p != null) { ev.chord = chordName; chordName = null }
    bar.ev.push(ev); last = ev;
  };
  const tupMul = () => { if (tup.left > 0) { tup.left--; return tup.f } return 1 };
  const afterNote = ev => { if (brk !== 1) { ev.db *= brk; brk = 1 } };

  for (let li = 0; li < lines.length; li++) {
    let s = lines[li];
    if (!s.trim() || /^\s*%/.test(s)) continue;
    const fm = /^([A-Za-z]):\s*(.*)$/.exec(s);
    if (fm) { field(fm[1], fm[2].replace(/s%.*$/, '')); continue }
    if (header) continue;
    if (voices.length && cur == null) cur = voices[0];
    s = s.replace(/(^|\s)%.*$/, '');
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === ' ' || c === '\t' || c === '\\') { i++; continue }
      if (c === '"') {
        const j = s.indexOf('"', i + 1); if (j < 0) break;
        const t = s.slice(i + 1, j); if (/^[A-G]/.test(t)) chordName = t; i = j + 1; continue;
      }
      if (c === '!') { const j = s.indexOf('!', i + 1); i = j < 0 ? i + 1 : j + 1; continue }
      if (c === '+') { const j = s.indexOf('+', i + 1); i = j > 0 && j - i < 20 ? j + 1 : i + 1; continue }
      if (c === '{') { const j = s.indexOf('}', i); i = j < 0 ? s.length : j + 1; continue }
      if (c === '(') {
        const m = /^\((\d)(?::(\d*))?(?::(\d*))?/.exec(s.slice(i, i + 12));
        if (m) {
          const p = +m[1], q = m[2] ? +m[2] : ({ 2: 3, 3: 2, 4: 3, 5: 2, 6: 2, 7: 2, 8: 3, 9: 2 })[p] || 2, r = m[3] ? +m[3] : p;
          tup = { left: r, f: q / p }; i += m[0].length;
        } else i++;
        continue;
      }
      if (c === ')' || c === '.' || c === '~' || c === '*' || c === '`' || c === '&' || c === '$' || c === '#') { i++; continue }
      if (c === '[') {
        const n1 = s[i + 1];
        if (n1 === '|') { i += 2; while (s[i] === ':') i++; barline(false, false, null); continue }
        if (/\d/.test(n1)) { const m = /^\[(\d+(?:[-,]\d+)*)/.exec(s.slice(i)); const v = parseVolta(m[1]); if (bar.ev.length) { barline(false, false, v) } else bar.volta = v; i += m[0].length; continue }
        if (/[A-Za-z]/.test(n1) && s[i + 2] === ':') {
          const j = s.indexOf(']', i); if (j < 0) { i++; continue }
          field(n1, s.slice(i + 3, j)); i = j + 1; continue;
        }
        // chord
        i++; let top = null, first = null, tie = false;
        while (i < s.length && s[i] !== ']') {
          if (s[i] === ' ') { i++; continue }
          if (s[i] === '-') { tie = true; i++; continue }
          const nt = readNote(s, i);
          if (!nt) { i++; continue }
          if (first == null) first = nt.frac;
          if (top == null || nt.p > top) top = nt.p;
          i = nt.i;
        }
        i++;
        const [lf, j] = readLen(s, i); i = j;
        if (s[i] === '-') { tie = true; i++ }
        if (top != null) {
          const ev = { kind: 'n', p: top, db: (first ?? 1) * lf * Lq * tupMul() * (brk !== 1 ? 1 : 1), tie };
          push(ev); afterNote(ev);
        }
        continue;
      }
      if (c === '|' || c === ':') {
        let j = i, left = 0; while (s[j] === ':') { left++; j++ }
        let glyph = 0;
        for (;;) {
          if (s[j] === '|') { j++; glyph++ }
          else if (s[j] === ']' && glyph) { j++ }
          else if (s[j] === '[' && s[j + 1] === '|') { j += 2; glyph++ }
          else break;
        }
        let right = 0; while (s[j] === ':') { right++; j++ }
        if (!glyph && left < 2) { i = i + 1; continue }
        let v = null; const m = /^(\d+(?:[-,]\d+)*)/.exec(s.slice(j));
        if (m) { v = parseVolta(m[1]); j += m[0].length }
        if (!glyph) barline(true, true, v); else barline(left > 0, right > 0, v);
        i = j; continue;
      }
      if (c === '<' || c === '>') {
        let k = 0; while (s[i] === c) { k++; i++ }
        const pf = c === '>' ? 2 - 2 ** -k : 2 ** -k, nf = c === '>' ? 2 ** -k : 2 - 2 ** -k;
        if (last && emitting()) last.db *= pf;
        brk = nf; continue;
      }
      if (c === 'z' || c === 'x' || c === 'Z') {
        const [lf, j] = readLen(s, i + 1); i = j;
        const ev = { kind: 'r', p: null, db: c === 'Z' ? lf * barBeats() : lf * Lq * tupMul() };
        push(ev); afterNote(ev); continue;
      }
      if (c === 'y') { i++; continue }
      if (c === '-') { if (last && emitting()) last.tie = true; i++; continue }
      if (c === '^' || c === '_' || c === '=' || /[A-Ga-g]/.test(c)) {
        const nt = readNote(s, i);
        if (!nt) { i++; continue }
        i = nt.i;
        const ev = { kind: 'n', p: nt.p, db: nt.frac * Lq * tupMul(), tie: false };
        push(ev); afterNote(ev); continue;
      }
      if (c === 'H' || c === 'L' || c === 'M' || c === 'O' || c === 'P' || c === 'S' || c === 'T' || c === 'u' || c === 'v' || c === 'w' || c === 'W') { i++; continue }
      warn('ignored character "' + c + '" in ' + (title || 'tune')); i++;
    }
  }
  function readNote(s, i) {
    let acc = null;
    while (s[i] === '^' || s[i] === '_' || s[i] === '=') {
      if (s[i] === '=') { acc = 0; i++ } else { const ch = s[i]; let k = 0; while (s[i] === ch) { k++; i++ } acc = (ch === '^' ? 1 : -1) * k }
    }
    const L = s[i]; if (!L || !/[A-Ga-g]/.test(L)) return null;
    i++;
    let oct = L <= 'G' ? 4 : 5;
    while (s[i] === "'") { oct++; i++ }
    while (s[i] === ',') { oct--; i++ }
    const U = L.toUpperCase(), k = U + oct;
    let semis;
    if (acc != null) { barAcc[k] = acc; semis = acc } else if (k in barAcc) semis = barAcc[k]; else semis = keyAcc[U] || 0;
    const [frac, j] = readLen(s, i);
    return { p: 12 * (oct + 1) + LETTER_PC[U] + semis, frac, i: j };
  }
  if (bar.ev.length) bars.push(bar);
  if (voices.length && want >= voices.length) throw new Error('ABC has voices ' + voices.join(', ') + '; part ' + want + ' does not exist');
  if (!bars.length) throw new Error('ABC: no notes found');

  const bb = M[0] * 4 / M[1], mb = (meta.meter || M)[0] * 4 / (meta.meter || M)[1];
  const bar0 = bars[0].ev.reduce((a, e) => a + e.db, 0);
  const played = opt.repeats === false ? bars : unfoldBars(bars);
  let b = 0; const raw = [], tempos = [], chords = [];
  for (const bx of played) for (const e of bx.ev) {
    if (e.tempo) tempos.push({ b, qpm: e.tempo });
    if (e.chord) chords.push({ b, name: e.chord });
    if (e.kind === 'n') raw.push({ b, db: e.db, p: e.p, tie: e.tie });
    b += e.db;
  }
  void bb;
  return assemble({ format: 'abc', title, notes: mergeTies(raw), tempos, meter: meta.meter || M, key: meta.key || key,
    pickup: bar0 < mb - EPS ? bar0 : 0, chords, warnings: W, voices });
}

/* ================= LilyPond ================= */
const NOTE_RE = /^([a-g])(isis|eses|is|es|ses|s)?$/;
const ALT = { is: 1, isis: 2, es: -1, eses: -2, s: -1, ses: -2 };
const LPC = [0, 2, 4, 5, 7, 9, 11];                       // c d e f g a b
function lyLex(src) {
  const T = [], n = src.length; let i = 0;
  const push = (t, v) => T.push({ t, v });
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue }
    if (c === '%') {
      if (src[i + 1] === '{') { const j = src.indexOf('%}', i + 2); i = j < 0 ? n : j + 2 } else { const j = src.indexOf('\n', i); i = j < 0 ? n : j + 1 }
      continue;
    }
    if (c === '"') { let j = i + 1; while (j < n && src[j] !== '"') { if (src[j] === '\\') j++; j++ } push('str', src.slice(i + 1, j)); i = j + 1; continue }
    if (c === '\\') {
      const d = src[i + 1] || '';
      if (d === '\\') { push('sep'); i += 2; continue }
      if (/[A-Za-z]/.test(d)) { let j = i + 1; while (j < n && /[A-Za-z]/.test(src[j])) j++; push('cmd', src.slice(i + 1, j)); i = j; continue }
      push('art', src.slice(i, i + 2)); i += 2; continue;
    }
    if (c === '#') {
      let j = i + 1;
      if (src[j] === '#') { j++; while (j < n && !/[\s{}<>]/.test(src[j])) j++ }
      else if (src[j] === '"') { j++; while (j < n && src[j] !== '"') { if (src[j] === '\\') j++; j++ } j++ }
      else {
        if (src[j] === "'" || src[j] === '`') j++;
        if (src[j] === '(') {
          let d = 0;
          for (; j < n; j++) {
            if (src[j] === '"') { j++; while (j < n && src[j] !== '"') { if (src[j] === '\\') j++; j++ } continue }
            if (src[j] === '(') d++; else if (src[j] === ')') { d--; if (d === 0) { j++; break } }
          }
        } else while (j < n && !/[\s{}<>]/.test(src[j])) j++;
      }
      push('scm', src.slice(i, j)); i = j; continue;
    }
    if (c === '<' && src[i + 1] === '<') { push('<<'); i += 2; continue }
    if (c === '>' && src[i + 1] === '>') { push('>>'); i += 2; continue }
    if (c === '-' || c === '^' || c === '_') {
      const m = /^[-^_](?:[-.>^_!+]|\d+|"(?:[^"\\]|\\.)*")?/.exec(src.slice(i, i + 200));
      push('art', m[0]); i += m[0].length; continue;
    }
    if (/\d/.test(c)) { let j = i; while (/\d/.test(src[j] || '')) j++; push('num', src.slice(i, j)); i = j; continue }
    if (/[A-Za-z]/.test(c)) {
      const m = /^[A-Za-z]+(?:-[A-Za-z]+)*/.exec(src.slice(i, i + 80)); push('word', m[0]); i += m[0].length; continue;
    }
    push('p', c); i++;
  }
  return T;
}
const SILENT = new Set(['break', 'pageBreak', 'noBreak', 'noPageBreak', 'autoBeamOff', 'autoBeamOn', 'numericTimeSignature', 'defaultTimeSignature', 'oneVoice', 'voiceOne',
  'voiceTwo', 'voiceThree', 'voiceFour', 'stemUp', 'stemDown', 'stemNeutral', 'slurUp', 'slurDown', 'slurNeutral', 'tieUp', 'tieDown', 'tieNeutral', 'dynamicUp', 'dynamicDown',
  'dynamicNeutral', 'shiftOff', 'shiftOn', 'fermata', 'trill', 'turn', 'mordent', 'prall', 'staccato', 'tenuto', 'marcato', 'accent', 'portato', 'p', 'pp', 'ppp', 'f', 'ff', 'fff',
  'mp', 'mf', 'fp', 'sf', 'sfz', 'cresc', 'decresc', 'dim', 'espressivo', 'startTrillSpan', 'stopTrillSpan', 'cadenzaOn', 'cadenzaOff', 'sustainOn', 'sustainOff', 'bigger', 'smaller',
  'easyHeadsOn', 'easyHeadsOff', 'hideNotes', 'unHideNotes', 'fine', 'segno', 'coda', 'laissezVibrer', 'arpeggio', 'glissando', 'breathe', 'default', 'italic', 'bold', 'small',
  'normalsize', 'teeny', 'large', 'upbow', 'downbow', 'open', 'stopped', 'flageolet', 'longfermata', 'shortfermata', 'startGroup', 'stopGroup', 'compressFullBarRests', 'textLengthOn',
  'textLengthOff', 'major', 'minor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian', 'ionian', 'stemUp', 'phrasingSlurUp', 'phrasingSlurDown', 'phrasingSlurNeutral',
  'newSpacingSection', 'bar', 'tupletUp', 'tupletDown', 'tupletNeutral', 'startStaff', 'stopStaff', 'afterGraceFraction', 'melisma', 'melismaEnd', 'sostenutoOn', 'sostenutoOff',
  'unaCorda', 'treCorde', 'omit', 'harmonic', 'noBeam', 'xNotesOn', 'xNotesOff', 'improvisationOn', 'improvisationOff', 'rest', 'fz', 'sp', 'rfz', 'sff', 'sfp', 'ppppp', 'ffff']);
const NONMEL = new Set(['Lyrics', 'ChordNames', 'FiguredBass', 'DrumStaff', 'TabStaff', 'Dynamics', 'NoteNames', 'FretBoards', 'RhythmicStaff', 'TabVoice', 'DrumVoice', 'GregorianTranscriptionStaff']);
export function parseLily(src, opt = {}) {
  const W = [], T = lyLex(src), vars = new Map();
  const meta = { key: null, meter: null, tempos: [], pickup: null };
  const ctx = { t: 0, out: [], mode: 'abs', ref: 0, baseOct: 3, dur: { n: 4, dots: 0 }, tup: 1, lastEv: null, scratch: false, depth: 0, simul: 0, shift: 0, evals: 0 };
  const warn = m => { if (!ctx.scratch && !W.includes(m) && W.length < 60) W.push(m) };
  const isP = (i, v) => T[i] && T[i].t === 'p' && T[i].v === v;
  const stepOf = (n, marks) => 7 * (3 + marks) + n;

  function skipBal(i) {
    const tk = T[i]; if (!tk) return i;
    if (tk.t === 'p' && tk.v === '{') { let d = 0; for (; i < T.length; i++) { if (isP(i, '{')) d++; else if (isP(i, '}')) { d--; if (d === 0) return i + 1 } } return i }
    if (tk.t === '<<') { let d = 0; for (; i < T.length; i++) { if (T[i].t === '<<') d++; else if (T[i].t === '>>') { d--; if (d === 0) return i + 1 } } return i }
    if (tk.t === 'cmd') { const n = T[i + 1]; return n && (n.t === 'cmd' || n.t === 'str' || n.t === 'scm' || n.t === 'word' || n.t === 'num' || (n.t === 'p' && n.v === '{') || n.t === '<<') ? skipBal(i + 1) : i + 1 }
    return i + 1;
  }
  const snap = () => ({ t: ctx.t, out: ctx.out, mode: ctx.mode, ref: ctx.ref, baseOct: ctx.baseOct, dur: { ...ctx.dur }, tup: ctx.tup, lastEv: ctx.lastEv, scratch: ctx.scratch, simul: ctx.simul, shift: ctx.shift });
  const restore = s => Object.assign(ctx, s, { dur: { ...s.dur } });
  function dry(i) { const s = snap(); ctx.scratch = true; ctx.out = []; ctx.depth++; let j; try { j = parseExpr(i) } finally { ctx.depth-- } restore(s); return j }

  // duration after a note: [beats, nextIndex]; an explicit number replaces the remembered one
  function readDur(i, defOnly) {
    const d = ctx.dur;
    if (T[i] && T[i].t === 'cmd' && (T[i].v === 'breve' || T[i].v === 'longa')) { d.n = T[i].v === 'breve' ? 0.5 : 0.25; d.dots = 0; i++ }
    else if (T[i] && T[i].t === 'num' && !defOnly) {
      d.n = +T[i].v; d.dots = 0; i++;
      while (isP(i, '.')) { d.dots++; i++ }
    }
    let mul = 1;
    while (isP(i, '*') && T[i + 1] && T[i + 1].t === 'num') {
      let a = +T[i + 1].v, b = 1; i += 2;
      if (isP(i, '/') && T[i + 1] && T[i + 1].t === 'num') { b = +T[i + 1].v; i += 2 }
      mul *= a / b;
    }
    return [(4 / d.n) * (2 - 2 ** -d.dots) * mul * ctx.tup, i];
  }
  function notePitch(n, alt, marks, refStep) {
    let oct;
    if (ctx.mode === 'rel') oct = Math.round((refStep - n) / 7) + marks; else oct = ctx.baseOct + marks;
    return { step: 7 * oct + n, midi: 12 * (oct + 1) + LPC[n] + alt };
  }
  function readPitchTok(i) {       // note word + octave marks + ! ? : { n, alt, marks, i } or null
    const w = T[i]; if (!w || w.t !== 'word') return null;
    const m = NOTE_RE.exec(w.v); if (!m) return null;
    let k = i + 1, marks = 0;
    while (isP(k, "'") || isP(k, ',')) { marks += T[k].v === "'" ? 1 : -1; k++ }
    while (isP(k, '!') || isP(k, '?')) k++;
    return { n: 'cdefgab'.indexOf(m[1]), alt: m[2] ? ALT[m[2]] : 0, marks, i: k };
  }
  const emit = (p, db, tie) => { const ev = { b: ctx.t, db, p: p + ctx.shift, tie: !!tie }; ctx.out.push(ev); ctx.lastEv = ev; ctx.t += db; return ev };

  function parseGroup(i) { while (i < T.length && !isP(i, '}')) i = parseExpr(i); return i + 1 }
  function parseChord(i) {
    let ref2 = ctx.ref, first = null, top = null;
    while (i < T.length && !isP(i, '>')) {
      const pt = readPitchTok(i);
      if (pt) {
        const r = notePitch(pt.n, pt.alt, pt.marks, ref2);
        ref2 = r.step; if (first == null) first = r.step; if (top == null || r.midi > top) top = r.midi;
        i = pt.i;
      } else i++;
    }
    i++;
    const [db, j] = readDur(i);
    if (first != null && ctx.mode === 'rel') ctx.ref = first;
    if (top != null) emit(top, db); else ctx.t += db;
    return j;
  }
  function parseSimul(i) {
    ctx.simul++;
    const depth = ctx.simul, st = snap(), parentOut = ctx.out, branches = [];
    while (i < T.length && T[i].t !== '>>') {
      if (T[i].t === 'sep') { i++; continue }
      restore({ ...st, out: [], simul: depth });
      i = parseExpr(i);
      branches.push({ ev: ctx.out, end: ctx.t, s: snap() });
    }
    restore({ ...st, simul: depth - 1 });
    const mel = branches.filter(b => b.ev.length), idx = depth === 1 ? (opt.part || 0) : 0;
    if (depth === 1 && mel.length && idx >= mel.length) throw new Error('LilyPond: part ' + idx + ' does not exist (' + mel.length + ' melodic voices)');
    const ch = mel[idx];
    ctx.out = parentOut;
    if (ch) { for (const e of ch.ev) ctx.out.push(e); ctx.t = ch.end; ctx.ref = ch.s.ref; ctx.dur = { ...ch.s.dur }; ctx.lastEv = ch.s.lastEv }
    else ctx.t = Math.max(st.t, ...branches.map(b => b.end));
    if (depth === 1 && mel.length > 1) warn('simultaneous voices: using melodic voice ' + idx + ' of ' + mel.length);
    return i + 1;
  }
  function parseWord(i) {
    const w = T[i].v;
    if (isP(i + 1, '=')) { const st = i + 2; const j = (T[st] && (T[st].t === 'str' || T[st].t === 'scm' || T[st].t === 'num')) ? st + 1 : dry(st); vars.set(w, { start: st, end: j }); return j }
    const pt = readPitchTok(i);
    if (pt) {
      const r = notePitch(pt.n, pt.alt, pt.marks, ctx.ref);
      if (ctx.mode === 'rel') ctx.ref = r.step;
      const [db, j] = readDur(pt.i);
      emit(r.midi, db); return j;
    }
    if (w === 'r' || w === 's' || w === 'R') { const [db, j] = readDur(i + 1); ctx.t += db; ctx.lastEv = null; return j }
    if (w === 'q') { warn('chord repeat q ignored'); const [db, j] = readDur(i + 1); ctx.t += db; return j }
    warn('unknown word "' + w + '" skipped');
    return i + 1;
  }
  function skipPath(i) {
    for (let g = 0; g < 40 && i < T.length; g++) {
      const t = T[i];
      if (t.t === 'word' || t.t === 'scm' || isP(i, '.')) { i++; continue }
      if (isP(i, '=')) { i++; if (T[i] && (T[i].t === 'scm' || T[i].t === 'str' || T[i].t === 'num' || T[i].t === 'word' || T[i].t === 'cmd')) i++; if (T[i] && T[i].t === 'art' && /^-\d/.test(T[i].v)) i++; return i }
      break;
    }
    return i;
  }
  const readFrac = i => { if (T[i] && T[i].t === 'num' && isP(i + 1, '/') && T[i + 2] && T[i + 2].t === 'num') return [+T[i].v, +T[i + 2].v, i + 3]; return null };
  function capture(i) {            // parse one expression, return its events relative to 0 and its length
    const st = snap(), t0 = ctx.t; ctx.out = [];
    const j = parseExpr(i); const ev = ctx.out.map(e => ({ ...e, b: e.b - t0 })), len = ctx.t - t0;
    ctx.out = st.out; ctx.t = t0; return { ev, len, i: j };
  }
  function parseCmd(i) {
    const name = T[i].v; i++;
    switch (name) {
      case 'relative': case 'fixed': {
        const st = { mode: ctx.mode, ref: ctx.ref, baseOct: ctx.baseOct };
        let marks = 1, n = 0;
        const pt = readPitchTok(i);
        if (pt) { marks = pt.marks; n = pt.n; i = pt.i } else if (name === 'fixed') { marks = 0 }
        if (name === 'relative') { ctx.mode = 'rel'; ctx.ref = stepOf(n, marks) } else { ctx.mode = 'abs'; ctx.baseOct = 3 + marks }
        i = parseExpr(i); Object.assign(ctx, st); return i;
      }
      case 'absolute': { const st = { mode: ctx.mode, baseOct: ctx.baseOct }; ctx.mode = 'abs'; ctx.baseOct = 3; i = parseExpr(i); Object.assign(ctx, st); return i }
      case 'transpose': {
        const a = readPitchTok(i); let b = null;
        if (a) b = readPitchTok(a.i);
        if (!a || !b) { warn('\\transpose not understood'); return i }
        const sa = 12 * (3 + a.marks + 1) + LPC[a.n] + a.alt, sb = 12 * (3 + b.marks + 1) + LPC[b.n] + b.alt;
        ctx.shift += sb - sa; i = parseExpr(b.i); ctx.shift -= sb - sa; return i;
      }
      case 'key': {
        const pt = readPitchTok(i);
        if (pt) {
          i = pt.i; let mode = 'major';
          if (T[i] && T[i].t === 'cmd') { mode = T[i].v; i++ }
          if (!ctx.scratch && !meta.key) meta.key = keyFrom('CDEFGAB'[pt.n], pt.alt, mode);
        }
        return i;
      }
      case 'time': {
        for (let g = 0; g < 30 && i < T.length && !(T[i].t === 'num' && isP(i + 1, '/')); g++) i++;
        const f = readFrac(i);
        if (f) { if (!ctx.scratch) { if (meta.meter && (meta.meter[0] !== f[0] || meta.meter[1] !== f[1])) warn('time signature changes inside the tune; bar numbers assume the first one'); meta.meter ||= [f[0], f[1]] } i = f[2] }
        return i;
      }
      case 'partial': {
        const d0 = { ...ctx.dur }, tup = ctx.tup; ctx.tup = 1;
        const [db, j] = readDur(i); ctx.dur = d0; ctx.tup = tup;
        if (!ctx.scratch && meta.pickup == null && ctx.t === 0) meta.pickup = db;
        return j;
      }
      case 'tempo': {
        if (T[i] && T[i].t === 'str') i++;
        if (T[i] && T[i].t === 'num') {
          let n = +T[i].v, dots = 0; i++;
          while (isP(i, '.')) { dots++; i++ }
          if (isP(i, '=') && T[i + 1] && T[i + 1].t === 'num') {
            const v = +T[i + 1].v; i += 2;
            if (T[i] && T[i].t === 'art' && /^-\d+$/.test(T[i].v)) i++;
            if (!ctx.scratch) meta.tempos.push({ b: ctx.t, qpm: (4 / n) * (2 - 2 ** -dots) * v });
          }
        }
        return i;
      }
      case 'clef': { if (T[i] && (T[i].t === 'word' || T[i].t === 'str')) i++; if (T[i] && T[i].t === 'art' && /^[_^]\d/.test(T[i].v)) i++; return i }
      case 'bar': case 'barNumberCheck': case 'mark': case 'ottava': case 'accidentalStyle': case 'instrumentSwitch': case 'language': case 'version': case 'tupletSpan':
        if (name === 'language' && !ctx.scratch && T[i] && T[i].v !== 'nederlands') warn('\\language "' + T[i].v + '" is not supported');
        if (T[i] && (T[i].t === 'str' || T[i].t === 'scm' || T[i].t === 'num' || T[i].t === 'word' || T[i].t === 'cmd')) i++;
        return i;
      case 'set': case 'unset': case 'override': case 'revert': case 'omit': case 'hide': case 'undo': return skipPath(i);
      case 'once': case 'unfoldRepeats': case 'default': return name === 'once' ? i : parseExpr(i);
      case 'keepWithTag': case 'removeWithTag': case 'tag': i++; return parseExpr(i);
      case 'new': case 'context': {
        const type = T[i] && T[i].v; i++;
        if (isP(i, '=') && T[i + 1]) i += 2;
        if (T[i] && T[i].t === 'cmd' && T[i].v === 'with') i = skipBal(i + 1);
        if (NONMEL.has(type)) return skipBal(i);
        return parseExpr(i);
      }
      case 'with': return skipBal(i);
      case 'tuplet': case 'times': {
        const f = readFrac(i); if (!f) { warn('\\' + name + ' not understood'); return i }
        i = f[2];
        if (name === 'tuplet' && T[i] && T[i].t === 'num') { i++; while (isP(i, '.')) i++ }
        const fac = name === 'tuplet' ? f[1] / f[0] : f[0] / f[1];
        ctx.tup *= fac; i = parseExpr(i); ctx.tup /= fac; return i;
      }
      case 'repeat': {
        const type = T[i] && T[i].v; i++;
        const N = T[i] && T[i].t === 'num' ? +T[i].v : 2; if (T[i] && T[i].t === 'num') i++;
        if (T[i] && T[i].t === 'str') i++;
        if (type === 'tremolo' || type === 'percent' || type === 'segno') warn('\\repeat ' + type + ' treated as unfold');
        const body = capture(i); i = body.i;
        let alts = [];
        if (T[i] && T[i].t === 'cmd' && T[i].v === 'alternative') {
          i++;
          if (isP(i, '{')) { i++; while (i < T.length && !isP(i, '}')) { const a = capture(i); alts.push(a); i = a.i } i++ }
        }
        const push = x => { for (const e of x.ev) ctx.out.push({ ...e, b: e.b + ctx.t, p: e.p }); ctx.t += x.len };
        if (type === 'volta' && alts.length) {
          if (alts.length > N) warn('\\alternative has more endings than repeats');
          for (let k = 1; k <= N; k++) { push(body); push(alts[Math.min(alts.length - 1, Math.max(0, k - (N - alts.length) - 1))]) }
        } else for (let k = 0; k < N; k++) push(body);
        ctx.lastEv = null;
        return i;
      }
      case 'alternative': return skipBal(i);
      case 'grace': case 'acciaccatura': case 'appoggiatura': case 'slashedGrace': {
        const st = snap(); ctx.scratch = true; ctx.out = []; const j = parseExpr(i); const keep = { ref: ctx.ref, dur: { ...ctx.dur } };
        restore(st); ctx.ref = keep.ref; ctx.dur = keep.dur; return j;
      }
      case 'afterGrace': { i = parseExpr(i); const st = snap(); ctx.scratch = true; ctx.out = []; i = parseExpr(i); restore(st); return i }
      case 'partcombine': { i = parseExpr(i); return skipBal(i) }
      case 'lyricsto': i++; return skipBal(i);
      case 'lyricmode': case 'lyrics': case 'addlyrics': case 'chordmode': case 'chords': case 'drummode': case 'drums': case 'figuremode': case 'figures':
      case 'markup': case 'markuplist': case 'header': case 'layout': case 'midi': case 'paper': case 'score': case 'book': case 'bookpart':
        return skipBal(i);
      case 'skip': { const [db, j] = readDur(i); ctx.t += db; return j }
      case 'breve': case 'longa': return i;
    }
    if (vars.has(name)) {
      if (ctx.evals++ > 20000) { warn('variable expansion too deep'); return i }
      parseExpr(vars.get(name).start); return i;
    }
    if (!SILENT.has(name)) warn('unknown command \\' + name + ' skipped');
    return i;
  }
  function parseExpr(i) {
    const tk = T[i]; if (!tk) return i + 1;
    switch (tk.t) {
      case 'p':
        if (tk.v === '{') return parseGroup(i + 1);
        if (tk.v === '<') return parseChord(i + 1);
        if (tk.v === '~') { if (ctx.lastEv) ctx.lastEv.tie = true; return i + 1 }
        return i + 1;
      case '<<': return parseSimul(i + 1);
      case 'word': return parseWord(i);
      case 'cmd': return parseCmd(i);
      default: return i + 1;
    }
  }

  // top level: assignments, \score blocks, loose music
  const scores = [], loose = [];
  for (let i = 0; i < T.length;) {
    const tk = T[i];
    if (tk.t === 'cmd') {
      const n = tk.v;
      if (n === 'version' || n === 'language') { i += 2; continue }
      if (n === 'header' || n === 'paper' || n === 'layout' || n === 'midi' || n === 'markup' || n === 'markuplist') { i = skipBal(i + 1); continue }
      if (n === 'book' || n === 'bookpart') { i++; if (isP(i, '{')) i++; continue }
      if (n === 'score') { i++; if (isP(i, '{')) { const e = skipBal(i); scores.push([i + 1, e - 1]); i = e } continue }
      loose.push(i); i = dry(i); continue;
    }
    if (tk.t === 'word' && isP(i + 1, '=')) { i = parseWord(i); continue }
    if (isP(i, '{') || tk.t === '<<') { loose.push(i); i = dry(i); continue }
    i++;
  }
  const evalAt = f => { ctx.t = 0; ctx.out = []; ctx.mode = 'abs'; ctx.baseOct = 3; ctx.ref = 0; ctx.tup = 1; ctx.shift = 0; ctx.simul = 0; ctx.dur = { n: 4, dots: 0 }; ctx.lastEv = null; ctx.scratch = false; f(); return ctx.out };
  let ev = [];
  for (const [s, e] of scores) {
    ev = evalAt(() => { for (let i = s; i < e;) { const t = T[i]; if (t.t === 'cmd' && (t.v === 'header' || t.v === 'layout' || t.v === 'midi')) i = skipBal(i + 1); else i = parseExpr(i) } });
    if (ev.length) break;
  }
  if (!ev.length) for (const i of loose) { ev = evalAt(() => parseExpr(i)); if (ev.length) break }
  if (!ev.length) for (const [k, v] of vars) { ev = evalAt(() => parseExpr(v.start)); if (ev.length) { warn('no \\score; used variable "' + k + '"'); break } }
  if (!ev.length) throw new Error('LilyPond: no notes found');
  ev.sort((a, c) => a.b - c.b);
  return assemble({ format: 'lilypond', notes: mergeTies(ev), tempos: meta.tempos, meter: meta.meter || [4, 4], key: meta.key || keyFromFifths(0, 'major'),
    pickup: meta.pickup || 0, chords: [], warnings: W });
}

/* ================= MusicXML ================= */
function parseXml(s) {
  const root = { name: '#root', attrs: {}, children: [], text: '' }, stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>\[]*(?:\[[\s\S]*?\])?\s*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(s))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) { if (stack.length > 1) stack.pop() }
    else if (m[3]) {
      const attrs = {}; for (const a of (m[4] || '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] ?? a[3];
      const el = { name: m[3], attrs, children: [], text: '' }; top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.text += m[6].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  return root;
}
const kid = (e, n) => e && e.children.find(c => c.name === n), kids = (e, n) => e ? e.children.filter(c => c.name === n) : [], txt = (e, n) => { const k = kid(e, n); return k ? k.text.trim() : null };
function unzipEntry(buf, pick) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip file');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16);
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + xl + cl;
    if (!pick(name)) continue;
    const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28), ds = off + 30 + lnl + lxl, data = buf.subarray(ds, ds + csize);
    return { name, data: (method === 0 ? data : inflateRawSync(data)).toString('utf8') };
  }
  return null;
}
const KIND = { major: '', minor: 'm', dominant: '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7', diminished: 'dim', augmented: 'aug', 'suspended-fourth': 'sus4', 'suspended-second': 'sus2', 'major-sixth': '6', 'minor-sixth': 'm6',
  'dominant-ninth': '9', 'half-diminished': 'm7b5', 'diminished-seventh': 'dim7', 'major-minor': 'm', power: '' };
export function parseMusicXml(text, opt = {}) {
  const W = [], warn = m => { if (!W.includes(m) && W.length < 60) W.push(m) };
  const root = parseXml(text), sc = root.children.find(c => c.name === 'score-partwise' || c.name === 'score-timewise');
  if (!sc) throw new Error('MusicXML: no score-partwise element');
  if (sc.name === 'score-timewise') throw new Error('MusicXML: score-timewise is not supported');
  const parts = kids(sc, 'part'), want = opt.part || 0;
  if (want >= parts.length) throw new Error('MusicXML: part ' + want + ' does not exist (' + parts.length + ' parts)');
  const P = parts[want];
  let div = 1, meter = null, key = null, tempos = [];
  const bars = []; let endingNums = null;
  for (const m of kids(P, 'measure')) {
    const bar = { notes: [], chords: [], tempos: [], len: 0, rs: false, re: false, volta: null, number: m.attrs.number };
    let cur = 0, maxc = 0, lastOn = 0;
    for (const e of m.children) {
      if (e.name === 'attributes') {
        const d = txt(e, 'divisions'); if (d) div = +d;
        const k = kid(e, 'key'); if (k && !key) key = keyFromFifths(+txt(k, 'fifths') || 0, txt(k, 'mode') || 'major');
        const t = kid(e, 'time'); if (t && !meter) meter = [+txt(t, 'beats') || 4, +txt(t, 'beat-type') || 4];
        if (kid(e, 'transpose')) warn('part has a <transpose> element; pitches are as written (concert pitch not applied)');
      } else if (e.name === 'direction') {
        const s = kid(e, 'sound'); let q = s && s.attrs.tempo ? +s.attrs.tempo : null;
        const dt = kid(kid(e, 'direction-type'), 'metronome');
        if (!q && dt && txt(dt, 'per-minute')) { const u = txt(dt, 'beat-unit'), pm = parseFloat(txt(dt, 'per-minute')); const base = { whole: 4, half: 2, quarter: 1, eighth: .5, '16th': .25 }[u]; if (base && pm) q = pm * base * (kid(dt, 'beat-unit-dot') ? 1.5 : 1) }
        if (q) bar.tempos.push({ pos: cur / div, qpm: q });
      } else if (e.name === 'sound' && e.attrs.tempo) bar.tempos.push({ pos: cur / div, qpm: +e.attrs.tempo });
      else if (e.name === 'harmony') {
        const rt = kid(e, 'root'); if (!rt) continue;
        const alt = +txt(rt, 'root-alter') || 0, kd = kid(e, 'kind'), kv = KIND[kd ? kd.text.trim() : 'major'] ?? '';
        let name = txt(rt, 'root-step') + (alt > 0 ? '#' : alt < 0 ? 'b' : '') + kv;
        const bs = kid(e, 'bass'); if (bs) name += '/' + txt(bs, 'bass-step') + ((+txt(bs, 'bass-alter') || 0) > 0 ? '#' : (+txt(bs, 'bass-alter') || 0) < 0 ? 'b' : '');
        bar.chords.push({ pos: cur / div, name });
      } else if (e.name === 'backup') { cur -= +txt(e, 'duration') || 0 }
      else if (e.name === 'forward') { cur += +txt(e, 'duration') || 0; maxc = Math.max(maxc, cur) }
      else if (e.name === 'barline') {
        const rp = kid(e, 'repeat'), en = kid(e, 'ending');
        if (rp) { if (rp.attrs.direction === 'forward') bar.rs = true; else bar.re = true }
        if (en) {
          if (en.attrs.type === 'start') endingNums = String(en.attrs.number).split(/[,\s]+/).map(Number).filter(Boolean);
          else bar.endStop = true;
        }
      } else if (e.name === 'note') {
        if (kid(e, 'grace') || kid(e, 'cue')) continue;
        const dur = +txt(e, 'duration') || 0, isChord = !!kid(e, 'chord');
        const on = isChord ? lastOn : cur;
        if (!kid(e, 'rest')) {
          const pt = kid(e, 'pitch');
          if (pt) {
            const p = 12 * ((+txt(pt, 'octave')) + 1) + LETTER_PC[txt(pt, 'step')] + (+txt(pt, 'alter') || 0);
            const ties = kids(e, 'tie').map(x => x.attrs.type);
            bar.notes.push({ pos: on / div, db: dur / div, p, voice: txt(e, 'voice') || '1', staff: txt(e, 'staff') || '1', tieStart: ties.includes('start'), tieStop: ties.includes('stop') });
          }
        }
        if (!isChord) { lastOn = cur; cur += dur; maxc = Math.max(maxc, cur) }
      }
    }
    bar.len = maxc / div;
    if (endingNums) bar.volta = endingNums;
    if (bar.endStop) endingNums = null;
    if (m.attrs.implicit === 'yes' && !bars.length) bar.pickup = bar.len;
    bars.push(bar);
  }
  const played = opt.repeats === false ? bars : unfoldBars(bars);
  let b0 = 0; const all = [], chords = [];
  for (const bar of played) {
    for (const n of bar.notes) all.push({ ...n, b: b0 + n.pos });
    for (const c of bar.chords) chords.push({ b: b0 + c.pos, name: c.name });
    for (const t of bar.tempos) tempos.push({ b: b0 + t.pos, qpm: t.qpm });
    b0 += bar.len;
  }
  // ties inside one voice
  const open = new Map(), merged = [];
  all.sort((a, c) => a.b - c.b);
  for (const n of all) {
    const k = n.voice + ':' + n.staff + ':' + n.p, o = open.get(k);
    if (o && n.tieStop && Math.abs(o.b + o.db - n.b) < 1e-4) { o.db += n.db; if (!n.tieStart) open.delete(k); continue }
    const x = { ...n }; merged.push(x);
    if (n.tieStart) open.set(k, x); else open.delete(k);
  }
  // the highest voice: at each onset keep the top note; a lower note that starts under a held higher one is an inner voice
  merged.sort((a, c) => a.b - c.b || c.p - a.p);
  const sky = [];
  for (const n of merged) {
    const l = sky[sky.length - 1];
    if (l && n.b - l.b < 1e-4) continue;
    if (l && n.b < l.b + l.db - 1e-4 && n.p < l.p - 2 && l.b + l.db - n.b > 0.1) continue;
    sky.push({ ...n });
  }
  for (let k = 0; k < sky.length - 1; k++) sky[k].db = Math.min(sky[k].db, sky[k + 1].b - sky[k].b);
  const voices = new Set(merged.map(n => n.voice + '/' + n.staff)); if (voices.size > 1) warn('part has ' + voices.size + ' voices/staves; the top voice is taken');
  return assemble({ format: 'musicxml', notes: sky.map(n => ({ b: n.b, db: n.db, p: n.p })), tempos, meter: meter || [4, 4], key: key || keyFromFifths(0, 'major'),
    pickup: bars[0] && bars[0].pickup ? bars[0].pickup : 0, chords, warnings: W });
}

/* ================= dispatch ================= */
export function loadScore(path, opt = {}) {
  const ext = path.toLowerCase().replace(/^.*\./, '');
  if (ext === 'abc') return parseAbc(readFileSync(path, 'utf8'), opt);
  if (ext === 'ly' || ext === 'ily') return parseLily(readFileSync(path, 'utf8'), opt);
  if (ext === 'xml' || ext === 'musicxml') return parseMusicXml(readFileSync(path, 'utf8'), opt);
  if (ext === 'mxl') {
    const buf = readFileSync(path);
    const c = unzipEntry(buf, n => n === 'META-INF/container.xml');
    let name = c && /full-path="([^"]+)"/.exec(c.data); name = name && name[1];
    const x = unzipEntry(buf, n => name ? n === name : (/\.(xml|musicxml)$/i.test(n) && !/^META-INF/.test(n)));
    if (!x) throw new Error(path + ': no MusicXML inside the .mxl');
    return parseMusicXml(x.data, opt);
  }
  throw new Error(path + ': unsupported score format .' + ext + ' (use .abc .ly .xml .musicxml .mxl)');
}

// CLI
import { pathToFileURL } from 'node:url';
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const a = process.argv.slice(2), file = a.find((x, k) => !x.startsWith('--') && a[k - 1] !== '--part');
  if (!file) { console.log('usage: node tools/scorelib.mjs <file> [--part N] [--norepeat] [--json]'); process.exit(1) }
  const r = loadScore(file, { part: a.includes('--part') ? +a[a.indexOf('--part') + 1] : 0, repeats: !a.includes('--norepeat') });
  if (a.includes('--json')) console.log(JSON.stringify(r));
  else {
    const last = r.notes[r.notes.length - 1], ps = r.notes.map(n => n.p);
    console.log(`${file}: ${r.format}, ${r.notes.length} notes, ${last ? (last.t + last.d).toFixed(1) : 0} s, bpm ${r.bpm}, meter ${r.meter.join('/')}, key fifths ${r.key.fifths} ${r.key.mode}, pickup ${r.pickup}, range ${noteName(Math.min(...ps))}-${noteName(Math.max(...ps))}, chords ${r.chords.length}`);
    for (const w of r.warnings) console.log('  warning: ' + w);
  }
}
