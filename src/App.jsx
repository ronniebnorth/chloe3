import { useState, useEffect, useRef, useMemo, useCallback, Fragment } from "react";
import { Soundfont, DrumMachine } from "smplr";
import { BRIGHTNESS_CONFIG, brightnessScore, normalizedBrightness, targetBrightness, findClosestScale, countBits, randomAtBrightness, diatonicNeighborhood } from './brightness';

/* ═══════════════════════════════════════════════════════
   SCALE ENGINE
═══════════════════════════════════════════════════════ */

// Right-rotate a 12-bit pattern by n steps
// Usage stats (GoatCounter, loaded in index.html): an event is a path on the dashboard.
// count.js skips it all on browsers opted out with ?nocount
const track = (path, title = path) => { try { window.goatcounter?.count?.({ path, title, event: true }); } catch {} };
const LISTEN_MARKS = [1, 5, 15, 30, 60];   // minutes of sound per visit

// ♥ "more of this": each like is a snapshot of what was playing. Auto's picks
// lean toward liked things: a like's pull halves every 15 minutes, and every
// like ever saved (in this browser) keeps a small share of a fixed 0.3 pull,
// so Chloe slowly learns a listener's taste without getting stuck.
const LIKE_HALF = 15 * 60000, LIKE_KEEP = 60;
const loadLikes = () => { try { return JSON.parse(localStorage.getItem("chloe-likes") || "[]"); } catch { return []; } };
const likeW = (likes, now = Date.now()) => likes.map(l => Math.pow(0.5, (now - l.t) / LIKE_HALF) + 0.3 / Math.max(5, likes.length));
// A liked value of one field, among the allowed ones, or null: the stronger the
// likes, the likelier (one fresh like ≈ 45%, several ≈ 80%)
const likedPick = (likes, field, allowed) => {
  const w = likeW(likes), votes = new Map();
  likes.forEach((l, i) => { const v = l[field]; if (v !== undefined && v !== null && (!allowed || allowed.includes(v))) votes.set(v, (votes.get(v) || 0) + w[i]); });
  const S = [...votes.values()].reduce((a, x) => a + x, 0);
  if (!S || Math.random() > 0.9 * S / (S + 1)) return null;
  let r = Math.random() * S;
  for (const [v, x] of votes) if ((r -= x) < 0) return v;
  return null;
};
// The liked average of a number field (log space for tempo) and how hard it pulls (0-0.7)
const likedMean = (likes, field, log = false) => {
  const w = likeW(likes); let S = 0, m = 0;
  likes.forEach((l, i) => { const v = l[field]; if (typeof v === "number" && v > 0) { S += w[i]; m += w[i] * (log ? Math.log(v) : v); } });
  return S ? { v: log ? Math.exp(m / S) : m / S, k: 0.7 * S / (S + 1) } : null;
};

const rot12 = (p, n) => {
  n = ((n % 12) + 12) % 12;
  return ((p >>> n) | (p << (12 - n))) & 0xfff;
};

const bitCt = (n) => n.toString(2).replace(/0/g, "").length;

// Check for 3 consecutive semitones (circular)
const hasTriple = (p) => {
  for (let i = 0; i < 12; i++)
    if (((p >> i) & 1) && ((p >> ((i + 1) % 12)) & 1) && ((p >> ((i + 2) % 12)) & 1))
      return true;
  return false;
};

// Brightness score: sum of active semitone positions (higher = brighter/Lydian-like)
const bright = (p) => {
  let s = 0;
  for (let i = 0; i < 12; i++) if ((p >> i) & 1) s += i;
  return s;
};

const toSemis = (p) => {
  const r = [];
  for (let i = 0; i < 12; i++) if ((p >> i) & 1) r.push(i);
  return r;
};

const toBin = (p) => Array.from({ length: 12 }, (_, i) => (p >> i) & 1).join("");

const CHROMATIC = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

const KNOWN = {
  // ── Diatonic modes ──────────────────────────────
  2773: "Lydian",          2741: "Ionian",         1717: "Mixolydian",
  1709: "Dorian",          1453: "Aeolian",         1451: "Phrygian",
  1387: "Locrian",

  // ── Harmonic minor & modes ───────────────────────
  2477: "Harm. Minor",
  1643: "Locrian ♯6",      // mode 2  — 0 1 3 5 6 9 10
  2869: "Ionian ♯5",       // mode 3  — 0 2 4 5 8 9 11
  1741: "Ukrainian Dorian",// mode 4  — 0 2 3 6 7 9 10  (= Dorian ♯4, Romanian)
  1459: "Phrygian Dom.",   // mode 5  — 0 1 4 5 7 8 10
  2777: "Lydian ♯2",       // mode 6  — 0 3 4 6 7 9 11
  731:  "Altered Dim.",    // mode 7  — 0 1 3 4 6 7 9

  // ── Melodic minor & modes ────────────────────────
  2733: "Mel. Minor",
  1707: "Dorian ♭2",       // mode 2  — 0 1 3 5 7 9 10
  2901: "Lydian Aug.",     // mode 3  — 0 2 4 6 8 9 11
  1749: "Lydian Dom.",     // mode 4  — 0 2 4 6 7 9 10  (= Acoustic, Overtone)
  1461: "Hindu",           // mode 5  — 0 2 4 5 7 8 10  (= Mixolydian ♭6)
  1389: "Locrian ♮2",      // mode 6  — 0 2 3 5 6 8 10  (= Half-Diminished)
  1371: "Altered",         // mode 7  — 0 1 3 4 6 8 10  (= Super Locrian)

  // ── Harmonic major & modes ───────────────────────
  2485: "Harmonic Major",  //           0 2 4 5 7 8 11
  2765: "Lydian Diminished",// mode 4  — 0 2 3 6 7 9 11

  // ── Other named heptatonics ──────────────────────
  2483: "Double Harmonic", //           0 1 4 5 7 8 11  (= Byzantine, Bhairav)
  2475: "Neapolitan Min.", //           0 1 3 5 7 8 11
  2731: "Neapolitan Maj.", //           0 1 3 5 7 9 11
  1753: "Hungarian Major", //           0 3 4 6 7 9 10

  // ── Pentatonics ──────────────────────────────────
  661:  "Maj. Pentatonic", 1193: "Min. Pentatonic",
  677:  "Ritusen",         //  0 2 5 7 9   (= Yo)
  1189: "Egyptian",        //  0 2 5 7 10  (Suspended pent.)
  1321: "Man Gong",        //  0 3 5 8 10
  1187: "Insen",           //  0 1 5 7 10
  1123: "Iwato",           //  0 1 5 6 10
  397:  "Hirajoshi",       //  0 2 3 7 8
  653:  "Kumoi",           //  0 2 3 7 9
  419:  "In Scale",        //  0 1 5 7 8
  395:  "Pelog",           //  0 1 3 7 8

  // ── Hexatonics ───────────────────────────────────
  1257: "Blues",
  1365: "Whole Tone",      //  0 2 4 6 8 10
  2457: "Augmented",       //  0 3 4 7 8 11
  1621: "Prometheus",      //  0 2 4 6 9 10
  1235: "Tritone Scale",   //  0 1 4 6 7 10
  219:  "Istrian",         //  0 1 3 4 6 7

  // ── Octatonics ───────────────────────────────────
  1755: "Octatonic HW",   //  half-whole diminished
  2925: "Octatonic WH",   //  whole-half diminished

  // ── Outside (contain a 3-semitone run) ───────────
  1843: "Coltrane Dominant", // 0 1 4 5 8 9 10 — augmented hexatonic + ♭7
};

// Duduk (Armenian, apricot wood, a big double reed on a cylindrical bore):
// odd harmonics strong, even ones softer, then a voice-like mouth of formants.
// Cached per context.
const dudukWave = ac => ac.__duduk || (ac.__duduk = (() => {
  const N = 30, re = new Float32Array(N + 1), im = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) im[n] = (n % 2 ? 1 : 0.38) / Math.pow(n, 0.95);
  return ac.createPeriodicWave(re, im);
})());
// The formants that make it sound like singing: ~600 Hz, ~1.15 kHz, ~2.6 kHz
const dudukBody = (ac, input, mk) => {
  const hp = mk("highpass", 140), f1 = mk("peaking", 600), f2 = mk("peaking", 1150), f3 = mk("peaking", 2600), lp = mk("lowpass", 3600);
  f1.Q.value = 2; f1.gain.value = 8; f2.Q.value = 3; f2.gain.value = 6; f3.Q.value = 4; f3.gain.value = 3; lp.Q.value = 0.5;
  input.connect(hp); hp.connect(f1); f1.connect(f2); f2.connect(f3); f3.connect(lp);
  return lp;
};
// Dam: the second duduk holding the home note under the melody, circular
// breathing so it never stops, swelling slowly, the pitch never quite still
function synthDam(ac, freq) {
  let F = fold(freq, 98, 196);
  const master = ac.createGain(); master.gain.value = 0.063;   // level with the tanpura
  const filt = [];
  const mk = (type, f) => { const b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; filt.push(b); return b; };
  const o = ac.createOscillator(); o.setPeriodicWave(dudukWave(ac)); o.frequency.value = F;
  const sw = ac.createGain(); sw.gain.value = 0.85;
  const swl = ac.createOscillator(), swg = ac.createGain(); swl.frequency.value = 0.08; swg.gain.value = 0.15; swl.connect(swg); swg.connect(sw.gain);
  const dr = ac.createOscillator(), drg = ac.createGain(); dr.frequency.value = 0.13; drg.gain.value = 5; dr.connect(drg); drg.connect(o.detune);
  o.connect(sw);
  const out = dudukBody(ac, sw, mk); out.connect(master);
  // Breath: a little air through the reed
  const nb = ac.createBufferSource(), nbuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate), nd = nbuf.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  nb.buffer = nbuf; nb.loop = true;
  const nf = mk("bandpass", 1500); nf.Q.value = 0.8; const ng = ac.createGain(); ng.gain.value = 0.035;
  nb.connect(nf); nf.connect(ng); ng.connect(sw);
  const lfos = [swl, dr];
  [o, ...lfos].forEach(x => x.start()); nb.start();
  return {
    node: master, oscs: [o], baseFreq: freq,
    setFreq: (ratio, glide) => {
      const now = ac.currentTime; F *= ratio;
      o.frequency.cancelScheduledValues(now); o.frequency.setValueAtTime(o.frequency.value, now); o.frequency.exponentialRampToValueAtTime(F, now + glide);
    },
    stop: () => { [o, ...lfos, nb].forEach(x => { try { x.stop(); } catch {} }); setTimeout(() => { try { master.disconnect(); } catch {} }, 150); },
  };
}

// New wave. Gated reverb (the 1980s snare): a burst of dense noise that holds
// flat for ~230 ms and then is cut off dead, darkened a little.
function gatedIR(ac) {
  const sr = ac.sampleRate, n = Math.floor(sr * 0.26), buf = ac.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c); let lp = 0;
    for (let i = 0; i < n; i++) { lp += 0.45 * ((Math.random() * 2 - 1) - lp); d[i] = lp * (i < sr * 0.005 ? i / (sr * 0.005) : i > n - sr * 0.012 ? (n - i) / (sr * 0.012) : 1) * 0.5; }
  }
  return buf;
}
// Synth bass, one note: two detuned saws and a square an octave down through a
// resonant low-pass whose cutoff snaps open and closes (the pulsing 8ths)
function neonBass(ac, dest, freq, t, dur, vel) {
  const g = ac.createGain(), f = ac.createBiquadFilter();
  f.type = "lowpass"; f.Q.value = 7;
  f.frequency.setValueAtTime(380 + 2400 * vel, t); f.frequency.setTargetAtTime(260, t + 0.005, 0.07);
  const os = [["sawtooth", freq, -6], ["sawtooth", freq, 6], ["square", freq / 2, 0]].map(([w, fr, dt]) => {
    const o = ac.createOscillator(); o.type = w; o.frequency.value = fr; o.detune.value = dt; o.connect(f); return o; });
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.16 * vel, t + 0.004);
  g.gain.setValueAtTime(0.16 * vel, t + dur * 0.8); g.gain.linearRampToValueAtTime(0, t + dur);
  f.connect(g); g.connect(dest);
  os.forEach(o => { o.start(t); o.stop(t + dur + 0.02); });
  os[0].onended = () => { try { g.disconnect(); f.disconnect(); } catch {} };
}
// New wave chord roots, as scale degrees, two bars each: I-vi-IV-V, I-V-vi-IV,
// vi-IV-I-V, I-IV-vi-V
const NEON_PROGS = [[0, 5, 3, 4], [0, 4, 5, 3], [5, 3, 0, 4], [0, 3, 5, 4]];
const NEON_BASS = [0, 0, 12, 0, 0, 0, 12, 0];   // octave pops in the 8th-note pulse

// Juno-style pad: root, fifth, octave and high fifth (plus the 9th when the
// scale has it, the suspended 80s shimmer), two detuned saws each, softened,
// then the Juno's chorus: two short modulated delays spread left and right
function synthJuno(ac, freq, opts) {
  let F = fold(freq, 65, 131);
  const master = ac.createGain(); master.gain.value = 0.11;   // level with the tanpura
  const sum = ac.createGain(); sum.gain.value = 1;
  const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2600; lp.Q.value = 0.6;
  const semis = opts?.scale?.() ?? [0, 7];
  const ratios = [1, 1.5, 2, 3].concat(semis.some(x => ((x % 12) + 12) % 12 === 2) ? [2.25] : []);
  const oscs = [], lfos = [];
  ratios.forEach(r => [-9, 9].forEach(dt => {
    const o = ac.createOscillator(); o.type = "sawtooth"; o.frequency.value = F * r; o.detune.value = dt;
    const g = ac.createGain(); g.gain.value = r === 1 ? 0.3 : r >= 2.25 ? 0.12 : 0.2; o.connect(g); g.connect(sum); oscs.push(o);
  }));
  sum.connect(lp); lp.connect(master);
  [[0.007, 0.5, -0.7], [0.011, 0.83, 0.7]].forEach(([d, rate, pan]) => {
    const dl = ac.createDelay(0.05); dl.delayTime.value = d;
    const l = ac.createOscillator(), lg = ac.createGain(); l.frequency.value = rate; lg.gain.value = 0.0025; l.connect(lg); lg.connect(dl.delayTime); lfos.push(l);
    const p = ac.createStereoPanner(); p.pan.value = pan;
    lp.connect(dl); dl.connect(p); p.connect(master);
  });
  [...oscs, ...lfos].forEach(o => o.start());
  return {
    node: master, oscs, baseFreq: freq,
    setFreq: (ratio, glide) => {
      const now = ac.currentTime; F *= ratio;
      for (const o of oscs) { o.frequency.cancelScheduledValues(now); o.frequency.setValueAtTime(o.frequency.value, now); o.frequency.exponentialRampToValueAtTime(o.frequency.value * ratio, now + glide); }
    },
    stop: () => { [...oscs, ...lfos].forEach(o => { try { o.stop(); } catch {} }); setTimeout(() => { try { master.disconnect(); } catch {} }, 150); },
  };
}

// Overtone voices (throat singing, jaw harp) play the drone root's own
// harmonic series; these are the harmonics they sing, kept to the ones whose
// pitch is in the scale (6, 8, 12, 16 = fifth and root, always safe).
// Harmonic 7 is the bluesy flat 7th (31 cents flat), 9 the 2nd, 10 the 3rd.
const OVERTONES = [6, 7, 8, 9, 10, 12, 14, 15, 16];
const harmPc = n => Math.round(12 * Math.log2(n)) % 12;
const overtonesIn = (semis, lo = 0, hi = 99) => {
  const pcs = new Set(semis.map(x => ((x % 12) + 12) % 12));
  const ok = OVERTONES.filter(n => n >= lo && n <= hi && pcs.has(harmPc(n)));
  return ok.length >= 2 ? ok : OVERTONES.filter(n => n >= lo && n <= hi && harmPc(n) === 0 || n === 12);
};
// A buzzy source wave: harmonic n at 1/n^tilt
const harmWave = (ac, tilt, N = 48) => {
  const re = new Float32Array(N + 1), im = new Float32Array(N + 1);
  for (let n = 1; n <= N; n++) im[n] = 1 / Math.pow(n, tilt);
  return ac.createPeriodicWave(re, im);
};
const fold = (f, lo, hi) => { while (f < lo) f *= 2; while (f > hi) f /= 2; return f; };

// Mongolian throat singing (khöömei / sygyt): a steady buzzing voice shaped
// by an "oo-aa" mouth, a very narrow resonance picking out one harmonic as a
// whistle that walks slowly through the overtones, a kargyraa growl an octave
// under that swells in and out, and a breath every 14-26 s.
// opts.scale() = the scale's semitones. Its own pitch is folded to 90-180 Hz.
function synthThroat(ac, freq, opts) {
  let F = fold(freq, 90, 180);
  const master = ac.createGain(), bright = ac.createGain(), phrase = ac.createGain();
  master.gain.value = 0.13; bright.gain.value = 0.13;   // level with the tanpura
  const src = ac.createOscillator(); src.setPeriodicWave(harmWave(ac, 1.05)); src.frequency.value = F;
  const sub = ac.createOscillator(); sub.setPeriodicWave(harmWave(ac, 1.3, 24)); sub.frequency.value = F / 2;
  const jit = ac.createOscillator(), jitG = ac.createGain();   // a little unsteadiness, ±4 cents
  jit.frequency.value = 0.31; jitG.gain.value = 4; jit.connect(jitG); jitG.connect(src.detune); jitG.connect(sub.detune);
  src.connect(phrase);
  // Mouth: two vowel formants
  const vowel = (f, q, g) => { const b = ac.createBiquadFilter(); b.type = "bandpass"; b.frequency.value = f; b.Q.value = q;
    const gg = ac.createGain(); gg.gain.value = g; phrase.connect(b); b.connect(gg); gg.connect(master); return b; };
  const f1 = vowel(480, 2.5, 1.1), f2 = vowel(1050, 5, 0.4);
  const vl = ac.createOscillator(), vlG = ac.createGain();   // the vowel drifts oo↔aa
  vl.frequency.value = 0.07; vlG.gain.value = 90; vl.connect(vlG); vlG.connect(f1.frequency);
  // Growl: the sub through a low-pass, swelling in and out
  const growlLp = ac.createBiquadFilter(); growlLp.type = "lowpass"; growlLp.frequency.value = 380;
  const growl = ac.createGain(); growl.gain.value = 0.15;
  const gl = ac.createOscillator(), glG = ac.createGain(); gl.frequency.value = 0.045; glG.gain.value = 0.15;
  gl.connect(glG); glG.connect(growl.gain);
  sub.connect(growlLp); growlLp.connect(growl); growl.connect(phrase);
  // Whistle: two narrow band-passes in a row on one harmonic, past the tone filter
  const w1 = ac.createBiquadFilter(), w2 = ac.createBiquadFilter(), wg = ac.createGain();
  for (const w of [w1, w2]) { w.type = "bandpass"; w.Q.value = 38; w.frequency.value = 8 * F; }
  wg.gain.value = 0;
  phrase.connect(w1); w1.connect(w2); w2.connect(wg); wg.connect(bright);
  const W = 6;   // the band-passes leave ~1/n of the source: the whistle sits ~3 dB over the voice
  let h = 8, alive = true, wT = null, bT = null;
  const t0 = ac.currentTime;
  phrase.gain.setValueAtTime(0, t0); phrase.gain.linearRampToValueAtTime(1, t0 + 1.2);
  wg.gain.setValueAtTime(0, t0); wg.gain.linearRampToValueAtTime(W, t0 + 3);
  const step = () => {
    if (!alive) return;
    const ok = overtonesIn(opts?.scale?.() ?? [0, 7], 6, 16);
    let i = ok.indexOf(h); if (i < 0) i = ok.indexOf(8) >= 0 ? ok.indexOf(8) : 0;
    const r = Math.random();
    const j = Math.max(0, Math.min(ok.length - 1, i + (r < 0.3 ? 1 : r < 0.6 ? -1 : r < 0.75 ? 2 : r < 0.9 ? -2 : 0)));
    h = ok[j];
    const now = ac.currentTime;
    for (const w of [w1, w2]) w.frequency.setTargetAtTime(h * F, now, 0.06 + Math.random() * 0.1);
    // Now and then the whistle sinks back into the drone for a while
    wg.gain.setTargetAtTime(Math.random() < 0.2 ? W * 0.12 : W, now, 0.5);
    wT = setTimeout(step, 700 + Math.random() * 2800);
  };
  wT = setTimeout(step, 2500);
  const breathe = () => {
    if (!alive) return;
    const now = ac.currentTime, p = phrase.gain;
    p.cancelScheduledValues(now); p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(0, now + 0.35); p.setValueAtTime(0, now + 1.1); p.linearRampToValueAtTime(1, now + 1.6);
    h = Math.random() < 0.5 ? 8 : 6;   // a new breath starts low
    bT = setTimeout(breathe, 14000 + Math.random() * 12000);
  };
  bT = setTimeout(breathe, 14000 + Math.random() * 12000);
  const oscs = [src, sub, jit, vl, gl];
  oscs.forEach(o => o.start());
  return {
    node: master, bright, oscs, baseFreq: freq,
    setFreq: (ratio, glide) => {
      const now = ac.currentTime; F *= ratio;
      for (const [o, f] of [[src, F], [sub, F / 2]]) { o.frequency.cancelScheduledValues(now); o.frequency.setValueAtTime(o.frequency.value, now); o.frequency.exponentialRampToValueAtTime(f, now + glide); }
      for (const w of [w1, w2]) w.frequency.setTargetAtTime(h * F, now, glide / 3);
    },
    stop: () => {
      alive = false; clearTimeout(wT); clearTimeout(bT);
      oscs.forEach(o => { try { o.stop(); } catch {} });
      setTimeout(() => { try { master.disconnect(); bright.disconnect(); } catch {} }, 150);
    },
  };
}

// Jaw harp (khomus / aman khuur): a buzzing reed plucked in rhythm, the mouth
// a resonance that jumps between the reed's harmonics with the "wow" swoop
// between them, a fixed twang formant higher up and a little body underneath.
// Plucks ride the beat's own 16th grid when a beat plays (opts.stepHook), or
// keep their own time from opts.bpm(). Gallop, straight 8ths or 3+3+2,
// changing every few bars; the mouth repeats a short motif. Pitch folded to 80-160 Hz.
const JAW_PATTERNS = [
  [1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1],   // gallop
  [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],   // straight 8ths
  [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0],   // 3+3+2
];
function synthJawHarp(ac, freq, opts) {
  let F = fold(freq, 80, 160);
  const master = ac.createGain(), bright = ac.createGain();
  master.gain.value = 0.44; bright.gain.value = 0.44;   // level with the tanpura
  const reed = ac.createOscillator(); reed.setPeriodicWave(harmWave(ac, 0.6, 60)); reed.frequency.value = F;
  const amp = ac.createGain(); amp.gain.value = 0;
  reed.connect(amp);
  const body = ac.createBiquadFilter(); body.type = "lowpass"; body.frequency.value = 420;
  const bodyG = ac.createGain(); bodyG.gain.value = 0.55; amp.connect(body); body.connect(bodyG); bodyG.connect(master);
  const mouth = ac.createBiquadFilter(); mouth.type = "bandpass"; mouth.Q.value = 11; mouth.frequency.value = 6 * F;
  const mouthG = ac.createGain(); mouthG.gain.value = 3.2; amp.connect(mouth); mouth.connect(mouthG); mouthG.connect(bright);
  const twang = ac.createBiquadFilter(); twang.type = "bandpass"; twang.Q.value = 2.5; twang.frequency.value = 2600;
  const twangG = ac.createGain(); twangG.gain.value = 0.3; amp.connect(twang); twang.connect(twangG); twangG.connect(bright);
  let alive = true, pat = JAW_PATTERNS[0], bars = 0, motif = [6, 8], mi = 0, h = 6, lastHook = -1;
  const newMotif = () => {
    const ok = overtonesIn(opts?.scale?.() ?? [0, 7], 4, 12).concat([4, 5].filter(n => (opts?.scale?.() ?? [0, 4]).some(x => ((x % 12) + 12) % 12 === harmPc(n))));
    motif = Array.from({ length: 3 + Math.floor(Math.random() * 4) }, () => ok[Math.floor(Math.random() * ok.length)]);
    mi = 0;
  };
  newMotif();
  const pluck = (t, step) => {
    if (!pat[step % 16]) return;
    if (step % 16 === 0 && ++bars % 4 === 0) {
      pat = JAW_PATTERNS[Math.floor(Math.random() * JAW_PATTERNS.length)];
      if (Math.random() < 0.5) newMotif();
    }
    const accent = step % 4 === 0, g = amp.gain;
    g.setTargetAtTime(accent ? 1 : 0.7, t, 0.002);
    g.setTargetAtTime(0.12, t + 0.015, 0.22 + Math.random() * 0.12);   // rings on between plucks
    // The mouth moves on about half the plucks: a quick swoop to the next harmonic
    if (accent || Math.random() < 0.4) {
      const prev = h; h = motif[mi++ % motif.length];
      mouth.frequency.setTargetAtTime(prev * F * (Math.random() < 0.3 ? 0.8 : 1), t, 0.01);
      mouth.frequency.setTargetAtTime(h * F, t + 0.02, 0.035);
    }
  };
  const hook = (ac2, t, step) => { if (ac2 === ac && alive) { lastHook = ac.currentTime; pluck(t, step); } };
  if (opts?.stepHook) opts.stepHook.current = hook;
  // No beat: its own clock (half time above 120 BPM, like the hand drums)
  let nextT = 0, own = 0;
  const tick = () => {
    if (!alive) return;
    if (ac.currentTime - lastHook > 0.3) {
      const b = Math.max(40, opts?.bpm?.() ?? 100), sd = 60 / (b > 120 ? b / 2 : b) / 4;
      if (nextT < ac.currentTime) { nextT = ac.currentTime + 0.05; own = 0; }
      while (nextT < ac.currentTime + 0.12) { pluck(nextT, own++); nextT += sd; }
    } else nextT = 0;
    tT = setTimeout(tick, 25);
  };
  let tT = setTimeout(tick, 25);
  const oscs = [reed];
  reed.start();
  return {
    node: master, bright, oscs, baseFreq: freq,
    setFreq: (ratio, glide) => {
      const now = ac.currentTime; F *= ratio;
      reed.frequency.cancelScheduledValues(now); reed.frequency.setValueAtTime(reed.frequency.value, now);
      reed.frequency.exponentialRampToValueAtTime(F, now + glide);
      mouth.frequency.setTargetAtTime(h * F, now, glide / 3);
    },
    stop: () => {
      alive = false; clearTimeout(tT);
      if (opts?.stepHook?.current === hook) opts.stepHook.current = null;
      try { reed.stop(); } catch {}
      setTimeout(() => { try { master.disconnect(); bright.disconnect(); } catch {} }, 150);
    },
  };
}

function synthDrone(ac, freq, type, opts) {
  if (type === "throat") return synthThroat(ac, freq, opts);
  if (type === "jawharp") return synthJawHarp(ac, freq, opts);
  if (type === "juno") return synthJuno(ac, freq, opts);
  if (type === "dam") return synthDam(ac, freq);
  const oscs = [];
  const mk = (f, wt, detune = 0) => {
    const o = ac.createOscillator();
    o.type = wt; o.frequency.value = f; o.detune.value = detune;
    oscs.push(o); return o;
  };
  const master = ac.createGain();

  if (type === "organ") {
    // Hammond-style additive: harmonic series of sines
    master.gain.value = 0.05;
    const mix = ac.createGain(); mix.gain.value = 1; mix.connect(master);
    [[0.5, 0.55], [1, 1.0], [2, 0.7], [3, 0.45], [4, 0.25], [6, 0.12], [8, 0.06]]
      .forEach(([mult, gain]) => {
        const g = ac.createGain(); g.gain.value = gain;
        mk(freq * mult, "sine").connect(g); g.connect(mix);
      });

  } else if (type === "pad") {
    // 8 detuned sines in two octaves, LFO shimmer
    master.gain.value = 0.055;
    const mix = ac.createGain(); mix.gain.value = 1; mix.connect(master);
    const lfo = ac.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 0.18;
    const lfoG = ac.createGain(); lfoG.gain.value = 3; lfo.connect(lfoG); oscs.push(lfo);
    [[-14,1],[-6,1],[6,1],[14,1],[-11,2],[-4,2],[4,2],[11,2]].forEach(([cents, mult]) => {
      const g = ac.createGain(); g.gain.value = 0.13;
      const o = mk(freq * mult, "sine", cents);
      lfoG.connect(o.detune);
      o.connect(g); g.connect(mix);
    });

  } else if (type === "strings") {
    // Detuned saws + octave triangle, with slow tremolo
    master.gain.value = 0.05;
    const mix = ac.createGain(); mix.gain.value = 1; mix.connect(master);
    const trem = ac.createOscillator(); trem.type = "sine"; trem.frequency.value = 4.5;
    const tremG = ac.createGain(); tremG.gain.value = 0.025; trem.connect(tremG); oscs.push(trem);
    const tremMix = ac.createGain(); tremMix.gain.value = 1;
    tremG.connect(tremMix.gain); tremMix.connect(mix);
    [[-7,1,"sawtooth"],[0,1,"sawtooth"],[7,1,"sawtooth"],[0,2,"triangle"]].forEach(([cents, mult, wt]) => {
      const g = ac.createGain(); g.gain.value = mult === 2 ? 0.2 : 0.28;
      mk(freq * mult, wt, cents).connect(g); g.connect(tremMix);
    });

  } else if (type === "tanpura") {
    // Indian tanpura: root, P5, oct, 2oct — each string slowly pulsing
    master.gain.value = 0.055;
    const mix = ac.createGain(); mix.gain.value = 1; mix.connect(master);
    [[1, -2, 0.23, 0.35, 0.65], [1.498, 1, 0.19, 0.28, 0.50], [2, 0, 0.27, 0.30, 0.55], [4, 2, 0.17, 0.22, 0.40]]
      .forEach(([mult, detune, rate, depth, base]) => {
        const o = mk(freq * mult, "sine", detune);
        const ampEnv = ac.createGain(); ampEnv.gain.value = base;
        const lfo = ac.createOscillator(); lfo.type = "sine"; lfo.frequency.value = rate;
        const lfoG = ac.createGain(); lfoG.gain.value = depth;
        lfo.connect(lfoG); lfoG.connect(ampEnv.gain); oscs.push(lfo);
        o.connect(ampEnv); ampEnv.connect(mix);
      });

  } else {
    // sine — clean fundamental + soft sub-octave
    master.gain.value = 0.07;
    const mix = ac.createGain(); mix.gain.value = 1; mix.connect(master);
    const g = ac.createGain(); g.gain.value = 0.85; mk(freq, "sine").connect(g); g.connect(mix);
    const sg = ac.createGain(); sg.gain.value = 0.28; mk(freq * 0.5, "sine").connect(sg); sg.connect(mix);
  }

  oscs.forEach(o => o.start());
  return {
    node: master,
    oscs,       // exposed for frequency gliding
    baseFreq: freq, // the frequency they were created at
    stop: () => {
      oscs.forEach(o => { try { o.stop(); } catch {} });
      setTimeout(() => { try { master.disconnect(); } catch {} }, 150);
    },
  };
}


window.__synthDrone = synthDrone;   // console / level tests
window.__synthNote = synthNote;

// Master bus: every sound goes through a limiter so loud accents and big
// chords can't clip. Chrome's compressor adds ~+1.7 dB make-up gain; the
// trim cancels it, so anything below the threshold plays unchanged.
function masterOut(ac) {
  if (!ac.__master) {
    const lim = ac.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20;
    lim.attack.value = 0.002; lim.release.value = 0.15;
    const trim = ac.createGain(); trim.gain.value = 0.82;
    // A gentle top-end cut on everything (-3 dB above ~5 kHz): no shrill edges
    const soft = ac.createBiquadFilter(); soft.type = "highshelf"; soft.frequency.value = 5000; soft.gain.value = -3;
    soft.connect(lim); lim.connect(trim); trim.connect(ac.destination);
    ac.__master = soft;
    ac.__masterTap = trim;      // the recorder listens here: exactly what you hear
  }
  return ac.__master;
}

// Recorder: an AudioWorklet copies the master output (stereo, float) to the
// page in ~4096-frame chunks; on stop they are written out as a 24-bit WAV.
const REC_WORKLET = `
class ChloeRec extends AudioWorkletProcessor {
  constructor() { super(); this.L = []; this.R = []; this.n = 0; }
  process(inputs) {
    const ch = inputs[0];
    if (ch && ch.length) {
      this.L.push(ch[0].slice()); this.R.push((ch[1] || ch[0]).slice()); this.n += ch[0].length;
      if (this.n >= 4096) { this.port.postMessage([this.L, this.R]); this.L = []; this.R = []; this.n = 0; }
    }
    return true;
  }
}
registerProcessor("chloe-rec", ChloeRec);`;

// The recorder lives in its own AudioContext, because Chloe swaps its playback
// context every couple of minutes. Each playback context's master output is
// bridged in through a MediaStream (attach), so takes run across the swaps and
// the overlap of old and new context records just as it sounds.
async function startRecorder(ac) {
  const rc = new AudioContext({ sampleRate: ac.sampleRate });
  const url = URL.createObjectURL(new Blob([REC_WORKLET], { type: "application/javascript" }));
  await rc.audioWorklet.addModule(url);
  if (rc.state === "suspended") await rc.resume();
  const node = new AudioWorkletNode(rc, "chloe-rec", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit" });
  const L = [], R = [];
  node.port.onmessage = (e) => { L.push(...e.data[0]); R.push(...e.data[1]); };
  const mute = rc.createGain(); mute.gain.value = 0;   // keeps the node pulled by the graph
  node.connect(mute); mute.connect(rc.destination);
  const taps = [];
  const attach = (pac) => {
    masterOut(pac);
    const dest = pac.createMediaStreamDestination();
    pac.__masterTap.connect(dest);
    const src = rc.createMediaStreamSource(dest.stream);
    src.connect(node);
    taps.push({ pac, dest, src });
  };
  attach(ac);
  return {
    attach,
    stop() {
      taps.forEach(t => { try { t.pac.__masterTap.disconnect(t.dest); } catch {} t.src.disconnect(); });
      node.port.onmessage = null;
      rc.close();
      return encodeWav24(L, R, rc.sampleRate);
    },
  };
}

function encodeWav24(Lc, Rc, sr) {
  const frames = Lc.reduce((a, c) => a + c.length, 0);
  const data = frames * 6, buf = new ArrayBuffer(44 + data), v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + data, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 6, true); v.setUint16(32, 6, true); v.setUint16(34, 24, true);
  str(36, "data"); v.setUint32(40, data, true);
  let o = 44;
  const put = (x) => {
    const s = Math.max(-1, Math.min(1, x)), n = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
    v.setUint8(o, n & 255); v.setUint8(o + 1, (n >> 8) & 255); v.setUint8(o + 2, (n >> 16) & 255); o += 3;
  };
  for (let c = 0; c < Lc.length; c++) {
    const l = Lc[c], r = Rc[c];
    for (let i = 0; i < l.length; i++) { put(l[i]); put(r[i]); }
  }
  return new Blob([buf], { type: "audio/wav" });
}

function synthKick(ac, vol, an) {
  const osc = ac.createOscillator(), g = ac.createGain();
  const now = ac.currentTime;
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, now);
  osc.frequency.exponentialRampToValueAtTime(40, now + 0.08);
  g.gain.setValueAtTime(0.8 * vol, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
  osc.connect(g); g.connect(masterOut(ac)); if (an) g.connect(an);
  osc.start(now); osc.stop(now + 0.25);
  setTimeout(() => { try { osc.disconnect(); g.disconnect(); } catch {} }, 800);
}

function synthSnare(ac, vol, an) {
  const buf = ac.createBuffer(1, ac.sampleRate * 0.12, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource(); src.buffer = buf;
  const filt = ac.createBiquadFilter(); filt.type = "highpass"; filt.frequency.value = 1500;
  const g = ac.createGain(); const now = ac.currentTime;
  g.gain.setValueAtTime(0.35 * vol, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
  src.connect(filt); filt.connect(g); g.connect(masterOut(ac)); if (an) g.connect(an);
  src.start(now); src.stop(now + 0.12);
  setTimeout(() => { try { src.disconnect(); filt.disconnect(); g.disconnect(); } catch {} }, 700);
}

function synthHat(ac, vol, an) {
  const buf = ac.createBuffer(1, ac.sampleRate * 0.05, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource(); src.buffer = buf;
  const filt = ac.createBiquadFilter(); filt.type = "highpass"; filt.frequency.value = 8000;
  const g = ac.createGain(); const now = ac.currentTime;
  g.gain.setValueAtTime(0.12 * vol, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
  src.connect(filt); filt.connect(g); g.connect(masterOut(ac)); if (an) g.connect(an);
  src.start(now); src.stop(now + 0.05);
  setTimeout(() => { try { src.disconnect(); filt.disconnect(); g.disconnect(); } catch {} }, 600);
}

// sub = fraction of a quarter note per step; sw = swing ratio (0 = straight, 1/3 = triplet swing)
// loop entries: [kick, snare, hat]  — keyed by the same rhythm names used in ARP_RHYTHM_PATS
const BEAT_PATTERNS = {
  even:   { sub: 0.5,  sw: 0,    loop: [[1,0,1],[0,0,1],[0,1,1],[0,0,1],[1,0,1],[0,0,1],[0,1,1],[0,0,1]] },
  swing:  { sub: 0.5,  sw: 1/3,  loop: [[1,0,1],[0,0,1],[0,1,1],[0,0,1],[1,0,1],[0,0,1],[0,1,1],[0,0,1]] },
  gallop: { sub: 0.5,  sw: 0,    loop: [[1,0,1],[1,0,1],[0,1,1],[0,0,1],[1,0,1],[1,0,1],[0,1,1],[0,0,1]] },
  waltz:  { sub: 1.0,  sw: 0,    loop: [[1,0,1],[0,1,1],[0,0,1]] },
  clave:  { sub: 0.25, sw: 0,    loop: [[1,0,0],[0,0,0],[0,0,0],[1,0,0],[0,0,0],[0,0,0],[1,0,0],[0,0,0],[0,0,0],[0,0,0],[1,0,0],[0,0,0],[1,0,0],[0,0,0],[0,0,0],[0,0,0]] },
};

// Main families (no 3-semitone cluster) keep their ids; "outside" families
// (3-8 notes WITH a cluster) are appended after them as x-<pfx>-<k> so the
// main ids never shift.
function buildFamilies() {
  return [...buildFamilySet(false), ...buildFamilySet(true)];
}

function buildFamilySet(outside) {
  const seen = new Map();
  for (let p = 1; p < 4096; p += 2) {
    const n = bitCt(p);
    if (n < 3 || n > 8 || hasTriple(p) !== outside) continue;
    let canon = p;
    for (let s = 1; s < 12; s++) {
      const r = rot12(p, s);
      if ((r & 1) && r < canon) canon = r;
    }
    if (!seen.has(canon)) {
      const ms = new Set();
      for (let s = 0; s < 12; s++) {
        const r = rot12(p, s);
        if (r & 1) ms.add(r);
      }
      seen.set(canon, { n, modes: [...ms].sort((a, b) => bright(b) - bright(a)) });
    }
  }
  const pfx = { 3: "tri", 4: "tet", 5: "pen", 6: "hex", 7: "hep", 8: "oct" };
  const cnt = {};
  return [...seen.entries()]
    .sort(([a, { n: na }], [b, { n: nb }]) => na - nb || a - b)
    .map(([canon, { n, modes }]) => {
      cnt[n] = (cnt[n] || 0) + 1;
      return { id: `${outside ? "x-" : ""}${pfx[n]}-${cnt[n]}`, n, canon, modes, outside };
    });
}


/* ═══════════════════════════════════════════════════════
   INSTRUMENT SYNTHESIS ENGINE
═══════════════════════════════════════════════════════ */

// Build a synthetic reverb impulse response
function makeImpulse(ac, duration, decay) {
  const sr = ac.sampleRate, len = sr * duration;
  const buf = ac.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++)
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

// Cathedral-style impulse for the orchestra: 50 ms pre-delay, a few early
// reflections, then a tail falling 60 dB over `rt60` s that darkens as it
// decays (one-pole low-pass closing over time). Unit energy per channel, so
// the wet level is set by the gain after it.
function makeHall(ac, rt60 = 6, pre = 0.05) {
  const sr = ac.sampleRate, len = Math.floor(sr * (pre + rt60 * 1.2));
  const buf = ac.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = Math.floor(pre * sr); i < len; i++) {
      const t = i / sr - pre;
      const a = 0.1 + 0.85 * Math.min(1, t / rt60);   // damping closes over time
      lp += (1 - a) * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * 10 ** (-3 * t / rt60);
    }
    for (let k = 0; k < 6; k++) {                        // early reflections
      const i = Math.floor((pre + 0.008 + Math.random() * 0.07) * sr);
      d[i] += (Math.random() < 0.5 ? -1 : 1) * (0.6 - k * 0.08);
    }
    let e = 0; for (let i = 0; i < len; i++) e += d[i] * d[i];
    const g = 1 / Math.sqrt(e); for (let i = 0; i < len; i++) d[i] *= g;
  }
  return buf;
}

// Dissonance of a pitch set: average clash over every pair of notes
// (half step / major 7th 1, tritone 0.6, whole step / minor 7th 0.25).
// Across Chloe's families: major 0.18, Phrygian Dom. 0.24, octatonic 0.26,
// outside-scale median 0.30. Mapped 0.20 → 0 (calm) .. 0.33 → 1 (urgent).
const CLASH = { 1: 1, 11: 1, 6: 0.6, 2: 0.25, 10: 0.25 };
const tensionOf = (semis) => {
  const pcs = [...new Set(semis.map(x => ((x % 12) + 12) % 12))];
  let sum = 0, n = 0;
  for (let i = 0; i < pcs.length; i++)
    for (let j = i + 1; j < pcs.length; j++) { sum += CLASH[(pcs[j] - pcs[i] + 12) % 12] || 0; n++; }
  return n ? Math.min(1, Math.max(0, (sum / n - 0.2) / 0.13)) : 0;
};

// Breakbeat patterns for the sampled LinnDrum (LM-2) kit: 16 steps per bar,
// step → velocity. k kick, s snare, g ghost snare, h closed hat, o open hat.
const BREAKS = {
  // New wave (1980-86): kick on 1 and 3 with a push before 3, a huge gated
  // snare + clap on 2 and 4, driving 16th hats, an open hat into the bar
  newwave: { k: { 0: 118, 8: 112, 10: 78 }, s: { 4: 120, 12: 124 }, g: {},
             h: Object.fromEntries([...Array(16).keys()].map(i => [i, i % 2 ? 40 : 70])), o: { 14: 52 } },
  // Big-beat break: kick on 1 and the "and" of 3, ghosted snares between
  break: { k: { 0: 120, 10: 110 }, s: { 4: 115, 12: 118 }, g: { 7: 34, 9: 30, 15: 40 },
           h: { 0: 72, 2: 48, 4: 66, 6: 48, 8: 72, 10: 48, 12: 66 }, o: { 14: 70 } },
  // Driving: busier kick, 16th hats
  drive: { k: { 0: 120, 3: 88, 8: 115, 10: 98 }, s: { 4: 118, 12: 118 }, g: { 14: 36 },
           h: Object.fromEntries([...Array(16).keys()].map(i => [i, i % 2 ? 44 : 74])), o: {} },
  // Heavy half-time: one big snare on beat 3
  heavy: { k: { 0: 127, 6: 100, 10: 110 }, s: { 8: 127 }, g: { 13: 32 },
           h: { 0: 64, 2: 44, 4: 60, 6: 44, 8: 64, 10: 44, 12: 60, 14: 44 }, o: {} },
  // Fusion (in the spirit of the Shrapnel-era session players, Atma Anur and
  // co.): syncopated kick, ghost notes only where kick and snare aren't (one
  // limb at a time, linear), ride instead of hats, hi-hat foot on 2 and 4.
  // Played by fusionStep below: group accents, linear tom fills, cross-stick
  // when calm, a little human looseness.
  fusion: { k: { 0: 116, 6: 82, 10: 104, 13: 70 }, s: { 4: 110, 12: 114 }, g: { 2: 26, 7: 30, 9: 24, 11: 28, 15: 34 },
            r: { 0: 86, 2: 54, 4: 76, 6: 54, 8: 86, 10: 54, 12: 76, 14: 54 }, h: {}, o: {} },
};
// Downtempo and hand drums, in the spirit of '90s downtempo (Enigma, Deep
// Forest): swung 16ths, laid back, played half-time above 120 BPM. Each
// voice maps step → velocity. downtempo: kick/snare/clap groove with a big
// room snare, shaker, tambourine and congas woven through; hand: no kit,
// congas, shaker and tambourine over a low tom pulse. No crash cymbals.
const WORLD = {
  downtempo: {
    kick: { 0: 122, 7: 88, 10: 112 }, "snare-m": { 4: 116, 12: 120 }, clap: { 4: 64, 12: 70 },
    "hhclosed-short": { 0: 46, 2: 36, 4: 46, 6: 36, 8: 46, 10: 36, 12: 46, 14: 40 },
    cabasa: { 1: 26, 3: 30, 5: 26, 7: 30, 9: 26, 11: 30, 13: 26, 15: 32 },
    tambourine: { 12: 40 }, "conga-h": { 3: 52, 11: 58 }, "conga-m": { 6: 56, 14: 50 }, "conga-l": { 15: 48 },
  },
  hand: {
    "tom-ll": { 0: 92 }, "tom-l": { 10: 68 },
    "conga-ll": { 0: 78, 10: 62 }, "conga-l": { 7: 58, 15: 54 }, "conga-m": { 4: 70, 12: 74 },
    "conga-h": { 2: 52, 6: 44, 11: 60, 14: 48 },
    cabasa: { 0: 34, 1: 22, 2: 30, 3: 22, 4: 34, 5: 22, 6: 30, 7: 22, 8: 34, 9: 22, 10: 30, 11: 22, 12: 34, 13: 22, 14: 30, 15: 24 },
    tambourine: { 4: 36, 12: 40 },
  },
  // Brushes, as near as the kit gets: a soft shaker swirl rising and falling
  // through each beat for the sweep, a quiet cross-stick tap (plus a breath
  // of snare in the room) on 2 and 4, a feathered kick. For sleep.
  brushes: {
    cabasa: Object.fromEntries([...Array(16).keys()].map(i => [i, [30, 20, 25, 18][i % 4]])),
    "stick-l": { 4: 38, 12: 40 }, "snare-l": { 4: 18, 12: 20 },
    hhclosed: { 4: 20, 12: 22 }, kick: { 0: 52, 10: 38 },
  },
  // Shaman: a deep frame drum's steady pulse, the heartbeat "da-DUM" leading
  // into each bar, the iron pendants jingling softly on every stroke
  // (tambourine + shaker). Tension doubles it to 8ths, the trance speeding up.
  // Desert (daf / bendir, as under a duduk in a desert film score): a deep
  // "dum" on the one, a softer one later, crisp rim "teks", the jingles barely
  // there. Sparse, so the melody and its silences carry the music.
  desert: {
    frame: { 0: 104, 8: 70, 11: 56 }, tek: { 6: 58, 12: 66, 14: 40 },
    tambourine: { 6: 18, 12: 22 },
  },
  shaman: {
    frame: { 0: 118, 4: 88, 8: 102, 12: 88, 15: 56 }, "frame-edge": { 10: 46 },
    tambourine: { 0: 30, 4: 22, 8: 26, 12: 22 }, cabasa: { 0: 22, 4: 16, 8: 20, 12: 16 },
  },
};
const WORLD_FILL = ["conga-h", "conga-h", "conga-m", "conga-l"];   // last beat of every 4th bar

// Rainstick, synthesized (the LM-2 kit has none): pebbles falling past pins =
// thousands of tiny pings (a short sine dying in a few ms), dense at first then
// thinning out, softened by a one-pole low-pass. Three sticks: deep wood, the
// middle one, and bright glass. The fall drifts across the stereo field, as if
// the stick were tilted past you. A few takes per context so no two sound alike.
const RAIN_STICKS = {
  wood:  { f: [600, 2000],  tau: [0.004, 0.009], rate: [220, 320], lp: 2200 },
  mid:   { f: [1500, 5000], tau: [0.002, 0.006], rate: [380, 540], lp: 3500 },
  glass: { f: [2800, 7000], tau: [0.001, 0.003], rate: [420, 600], lp: 6000 },
};
function makeRainstick(ac, dur, stick = RAIN_STICKS.mid) {
  const sr = ac.sampleRate, n = Math.floor(sr * dur), buf = ac.createBuffer(2, n, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const peakRate = stick.rate[0] + Math.random() * (stick.rate[1] - stick.rate[0]);   // pings per second at the densest
  const rise = Math.min(0.18, dur * 0.08);   // a quick shake gets dense fast
  // Pan drift: a sweep of 30-80% of the field, either way, around a centre near the middle
  const mid = 0.35 + Math.random() * 0.3, sweep = (0.3 + Math.random() * 0.5) * (Math.random() < 0.5 ? -1 : 1);
  for (let t = 0; t < dur;) {
    const dens = peakRate * (1 - Math.exp(-t / rise)) * Math.exp(-t / (dur * 0.42)) + 6;
    t += -Math.log(1 - Math.random()) / dens;
    if (t >= dur) break;
    const f = stick.f[0] + Math.random() * (stick.f[1] - stick.f[0]), tau = stick.tau[0] + Math.random() * (stick.tau[1] - stick.tau[0]);
    const a = Math.pow(Math.random(), 2) * (0.5 + 0.5 * Math.exp(-t / dur));
    const pan = Math.min(1, Math.max(0, mid + sweep * (t / dur - 0.5) + (Math.random() - 0.5) * 0.35));
    const s0 = Math.floor(t * sr), len = Math.min(n - s0, Math.floor(tau * 5 * sr));
    const w = 2 * Math.PI * f / sr, d = Math.exp(-1 / (tau * sr));
    for (let k = 0, e = a; k < len; k++, e *= d) {
      const v = e * Math.sin(w * k);
      L[s0 + k] += v * (1 - pan); R[s0 + k] += v * pan;
    }
  }
  const c = Math.exp(-2 * Math.PI * stick.lp / sr);
  let peak = 0;
  for (const ch of [L, R]) {
    let y = 0;
    for (let k = 0; k < n; k++) { y = (1 - c) * ch[k] + c * y; ch[k] = y; peak = Math.max(peak, Math.abs(y)); }
  }
  const fadeN = Math.floor(Math.min(0.4, dur * 0.25) * sr);   // no click at the tail
  for (const ch of [L, R]) for (let k = 0; k < n; k++) ch[k] *= (k > n - fadeN ? (n - k) / fadeN : 1) / (peak || 1);
  return buf;
}

// Hand drums, synthesized (the LM-2's congas are gritty 12-bit samples): a skin
// ringing at its own pitch with a few inharmonic partials (each dying faster
// than the last), the pitch settling down a few percent as the head relaxes,
// and a short slap of filtered noise on the attack. Pitches and pan per drum;
// the hand pattern's toms become a low djembe-style bass tone.
const HAND_DRUMS = {
  "conga-h":  { f: 340, decay: 0.22, slap: 0.5,  pan: 0.35 },
  "conga-hh": { f: 400, decay: 0.18, slap: 0.55, pan: 0.45 },
  "conga-m":  { f: 255, decay: 0.28, slap: 0.4,  pan: 0.1 },
  "conga-l":  { f: 196, decay: 0.34, slap: 0.3,  pan: -0.2 },
  "conga-ll": { f: 150, decay: 0.4,  slap: 0.22, pan: -0.35 },
  "conga-lll":{ f: 120, decay: 0.45, slap: 0.2,  pan: -0.4 },
  "tom-l":    { f: 98,  decay: 0.42, slap: 0.12, pan: -0.15, g: 0.7 },
  "tom-ll":   { f: 72,  decay: 0.55, slap: 0.08, pan: 0, g: 0.7 },
  // Shaman's frame drum: a big, loose skin hit with a felt beater, low and long,
  // and the higher ring of a strike near the rim
  "frame":    { f: 52,  decay: 1.0,  slap: 0.1,  pan: 0, g: 1 },
  "frame-edge": { f: 140, decay: 0.35, slap: 0.35, pan: 0.2, g: 0.45 },
  // Daf / bendir "tek": a crisp strike at the rim
  "tek":      { f: 380, decay: 0.12, slap: 0.6,  pan: 0.25, g: 0.5 },
};
const HAND_MODES = [[1, 1], [1.52, 0.42], [1.98, 0.22], [2.44, 0.12], [3.02, 0.06]];   // ratio, level
function makeHandDrum(ac, d) {
  const sr = ac.sampleRate, dur = d.decay * 4, n = Math.floor(sr * dur);
  const buf = ac.createBuffer(1, n, sr), y = buf.getChannelData(0);
  const f0 = d.f * (0.985 + Math.random() * 0.03);
  HAND_MODES.forEach(([ratio, lvl], m) => {
    const a = lvl * (0.85 + Math.random() * 0.3), tau = d.decay / (1 + m * 0.9);
    let ph = Math.random() * 0.2;
    for (let k = 0; k < n; k++) {
      const t = k / sr, f = f0 * ratio * (1 + 0.05 * Math.exp(-t / 0.025));
      ph += 2 * Math.PI * f / sr;
      y[k] += a * Math.exp(-t / tau) * Math.sin(ph);
    }
  });
  // Slap: noise through a resonant band-pass ~2.2 kHz, ~6 ms
  const w = 2 * Math.PI * 2200 / sr, q = 2.5, al = Math.sin(w) / (2 * q), cw = Math.cos(w);
  const b0 = al / (1 + al), a1 = -2 * cw / (1 + al), a2 = (1 - al) / (1 + al);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let k = 0; k < Math.floor(0.04 * sr); k++) {
    const x = (Math.random() * 2 - 1) * Math.exp(-k / sr / 0.006);
    const v = b0 * x - b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = v;
    y[k] += d.slap * 4.2 * v;
  }
  for (let k = 0; k < 64; k++) y[k] *= k / 64;   // no click at the start
  let peak = 0; for (let k = 0; k < n; k++) peak = Math.max(peak, Math.abs(y[k]));
  for (let k = 0; k < n; k++) y[k] /= peak || 1;
  return buf;
}

const BEAT_FAMILY = { break: "kit", drive: "kit", heavy: "kit", downtempo: "world", hand: "world", fusion: "fusion", brushes: "brushes", shaman: "shaman", newwave: "neon", desert: "desert" };

// Linear fills for fusion: one drum per 16th. Short = the last beat of every
// 4th bar; long = the last two beats of every 8th, phrased in 3s across the beat.
const FUSION_FILLS = {
  short: [["snare-h", "tom-h", "tom-m", "kick"], ["tom-hh", "tom-h", "kick", "tom-l"], ["snare-m", "kick", "tom-m", "tom-ll"], ["snare-h", "snare-m", "tom-l", "kick"]],
  long: [["snare-h", "tom-hh", "kick", "tom-h", "tom-m", "kick", "tom-l", "tom-ll"],
         ["tom-hh", "snare-h", "kick", "tom-h", "snare-m", "kick", "tom-m", "kick"],
         ["snare-h", "tom-h", "tom-m", "kick", "tom-l", "tom-ll", "kick", "kick"]],
};

// Tunings, as ratios above the scale root for each semitone. Equal = 2^(n/12).
// just: 5-limit (Zarlino's pure 5/4 thirds). pyth: Pythagorean, built only from
// stacked 3/2 fifths, so 5ths are pure but 3rds come out sharp (81/64).
const TUNINGS = {
  just: [1, 16/15, 9/8, 6/5, 5/4, 4/3, 45/32, 3/2, 8/5, 5/3, 9/5, 15/8],
  pyth: [1, 256/243, 9/8, 32/27, 81/64, 4/3, 729/512, 3/2, 128/81, 27/16, 16/9, 243/128],
};
const tunedRatio = (semi, tuning) => {
  const r = TUNINGS[tuning];
  if (!r) return 2 ** (semi / 12);
  const pc = ((semi % 12) + 12) % 12;
  return 2 ** ((semi - pc) / 12) * r[pc];
};

// Per-sound gain so every instrument/wave plays at about the same loudness
// (measured K-weighted, eighth-note runs C3-C5, levelled to -28 LUFS).
const SOUND_GAIN = { piano: 0.55, guitar: 5.37, xylo: 3.05, space: 0.8, lute: 1.88, fiddle: 0.78, dx7: 0.52, duduk: 0.36, sine: 1.4, triangle: 1.72, square: 1.14, sawtooth: 1.93 };

// Steppe strings slide into a note from the one before (within a 4th, not
// across a rest, not between the notes of one chord)
let lastString = { freq: 0, t: -9 };
const slideFrom = (ac, freq, chance) => {
  const now = ac.currentTime, p = lastString;
  const near = p.freq && now - p.t > 0.03 && now - p.t < 0.8 && Math.abs(12 * Math.log2(freq / p.freq)) <= 5 && Math.abs(12 * Math.log2(freq / p.freq)) > 0.5;
  if (now - p.t > 0.03) lastString = { freq, t: now };
  return near && Math.random() < chance ? p.freq : 0;
};

// Plucked lute (tovshuur / dombra, the oud family): a Karplus-Strong gut
// string, fractional delay so it stays in tune up high, plucked a sixth of the
// way along (the comb on the pick noise), dying faster on high notes, through
// a wooden body (low resonances, rolled-off top). Two takes per pitch.
const luteCache = new Map();
function luteBuffer(ac, freq) {
  const key = ac.sampleRate + ":" + freq.toFixed(1);
  const takes = luteCache.get(key) || [];
  if (takes.length >= 2) return takes[Math.floor(Math.random() * 2)];
  const sr = ac.sampleRate, T60 = Math.max(0.6, Math.min(2.6, 2.6 * Math.pow(110 / freq, 0.5)));
  const n = Math.floor(sr * Math.min(3, T60 + 0.2)), buf = ac.createBuffer(1, n, sr), y = buf.getChannelData(0);
  const P = sr / freq - 0.5, g = Math.exp(Math.log(0.001) / (freq * T60));
  const N = Math.max(2, Math.round(P)), pick = Math.max(1, Math.round(N / 6));
  const exc = new Float32Array(N + pick);
  let lp = 0;
  for (let i = 0; i < N; i++) { lp += 0.5 * ((Math.random() * 2 - 1) - lp); exc[i] = lp; }
  const at = (k) => { if (k < 0) return 0; const i = Math.floor(k), f = k - i; return y[i] * (1 - f) + (y[i + 1] ?? 0) * f; };
  for (let i = 0; i < n; i++) {
    const e = i < N ? exc[i] - (i >= pick ? exc[i - pick] : 0) : 0;
    y[i] = e + g * 0.5 * (at(i - P) + at(i - P - 1));
  }
  let peak = 0; for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(y[i]));
  for (let i = 0; i < n; i++) y[i] /= peak || 1;
  const fadeN = Math.floor(0.05 * sr);
  for (let i = n - fadeN; i < n; i++) y[i] *= (n - i) / fadeN;
  takes.push(buf); luteCache.set(key, takes);
  if (luteCache.size > 400) luteCache.delete(luteCache.keys().next().value);
  return buf;
}

function synthNote(ac, freq, vel, instrument, timbre, beatDur, reverbSend, delaySend, analyserSend, out) {
  vel *= SOUND_GAIN[instrument || timbre] ?? 1;
  // reverbSend / delaySend / analyserSend: AudioNode or null
  const dest = out || masterOut(ac);
  const nodes = []; // track all created nodes for post-note cleanup
  const mkG = () => { const n = ac.createGain(); nodes.push(n); return n; };
  const mkO = (type) => { const n = ac.createOscillator(); n.type = type; nodes.push(n); return n; };
  const mkF = (type, freq) => { const n = ac.createBiquadFilter(); n.type = type; n.frequency.value = freq; nodes.push(n); return n; };
  const mkB = () => { const n = ac.createBufferSource(); nodes.push(n); return n; };
  const connectOut = (node) => {
    node.connect(dest);
    if (reverbSend) node.connect(reverbSend);
    if (delaySend) node.connect(delaySend);
    if (analyserSend) node.connect(analyserSend);
  };
  const cleanup = (dur) => setTimeout(() => nodes.forEach(n => { try { n.disconnect(); } catch {} }), (dur + 0.5) * 1000);
  const now = ac.currentTime;

  if (instrument === "piano") {
    const g = mkG();
    const f = mkF("lowpass", 4000);
    [0, 4, -4].forEach(detune => {
      const o = mkO("triangle");
      o.frequency.value = freq; o.detune.value = detune;
      o.connect(g);
    });
    [2, 3].forEach((mult, i) => {
      const o = mkO("sine"); o.frequency.value = freq * mult;
      const og = mkG(); og.gain.value = [0.12, 0.04][i];
      o.connect(og); og.connect(g);
    });
    const dur = Math.min(beatDur * 1.6, 3.2);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vel * 0.7, now + 0.006);
    g.gain.setTargetAtTime(vel * 0.22, now + 0.018, 0.07);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    g.connect(f); connectOut(f);
    nodes.filter(n => n instanceof OscillatorNode).forEach(o => { o.start(now); o.stop(now + dur); });
    cleanup(dur);
    return { start: now, stop: now + dur };
  }

  if (instrument === "guitar") {
    const g = mkG();
    const filt = mkF("bandpass", freq); filt.Q.value = 18;
    const buf = ac.createBuffer(1, ac.sampleRate * 0.04, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src2 = mkB(); src2.buffer = buf;
    src2.connect(filt); filt.connect(g);
    const o = mkO("triangle"); o.frequency.value = freq;
    const og = mkG(); og.gain.value = 0.3;
    o.connect(og); og.connect(g);
    const dur = Math.min(beatDur * 1.2, 2.2);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vel * 0.9, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    connectOut(g);
    src2.start(now); src2.stop(now + 0.05);
    o.start(now); o.stop(now + dur);
    cleanup(dur);
    return { start: now, stop: now + dur };
  }

  if (instrument === "duduk") {
    // The duduk sings: most notes scoop up into pitch from below, some flick
    // down from the note above (a grace), legato ones slide from the last note;
    // a soft breathy attack, long notes swell, vibrato blooms late and slow
    const dur = Math.max(0.35, Math.min(beatDur * 1.7, 4));
    const o = mkO("sine"); o.setPeriodicWave(dudukWave(ac));
    const from = slideFrom(ac, freq, 0.4), r = Math.random();
    if (from) { o.frequency.setValueAtTime(from, now); o.frequency.exponentialRampToValueAtTime(freq, now + 0.1 + Math.random() * 0.08); }
    else if (r < 0.2 && dur > 0.5) { o.frequency.setValueAtTime(freq * 2 ** (2 / 12), now); o.frequency.setValueAtTime(freq * 2 ** (2 / 12), now + 0.05); o.frequency.exponentialRampToValueAtTime(freq, now + 0.09); }
    else if (r < 0.85) { o.frequency.setValueAtTime(freq * 2 ** (-(60 + Math.random() * 70) / 1200), now); o.frequency.exponentialRampToValueAtTime(freq, now + 0.12 + Math.random() * 0.1); }
    else o.frequency.value = freq;
    const vib = mkO("sine"), vibG = mkG(); vib.frequency.value = 4.6 + Math.random() * 0.6;
    vibG.gain.setValueAtTime(0, now); vibG.gain.setValueAtTime(0, now + Math.min(0.3, dur * 0.4));
    vibG.gain.linearRampToValueAtTime(12 + Math.random() * 8, now + Math.min(0.9, dur * 0.8));
    vib.connect(vibG); vibG.connect(o.detune);
    const src = mkG(); src.gain.value = 1; o.connect(src);
    const nb = mkB(); const nbuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.6), ac.sampleRate);
    const nd = nbuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    nb.buffer = nbuf; nb.loop = true;
    const nf = mkF("bandpass", 1500); nf.Q.value = 0.8;
    const ng = mkG(); ng.gain.setValueAtTime(0.09, now); ng.gain.setTargetAtTime(0.03, now + 0.05, 0.1);   // breathier at the start
    nb.connect(nf); nf.connect(ng); ng.connect(src);
    const body = dudukBody(ac, src, mkF);
    const g = mkG(), atk = Math.min(0.09, dur * 0.25), rel = Math.min(0.28, dur * 0.35);
    g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(vel * 0.7, now + atk);
    g.gain.linearRampToValueAtTime(vel * (dur > 1 ? 1 : 0.8), now + Math.max(atk + 0.01, dur * 0.6));   // long notes swell
    g.gain.setValueAtTime(vel * (dur > 1 ? 1 : 0.8), now + dur - rel);
    g.gain.linearRampToValueAtTime(0, now + dur);
    body.connect(g); connectOut(g);
    for (const x of [o, vib, nb]) { x.start(now); x.stop(now + dur + 0.02); }
    cleanup(dur);
    return { start: now, stop: now + dur };
  }

  if (instrument === "dx7") {
    // DX7 electric piano: a 1:1 FM pair whose brightness (index) falls after
    // the strike, a second carrier a few cents up for the chorus, and the
    // "tine": a 14:1 pair that only clicks for the first few ms
    const dur = Math.min(Math.max(beatDur * 2.4, 0.6), 3.5), g = mkG();
    const pair = (ratio, idx0, idx1, tau, cents, lvl) => {
      const c = mkO("sine"), m = mkO("sine"), mg = mkG(), cg = mkG();
      c.frequency.value = freq; c.detune.value = cents; m.frequency.value = freq * ratio;
      mg.gain.setValueAtTime(idx0 * freq, now); mg.gain.setTargetAtTime(idx1 * freq, now + 0.002, tau);
      m.connect(mg); mg.connect(c.frequency); cg.gain.value = lvl; c.connect(cg); cg.connect(g);
      for (const o of [c, m]) { o.start(now); o.stop(now + dur + 0.02); }
    };
    pair(1, 2.4, 0.35, 0.25, 0, 0.55);
    pair(1, 2, 0.3, 0.3, 7, 0.35);
    pair(14, 1.6, 0, 0.012, 0, 0.18);
    g.gain.setValueAtTime(0, now); g.gain.linearRampToValueAtTime(vel * 0.8, now + 0.003);
    g.gain.setTargetAtTime(vel * 0.35, now + 0.01, 0.35);
    g.gain.setValueAtTime(vel * 0.35 * Math.exp(-(dur - 0.09) / 0.35) + 0.0001, now + dur - 0.08);
    g.gain.linearRampToValueAtTime(0, now + dur);
    connectOut(g);
    cleanup(dur);
    return { start: now, stop: now + dur };
  }

  if (instrument === "lute") {
    const src = mkB(); src.buffer = luteBuffer(ac, freq);
    // A slide (or hammer-on) from the last note: the string starts at the old pitch
    const from = slideFrom(ac, freq, 0.3);
    if (from) { src.playbackRate.setValueAtTime(from / freq, now); src.playbackRate.exponentialRampToValueAtTime(1, now + 0.05 + Math.random() * 0.05); }
    const b1 = mkF("peaking", 210); b1.Q.value = 1.4; b1.gain.value = 7;     // the wooden body
    const b2 = mkF("peaking", 520); b2.Q.value = 2; b2.gain.value = 4;
    const top = mkF("highshelf", 2800); top.gain.value = -8;
    const g = mkG();
    const dur = Math.min(Math.max(beatDur * 2.2, 0.5), src.buffer.duration);
    g.gain.setValueAtTime(vel * 0.9, now);
    g.gain.setValueAtTime(vel * 0.9, now + dur - 0.08);
    g.gain.linearRampToValueAtTime(0, now + dur);
    src.connect(b1); b1.connect(b2); b2.connect(top); top.connect(g); connectOut(g);
    src.start(now); src.stop(now + dur + 0.02);
    cleanup(dur);
    return { start: now, stop: now + dur };
  }

  if (instrument === "fiddle") {
    // Morin khuur, the horsehead fiddle: a bowed string (a saw, softened) with
    // the bow swelling in, horsehair grit (noise around 2.5 kHz following the
    // bow), vibrato that blooms after the attack, a slide in from the last note,
    // through a hollow, nasal body
    const dur = Math.max(0.28, Math.min(beatDur * 1.5, 3.5));
    const atk = Math.min(0.14, dur * 0.3), rel = Math.min(0.25, dur * 0.35);
    const o1 = mkO("sawtooth"), o2 = mkO("sawtooth");
    o1.frequency.value = freq; o2.frequency.value = freq; o2.detune.value = 7;
    const from = slideFrom(ac, freq, 0.55);
    if (from) for (const o of [o1, o2]) { o.frequency.setValueAtTime(from, now); o.frequency.exponentialRampToValueAtTime(freq, now + 0.07 + Math.random() * 0.06); }
    const vib = mkO("sine"); vib.frequency.value = 5 + Math.random() * 0.6;
    const vibG = mkG(); vibG.gain.setValueAtTime(0, now); vibG.gain.linearRampToValueAtTime(16, now + Math.min(0.5, dur * 0.6));
    vib.connect(vibG); vibG.connect(o1.detune); vibG.connect(o2.detune);
    const mixG = mkG(); mixG.gain.value = 0.5; o1.connect(mixG); o2.connect(mixG);
    const nb = mkB(); const nbuf = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.5), ac.sampleRate);
    const nd = nbuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    nb.buffer = nbuf; nb.loop = true;
    const nf = mkF("bandpass", 2500); nf.Q.value = 1.2;
    const ng = mkG(); ng.gain.value = 0.05; nb.connect(nf); nf.connect(ng); ng.connect(mixG);
    const lp = mkF("lowpass", 3200), f1 = mkF("peaking", 330), f2 = mkF("peaking", 1250), dip = mkF("peaking", 700);
    f1.Q.value = 2; f1.gain.value = 6; f2.Q.value = 2.5; f2.gain.value = 5; dip.Q.value = 1.5; dip.gain.value = -5;
    const g = mkG();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vel * 0.85, now + atk);
    g.gain.setTargetAtTime(vel * 0.7, now + atk, dur * 0.4);           // the bow eases off a little
    g.gain.setValueAtTime(vel * 0.7, now + dur - rel);
    g.gain.linearRampToValueAtTime(0, now + dur);
    mixG.connect(f1); f1.connect(dip); dip.connect(f2); f2.connect(lp); lp.connect(g); connectOut(g);
    for (const o of [o1, o2, vib]) { o.start(now); o.stop(now + dur + 0.02); }
    nb.start(now); nb.stop(now + dur + 0.02);
    cleanup(dur);
    return { start: now, stop: now + dur };
  }

  if (instrument === "xylo") {
    const g = mkG();
    const f = mkF("highpass", 800);
    [1, 2.756, 5.404].forEach((ratio, i) => {
      const o = mkO("sine"); o.frequency.value = freq * ratio;
      const og = mkG(); og.gain.value = [0.7, 0.25, 0.08][i];
      o.connect(og); og.connect(g);
      o.start(now); o.stop(now + 0.9);
    });
    const dur = 0.55;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vel, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    g.connect(f); connectOut(f);
    cleanup(dur);
    return { start: now, stop: now + dur };
  }

  if (instrument === "space") {
    const g = mkG();
    const f = mkF("lowpass", 1600);
    const lfo = mkO("sine"); lfo.frequency.value = 0.4;
    const lfoG = mkG(); lfoG.gain.value = 4;
    lfo.connect(lfoG);
    [-8, -3, 3, 8].forEach(d => {
      const o = mkO("sine"); o.frequency.value = freq; o.detune.value = d;
      lfoG.connect(o.frequency);
      const og = mkG(); og.gain.value = 0.28;
      o.connect(og); og.connect(g);
      o.start(now); o.stop(now + 4.0);
    });
    lfo.start(now); lfo.stop(now + 4.0);
    const dur = Math.min(beatDur * 2.5, 4.0);
    const atk = Math.min(beatDur * 0.6, 0.5);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vel * 1.1, now + atk);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    g.connect(f); connectOut(f);
    cleanup(dur);
    return { start: now, stop: now + dur };
  }

  // Fallback: raw oscillator (original timbre mode)
  const o = mkO(timbre); o.frequency.value = freq;
  const g = mkG();
  const f = mkF("lowpass", 2400);
  const dur = beatDur * 0.82;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(vel, now + 0.012);
  g.gain.exponentialRampToValueAtTime(0.001, now + dur);
  o.connect(g); g.connect(f); connectOut(f);
  o.start(now); o.stop(now + dur);
  cleanup(dur);
  return { start: now, stop: now + dur };
}

/* ═══════════════════════════════════════════════════════
   SCALE WHEEL COMPONENT
═══════════════════════════════════════════════════════ */

function ScaleWheel({ active, rootOffset, playing, size = 180, K }) {
  const cx = size / 2, cy = size / 2, R = size * 0.4, rDot = size * 0.067;
  const notes = CHROMATIC.map((_, i) => (i + rootOffset) % 12);

  // points for each of the 12 positions (clockwise from top)
  const pt = (i) => {
    const a = (i / 12) * 2 * Math.PI - Math.PI / 2;
    return [cx + R * Math.cos(a), cy + R * Math.sin(a)];
  };

  // polygon of active notes
  const activeIdxs = [];
  for (let i = 0; i < 12; i++) if (active.has(i)) activeIdxs.push(i);
  const poly = activeIdxs.map(i => pt(i).join(",")).join(" ");

  return (
    <svg width={size} height={size} style={{ display: "block", margin: "0 auto", transition: "width .1s, height .1s" }}>
      {/* outer ring */}
      <circle cx={cx} cy={cy} r={R + rDot + 4} fill="none" stroke={K.whBr} strokeWidth="1" />
      <circle cx={cx} cy={cy} r={R - rDot - 4} fill="none" stroke={K.whBr} strokeWidth="1" />

      {/* polygon */}
      {poly && (
        <polygon points={poly}
          fill={K.a + "18"} stroke={K.a} strokeWidth="1.5"
          strokeLinejoin="round" />
      )}

      {/* dots + labels */}
      {Array.from({ length: 12 }, (_, i) => {
        const chromI = notes[i]; // which chromatic note lands at position i
        const isActive = active.has(i);
        const isPlaying = playing === i;
        const [x, y] = pt(i);
        const label = CHROMATIC[(rootOffset + i) % 12];
        return (
          <g key={i}>
            <circle cx={x} cy={y} r={rDot - 1}
              fill={isPlaying ? K.a : isActive ? K.a + "30" : K.wh}
              stroke={isActive ? K.a : K.whBr}
              strokeWidth={isActive ? 1.5 : 1}
            />
            <text x={x} y={y + 0.5} textAnchor="middle" dominantBaseline="middle"
              fontSize={Math.max(6, Math.round(rDot * 0.62))}
              fontFamily="'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', monospace"
              fontWeight={isActive ? 600 : 400}
              fill={isPlaying ? "#000" : isActive ? K.a : K.whTxt}>
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════
   PIANO COMPONENT
═══════════════════════════════════════════════════════ */

const WHITE_KEYS = [0, 2, 4, 5, 7, 9, 11];
const BLACK_KEYS = [{ s: 1, x: 0.67 }, { s: 3, x: 1.67 }, { s: 6, x: 3.67 }, { s: 8, x: 4.67 }, { s: 10, x: 5.67 }];

function Piano({ active, playing, K }) {
  return (
    <div style={{ position: "relative", height: 72, width: "100%", userSelect: "none" }}>
      {WHITE_KEYS.map((s, i) => {
        const on = active.has(s), pl = playing === s;
        return (
          <div key={s} style={{
            position: "absolute", left: `${(i / 7) * 100}%`,
            width: `calc(${100 / 7}% - 2px)`, height: "100%",
            background: pl ? K.a : on ? K.a + "8c" : K.keyW,
            border: `1px solid ${on || pl ? K.a + "b3" : K.keyWBr}`,
            borderRadius: "0 0 5px 5px",
            boxShadow: pl ? `0 0 14px ${K.a}60` : on ? `0 0 5px ${K.a}47` : "none",
            transition: "background .08s, box-shadow .08s",
          }} />
        );
      })}
      {BLACK_KEYS.map(({ s, x }) => {
        const on = active.has(s), pl = playing === s;
        return (
          <div key={s} style={{
            position: "absolute", left: `calc(${(x / 7) * 100}% - 1px)`,
            width: `${(0.6 / 7) * 100}%`, height: "62%",
            background: pl ? K.a : on ? K.a + "88" : K.keyB,
            borderRadius: "0 0 4px 4px", zIndex: 2,
            boxShadow: pl ? `0 0 10px ${K.a}50` : on ? `0 0 4px ${K.a}59` : "none",
            transition: "background .08s",
          }} />
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   CONSTANTS & THEME
═══════════════════════════════════════════════════════ */

const ROOTS = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const OFFS  = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const TIMBRES = ["sine", "triangle", "square", "sawtooth"];
const INSTRUMENTS = ["piano", "guitar", "xylo", "space", "lute", "fiddle", "dx7", "duduk"];
// Steppe: with the throat-singing or jaw-harp drone, or the shaman beat, the
// lead becomes Mongolian strings: the horsehead fiddle at slow tempos (90 BPM
// and under), the plucked lute at faster ones (100 and up; between, it keeps
// whichever it had). The chosen instrument comes back when the steppe sounds go.
const isSteppe = st => st.beatStyle === "shaman" || (st.beatStyle !== "newwave" && st.droneOn && (st.droneWave === "throat" || st.droneWave === "jawharp"));
// Neon (new wave): the new wave beat or the Juno pad makes the lead a DX7
// electric piano and lifts the scale picks toward bright major colours
const isNeon = st => st.beatStyle === "newwave" || (st.beatStyle !== "shaman" && st.droneOn && st.droneWave === "juno");
// Desert: the desert beat or the dam drone makes the lead a duduk singing
// phrases with silence between them, leans the scales Middle Eastern (Hijaz and
// friends), slows the tempo and opens a long reverb
const isDesert = st => st.beatStyle === "desert" || (st.beatStyle !== "shaman" && st.beatStyle !== "newwave" && st.droneOn && st.droneWave === "dam");
// Hijaz (Phrygian dominant), Hijaz Kar (double harmonic), harmonic minor,
// Nikriz (Ukrainian Dorian), Kurd (Phrygian), Neapolitan minor, Nahawand
// (Aeolian), Bayati without its quarter tone (Dorian), with weights
const DESERT_SCALES = [[1459, 3], [2483, 3], [2477, 2], [1741, 2], [1451, 2], [2475, 1], [1453, 1], [1709, 1]];
const GRP_NAME = { 3: "Tritonic", 4: "Tetratonic", 5: "Pentatonic", 6: "Hexatonic", 7: "Heptatonic", 8: "Octatonic" };
const GRP_PFX  = { 3: "tri", 4: "tet", 5: "pen", 6: "hex", 7: "hep", 8: "oct" };
// Sidebar group key — outside families get their own groups below the main ones
const grpKey = (fam) => (fam.outside ? "x-" : "") + GRP_PFX[fam.n];
// Outside scales are passing colour, not a brightness position: brightness/EEG
// picks never choose them, and auto mode drops one in on this share of picks.
const OUTSIDE_CHANCE = 0.33;
// GROUPS "mix": group sizes (in 8th notes) that add up to whole 4/4 bars
// (16 = 2 bars, 32 = 4), so the line crosses the beat then lands back on a
// downbeat at the end of each pattern, Eric Johnson style.
const MIX_PATTERNS = [
  [5, 5, 6], [6, 5, 5], [5, 6, 5],
  [3, 3, 5, 5], [5, 5, 3, 3], [3, 5, 3, 5],
  [7, 4, 5], [4, 5, 7],
  [5, 4, 5, 5, 4, 5, 4], [5, 4, 5, 5, 4, 4, 5],
];
// Settings Auto may change; unticked ones in the ⚙ panel are left alone
const AUTO_LOCKS_DEFAULT = { sound:true, rootNote:true, rhythm:true, arpDir:true, chordVoice:true, melMode:true, grouping:true, bpm:true, reverb:true, delay:true, delayTime:true, sustain:true, droneOn:true, droneVol:true, droneOct:true, droneWave:true, tuning:false, beat:true };
const isOutsideId = (id) => !!id && id.startsWith("x-");

// Longest run of consecutive semitones (circular) — 3..8 for outside scales
const maxRun = (p) => {
  let best = 0;
  for (let i = 0; i < 12; i++) {
    let k = 0;
    while (k < 12 && ((p >> ((i + k) % 12)) & 1)) k++;
    if (k > best) best = k;
  }
  return best;
};

// Pick an outside scale: first a run length (each extra semitone halves the
// chance, so 3-runs ~50% … 8-runs ~1.5%), then a random scale with that run.
const pickOutside = (opts) => {
  const byRun = {};
  for (const e of opts) (byRun[maxRun(e.pat)] ??= []).push(e);
  const runs = Object.keys(byRun).map(Number);
  const total = runs.reduce((a, r) => a + 2 ** -r, 0);
  let x = Math.random() * total;
  for (const r of runs) {
    x -= 2 ** -r;
    if (x <= 0) return byRun[r][Math.floor(Math.random() * byRun[r].length)];
  }
  const last = byRun[runs[runs.length - 1]];
  return last[Math.floor(Math.random() * last.length)];
};

// Brain-derived brightness target (0–1) from one /eeg snapshot; null when not streaming
function eegBrainTarget(eeg, config) {
  if (!eeg || !eeg.connected || !eeg.bands || !eeg.derived) return null;
  const b = eeg.bands;
  const avg = k => ((b[k]?.left_pct || 0) + (b[k]?.right_pct || 0)) / 2;
  const bal = ['gamma', 'beta', 'alpha', 'theta'].map(k => {
    const l = b[k]?.left_pct || 0, r = b[k]?.right_pct || 0;
    return (l + r) > 0.5 ? 0.5 + 0.5 * (r - l) / (l + r) : null;
  }).filter(v => v !== null);
  return targetBrightness(
    { derived:             { dominant_active_band: eeg.derived.dominant_active_band },
      bands:               { alpha_pct: avg('alpha'), theta_pct: avg('theta'), beta_pct: avg('beta') },
      hemispheric_balance: bal.length ? bal.reduce((a, v) => a + v, 0) / bal.length : 0.5 },
    config
  );
}

/* ── Session arc ──
   Lead: 1 min baseline (no steering), then the brightness target glides from
   the baseline brain average to baseline ± amount over the chosen minutes,
   then holds until stopped. Mirror: no steering, logging only (a baseline to
   compare leads against). Every session logs a row every 5 s. */
const ARC_BASELINE_MS = 60000;
const ARC_LOG_MS      = 5000;
const ARC_COLOR       = "#5fd08a";
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000)), p = n => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
};
const ARC_CSV_COLS = ["t_s", "phase", "lead_target", "brain_target", "scale_id", "scale_name", "scale_brightness",
                      "dominant", "alpha_pct", "theta_pct", "beta_pct", "gamma_pct", "relaxation_index", "hemi_balance"];
const sessionCSV = (sess) => [
  `# Chloe session ${sess.startedAt} · ${sess.mode}${sess.mode === "lead" ? ` ${sess.from?.toFixed(2)} -> ${sess.to?.toFixed(2)} over ${sess.mins} min` : ` ${sess.mins} min`}`,
  ARC_CSV_COLS.join(","),
  ...sess.rows.map(r => ARC_CSV_COLS.map(c => {
    const v = r[c];
    if (v === null || v === undefined) return "";
    return typeof v === "string" && /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(",")),
].join("\n");
// Mean brain target over the first / last 2 minutes — the at-a-glance result
const sessionSummary = (sess) => {
  const pts = sess.rows.filter(r => r.brain_target !== null);
  if (pts.length < 4) return null;
  const mean = a => a.reduce((x, r) => x + r.brain_target, 0) / a.length;
  const end = pts[pts.length - 1].t_s;
  const first = pts.filter(r => r.t_s <= pts[0].t_s + 120), last = pts.filter(r => r.t_s >= end - 120);
  return { start: mean(first), end: mean(last), mins: end / 60 };
};

/* ── Journeys ──
   A shape over a chosen length that steers Auto: brightness target (b),
   tempo as a multiple of the BPM it started at (t), reverb (rv), sustain (su),
   orchestra energy added on top of tension (e) and, for Storm, a tension
   target for scale picks (tn). Waypoints at fraction `at`, eased between.
   On arrival: while recording, land on `home`, fade out and save the WAV;
   otherwise hold the last waypoint and keep playing. */
const JOURNEYS = {
  dawn: { label: "dawn", home: 2773, tip: "Dark to bright: Locrian-dark scales open up to Lydian-bright, the tempo lifts a little, the reverb dries out.",
    pts: [{ at: 0, b: 0.30, t: 0.8, rv: 0.85, su: 1.4 }, { at: 1, b: 0.70, t: 1.1, rv: 0.45, su: 0.9 }] },
  dusk: { label: "dusk", home: 1453, tip: "Bright to dark: from open, bright scales down into dark ones, slowing, longer notes, deeper reverb. Good for winding down.",
    pts: [{ at: 0, b: 0.70, t: 1.1, rv: 0.45, su: 0.9 }, { at: 1, b: 0.30, t: 0.65, rv: 0.9, su: 1.6 }] },
  descent: { label: "descent", home: 2741, tip: "Descent & return: bright down into the dark, slowest at the halfway point, then back up into the light.",
    pts: [{ at: 0, b: 0.65, t: 1, rv: 0.55, su: 1 }, { at: 0.5, b: 0.30, t: 0.75, rv: 0.9, su: 1.5 }, { at: 1, b: 0.70, t: 1.1, rv: 0.5, su: 0.9 }] },
  storm: { label: "storm", home: 2741, tip: "Calm, storm, calm: tension and tempo build to a peak about 60% of the way in (clashing scales, faster, the orchestra at full energy if it's on), then it clears.",
    pts: [{ at: 0, b: 0.55, t: 0.85, rv: 0.8, su: 1.3, e: 0, tn: 0 }, { at: 0.6, b: 0.45, t: 1.35, rv: 0.5, su: 0.7, e: 0.8, tn: 1 },
          { at: 0.8, b: 0.5, t: 1, rv: 0.7, su: 1, e: 0.3, tn: 0.4 }, { at: 1, b: 0.6, t: 0.8, rv: 0.85, su: 1.3, e: 0, tn: 0 }] },
  // Rise: epic and energizing. Starts from its own driving tempo (not whatever
  // the last one was), climbs brighter, faster and drier with the orchestra
  // pushing, takes one breath at ~60%, then a second, bigger climb it holds to the
  // end. Bold sounds, organ/strings drone, only forward tempo pushes, more marches.
  rise: { label: "rise", home: 2741, epic: true, bpm: 116,
    tip: "Epic and energizing: a steady build to a big, bright peak. Faster, drier and louder, the orchestra driving and marching, one breath at about 60%, then a second climb that holds to the end.",
    pts: [{ at: 0, b: 0.55, t: 1, rv: 0.5, su: 0.9, e: 0.35, tn: 0.1 }, { at: 0.45, b: 0.67, t: 1.2, rv: 0.42, su: 0.8, e: 0.75, tn: 0.2 },
          { at: 0.6, b: 0.62, t: 1.1, rv: 0.55, su: 1, e: 0.45, tn: 0.1 }, { at: 0.88, b: 0.74, t: 1.35, rv: 0.38, su: 0.7, e: 1, tn: 0.25 },
          { at: 1, b: 0.74, t: 1.35, rv: 0.4, su: 0.75, e: 1, tn: 0.2 }] },
};
// Endless: no destination. Overlapping slow waves (17, 6.3 and 11 minutes, so
// the pattern never lines up the same way twice) keep it wandering, dark-leaning,
// slow and consonant; built for sleep. Never arrives, so never ends or fades.
JOURNEYS.endless = { label: "endless", home: 1453, endless: true,
  tip: "Never-ending: a slow, calm wander with no destination, leaning dark, slow and consonant, deep reverb and long notes. No tempo surprises and no march. Built for sleep or long listening.",
  at: (ms) => {
    const m = ms / 60000, w = (p, ph = 0) => Math.sin(2 * Math.PI * m / p + ph);
    return { b: 0.40 + 0.08 * w(17) + 0.04 * w(6.3, 1.3), t: 0.62 + 0.06 * w(11, 0.7), rv: 0.88 + 0.06 * w(13, 2.1),
             su: 1.6 + 0.3 * w(9, 0.4), e: 0, tn: 0,
             // Lots of slow delay: wet ~50%, long echoes trailing out (feedback 0.55)
             dl: 0.5 + 0.1 * w(7.7, 0.3), fb: 0.55,
             // Percussion comes in now and then: on for a few minutes about a third of the time
             perc: w(23, 0.9) + 0.5 * w(8.7, 2.0) > 0.45 };
  } };
const ENDLESS_WINDOW = 40 * 60000;   // how much of Endless a card or the stage draws
const JOURNEY_MINS  = [5, 15, 30, 60];
// Sleep timer: stop after this many minutes, fading out over the last SLEEP_FADE seconds
const SLEEP_MINS = [15, 30, 60, 90], SLEEP_FADE = 90;
const JOURNEY_COLOR = "#e8b04a";
// Rise: Ronnie's own riffs (recorded 2026-10-18 over a 116 BPM gallop beat;
// tools/riffrec). Each is 2 bars with E as its root, plus a 250 ms tail, and
// starts 4 ms before its downbeat. bpm = the tempo he actually played it at
// (the beat was 116); playback rate corrects for it.
const RISE_RIFFS = [{ f: "rise_riff_1.wav", bpm: 114.8 }, { f: "rise_riff_2.wav", bpm: 116.6 }];
const RIFF_BPM = 116, RIFF_ROOT = 4, RIFF_BARS = 2, RIFF_GAIN = 0.6, RIFF_PRE = 0.004;
const journeyAt = (j, f) => {
  if (j.endless) return j.at(f * ENDLESS_WINDOW);
  const p = j.pts;
  let i = 0;
  while (i < p.length - 2 && f > p[i + 1].at) i++;
  const a = p[i], b = p[i + 1];
  const x = Math.min(1, Math.max(0, (f - a.at) / (b.at - a.at)));
  const s = (1 - Math.cos(Math.PI * x)) / 2;   // ease in and out of each waypoint
  const out = {};
  for (const k of ["b", "t", "rv", "su", "e", "tn"]) if (a[k] !== undefined) out[k] = a[k] + (b[k] - a[k]) * s;
  return out;
};
const patSemis = (p) => [...Array(12).keys()].filter(i => (p >> i) & 1);
const popcount = (x) => { let n = 0; while (x) { n += x & 1; x >>= 1; } return n; };

// Arpeggio rhythm patterns: arrays of step durations in eighth-note units.
// Single notes use each value directly; chords use value × 2.
const ARP_RHYTHM_PATS = {
  even:   [2],           // straight quarters
  swing:  [3, 1],        // dotted-eighth + sixteenth (3:1 swing)
  gallop: [1, 1, 2],     // 16th-16th-8th forward gallop
  waltz:  [4, 2, 2],     // half + quarter + quarter (3/4 feel)
  clave:  [3, 3, 4, 2, 4], // son clave
};

const DARK_K = {
  bg:  "#060a0e", bg2: "#0a1219", bg3: "#0e1822",
  br:  "#35485b", t1:  "#aec1cb", t2:  "#95b1c3",
  a:   "#e8922a", ag:  "rgba(232,146,42,0.07)",
  txt: "#cbe5f1", lbl: "#a5cbde", title: "#daebf3",
  demoB: "#0a1a0a", demoBr: "#1a3a1a", demoT: "#a5cba5", demoT2: "#81bc81", demoT3: "#81ae81", demoT4: "#679567",
  demoEL: "#0f2a0f", demoE1: "#0d220d",
  wh: "#0a1219", whBr: "#405971", whTxt: "#85aabd",
  keyW: "#c8dde4", keyWBr: "#90b4bf", keyB: "#0e161b",
  modB: "#0d1520", modBr: "#35495d", modT: "#daebf3", modST: "#90aebe",
};

const LIGHT_K = {
  bg:  "#f0f4f7", bg2: "#ffffff", bg3: "#e4eaef",
  br:  "#a8b8c4", t1:  "#1a2830", t2:  "#4a6676",
  a:   "#d07818", ag:  "rgba(208,120,24,0.10)",
  txt: "#1a2830", lbl: "#3a6070", title: "#0a1820",
  demoB: "#edf8f0", demoBr: "#9ed4aa", demoT: "#2a7040", demoT2: "#3a8a50", demoT3: "#4a7060", demoT4: "#2a5a40",
  demoEL: "#b0dcc0", demoE1: "#d8f0e0",
  wh: "#e8eef4", whBr: "#9ab8cc", whTxt: "#5a7888",
  keyW: "#f0f4f6", keyWBr: "#a8c4d0", keyB: "#2a3a44",
  modB: "#ffffff", modBr: "#c0d0dc", modT: "#0a1820", modST: "#4a6878",
};

const PRESETS = [
  { l: "std modes",   f: "hep-6" },
  { l: "pentatonic",  f: "pen" },
  { l: "hexatonic",   f: "hex" },
  { l: "heptatonic",  f: "hep" },
  { l: "octatonic",   f: "oct" },
];

/* ═══════════════════════════════════════════════════════
   HELPER COMPONENTS
═══════════════════════════════════════════════════════ */

function Sec({ label, children, K }) {
  return (
    <div style={{ padding: "10px 14px", borderBottom: `1px solid ${K.br}`, flexShrink: 0 }}>
      <div style={{ color: K.lbl, fontSize: 9, letterSpacing: 3, marginBottom: 7, display: "flex", alignItems: "center" }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function Lbl({ children, K }) {
  return <div style={{ color: K.lbl, fontSize: 9, letterSpacing: 3, marginBottom: 5 }}>{children}</div>;
}


// Help modal
const HELP_SECTIONS = [
  { title: "WHAT IS CHLOE?", body: "Chloe generates every possible scale from 3 to 8 notes, filtered to exclude scales with 3 consecutive semitones. Use it to hear how different scales sound over a drone note and develop your ear for modal colour." },
  { title: "BINARY NOTATION", body: "Each scale is a 12-bit binary string, one bit per chromatic semitone from the root. 1 = active, 0 = inactive. The number in brackets e.g. (2741) is the decimal value of that string. Scales are grouped into families sharing the same interval structure - e.g. hep-6 contains all 7 standard modes." },
  { title: "BRIGHTNESS SORTING", body: "Within each family, modes are sorted bright to dark by summing their active semitone positions (raw brightness). Lydian scores highest (raised 4th), Locrian lowest (flatted 2nd and 5th). This mirrors the circle-of-fifths: Lydian → Ionian → Mixolydian → Dorian → Aeolian → Phrygian → Locrian. The sidebar and scale list show the raw brightness score (e.g. Dorian = 36). The EEG system uses a separate normalized brightness (0.0–1.0) that adjusts for note count, so pentatonics and tetratonics are comparable to heptatonics — Dorian normalizes to exactly 0.5 as the neutral midpoint." },
  { title: "SCALE WHEEL", body: "The circle shows all 12 chromatic notes. Active tones are highlighted and connected by a polygon. Wide polygons = sparse scales. Compact polygons = denser chromatic scales. A perfect regular polygon = equal temperament." },
  { title: "SEARCH & FILTER", body: "The left sidebar has a search box that filters scales by name as you type — results narrow to only matching modes within each family (e.g. searching 'dorian' shows just the Dorian row, not all 7 modes). The number chips (3–8) below it filter by note count — click any to isolate tritonic, pentatonic, heptatonic, etc. These compose with each other and with the header filter bar. The header filter accepts comma-separated terms: family ID (hep-6), group prefix (pen, hep, hex), scale name, binary fragment, decimal value, or interval pattern (2-2-1). The star button on any row marks a favourite; the favs button in the header shows starred scales only. Custom names are searchable too." },
  { title: "A/B SCALE COMPARISON", body: "Pin any scale as a reference point using the ⊿ pin button next to its name in the info panel. An A/B panel appears below showing both the pinned scale (B) and your current selection (A). Click either side to jump between them instantly — both play at the same root, tempo, and settings so you can hear the contrast directly. The A side automatically tracks whatever you're playing when you're not on the pinned scale, so browsing the list always updates A. The × button clears the comparison." },
  { title: "NAMING SCALES", body: "Any scale without a built-in name shows a pencil icon (✎) in its row. Click it to open an inline text field and type your own name. Press Enter or click away to save; Escape to cancel. To edit or clear a name, click the pencil next to it. Custom names appear in the info panel, show up in saved moments, and are fully searchable. They persist in your browser across sessions." },
  { title: "PLAYBACK", body: "Drone sustains the root note. DRONE OCT drops it 1–3 octaves. DRONE VOL sets its level independently. DRONE TYPE sets the drone sound: sine (clean + sub-octave), organ (additive harmonics), pad (detuned shimmer), strings (bowed saws with tremolo), tanpura (Indian root/fifth/octave pulsing). Play steps through the scale in Arpeggio or Melody mode. OCTAVES (1–3) expands playback across multiple octaves. Click the direction button to cycle: ascending, descending, or random. RHYTHM sets the note-spacing pattern: even, swing, gallop, waltz, or clave. Melody uses a weighted random walk with octave leaps. CHORD layers multiple scale tones per step: power (root+5th), sus2, triad, 7th, or all notes at once. If a heart rate sensor is connected, a ♥ button appears showing live BPM — click it to instantly set tempo to your heart rate." },
  { title: "SOUND", body: "All instruments are synthesised in the browser using Web Audio. piano = detuned triangle oscillators with harmonic decay. guitar = Karplus-Strong style noise burst. xylo = marimba-ratio harmonic partials. space = detuned sines with LFO vibrato. VOL sets note volume. REV adds convolution reverb. DEL sets delay wet level. D.T sets delay time in seconds (try 0.125, 0.25, 0.375, 0.5 for rhythmic values). A= sets concert pitch (432–440 Hz). BPM sets tempo." },
  { title: "SHARE / URL", body: "The share button encodes all settings into the URL and copies it to clipboard. Paste or bookmark to restore the exact session: scale, root, instrument, BPM, tuning, chord mode, and more." },
  { title: "⟲ AUTO MODE", body: "Auto mode explores scales automatically without needing an API key. It randomly picks from all named scales, varying root note, rhythm, arpeggio direction, chord voicing, BPM, reverb, delay level, and delay time every 12–16 seconds. Each choice is logged in the demo log panel; click any entry to jump back to that scale. Use Loop to freeze on a scale you like, and Save to capture it." },
  { title: "◇ JOURNEYS", body: "JOURNEY in the playback controls gives Auto a destination instead of wandering. Dawn = dark to bright; Dusk = bright to dark, slowing, with longer notes and deeper reverb; Descent = bright, down into the dark and back up; Storm = calm, a storm of clashing scales and faster tempo peaking about 60% of the way in (the orchestra at full energy if it's on), then calm; Rise = epic and energizing, a build to a big bright peak with one breath on the way, starting at its own 116 BPM, bold sounds, the orchestra driving and marching (choosing it in Listen turns on the orchestra and a drive beat). LENGTH sets 5, 15, 30 or 60 minutes. Choosing a journey starts Auto. Near the target, scales change one note at a time (a note moves, or one is added or dropped), and tempo, reverb and note length follow the shape; everything else ticked in ⚙ still changes. Progress shows next to BRIGHT. On arrival it holds at the destination and keeps playing, unless ⏺ rec is running: then it settles on a home scale, fades out over 10 seconds and saves the WAV. Share links carry jo= and jm=." },
  { title: "SMOOTH", body: "The SMOOTH slider in Auto's ⚙ menu hides where Auto's changes happen. At 0 every setting changes together on each pick. Turned up, each setting changes at its own moment between picks, fewer change each time (about 4 in 10 at 100%), reverb, delay and drone levels glide, the sound crossfade stretches to 12 seconds, scales morph note by note at up to half speed, the drone fades in and out, and the beat fades instead of cutting. Now and then Auto rests the beat: it fades out and comes back in a little later (untick Beat Style in ⚙ to stop that). Links carry it as sm= (0-100)." },
  { title: "★ DEMO MODE", body: "Demo mode uses the Claude AI API to autonomously explore scales with live commentary. Claude controls root, rhythm, direction, chord voicing, BPM, reverb, delay level, and delay time — choosing musically varied combinations and explaining its thinking. Commentary and feature requests (✦) appear in the Claude Chat panel, not the banner — the banner shows a one-line parameter summary only. If an EEG headband is connected (see EEG MODE), the scale is pre-selected algorithmically by brightness matching before Claude is called — Claude then articulates the selection rather than picking freely, and can override with justification. Without EEG, Claude picks scales freely. A chat box appears while Demo is running: type anything to direct the music — e.g. 'play something dark and slow', 'go to Lydian', or 'sync BPM to my heart rate'. Claude can lock BPM to your live heart rate and track it each cycle until you ask it to stop. Enter your Anthropic API key when prompted (console.anthropic.com → API Keys). Your key is stored in your browser only." },
  { title: "EEG MODE", body: "When a FlowTime headband is connected via the EEG proxy (localhost:8520), a coloured dot appears in the Demo controls showing your dominant brainwave band (excluding delta, which is always high at forehead sites and not meaningful). In Demo mode with EEG active, a brightness-matching algorithm runs before each Claude call: a high theta/alpha ratio pushes the target darker (deep meditation, drowsiness); a high beta/alpha ratio pushes it brighter (focus, engagement); alpha dominance pulls 50% toward neutral (0.5 = Dorian). The system then finds the scale in the catalogue whose normalized brightness is closest to the target — scales of any size (pentatonic, heptatonic, etc.) are equally reachable at any brightness level. A scale only changes if the target shifts by more than 5% from the current scale's brightness. Claude receives the pre-selected scale and its normalized brightness, and focuses on choosing BPM, voicing, and effects to complement it. The brightness bar lets you override the EEG target manually with the slider, lock the current zone, or explore random scales at similar brightness. If a heart rate sensor is also active, the live BPM appears in the playback controls — Claude can read and track it each cycle when you ask it to sync BPM to your pulse." },
  { title: "LOOP & SAVE", body: "While Demo or Auto is running, a Loop button appears. Click it to freeze playback on the current scale — Claude or Auto keeps repeating it instead of moving on. While looping, a Save button appears. Clicking Save captures a full snapshot: scale, root, BPM, rhythm, arpeggio direction, chord voicing, instrument, reverb, delay, and drone settings. Saved moments persist in your browser and appear in a collapsible panel. Click the play button on any saved moment to instantly restore all its settings and start playback. Delete a moment with the × button." },
  { title: "◎ MONASTIC MODE", body: "A toggle in the playback controls (◎ Monastic / ◎ Still) that shifts the entire system into a slow, sustained, contemplative mode — the opposite of the default, which optimises for variety and exploration. When activated: BPM is set to 15 and the floor drops to 1 (one note every 60 seconds at BPM 1); the drone turns on with tanpura selected; Claude and Auto cycle intervals extend to 3 minutes; the EEG smoothing window widens to 30 polls (60 seconds of data) so only sustained brain state shifts register; and the brightness transition threshold rises to 0.15, meaning subtler fluctuations no longer trigger scale changes. Claude is instructed to hold each scale for the full cycle, prefer sparse scales (3–5 notes) and slow tempos, keep commentary to one sentence, and skip feature suggestions. Toggle off to restore the previous BPM and normal cycle speed. Monastic mode is independent of Demo, Auto, and manual Play — it modifies how each mode behaves, not which mode is active." },
];

function WelcomeModal({ onClose, K }) {
  const steps = [
    { icon: "←", label: "Pick a scale", desc: "Click any scale in the left panel. They're grouped by size — try the Heptatonic group for familiar sounds like Dorian or Lydian." },
    { icon: "▶", label: "Play it", desc: "Hit Play in the right panel to arpeggiate through the scale. Hit Drone to hear a sustained root note underneath." },
    { icon: "⟲", label: "Let it explore", desc: "Hit Auto to have Chloe wander through scales automatically. Or hit ★ Claude to let AI explore and explain each scale with live commentary." },
    { icon: "?", label: "Go deeper", desc: "Click ? in the top bar for full documentation — binary notation, brightness sorting, saved moments, A/B comparison, and more." },
  ];
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.82)",
      zIndex: 1100, display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: K.modB, border: `1px solid ${K.modBr}`,
        borderRadius: 10, width: "100%", maxWidth: 480,
        boxShadow: "0 24px 80px rgba(0,0,0,0.9)",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{ padding: "28px 28px 20px", borderBottom: `1px solid ${K.modBr}` }}>
          <div style={{ fontFamily: "'Trebuchet MS', sans-serif", fontSize: 28, fontWeight: 800, letterSpacing: 4, color: K.modT, marginBottom: 6 }}>CHLOE</div>
          <div style={{ color: K.modST, fontSize: 11, letterSpacing: 2, lineHeight: 1.6 }}>
            A scale explorer. Every possible musical scale from 3 to 8 notes — hear them, compare them, get lost in them.
          </div>
        </div>
        {/* Steps */}
        <div style={{ padding: "20px 28px" }}>
          {steps.map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 16, marginBottom: i < steps.length - 1 ? 18 : 0 }}>
              <div style={{
                width: 36, height: 36, borderRadius: "50%", background: K.ag,
                border: `1px solid ${K.a}`, display: "flex", alignItems: "center", justifyContent: "center",
                color: K.a, fontSize: 14, fontWeight: 700, flexShrink: 0,
              }}>{s.icon}</div>
              <div>
                <div style={{ color: K.a, fontSize: 11, fontWeight: 700, letterSpacing: 1, marginBottom: 3 }}>{s.label}</div>
                <div style={{ color: K.modST, fontSize: 10, lineHeight: 1.6 }}>{s.desc}</div>
              </div>
            </div>
          ))}
        </div>
        {/* Footer */}
        <div style={{ padding: "16px 28px 24px", display: "flex", gap: 10 }}>
          <button onClick={onClose} style={{
            flex: 1, background: K.a, border: "none", color: "#000",
            borderRadius: 5, padding: "11px 0", fontSize: 12, fontWeight: 700,
            cursor: "pointer", fontFamily: "inherit", letterSpacing: 1,
          }}>Get started</button>
          <button onClick={onClose} style={{
            background: "none", border: `1px solid ${K.modBr}`, color: K.modST,
            borderRadius: 5, padding: "11px 16px", fontSize: 10,
            cursor: "pointer", fontFamily: "inherit", letterSpacing: 0.5,
          }}>skip</button>
        </div>
      </div>
    </div>
  );
}

function HelpModal({ onClose, K }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.78)",
      zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: K.modB, border: `1px solid ${K.modBr}`,
        borderRadius: 8, width: "100%", maxWidth: 660, maxHeight: "80vh",
        display: "flex", flexDirection: "column", overflow: "hidden",
        boxShadow: "0 24px 64px rgba(0,0,0,0.8)",
      }}>
        <div style={{ display: "flex", alignItems: "center", padding: "14px 20px", borderBottom: `1px solid ${K.modBr}`, flexShrink: 0 }}>
          <div style={{ fontFamily: "'Trebuchet MS', sans-serif", fontSize: 16, fontWeight: 800, letterSpacing: 3, color: K.modT }}>CHLOE</div>
          <div style={{ color: K.modST, fontSize: 9, letterSpacing: 4, marginLeft: 10, marginTop: 2 }}>HELP</div>
          <button onClick={onClose} style={{ marginLeft: "auto", background: "none", border: "none", color: K.t2, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 4px" }}>x</button>
        </div>
        <div style={{ overflowY: "auto", padding: "16px 20px", flex: 1 }}>
          {HELP_SECTIONS.map(sec => (
            <div key={sec.title} style={{ marginBottom: 22 }}>
              <div style={{ color: K.a, fontSize: 9, letterSpacing: 3, fontWeight: 600, marginBottom: 6 }}>{sec.title}</div>
              <div style={{ color: K.txt, fontSize: 11, lineHeight: 1.8 }}>{sec.body}</div>
            </div>
          ))}
          <div style={{ color: K.t2, fontSize: 9, marginTop: 8, borderTop: `1px solid ${K.br}`, paddingTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Click outside or press Esc to close</span>
            <div style={{ display: "flex", gap: 16 }}>
              <a href="chloe3-guide.html" target="_blank" rel="noreferrer" style={{ color: K.a, textDecoration: "none", letterSpacing: 1 }}>full guide ↗</a>
              <a href="scales-interactive.html" target="_blank" rel="noreferrer" style={{ color: K.a, textDecoration: "none", letterSpacing: 1 }}>scales are numbers ↗</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   VISUALIZER
═══════════════════════════════════════════════════════ */

function Visualizer({ analyserRef, playing, rootIdx, active, K }) {
  const canvasRef  = useRef(null);
  const rafRef     = useRef(null);
  const KRef       = useRef(K);
  useEffect(() => { KRef.current = K; }, [K]);
  const playingRef = useRef(playing);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  const rootIdxRef = useRef(rootIdx);
  useEffect(() => { rootIdxRef.current = rootIdx; }, [rootIdx]);
  const activeRef  = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);
  const hueRef     = useRef(0); // smoothly lerped current hue

  // Draw loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const data = new Uint8Array(2048);

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw);
      const W = canvas.width, H = canvas.height;
      if (!W || !H) return;
      const Kc = KRef.current;
      const { whBr } = Kc;

      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H / 2;
      const R = Math.min(W, H) * 0.36;

      // Lerp hue toward the current note's chromatic colour
      const p = playingRef.current;
      if (p !== null) {
        const targetHue = ((rootIdxRef.current ?? 0) + p) % 12 * 30;
        let diff = targetHue - hueRef.current;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;
        hueRef.current = (hueRef.current + diff * 0.07 + 360) % 360;
      }
      const noteColor = `hsl(${hueRef.current.toFixed(1)}, 80%, 62%)`;

      // 12-segment chromatic colour wheel (faint outer ring)
      const gap = 0.04;
      for (let i = 0; i < 12; i++) {
        const a0 = (i / 12) * Math.PI * 2 - Math.PI / 2 + gap;
        const a1 = ((i + 1) / 12) * Math.PI * 2 - Math.PI / 2 - gap;
        ctx.beginPath();
        ctx.arc(cx, cy, R + 10, a0, a1);
        ctx.strokeStyle = `hsl(${i * 30}, 70%, 55%)`;
        ctx.lineWidth = 4;
        ctx.globalAlpha = 0.28;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Ghost ring
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.strokeStyle = whBr;
      ctx.lineWidth = 1;
      ctx.stroke();

      const analyser = analyserRef.current?.node;
      if (analyser) {
        analyser.getByteTimeDomainData(data);
        const N = data.length;

        // Waveform ring — subsample to every 4th point (512 pts, visually identical)
        // Double-stroke glow avoids shadowBlur which forces Firefox to allocate
        // a compositing surface every frame (~72MB/min at 60fps on a 600×500 canvas)
        ctx.beginPath();
        for (let i = 0; i <= N; i += 4) {
          const idx = i % N;
          const v = (data[idx] / 128.0) - 1.0;
          const r = R + v * R * 0.55;
          const angle = (idx / N) * Math.PI * 2 - Math.PI / 2;
          const x = cx + r * Math.cos(angle);
          const y = cy + r * Math.sin(angle);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.strokeStyle = noteColor;
        // Glow pass: wide + transparent, no shadowBlur
        ctx.lineWidth = 6;
        ctx.globalAlpha = 0.18;
        ctx.stroke();
        // Line pass: crisp
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = 1;
        ctx.stroke();
      }

      // Scale wheel
      const act = activeRef.current;
      if (act) {
        const wheelR = R * 0.60;
        const dotR   = Math.max(5, wheelR * 0.155);
        const rootOff = rootIdxRef.current ?? 0;

        // Dark background fill
        ctx.beginPath();
        ctx.arc(cx, cy, wheelR + dotR + 6, 0, Math.PI * 2);
        ctx.fillStyle = Kc.bg;
        ctx.globalAlpha = 0.92;
        ctx.fill();
        ctx.globalAlpha = 1;

        // Outer ring
        ctx.beginPath();
        ctx.arc(cx, cy, wheelR + dotR + 4, 0, Math.PI * 2);
        ctx.strokeStyle = whBr;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Inner ring
        ctx.beginPath();
        ctx.arc(cx, cy, wheelR - dotR - 4, 0, Math.PI * 2);
        ctx.strokeStyle = whBr;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Polygon
        const activePts = [];
        for (let i = 0; i < 12; i++) {
          if (act.has(i)) {
            const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
            activePts.push([cx + wheelR * Math.cos(a), cy + wheelR * Math.sin(a)]);
          }
        }
        if (activePts.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(activePts[0][0], activePts[0][1]);
          for (let i = 1; i < activePts.length; i++) ctx.lineTo(activePts[i][0], activePts[i][1]);
          ctx.closePath();
          ctx.fillStyle = Kc.a + "18";
          ctx.fill();
          ctx.strokeStyle = Kc.a;
          ctx.lineWidth = 1.5;
          ctx.lineJoin = "round";
          ctx.stroke();
        }

        // Dots + labels
        const fontSize = Math.max(7, Math.round(dotR * 0.75));
        ctx.font = `500 ${fontSize}px 'JetBrains Mono', monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
          const x = cx + wheelR * Math.cos(a);
          const y = cy + wheelR * Math.sin(a);
          const isActive = act.has(i);
          const isPlaying = playingRef.current === i;
          const label = CHROMATIC[(rootOff + i) % 12];

          ctx.beginPath();
          ctx.arc(x, y, dotR - 1, 0, Math.PI * 2);
          ctx.fillStyle = isPlaying ? Kc.a : isActive ? Kc.a + "30" : Kc.wh;
          ctx.fill();
          ctx.strokeStyle = isActive ? Kc.a : whBr;
          ctx.lineWidth = isActive ? 1.5 : 1;
          ctx.stroke();

          ctx.fillStyle = isPlaying ? "#000" : isActive ? Kc.a : Kc.whTxt;
          ctx.fillText(label, x, y + 0.5);
        }
      }
    };

    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    draw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [analyserRef]);

  // Keep canvas sized to its container
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />;
}

/* ═══════════════════════════════════════════════════════
   SCALE INFO PANEL
═══════════════════════════════════════════════════════ */

function ScaleInfo({ sel, selName, selIvs, selNotes, demoKey, K }) {
  const [aiText,  setAiText]  = useState(null);
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef({});

  useEffect(() => {
    if (!sel || !selName) { setAiText(null); setLoading(false); return; }
    const key = sel.pattern;
    if (cacheRef.current[key]) { setAiText(cacheRef.current[key]); setLoading(false); return; }
    if (!demoKey) { setAiText(null); setLoading(false); return; }

    setLoading(true);
    setAiText(null);
    let cancelled = false;

    (async () => {
      const { Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: demoKey, dangerouslyAllowBrowser: true });
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: "You are a music theory expert. Write concisely for a musician who wants to understand a scale's character and practical use. Each paragraph should be 1-2 sentences.",
        messages: [{ role: "user", content: `Give me a short musical guide to the ${selName} scale. In 3 short paragraphs cover: (1) its mood and character, (2) its origins and history, (3) notable songs, genres, or composers associated with it. Be specific with examples. Keep it brief and engaging.` }],
      });
      if (cancelled) return;
      const result = msg.content[0].text.trim();
      cacheRef.current[key] = result;
      setAiText(result);
      setLoading(false);
    })().catch(err => {
      if (!cancelled) { setAiText(`Error: ${err.message}`); setLoading(false); }
    });

    return () => { cancelled = true; };
  }, [sel?.pattern, selName, demoKey]);

  const noteCount = selNotes ? selNotes.length : 0;
  const grpName = GRP_NAME[noteCount] || "";
  const ivStr = selIvs ? selIvs.join("–") : "";

  if (!sel) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: K.t2, fontSize: 11 }}>
      Select a scale to see information
    </div>
  );

  return (
    <div style={{ padding: "28px 32px", overflowY: "auto", height: "100%" }}>
      <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 4, color: selName ? K.a : K.t1, marginBottom: 4 }}>
        {selName || "Unnamed Scale"}
      </div>
      <div style={{ fontSize: 9, color: K.t2, letterSpacing: 3, marginBottom: 24 }}>
        {grpName.toUpperCase()}{sel.id ? ` · ${sel.id}` : ""}
      </div>

      <div style={{ background: K.bg3, border: `1px solid ${K.br}`, borderRadius: 6, padding: "14px 18px", marginBottom: 24 }}>
        <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "8px 20px", fontSize: 10 }}>
          <span style={{ color: K.lbl, letterSpacing: 2, fontSize: 9 }}>NOTES</span>
          <span style={{ color: K.txt, letterSpacing: 3 }}>{selNotes?.join("  ")}</span>
          <span style={{ color: K.lbl, letterSpacing: 2, fontSize: 9 }}>INTERVALS</span>
          <span style={{ color: K.txt }}>{ivStr}</span>
          <span style={{ color: K.lbl, letterSpacing: 2, fontSize: 9 }}>DECIMAL</span>
          <span style={{ color: K.t2 }}>{sel.pattern}</span>
        </div>
      </div>

      {!selName ? (
        <div style={{ color: K.t2, fontSize: 10, fontStyle: "italic" }}>This scale doesn't have a name in the catalogue.</div>
      ) : loading ? (
        <div style={{ color: K.t2, fontSize: 10, fontStyle: "italic" }}>Loading…</div>
      ) : aiText ? (
        <div style={{ fontSize: 11, lineHeight: 1.9, color: K.txt }}>
          {aiText.split(/\n\n+/).map((para, i) => (
            <p key={i} style={{ marginBottom: 16, marginTop: 0 }}>{para}</p>
          ))}
        </div>
      ) : !demoKey ? (
        <div style={{ color: K.t2, fontSize: 10, fontStyle: "italic" }}>
          Enter an API key via ★ Claude to enable AI-generated scale info.
        </div>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   MAIN APP
═══════════════════════════════════════════════════════ */

export default function Chloe() {
  const FAMILIES = useMemo(buildFamilies, []);
  // Outside scales (3-semitone clusters): shown in the list and used by
  // demo/auto/randomizer only when this is on
  const [showOutside, setShowOutside] = useState(() => {
    try { return localStorage.getItem("chloe-show-outside") === "1"; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem("chloe-show-outside", showOutside ? "1" : "0"); } catch {} }, [showOutside]);
  const ACTIVE_FAMILIES = useMemo(() => showOutside ? FAMILIES : FAMILIES.filter(f => !f.outside), [FAMILIES, showOutside]);
  const activeFamiliesRef = useRef(ACTIVE_FAMILIES);
  useEffect(() => { activeFamiliesRef.current = ACTIVE_FAMILIES; }, [ACTIVE_FAMILIES]);
  // Full catalogue of all scales (used by brightness randomizer — includes unnamed, never outside)
  const fullCatalogue = useMemo(() => {
    const result = [];
    for (const fam of FAMILIES.filter(f => !f.outside)) {
      fam.modes.forEach((pat, mi) => result.push({ familyId: fam.id, modeIdx: mi, name: KNOWN[pat] || `${fam.id}.${mi}`, notes: fam.n, pattern: pat }));
    }
    return result;
  }, [FAMILIES]);

  // ── Parse initial state from URL ──
  const _initFromURL = () => {
    try {
      const p = new URLSearchParams(window.location.search);
      return {
        rootIdx:    parseInt(p.get("r") ?? "0"),
        timbre:     ["sine","triangle","square","sawtooth"].includes(p.get("t")) ? p.get("t") : "sine",
        instrument: ["piano","guitar","xylo","space","lute","fiddle","dx7","duduk"].includes(p.get("i")) ? p.get("i") : null,
        noteVol:    Number.isFinite(parseFloat(p.get("v"))) ? parseFloat(p.get("v")) : 0.7,
        reverbAmt:  parseFloat(p.get("rv") ?? "0.75"),
        delayAmt:   parseFloat(p.get("dl") ?? "0.15"),
        bpm:        parseInt(p.get("b") ?? "100"),
        filter:     p.get("f") ?? "",
        selId:      p.get("s") ?? null,   // "hep-6.1" style
        aRef:       parseInt(p.get("a") ?? "440"),
        droneOct:   p.has("do") ? parseInt(p.get("do")) : null,
        droneOn:    p.get("dr") === "1",
        droneWave:  ["sine", "organ", "pad", "strings", "tanpura", "throat", "jawharp", "juno", "dam"].includes(p.get("dw")) ? p.get("dw") : undefined,
        melMode:    p.get("m") === "1",
        autoOff:    p.get("al") ?? "",
        autoOn:     p.get("an") ?? "",
        blend:      p.get("bl") !== "0",
        tempoGlide: p.get("tg") !== "0",
        soundBlend: p.get("sb") !== "0",
        tuning:     ["just", "pyth"].includes(p.get("tu")) ? p.get("tu") : "equal",
        autoTempo:  p.get("at") === "drift" ? "drift" : "bursts",
        journey:    Object.hasOwn(JOURNEYS, p.get("jo") ?? "") ? p.get("jo") : "off",
        smooth:     Math.min(100, Math.max(0, parseInt(p.get("sm") ?? "0") || 0)) / 100,
        journeyMins: JOURNEY_MINS.includes(parseInt(p.get("jm"))) ? parseInt(p.get("jm")) : 15,
        sleepMins:  SLEEP_MINS.includes(parseInt(p.get("sl"))) ? parseInt(p.get("sl")) : undefined,
        symphonic:  p.get("sy") === "1",
        beatWander: p.get("bw") === "1",
        beatStyle:  ["break", "drive", "heavy", "fusion", "downtempo", "hand", "brushes", "shaman", "newwave", "desert"].includes(p.get("bt")) ? p.get("bt") : "off",
        grouping:   p.get("g") === "mix" ? "mix" : [3, 5, 6, 7].includes(parseInt(p.get("g"))) ? parseInt(p.get("g")) : 0,
        sidebarW:   parseInt(p.get("sw") ?? "520"),
      };
    } catch { return {}; }
  };
  const _u = useMemo(_initFromURL, []);

  const [rootIdx,    setRootIdx]    = useState(_u.rootIdx    ?? 0);
  const [timbre,     setTimbre]     = useState(_u.timbre     ?? "sine");
  const [instrument, setInstrument] = useState(_u.instrument ?? null);
  const [noteVol,    setNoteVol]    = useState(_u.noteVol    ?? 0.7);
  const [reverbAmt,  setReverbAmt]  = useState(_u.reverbAmt  ?? 0.75);
  const [delayAmt,   setDelayAmt]   = useState(_u.delayAmt   ?? 0.15);
  const [delayTime,  setDelayTime]  = useState(0.375); // seconds
  const [sustainMult, setSustainMult] = useState(() => parseFloat(new URLSearchParams(window.location.search).get("su") ?? "1"));
  const [bpm,        setBpm]        = useState(_u.bpm        ?? 100);
  const [filter,     setFilter]     = useState(_u.filter     ?? "");
  const [sel,        setSelRaw]     = useState(null); // resolved after FAMILIES built
  // Smooth scale transition: if arp is playing, queue the change
  const setSel = useCallback((newSel) => {
    if (!newSel) { setSelRaw(newSel); return; }
    // If arp is not running, apply immediately
    if (!arpRef.current) { setSelRaw(newSel); return; }
    // Queue it — melTick will apply it at the right moment
    pendingSelRef.current = newSel;
    pendingSelTimeRef.current = Date.now();
  }, []);
  const [aRef,       setARef]       = useState(_u.aRef       ?? 440);
  const [droneOn,    setDroneOn]    = useState(_u.droneOn ?? false);
  const [droneOct,   setDroneOct]   = useState(_u.droneOct   ?? -24);
  const [arpOn,      setArpOn]      = useState(false);
  const usageRef = useRef({ secs: 0, next: 0 });
  const [arpDir,     setArpDir]     = useState("asc"); // "asc" | "desc" | "rand"
  const [arpOct,     setArpOct]     = useState(3);
  // Note grouping (0 = off): play the line in repeating groups of N even notes,
  // each group shifted one scale step, so the group cycle runs against the pulse
  // (Eric Johnson style 5s/6s) and the ear can't settle on where the beat is.
  // "mix" varies the size per group in patterns that fill whole bars (MIX_PATTERNS).
  const [grouping,   setGrouping]   = useState(_u.grouping ?? 0);
  const [rhythm,     setRhythm]     = useState("even");
  const [melMode,    setMelMode]    = useState(_u.melMode     ?? false);
  const [chordVoice, setChordVoice] = useState("off"); // off | triad | 7th | sus2 | power | all | rand
  const [playing,    setPlaying]    = useState(null);
  // Scale blend: when the scale (or key) changes while playing, the line moves
  // to the new notes one voice-leading step at a time instead of cutting.
  // morphSemis is the in-between note set (relative to the root) for the wheel.
  const [blend,      setBlend]      = useState(_u.blend ?? true);
  // Tempo glide: BPM changes ease over ~6 s per doubling/halving (2 s minimum) instead of jumping
  const [tempoGlide, setTempoGlide] = useState(_u.tempoGlide ?? true);
  const [soundBlend, setSoundBlend] = useState(_u.soundBlend ?? true);
  const [tuning, setTuning] = useState(_u.tuning ?? "equal");
  // Auto tempo: drift = wander in small steps; bursts = hold steady, with short surprises
  const [autoTempo, setAutoTempo] = useState(_u.autoTempo ?? "bursts");
  // Journey — see JOURNEYS above. journeyRef holds the live run while Auto plays one
  const [journey,     setJourney]     = useState(_u.journey ?? "off");
  const [journeyMins, setJourneyMins] = useState(_u.journeyMins ?? 15);
  // 0 = off. Remembered between visits; a link can set it with sl=
  const [sleepMins, setSleepMins] = useState(() => {
    if (_u.sleepMins) return _u.sleepMins;
    try { const v = parseInt(localStorage.getItem("chloe-sleep")); return SLEEP_MINS.includes(v) ? v : 0; } catch { return 0; }
  });
  const [sleepLeft, setSleepLeft] = useState(null);   // ms left while the timer runs
  useEffect(() => { try { localStorage.setItem("chloe-sleep", String(sleepMins)); } catch {} }, [sleepMins]);
  const [journeyNow,  setJourneyNow]  = useState(null); // { el, f, arrived, ending } for the display
  const journeyRef = useRef(null);  // { id, mins, startMs, homeBpm, vals, arrived, ending }
  // Smooth (0-1): hides where Auto's changes happen. Staggers them across the
  // gap between picks, changes fewer settings per pick, glides levels, slows
  // the sound crossfade and scale morph, fades drone and beat in and out
  const [smooth, setSmooth] = useState(_u.smooth ?? 0);
  const smoothRef = useRef(smooth);
  useEffect(() => { smoothRef.current = smooth; }, [smooth]);
  // Glide an AudioParam while Auto/Claude runs with Smooth up (3 time constants ≈ 0.3-8 s), else set it
  const glideParam = (param, v) => {
    const sm = smoothRef.current, ac = param && ctxRef.current;
    if (!param) return;
    if (!sm || !ac || !(autoOnRef.current || demoOnRef.current)) { param.value = v; return; }
    param.cancelScheduledValues(ac.currentTime);
    param.setTargetAtTime(v, ac.currentTime, 0.1 + 2.5 * sm);
  };
  // Symphonic: sampled strings + double bass play the scale's chords under the line
  const [symphonic, setSymphonic] = useState(_u.symphonic ?? false);
  const [orchLoading, setOrchLoading] = useState(false);
  const orchRef = useRef(null);
  // Beat: off | break | drive | heavy (sampled LinnDrum through a punch compressor)
  const [beatStyle, setBeatStyle] = useState(_u.beatStyle ?? "off");
  // Wander: Auto's beat changes roam across every style instead of staying in one family
  const [beatWander, setBeatWander] = useState(_u.beatWander ?? false);
  const likesRef = useRef(loadLikes());
  const [likeFlash, setLikeFlash] = useState(0);   // Date.now() of the last ♥, for the "more like this" note
  const kitRef = useRef(null);
  const beatRestRef = useRef(0);   // Smooth: Date.now() until which Auto rests the beat (0 = playing)
  const beatPhraseRef = useRef(false);   // Auto's style change waits for the end of the 4-bar phrase
  const riffHoldRef = useRef(0);   // Rise: Date.now() until which a riff owns the tempo (Auto and bursts leave it alone)
  const riffBufsRef = useRef(null); // Rise riffs: { ready, bufs } once fetched (AudioBuffers work in any context)
  // Recorder state: null, or { rec, t0 } while recording
  const [recording, setRecording] = useState(null);
  const [recSecs, setRecSecs] = useState(0);
  const recordingRef = useRef(null);
  useEffect(() => { recordingRef.current = recording; }, [recording]);
  const toggleRecRef = useRef(null);
  const energyRef = useRef(0);        // orchestra tension energy, shared with Auto
  const autoOnRef = useRef(false);
  const tempoSnapRef = useRef(false); // next BPM change jumps instead of gliding
  const beatStepHookRef = useRef(null); // the jaw harp plucks on the beat's 16ths: (ac, time, step, stepDur)
  const leadTempoRef = useRef(1);       // lead-only burst: the lead plays at this × the band's tempo
  const [morphSemis, setMorphSemis] = useState(null);
  const [expanded,   setExpanded]   = useState(new Set(["hep"]));
  const [sidebarW,   setSidebarW]   = useState(_u.sidebarW   ?? 520);
  const [listW,      setListW]      = useState(360);
  const [urlCopied,  setUrlCopied]  = useState(false);
  const [showHelp,    setShowHelp]    = useState(false);
  // Listen: a simple front door (pick a journey, press play); Studio: the full app
  // Which door opens: ?view= wins; a shared settings link opens Studio; otherwise
  // the last view used, Listen for first-time visitors
  const [view, setView] = useState(() => {
    const p = new URLSearchParams(window.location.search), v = p.get("view");
    if (v === "listen" || v === "studio") return v;
    // An old ?v=listen link (v is note volume) still opens Listen
    if (p.get("v") === "listen") return "listen";
    if ([...p.keys()].length) return "studio";
    try { return localStorage.getItem("chloe-view") === "studio" ? "studio" : "listen"; } catch { return "listen"; }
  });
  // Only a click on LISTEN / STUDIO is remembered, not a link that opened one
  const goView = (v) => { setView(v); try { localStorage.setItem("chloe-view", v); } catch {} if (v === "studio") track("studio/open"); };
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem("chloe-welcomed"));
  const [demoOn,      setDemoOn]      = useState(false);
  useEffect(() => { demoOnRef.current = demoOn; }, [demoOn]);
  const [demoKey,     setDemoKey]     = useState(() => localStorage.getItem("chloe-demo-key") || "");
  const [demoComment, setDemoComment] = useState("");
  const [demoRequest, setDemoRequest] = useState("");
  const [chatInput,   setChatInput]   = useState("");
  const [chatLog,     setChatLog]     = useState([]); // { role:"user"|"claude", text, ts }
  const chatLogRef = useRef([]);
  useEffect(() => { chatLogRef.current = chatLog; }, [chatLog]);
  const [chatOpen,    setChatOpen]    = useState(false);
  const pendingUserMsgRef = useRef(null); // message waiting to be sent to Claude
  const callClaudeNowRef  = useRef(null); // fn to trigger immediate Claude call
  const chatScrollRef     = useRef(null); // chat log container for auto-scroll
  useEffect(() => { if (chatScrollRef.current) chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight; }, [chatLog]);
  const [demoKeyInput, setDemoKeyInput] = useState(false);
  const [demoLog,     setDemoLog]     = useState([]);
  const [showDemoLog, setShowDemoLog] = useState(false);
  const [logCopied,   setLogCopied]   = useState(false);
  const [autoOn,      setAutoOn]      = useState(false);
  // Usage stats: GoatCounter events at 1/5/15/30/60 minutes of sound per visit
  useEffect(() => {
    if (!autoOn && !arpOn) return;
    const id = setInterval(() => {
      const u = usageRef.current;
      u.secs += 15;
      while (u.next < LISTEN_MARKS.length && u.secs >= LISTEN_MARKS[u.next] * 60) track(`listened/${LISTEN_MARKS[u.next++]}min`);
    }, 15000);
    return () => clearInterval(id);
  }, [autoOn, arpOn]);
  const demoOnRef = useRef(false);
  useEffect(() => { autoOnRef.current = autoOn; }, [autoOn]);
  const [loopOn,      setLoopOn]      = useState(false);
  const loopOnRef = useRef(false);
  useEffect(() => { loopOnRef.current = loopOn; }, [loopOn]);
  const [savedMoments, setSavedMoments] = useState(() => {
    try { return JSON.parse(localStorage.getItem("chloe-saved-moments") || "[]"); }
    catch { return []; }
  });
  const [showSaved, setShowSaved] = useState(false);
  const [beatOn,      setBeatOn]      = useState(false);
  const [droneVol,    setDroneVol]    = useState(1.0);
  const [droneTone,   setDroneTone]   = useState(0.5);
  const [droneWave,   setDroneWave]   = useState(_u.droneWave ?? "tanpura");
  const [beatVol,     setBeatVol]     = useState(1.0);
  const beatStepRef  = useRef(0);
  const beatTimeout  = useRef(null);
  const droneGainRef   = useRef(null);
  const swapAtRef      = useRef(0);   // when the periodic recycler last swapped the context
  const droneFilterRef = useRef(null);
  const droneVoiceRef  = useRef(null);
  const droneFreqRef   = useRef(0);
  const demoLogRef   = useRef([]);
  const brightnessHistoryRef = useRef([]);  // rolling window of raw targets for smoothing
  const overrideTargetRef    = useRef(null); // live value for callClaude (avoids stale closure)
  const brightnessLockedRef  = useRef(false);
  const claudeOverrideRef    = useRef(null); // Claude-set brightness override
  const [overrideTarget,   setOverrideTarget]   = useState(null);  // mirrors ref, for rendering
  const [brightnessLocked, setBrightnessLocked] = useState(false);
  const [claudeOverride,   setClaudeOverride]   = useState(null);  // Claude-driven target
  const [claudeBpmOverride, setClaudeBpmOverride] = useState(null); // "heart_rate" | number | null
  const claudeBpmOverrideRef = useRef(null);
  useEffect(() => { claudeBpmOverrideRef.current = claudeBpmOverride; }, [claudeBpmOverride]);
  const [monasticMode, setMonasticMode] = useState(false);
  const monasticModeRef = useRef(false);
  useEffect(() => { monasticModeRef.current = monasticMode; }, [monasticMode]);
  const preMonasticBpmRef = useRef(null);
  const [eegTarget,        setEegTarget]        = useState(null);  // last smoothed EEG target
  const [eegData,    setEegData]    = useState(null);  // live EEG from proxy
  const eegDataRef = useRef(null);
  useEffect(() => { eegDataRef.current = eegData; }, [eegData]);
  // Session arc — see ARC_* above
  const [arc,      setArc]      = useState(null); // { mode, mins, dir, amount, startMs, from, to, rows } while running
  const arcRef = useRef(null);
  useEffect(() => { arcRef.current = arc; }, [arc]);
  const [arcNow,   setArcNow]   = useState(0);    // elapsed ms, for the timer display
  const [showArc,  setShowArc]  = useState(false);
  const [arcCfg,   setArcCfg]   = useState({ mode: "lead", mins: 15, dir: 1, amount: 0.25 });
  const [sessions, setSessions] = useState(() => {
    try { return JSON.parse(localStorage.getItem("chloe-sessions") || "[]"); } catch { return []; }
  });
  useEffect(() => { try { localStorage.setItem("chloe-sessions", JSON.stringify(sessions)); } catch {} }, [sessions]);

  const setLeadTarget = (v) => {
    overrideTargetRef.current = v; setOverrideTarget(v);
    brightnessLockedRef.current = false; setBrightnessLocked(false);
  };
  const startArc = () => {
    const now = Date.now();
    setArc({ ...arcCfg, startMs: now, from: null, to: null, rows: [], lastLog: 0 });
    setArcNow(0);
    if (arcCfg.mode === "lead") { overrideTargetRef.current = null; setOverrideTarget(null); }
  };
  const stopArc = () => {
    const a = arcRef.current;
    if (!a) return;
    arcRef.current = null; setArc(null);
    if (a.mode === "lead") { overrideTargetRef.current = null; setOverrideTarget(null); }
    if (a.rows.length) {
      const sess = { id: a.startMs, startedAt: new Date(a.startMs).toISOString(), mode: a.mode, mins: a.mins,
                     from: a.from, to: a.to, rows: a.rows };
      setSessions(p => [sess, ...p].slice(0, 20));
    }
  };
  const downloadSession = (sess) => {
    const blob = new Blob([sessionCSV(sess)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `chloe-session-${sess.startedAt.slice(0, 16).replace(/[:T]/g, "-")}-${sess.mode}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // Arc clock: steer the lead target once a second, log a row every ARC_LOG_MS
  useEffect(() => {
    if (!arc) return;
    const id = setInterval(() => {
      const a = arcRef.current;
      if (!a) return;
      const el = Date.now() - a.startMs;
      setArcNow(el);
      const brain = eegBrainTarget(eegDataRef.current, BRIGHTNESS_CONFIG);
      let phase = a.mode, lead = null;
      if (a.mode === "lead") {
        if (el < ARC_BASELINE_MS) phase = "baseline";
        else {
          if (a.from === null) {
            // Baseline over: start from where the brain sat, or from the current scale without EEG
            const pts = a.rows.map(r => r.brain_target).filter(v => v !== null);
            const cur = stRef.current.sel;
            a.from = pts.length ? pts.reduce((x, v) => x + v, 0) / pts.length
                   : cur && !isOutsideId(cur.id) ? normalizedBrightness(cur.pattern) : 0.5;
            a.to = Math.min(0.95, Math.max(0.05, a.from + a.dir * a.amount));
          }
          const f = Math.min(1, (el - ARC_BASELINE_MS) / (a.mins * 60000));
          lead = a.from + (a.to - a.from) * f;
          phase = f < 1 ? "lead" : "hold";
          if (!journeyRef.current) setLeadTarget(lead);   // a running journey steers instead
        }
      } else if (el >= a.mins * 60000) phase = "mirror-over";
      if (el - a.lastLog >= ARC_LOG_MS || !a.rows.length) {
        a.lastLog = el;
        const eeg = eegDataRef.current, b = eeg?.connected ? eeg.bands : null;
        const avg = k => b?.[k] ? +(((b[k].left_pct || 0) + (b[k].right_pct || 0)) / 2).toFixed(1) : null;
        const sel = stRef.current.sel, out = sel ? isOutsideId(sel.id) : false;
        let hemi = null;
        if (b) {
          const bal = ['gamma', 'beta', 'alpha', 'theta'].map(k => {
            const l = b[k]?.left_pct || 0, r = b[k]?.right_pct || 0;
            return (l + r) > 0.5 ? 0.5 + 0.5 * (r - l) / (l + r) : null;
          }).filter(v => v !== null);
          if (bal.length) hemi = +(bal.reduce((x, v) => x + v, 0) / bal.length).toFixed(3);
        }
        a.rows.push({
          t_s: Math.round(el / 1000), phase,
          lead_target: lead === null ? null : +lead.toFixed(3),
          brain_target: brain === null ? null : +brain.toFixed(3),
          scale_id: sel?.id ?? null,
          scale_name: sel ? (KNOWN[sel.pattern] || customNamesRef.current[sel.pattern] || sel.id) : null,
          scale_brightness: sel && !out ? +normalizedBrightness(sel.pattern).toFixed(3) : null,
          dominant: b ? eeg.derived?.dominant_active_band ?? null : null,
          alpha_pct: avg('alpha'), theta_pct: avg('theta'), beta_pct: avg('beta'), gamma_pct: avg('gamma'),
          relaxation_index: b ? eeg.derived?.relaxation_index ?? null : null,
          hemi_balance: hemi,
        });
      }
    }, 1000);
    return () => clearInterval(id);
  }, [arc]);

  // Journey clock: while Auto plays a journey, update its values and the
  // brightness target once a second; on arrival either hold or (recording) end
  useEffect(() => {
    if (!autoOn || journey === "off") {
      if (journeyRef.current) { journeyRef.current = null; setJourneyNow(null); if (!arcRef.current) setLeadTarget(null); }
      // Stopped by hand during the ending fade: cancel it and bring the level back
      if (endTimersRef.current.length) {
        endTimersRef.current.forEach(clearTimeout); endTimersRef.current = [];
        const ac = getCtx(), g = ac.__masterTap?.gain;
        if (g) { g.cancelScheduledValues(ac.currentTime); g.setValueAtTime(0.82, ac.currentTime); }
      }
      return;
    }
    const j = JOURNEYS[journey];
    // Changing only the length keeps the clock running; a new journey starts over
    if (!journeyRef.current || journeyRef.current.id !== journey)
      journeyRef.current = { id: journey, startMs: Date.now(), homeBpm: j.bpm ?? stRef.current.bpm, arrived: false, ending: false };
    const J = journeyRef.current;
    J.mins = journeyMins;
    const tick = () => {
      if (journeyRef.current !== J || J.ending) return;
      const el = Date.now() - J.startMs;
      // Endless never arrives; f is just where it is in the drawn window
      const f = j.endless ? (el % ENDLESS_WINDOW) / ENDLESS_WINDOW : Math.min(1, el / (J.mins * 60000));
      J.vals = j.endless ? j.at(el) : journeyAt(j, f);
      setLeadTarget(J.vals.b);
      if (!j.endless && f >= 1 && !J.arrived) {
        J.arrived = true;
        if (recordingRef.current) endJourney(J, j);
      }
      setJourneyNow({ el, f, arrived: J.arrived, ending: J.ending, endless: !!j.endless });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOn, journey, journeyMins]);

  // Recorded journeys end the piece: settle on the home scale for a couple of
  // bars, fade the master out over 10 s, save the WAV, stop, restore the level
  const endTimersRef = useRef([]);
  const endJourney = (J, j) => {
    const timers = endTimersRef.current;
    J.ending = true;
    const fam = FAMILIES.find(fm => !fm.outside && fm.modes.includes(j.home));
    if (fam) pick(fam, fam.modes.indexOf(j.home), j.home);
    setLeadTarget(normalizedBrightness(j.home));
    setLoopOn(true);   // Auto stops picking
    const ac = getCtx(), g = ac.__masterTap?.gain;
    const settle = Math.max(4, 480 / stRef.current.bpm);
    timers.push(setTimeout(() => {
      if (g) { g.cancelScheduledValues(ac.currentTime); g.setValueAtTime(g.value, ac.currentTime); g.linearRampToValueAtTime(0, ac.currentTime + 10); }
      timers.push(setTimeout(() => {
        endTimersRef.current = [];
        if (recordingRef.current) toggleRecRef.current?.();
        journeyRef.current = null; setJourneyNow(null);
        setAutoOn(false); setArpOn(false); setLoopOn(false); setDroneOn(false);
        overrideTargetRef.current = null; setOverrideTarget(null);
        if (g) setTimeout(() => { g.cancelScheduledValues(ac.currentTime); g.setValueAtTime(0, ac.currentTime); g.linearRampToValueAtTime(0.82, ac.currentTime + 0.5); }, 1500);
      }, 10500));
    }, settle * 1000));
    setJourneyNow(p => p && { ...p, ending: true });
  };

  // Sleep timer: counts from ▶ (or from changing it while playing). Over the
  // last SLEEP_FADE s the master eases down to silence, then everything stops
  // (a running recording is saved). The ending timer in endTimersRef holds
  // off the context swap so the fresh context doesn't come back at full level.
  useEffect(() => {
    if (!autoOn || !sleepMins || journey === "off") { setSleepLeft(null); return; }
    const end = Date.now() + sleepMins * 60000;
    let fading = null;
    const tick = () => {
      const left = end - Date.now();
      setSleepLeft(Math.max(0, left));
      if (left <= SLEEP_FADE * 1000 && !fading) {
        const ac = getCtx(), g = ac.__masterTap?.gain;
        fading = { ac, g, id: setTimeout(() => {}, left + 5000) };
        endTimersRef.current.push(fading.id);
        if (g) { g.cancelScheduledValues(ac.currentTime); g.setValueAtTime(g.value, ac.currentTime); g.setTargetAtTime(0, ac.currentTime, Math.max(1, left / 1000) / 4); }
      }
      if (left <= 0) {
        clearInterval(id);
        endTimersRef.current = [];
        if (recordingRef.current) toggleRecRef.current?.();
        stopAuto(); setDroneOn(false);
        const g = fading?.g, ac = fading?.ac;
        fading = null;
        if (g) setTimeout(() => { g.cancelScheduledValues(ac.currentTime); g.setValueAtTime(0, ac.currentTime); g.linearRampToValueAtTime(0.82, ac.currentTime + 0.5); }, 10000);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      clearInterval(id);
      // Changed or stopped mid-fade: bring the level back
      if (fading) {
        endTimersRef.current = endTimersRef.current.filter(t => t !== fading.id);
        const { g, ac } = fading;
        if (g) { g.cancelScheduledValues(ac.currentTime); g.setValueAtTime(g.value, ac.currentTime); g.linearRampToValueAtTime(0.82, ac.currentTime + 2); }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOn, sleepMins, journey]);

  // Stopping Auto / Claude ends the session and saves its log
  useEffect(() => { if (!autoOn && !demoOn && arcRef.current) stopArc(); }, [autoOn, demoOn]);
  useEffect(() => { demoLogRef.current = demoLog; }, [demoLog]);
  // EEG proxy polling — always on so brainwave indicator works outside demo mode too
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch("http://localhost:8520/eeg");
        if (res.ok) setEegData(await res.json());
        else setEegData(null);
      } catch { setEegData(null); }
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, []);
  const analyserRef  = useRef(null);
  // Sleep tone (Endless): the line goes through a low-pass before its reverb
  // and delay sends, so the notes, echoes and tail are all soft
  // Lead bus (when no orchestra or sleep bus takes the lead): softened (-6 dB
  // above 3 kHz, a gentle low-pass at 5.5 kHz), a little less dry and more of
  // it in the reverb, so the line sits back in the room
  const leadSoftRef = useRef(null);
  const getLeadSoft = (ac) => {
    if (leadSoftRef.current && leadSoftRef.current.ac === ac) return leadSoftRef.current;
    const input = ac.createGain(), shelf = ac.createBiquadFilter(), lp = ac.createBiquadFilter(), dry = ac.createGain(), send = ac.createGain();
    shelf.type = "highshelf"; shelf.frequency.value = 3000; shelf.gain.value = -6;
    lp.type = "lowpass"; lp.frequency.value = 5500; lp.Q.value = 0.5;
    dry.gain.value = 0.85; send.gain.value = 1.4;
    input.connect(shelf); shelf.connect(lp); lp.connect(dry); dry.connect(masterOut(ac));
    lp.connect(send); send.connect(getOrCreateReverb(ac).convolver);
    leadSoftRef.current = { ac, input };
    return leadSoftRef.current;
  };
  const darkRef = useRef(null);
  const getDark = (ac) => {
    if (darkRef.current && darkRef.current.ac === ac) return darkRef.current;
    const input = ac.createGain();
    const lp = ac.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 1100; lp.Q.value = 0.5;
    input.connect(lp); lp.connect(masterOut(ac));
    lp.connect(getOrCreateReverb(ac).convolver);
    const toDelay = ac.createGain(); toDelay.gain.value = 1;
    lp.connect(toDelay); toDelay.connect(getOrCreateDelay(ac).delayNode);
    darkRef.current = { ac, input };
    return darkRef.current;
  };
  const getOrCreateAnalyser = useCallback((ac) => {
    if (analyserRef.current && analyserRef.current.ac === ac) return analyserRef.current;
    const node = ac.createAnalyser();
    node.fftSize = 2048;
    node.smoothingTimeConstant = 0.85;
    analyserRef.current = { node, ac };
    return analyserRef.current;
  }, []);
  const [favs,       setFavs]       = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("chloe2-favs") || "[]")); }
    catch { return new Set(); }
  }); // Set of "fam.id.mi" strings
  const [favsOnly,   setFavsOnly]   = useState(false);
  const [customNames, setCustomNames] = useState(() => {
    try { return JSON.parse(localStorage.getItem("chloe-custom-names") || "{}"); }
    catch { return {}; }
  }); // { [pattern decimal]: "name" }
  const [editingName,  setEditingName]  = useState(null); // pattern decimal currently being named
  const [nameInput,    setNameInput]    = useState("");
  const [demoAllScales, setDemoAllScales] = useState(true);
  const [pinnedScale,   setPinnedScale]   = useState(null); // { id, pattern } — A/B comparison B side
  const [prePinSel,     setPrePinSel]     = useState(null); // { id, pattern } — A/B comparison A side
  const [listSearch,    setListSearch]    = useState("");   // sidebar name search
  const [noteCountFilter, setNoteCountFilter] = useState(null); // null | 3-8
  const [showDiatonic,  setShowDiatonic]  = useState(false); // show diatonic neighborhood annotations
  const showDiatonicRef = useRef(false);
  useEffect(() => { showDiatonicRef.current = showDiatonic; }, [showDiatonic]);
  // Settings unticked in the Auto ⚙ panel travel in shared links as al=bpm,rootNote,...
  const [autoLocks, setAutoLocks] = useState(() => {
    const off = (_u.autoOff || "").split(",").filter(k => k in AUTO_LOCKS_DEFAULT);
    const on  = (_u.autoOn  || "").split(",").filter(k => k in AUTO_LOCKS_DEFAULT);
    return { ...AUTO_LOCKS_DEFAULT, ...Object.fromEntries(off.map(k => [k, false])), ...Object.fromEntries(on.map(k => [k, true])) };
  });
  const autoLocksRef = useRef(AUTO_LOCKS_DEFAULT);
  useEffect(() => { autoLocksRef.current = autoLocks; }, [autoLocks]);
  const [showAutoLocks, setShowAutoLocks] = useState(false);
  const customNamesRef = useRef({});
  useEffect(() => { customNamesRef.current = customNames; }, [customNames]);
  const demoAllScalesRef = useRef(true);
  useEffect(() => { demoAllScalesRef.current = demoAllScales; }, [demoAllScales]);
  const selRowRef = useRef(null);

  // When Auto/Demo changes the scale, expand its group and scroll to it in the sidebar
  useEffect(() => {
    if (!(autoOn || demoOn) || !sel) return;
    const famId = sel.id.slice(0, sel.id.lastIndexOf("."));
    const fam = FAMILIES.find(f => f.id === famId);
    if (fam) setExpanded(p => { const s = new Set(p); s.add(grpKey(fam)); return s; });
    // Small delay so the row has rendered before scrolling
    setTimeout(() => selRowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 80);
  }, [sel, autoOn, demoOn]);
  const [theme,      setTheme]      = useState(() => localStorage.getItem("chloe-theme") || "dark");
  const [centerTab,  setCenterTab]  = useState("viz");
  const dragRef = useRef(null); // { startX, startW }

  const K = theme === "dark" ? DARK_K : LIGHT_K;

  // Restore sel from URL once FAMILIES is available
  useEffect(() => {
    if (!_u.selId) return;
    const [famId, miStr] = _u.selId.split(".");
    const fam = FAMILIES.find(f => f.id === famId);
    if (fam) {
      const mi = parseInt(miStr ?? "0");
      if (fam.modes[mi] !== undefined) setSel({ id: _u.selId, pattern: fam.modes[mi] });
    }
  }, [FAMILIES]);

  const ctxRef     = useRef(null);
  const reverbRef  = useRef(null); // { convolver, wetGain }
  const delayRef   = useRef(null); // { delayNode, feedbackGain, wetGain }
  const noteCountRef = useRef(0);  // tracks nodes created; used to recycle AudioContext
  const RECYCLE_THRESHOLD = 500;   // recycle AudioContext after this many notes
  const [recycleGen, setRecycleGen] = useState(0); // incremented to trigger drone/arp restart after context recycle
  const arpRef      = useRef(null);
  const playGridRef  = useRef(null); // { startTime, bpm } set when arp starts; used by beat to sync
  const arpIdxRef   = useRef(0);
  const rhythmIdxRef = useRef(0);
  const melPrevRef  = useRef(0);
  const pendingSelRef = useRef(null);  // pending scale transition
  const pendingSelTimeRef = useRef(0); // when the pending scale was requested
  const stRef      = useRef({ rootIdx, timbre, bpm, sel, melMode, arpDir, arpOct, grouping, blend, tempoGlide, soundBlend, tuning, autoTempo, symphonic, beatStyle, rhythm, chordVoice, instrument, noteVol, reverbAmt, delayAmt, sustainMult, aRef, beatVol, droneWave });
  useEffect(() => { stRef.current = { rootIdx, timbre, bpm, sel, melMode, arpDir, arpOct, grouping, blend, tempoGlide, soundBlend, tuning, autoTempo, symphonic, beatStyle, rhythm, chordVoice, instrument, noteVol, reverbAmt, delayAmt, delayTime, sustainMult, aRef, beatVol, droneWave, droneOn, beatWander }; }, [rootIdx, timbre, bpm, sel, melMode, arpDir, arpOct, grouping, blend, tempoGlide, soundBlend, tuning, autoTempo, symphonic, beatStyle, rhythm, chordVoice, instrument, noteVol, reverbAmt, delayAmt, delayTime, sustainMult, aRef, beatVol, droneWave, droneOn, beatWander]);
  useEffect(() => { try { localStorage.setItem("chloe-saved-moments", JSON.stringify(savedMoments)); } catch {} }, [savedMoments]);
  useEffect(() => { try { localStorage.setItem("chloe-custom-names", JSON.stringify(customNames)); } catch {} }, [customNames]);

  const getCtx = useCallback(() => {
    if (!ctxRef.current || ctxRef.current.state === "closed") {
      ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      recordingRef.current?.rec.attach(ctxRef.current);   // a take runs on across the swap
    }
    if (ctxRef.current.state === "suspended") ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  const getOrCreateReverb = useCallback((ac) => {
    if (reverbRef.current && reverbRef.current.ac === ac) return reverbRef.current;
    const convolver = ac.createConvolver();
    convolver.buffer = makeImpulse(ac, 2.8, 3.0);
    const wetGain = ac.createGain();
    wetGain.gain.value = stRef.current.reverbAmt;
    convolver.connect(wetGain); wetGain.connect(masterOut(ac));
    reverbRef.current = { convolver, wetGain, ac };
    return reverbRef.current;
  }, []);

  // Orchestra: free MusyngKite samples (gleitz/midi-js-soundfonts, ~3 MB each),
  // loaded once on first use. Its bus feeds the master limiter and the reverb.
  const getOrchestra = useCallback((ac) => {
    if (orchRef.current && orchRef.current.ac === ac) return orchRef.current;
    // Dry signal low, most of the sound from its own cathedral reverb
    const bus = ac.createGain(); bus.gain.value = 0.65;  // up from 0.5: the swell averages below 1
    const dry = ac.createGain(); dry.gain.value = 0.3;
    const hall = ac.createConvolver(); hall.buffer = makeHall(ac);
    const wet = ac.createGain(); wet.gain.value = 1.4 * stRef.current.reverbAmt;
    bus.connect(dry); dry.connect(masterOut(ac));
    bus.connect(hall); hall.connect(wet); wet.connect(masterOut(ac));
    // Strings get their own gain so each chord can swell in and out
    const swell = ac.createGain(); swell.gain.value = 0.5; swell.connect(bus);
    const strings = Soundfont(ac, { instrument: "string_ensemble_1", destination: swell });
    // Bass has loop points (goldst.dev), so it sustains; the strings have none
    const bass = Soundfont(ac, { instrument: "contrabass", destination: bus, loadLoopData: true });
    // Low strings ostinato + orchestra drums
    const cello = Soundfont(ac, { instrument: "cello", destination: bus });
    const drums = ac.createGain(); drums.gain.value = 0.8; drums.connect(bus);
    const timpani = Soundfont(ac, { instrument: "timpani", destination: drums });
    const taiko = Soundfont(ac, { instrument: "taiko_drum", destination: drums });
    // Fast licks woven through: violin and flute runs and turns
    const violin = Soundfont(ac, { instrument: "violin", destination: bus });
    const flute = Soundfont(ac, { instrument: "flute", destination: bus });
    setOrchLoading(true);
    Promise.all([strings.ready, bass.ready, cello.ready, timpani.ready, taiko.ready, violin.ready, flute.ready]).finally(() => {
      setOrchLoading(false);
      // March section (brass, tuba, orchestra hit) loads afterwards in the background
      const o = orchRef.current;
      if (!o || o.ac !== ac || o.brass) return;
      const brass = Soundfont(ac, { instrument: "brass_section", destination: bus });
      const tuba = Soundfont(ac, { instrument: "tuba", destination: bus });
      const hit = Soundfont(ac, { instrument: "orchestra_hit", destination: drums });
      Promise.all([brass.ready, tuba.ready, hit.ready]).then(() => {
        Object.assign(o, { brass, tuba, hit });
        o.all.push(brass, tuba, hit);
      });
    });
    // Lead bus: with the orchestra on, Chloe's own line is softened (low-pass,
    // a little quieter) and sent into the same cathedral so it sits in the room
    const lead = ac.createGain(); lead.gain.value = 0.8;
    const leadLp = ac.createBiquadFilter(); leadLp.type = "lowpass"; leadLp.frequency.value = 1600; leadLp.Q.value = 0.5;
    const leadSend = ac.createGain(); leadSend.gain.value = 0.5;
    lead.connect(leadLp); leadLp.connect(masterOut(ac)); leadLp.connect(leadSend); leadSend.connect(hall);
    orchRef.current = { ac, bus, wet, swell, lead, strings, bass, cello, timpani, taiko, violin, flute, all: [strings, bass, cello, timpani, taiko, violin, flute] };
    return orchRef.current;
  }, [getOrCreateReverb]);

  // Drum kit: LinnDrum samples → compressor (punch) → limiter, snare also into
  // the orchestra's cathedral when it exists, otherwise the main reverb
  const getKit = useCallback((ac) => {
    if (kitRef.current && kitRef.current.ac === ac) return kitRef.current;
    const inGain = ac.createGain(); inGain.gain.value = 0.9;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -20; comp.ratio.value = 4; comp.knee.value = 6;
    comp.attack.value = 0.006; comp.release.value = 0.12;
    const vol = ac.createGain(); vol.gain.value = stRef.current.beatVol ?? 1;
    // fade / fadeRoom: the beat's fade in and out (Smooth), dry and reverb send together
    const fade = ac.createGain(), fadeRoom = ac.createGain();
    // Distance (setBeatDistance): darker (low-pass), less dry, more of it in the
    // reverb and a little in the delay, so the drums sit far back in the room
    const tone = ac.createBiquadFilter(); tone.type = "lowpass"; tone.Q.value = 0.5; tone.frequency.value = 18000;
    const dry = ac.createGain(), farSend = ac.createGain(), farDelay = ac.createGain();
    dry.gain.value = 1; farSend.gain.value = 0; farDelay.gain.value = 0;
    inGain.connect(comp); comp.connect(vol); vol.connect(tone);
    tone.connect(dry); dry.connect(fade); fade.connect(masterOut(ac));
    tone.connect(farSend); farSend.connect(fadeRoom);
    fade.connect(farDelay); farDelay.connect(getOrCreateDelay(ac).delayNode);
    const roomSend = ac.createGain(); roomSend.gain.value = 0.35;
    roomSend.connect(fadeRoom); fadeRoom.connect(getOrCreateReverb(ac).convolver);
    const kit = DrumMachine(ac, { instrument: "LM-2", destination: inGain });
    const snareKit = DrumMachine(ac, { instrument: "LM-2", destination: roomSend });
    kitRef.current = { ac, kit, snareKit, vol, roomSend, fade, fadeRoom, tone, dry, farSend, farDelay, dist: 0 };
    return kitRef.current;
  // getOrCreateDelay is defined below and stable ([] deps); listing it here would hit it before it exists
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getOrCreateReverb]);
  // 0 = up close (as recorded) .. 1 = far away: low-pass 18 kHz → 1.8 kHz,
  // dry 1 → 0.3, reverb send 0 → 1.2, delay send 0 → 0.35. Eases over ~3 s.
  const setBeatDistance = (k, d) => {
    if (Math.abs(k.dist - d) < 0.01) return;
    k.dist = d;
    const now = k.ac.currentTime, to = (p, v) => { p.cancelScheduledValues(now); p.setTargetAtTime(v, now, 1); };
    to(k.tone.frequency, 18000 * Math.pow(0.1, d));
    to(k.dry.gain, 1 - 0.7 * d);
    to(k.farSend.gain, 1.2 * d);
    to(k.farDelay.gain, 0.35 * d);
  };
  useEffect(() => { if (kitRef.current) kitRef.current.vol.gain.value = beatVol; }, [beatVol]);
  useEffect(() => { if (beatStyle !== "off" && ctxRef.current) getKit(ctxRef.current); }, [beatStyle, getKit]);

  // Start the download as soon as Symphonic is switched on
  // and let the strings fade out at once when it's switched off
  useEffect(() => {
    if (symphonic && ctxRef.current) getOrchestra(ctxRef.current);
    if (!symphonic && orchRef.current) orchRef.current.all.forEach(i => i.stop());
  }, [symphonic, getOrchestra]);

  // Keep reverb wet gain in sync with reverbAmt slider
  useEffect(() => {
    if (reverbRef.current) glideParam(reverbRef.current.wetGain.gain, reverbAmt);
    if (orchRef.current) orchRef.current.wet.gain.value = 1.4 * reverbAmt;
  }, [reverbAmt]);

  const getOrCreateDelay = useCallback((ac) => {
    if (delayRef.current && delayRef.current.ac === ac) return delayRef.current;
    const delayNode = ac.createDelay(2.0);
    delayNode.delayTime.value = stRef.current.delayTime ?? 0.375;
    const feedbackGain = ac.createGain();
    feedbackGain.gain.value = journeyRef.current?.vals?.fb ?? 0.4;
    const wetGain = ac.createGain();
    wetGain.gain.value = stRef.current.delayAmt;
    delayNode.connect(feedbackGain);
    feedbackGain.connect(delayNode);
    delayNode.connect(wetGain);
    wetGain.connect(masterOut(ac));
    delayRef.current = { delayNode, feedbackGain, wetGain, ac };
    return delayRef.current;
  }, []);

  // Periodic AudioContext recycler — Firefox retains AudioNodes in the context graph even after
  // disconnect() until the context is closed. Recycle every 2 minutes to prevent accumulation.
  useEffect(() => {
    const id = setInterval(() => {
      // Not during a journey's ending fade: the fresh context would start at full level
      if (!ctxRef.current || endTimersRef.current.length) return;
      const old = ctxRef.current;
      ctxRef.current = null;
      reverbRef.current = null;
      delayRef.current = null;
      analyserRef.current = null;
      noteCountRef.current = 0;
      // Let the old context ring out (reverb, delay, held bass notes) before closing it
      setTimeout(() => { try { old.close(); } catch {} }, 15000);
      swapAtRef.current = Date.now();
      setRecycleGen(g => g + 1); // triggers drone to restart on fresh context
    }, 120000); // every 2 minutes
    return () => clearInterval(id);
  }, []);

  // Keep delay wet gain in sync with delayAmt slider
  useEffect(() => {
    if (delayRef.current) glideParam(delayRef.current.wetGain.gain, delayAmt);
  }, [delayAmt]);

  // Keep delay time in sync with delayTime slider
  useEffect(() => {
    if (delayRef.current) delayRef.current.delayNode.delayTime.value = delayTime;
  }, [delayTime]);

  const noteFreq = (semi, ri) => aRef * 2 ** ((60 + OFFS[ri] - 69) / 12) * tunedRatio(semi, tuning);

  /* ── Drone ── */
  useEffect(() => {
    if (!droneOn) return;
    const ac = getCtx();
    const rev = getOrCreateReverb(ac);
    const del = getOrCreateDelay(ac);
    const an = getOrCreateAnalyser(ac);
    const f = ac.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 200 * Math.pow(40, droneTone);
    droneFilterRef.current = f;
    const dFreq = aRef * 2 ** ((60 + OFFS[rootIdx] + droneOct - 69) / 12);
    const voice = synthDrone(ac, dFreq, droneWave, {
      scale: () => toSemis(stRef.current.sel?.pattern || 0),
      bpm: () => stRef.current.bpm,
      stepHook: beatStepHookRef,
    });
    droneVoiceRef.current = voice;
    droneFreqRef.current = dFreq;
    const volGain = ac.createGain();
    // Smooth (under Auto/Claude): the drone fades in and out over up to 6 s.
    // Across a context swap the old and new drones crossfade over 3 s.
    const swapped = Date.now() - swapAtRef.current < 2000, SWAP_FADE = 3;
    const smoothFade = () => autoOnRef.current || demoOnRef.current ? 6 * smoothRef.current : 0;
    volGain.gain.setValueAtTime(0, ac.currentTime);
    volGain.gain.linearRampToValueAtTime(droneVol, ac.currentTime + (swapped ? SWAP_FADE : 0.08 + smoothFade()));
    droneGainRef.current = volGain;
    voice.node.connect(f); f.connect(volGain);
    if (voice.bright) voice.bright.connect(volGain);   // whistle / mouth: past the tone filter
    volGain.connect(masterOut(ac)); volGain.connect(rev.convolver); volGain.connect(del.delayNode); volGain.connect(an.node);
    return () => {
      const now = ac.currentTime, out = ctxRef.current === ac ? 0.08 + smoothFade() : SWAP_FADE;
      volGain.gain.cancelScheduledValues(now);
      volGain.gain.setValueAtTime(volGain.gain.value, now);
      volGain.gain.linearRampToValueAtTime(0, now + out);
      droneGainRef.current = null; droneFilterRef.current = null;
      droneVoiceRef.current = null; droneFreqRef.current = 0;
      setTimeout(() => {
        try { voice.stop(); } catch {}
        try { f.disconnect(); } catch {}
        try { volGain.disconnect(); } catch {}
      }, out * 1000 + 20);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droneOn, droneWave, aRef, recycleGen, getCtx, getOrCreateReverb, getOrCreateDelay, getOrCreateAnalyser]);

  // Glide drone frequency smoothly when root or octave changes
  useEffect(() => {
    const voice = droneVoiceRef.current;
    if (!voice || !voice.oscs.length) return;
    const ac = voice.oscs[0].context;
    const newFreq = aRef * 2 ** ((60 + OFFS[rootIdx] + droneOct - 69) / 12);
    const oldFreq = droneFreqRef.current;
    if (oldFreq <= 0 || newFreq === oldFreq) return;
    const ratio = newFreq / oldFreq;
    const now = ac.currentTime;
    const glideTime = 0.3 + 2.7 * smoothRef.current; // 300 ms, up to 3 s with Smooth
    if (voice.setFreq) voice.setFreq(ratio, glideTime);
    else for (const osc of voice.oscs) {
      const curFreq = osc.frequency.value;
      osc.frequency.cancelScheduledValues(now);
      osc.frequency.setValueAtTime(curFreq, now);
      osc.frequency.exponentialRampToValueAtTime(curFreq * ratio, now + glideTime);
    }
    droneFreqRef.current = newFreq;
  }, [rootIdx, droneOct, aRef]);

  // Keep drone volume in sync with droneVol slider
  useEffect(() => {
    if (droneGainRef.current) glideParam(droneGainRef.current.gain, droneVol);
  }, [droneVol]);

  // Keep drone tone in sync with droneTone slider
  useEffect(() => {
    if (droneFilterRef.current) droneFilterRef.current.frequency.value = 200 * Math.pow(40, droneTone);
  }, [droneTone]);

  /* ── Beat ── */
  useEffect(() => {
    if (!beatOn) return;
    beatStepRef.current = 0;
    let cancelled = false;
    const ac = getCtx();

    // If arp is running, snap first beat to the next sub-beat boundary of the arp grid
    // so they stay phase-locked automatically.
    const grid = playGridRef.current;
    let nextTickTime; // AudioContext seconds
    if (grid) {
      const { rhythm: patKey, bpm: gridBpm } = stRef.current;
      const pat = BEAT_PATTERNS[patKey] ?? BEAT_PATTERNS.even;
      const subSec = pat.sub * (60 / gridBpm); // duration of one beat step
      const elapsed = ac.currentTime - grid.startTime;
      const stepsSinceStart = elapsed / subSec;
      const nextStep = Math.ceil(stepsSinceStart + 0.01); // +epsilon avoids snapping to current step if exactly on boundary
      nextTickTime = grid.startTime + nextStep * subSec;
    } else {
      nextTickTime = ac.currentTime;
    }

    const tick = () => {
      if (cancelled) return;
      const { bpm, beatVol: vol, rhythm: patKey } = stRef.current;
      const pat = BEAT_PATTERNS[patKey] ?? BEAT_PATTERNS.even;
      const step = beatStepRef.current % pat.loop.length;
      const [k, s, h] = pat.loop[step];
      const an = getOrCreateAnalyser(ac);
      if (k) synthKick(ac, vol, an.node);
      if (s) synthSnare(ac, vol, an.node);
      if (h) synthHat(ac, vol, an.node);
      beatStepRef.current++;
      // Self-correcting: advance scheduled time rather than relying on setTimeout precision
      const stepSec = pat.sub * (60 / bpm) * (step % 2 === 1 ? (1 - pat.sw) : (1 + pat.sw));
      nextTickTime += stepSec;
      const delayMs = Math.max(0, (nextTickTime - ac.currentTime) * 1000);
      beatTimeout.current = setTimeout(tick, delayMs);
    };

    const initialDelay = Math.max(0, (nextTickTime - ac.currentTime) * 1000);
    beatTimeout.current = setTimeout(tick, initialDelay);
    return () => { cancelled = true; clearTimeout(beatTimeout.current); };
  }, [beatOn, getCtx, getOrCreateAnalyser]);

  /* ── Arpeggio / Melody ── */
  useEffect(() => {
    clearInterval(arpRef.current);
    setPlaying(null);
    if (!arpOn || !stRef.current.sel) { playGridRef.current = null; return; }

    // Recycle AudioContext periodically to prevent Chrome node accumulation leak
    if (noteCountRef.current > RECYCLE_THRESHOLD) {
      const old = ctxRef.current;
      ctxRef.current = null;
      reverbRef.current = null;
      delayRef.current = null;
      analyserRef.current = null;
      noteCountRef.current = 0;
      if (old) setTimeout(() => { try { old.close(); } catch {} }, 2000);
    }

    // Record grid epoch so the beat can snap to this clock
    const _ac0 = getCtx();
    playGridRef.current = { startTime: _ac0.currentTime, bpm: stRef.current.bpm };
    arpIdxRef.current = 0;
    rhythmIdxRef.current = 0;
    melPrevRef.current = 0;
    // Grouping state: position inside the current group, the group's starting
    // scale degree, the melody motif (degree offsets) and how many more times
    // it is sequenced before a new one is drawn. tick counts every grouped note
    // so the pulse accent lands on every 4th one regardless of the group size.
    // Blend state: the pitch classes actually sounding (absolute, C = 0), the
    // set being moved toward, the planned steps, and notes left until the next
    const mo = { cur: null, key: "", steps: [], every: 8, wait: 0 };
    // Tempo glide: the BPM actually played eases from `from` to `to` in log
    // space (equal ratios feel like equal steps), 12 s per octave of change,
    // 4-30 s (up to twice that with Smooth), smoothstep-shaped. A new target
    // mid-glide starts from where it is.
    const tg = { cur: null, from: 0, to: 0, t0: 0, dur: 0 };
    // Sound crossfade: while blending, each note plays on both the old and new sound
    const sbDur = () => 4000 + 8000 * smoothRef.current;   // 4 s, up to 12 s with Smooth
    const sb = { from: null, to: null, t0: 0 };
    const playBpm = () => {
      const { bpm: target, tempoGlide: on } = stRef.current;
      const now = performance.now();
      if (!on || tg.cur === null) { tg.cur = tg.from = tg.to = target; tg.dur = 0; return target; }
      if (target !== tg.to && tempoSnapRef.current) {
        tempoSnapRef.current = false;
        tg.cur = tg.from = tg.to = target; tg.dur = 0;
        return target;
      }
      if (target !== tg.to) {
        tg.from = tg.cur; tg.to = target; tg.t0 = now;
        tg.dur = 1000 * (1 + smoothRef.current) * Math.max(4, Math.min(30, 12 * Math.abs(Math.log2(target / tg.from))));
      }
      const x = tg.dur ? Math.min(1, (now - tg.t0) / tg.dur) : 1;
      const e = x * x * (3 - 2 * x);
      tg.cur = tg.from * Math.pow(tg.to / tg.from, e);
      return tg.cur;
    };
    const pcsOf = (pattern, root) => toSemis(pattern).map(x => (x + root) % 12);
    const grp = { pos: 0, start: 0, dir: 1, motif: null, cur: null, size: 0, left: 0, tick: 0, G: 0, pat: null, pi: 0, reps: 0 };

    // Rhythm subdivisions: multiples of one 8th note (60000/bpm/2 ms)
    // values: 1=8th, 2=quarter, 3=dotted quarter, 4=half
    const RHYTHMS = [1, 1, 1, 2, 2, 2, 3, 4];

    // Weighted random walk: bias toward stepwise motion (+/-1,2 scale steps)
    const pickMelNote = (notes) => {
      const prev = melPrevRef.current;
      const n = notes.length;
      // Build weights: higher for nearby notes (step/skip), lower for leaps
      const weights = notes.map((_, i) => {
        const dist = Math.abs(i - prev);
        if (dist === 0) return 0.4;   // repeat same note
        if (dist === 1) return 3.0;   // step
        if (dist === 2) return 2.0;   // skip
        if (dist === 3) return 1.0;   // small leap
        return 0.3;                   // big leap (rare)
      });
      // Occasionally jump to a different octave (upper neighbour)
      const total = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * total, idx = 0;
      for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) { idx = i; break; } }
      melPrevRef.current = idx;
      // 20% chance of playing an octave higher — only when using single octave
      const octShift = (stRef.current.arpOct || 1) === 1 && Math.random() < 0.2 ? 12 : 0;
      return notes[idx] + octShift;
    };

    // For melody mode, we schedule with variable intervals using setTimeout chains
    let melTimeout = null;

    // Symphonic layer: every few seconds (1-4 bars, ~5 s) strings hold a triad
    // stacked from the scale and the double bass plays its root. Chords move by
    // 4ths/5ths in scale steps with a pull home. Uses the notes the line is
    // playing (blend-aware) and the current tuning.
    let orchT = null, orchDeg = 0, lastBase = null, orchKey = null, rollIn = false;
    // Energy 0 (calm) .. 1 (urgent), driven by how dissonant the sounding notes
    // are, plus a push while a blend is morphing between scales. Rises fast,
    // settles slowly; when it falls back after a peak the orchestra resolves home.
    let energy = 0, peakE = 0, lastMarch = -1e9;

    // March: 2-4 bars of dark martial orchestra (in the spirit of a film-score
    // villain march, not any actual tune). Low strings + tuba chug 8ths on the
    // root, brass stabs the scale's home triad with a pickup into each bar,
    // drums on the downbeats, and a final crunch stab (with a soft orchestra hit) that
    // adds the note a half step above the root when the scale has one.
    const playMarch = (o, ac, st, b, semiOf, rootMidi, tune) => {
      const beat = 60 / b, barSec = 4 * beat;
      const bars = 2 + Math.floor(Math.random() * 3);
      const t0 = ac.currentTime + 0.02, end = t0 + bars * barSec;
      const R = semiOf(0), T3 = semiOf(2), F5 = semiOf(4);
      const chord = [R - 12, T3 - 12, F5 - 12, R];
      const crunch = lastBase.includes(1) ? [R - 12, 1 - 12, F5 - 12, 1] : chord;
      const lowN = n => (rootMidi + n - 12 >= 28 ? n - 12 : n);
      o.swell.gain.cancelScheduledValues(t0);
      o.swell.gain.setValueAtTime(o.swell.gain.value, t0);
      o.swell.gain.linearRampToValueAtTime(0.25, t0 + 0.3);           // strings step back
      for (let tc = t0, i = 0; tc < end - 0.02; tc += beat / 2, i++) { // chug
        const acc = i % 4 === 0 ? 100 : 72;
        const sb = lowN(R - 24);
        o.cello.start({ note: rootMidi + R - 24, velocity: acc, time: tc, duration: beat * 0.4, detune: tune(R - 24) });
        o.tuba.start({ note: rootMidi + sb, velocity: acc - 8, time: tc, duration: beat * 0.42, detune: tune(sb) });
      }
      for (let bar = 0; bar < bars; bar++) {
        const tb = t0 + bar * barSec, last = bar === bars - 1;
        const stab = (notes, t, dur, vel) => notes.forEach(n => o.brass.start({ note: rootMidi + n, velocity: vel, time: t, duration: dur, detune: tune(n) }));
        stab(chord, tb, beat * 1.4, 110);                                 // beat 1, long
        stab(chord, tb + 2 * beat, beat * 0.5, 100);                      // beat 3, short
        if (!last) stab(chord, tb + 3.5 * beat, beat * 0.4, 96);          // pickup into next bar
        else stab(crunch, tb + 3 * beat, beat * 1.6, 120);                // final crunch
        o.timpani.start({ note: Math.min(57, Math.max(38, rootMidi + R - 24)), velocity: 110, time: tb, detune: tune(R - 24) });
        o.timpani.start({ note: Math.min(57, Math.max(38, rootMidi + R - 24)), velocity: 95, time: tb + 2 * beat, detune: tune(R - 24) });
        o.taiko.start({ note: 40, velocity: 115, time: tb });
      }
      // One soft orchestra hit under the final crunch (two loud ones were too much)
      o.hit.start({ note: rootMidi + R - 12, velocity: 64, time: t0 + (bars - 1) * barSec + 3 * beat, detune: tune(R - 12) });
      o.swell.gain.linearRampToValueAtTime(0.4, end);
      return end - t0;
    };
    const updateEnergy = (base) => {
      const target = Math.min(1, tensionOf(base) * 0.9 + (mo.steps.length ? 0.4 : 0) + (journeyRef.current?.vals?.e ?? 0));
      energy += (target - energy) * (target > energy ? 0.25 : 0.04);
      energyRef.current = energy;
      peakE = Math.max(peakE, energy);
    };
    const orchTick = () => {
      let hold = 4;
      try {
        const st = stRef.current;
        const b = tg.cur ?? st.bpm;
        const barSec = 240 / b;
        hold = Math.max(1, Math.min(4, Math.round((5 - 2.5 * energy) / barSec))) * barSec;
        if (st.symphonic && st.sel && lastBase && lastBase.length >= 3) {
          const ac = getCtx();
          const o = getOrchestra(ac);
          const L = lastBase.length;
          // Rise marches more: every 30 s at most, likelier when the energy is up.
          // The calm journeys (dawn, dusk, descent, endless) never march: its
          // brass stabs and hits jar out of a wind-down; storm and free play can
          const jid = journeyRef.current?.id, epic = !!JOURNEYS[jid]?.epic;
          const marchNow = o.brass && ac.currentTime - lastMarch > (epic ? 30 : 45) && (!jid || epic || jid === "storm") &&
            ((energy > 0.6 && Math.random() < (epic ? 0.5 : 0.35)) || Math.random() < 0.07);
          const moves = [[0, 1], [3, 3], [4, 3], [5, 1.5], [1, 1], [L - 1, 1]];
          let r = Math.random() * moves.reduce((a, m) => a + m[1], 0), next = orchDeg;
          for (const [d, w] of moves) { if ((r -= w) < 0) { next = d === 0 ? 0 : (orchDeg + d) % L; break; } }
          if (next === orchDeg) next = orchDeg === 0 ? 4 % L : 0;
          // Tension has drained after a peak: resolve to the home chord
          const resolve = peakE > 0.6 && energy < 0.35;
          if (resolve) { next = 0; peakE = 0; }
          orchDeg = next;
          const semiOf = k => lastBase[((k % L) + L) % L] + 12 * Math.floor(k / L);  // k may go below 0 (downward runs)
          const rootMidi = 60 + OFFS[st.rootIdx];
          const tune = semi => 1200 * Math.log2(tunedRatio(semi, st.tuning) * st.aRef / 440) - 100 * semi;
          if (marchNow) {
            lastMarch = ac.currentTime;
            // Auto with the beat ticked: the march brings in the heavy beat
            if (autoOnRef.current && autoLocksRef.current.beat && BEAT_FAMILY[st.beatStyle] === "kit" && st.beatStyle !== "heavy") setBeatStyle("heavy");
            orchDeg = 0;
            orchKey = st.sel.pattern + "@" + st.rootIdx;
            hold = playMarch(o, ac, st, b, semiOf, rootMidi, tune);
            orchT = setTimeout(orchTick, hold * 1000);
            return;
          }
          const t0 = ac.currentTime + 0.02;
          // The string samples are 3.16 s and stop dead, so long chords are
          // re-bowed: overlapping bows every 2.2 s, each fading as the next swells
          // Hairpin per chord: soft start, swell to a peak 35-70% of the way
          // through (height varies), ease back down as the next chord arrives
          const g = o.swell.gain;
          const peakAt = t0 + hold * (0.35 + Math.random() * 0.35);
          g.cancelScheduledValues(t0);
          g.setValueAtTime(Math.max(0.3, g.value), t0);
          g.linearRampToValueAtTime(resolve ? 1.35 : 0.75 + Math.random() * 0.45, peakAt);
          g.linearRampToValueAtTime(0.32 + Math.random() * 0.1, t0 + hold);
          const BOW = 2.2, end = t0 + hold + 0.15;
          for (let tb = t0; tb < end - 0.3; tb += BOW) {
            const dur = Math.min(2.6, end - tb);
            [0, 2, 4].forEach(k => {
              const semi = semiOf(orchDeg + k) - 12;
              o.strings.start({ note: rootMidi + semi, velocity: tb === t0 ? 70 : 62, time: tb, duration: dur, ampRelease: 0.5, detune: tune(semi) });
            });
          }
          const bassSemi = semiOf(orchDeg) - 24;
          // Double bass an octave deeper wherever it stays above its low E (28)
          const bassNote = rootMidi + bassSemi - 12 >= 28 ? rootMidi + bassSemi - 12 : rootMidi + bassSemi;
          o.bass.start({ note: bassNote, velocity: 85, time: t0, duration: hold * 0.95, loop: true, detune: tune(bassSemi) });

          // Cellos: driving low ostinato on the chord (root, fifth, octave) in
          // 8ths up to 120 BPM, quarters above; rests on about 1 chord in 5
          const beat = 60 / b;
          const R = semiOf(orchDeg), F = semiOf(orchDeg + 4), O = R + 12;
          // (tension doubles the pulse and it never rests)
          if (energy > 0.3 || Math.random() < 0.8) {
            const pat = [R, R, F, R, O, R, F, R];
            const step = (b <= 120 ? beat / 2 : beat) / (energy > 0.5 ? 2 : 1);
            for (let i = 0, tc = t0; tc < t0 + hold - 0.02; i++, tc += step) {
              const semi = pat[i % 8] - 24;
              o.cello.start({ note: rootMidi + semi, velocity: (i % 4 === 0 ? 80 : 58) + Math.round(12 * energy), time: tc, duration: step * 0.85, detune: tune(semi) });
            }
          }

          // Drums: timpani tuned to the chord root (kept in D2-A3), taiko for weight.
          // A new scale or key = a big boom; otherwise downbeat hits, and
          // sometimes a timpani roll into the next chord.
          const key = st.sel.pattern + "@" + st.rootIdx;
          const boom = orchKey !== null && key !== orchKey;
          orchKey = key;
          let tn = rootMidi + R - 24;
          while (tn < 38) tn += 12;
          while (tn > 57) tn -= 12;
          const tTune = tune(tn - rootMidi);
          if (boom || resolve) {
            o.timpani.start({ note: tn, velocity: 120, time: t0, detune: tTune });
            o.taiko.start({ note: 40, velocity: 120, time: t0 });
            o.taiko.start({ note: 40, velocity: 100, time: t0 + beat * 1.5 });
          } else if (rollIn || Math.random() < 0.55 + 0.35 * energy) {
            o.timpani.start({ note: tn, velocity: rollIn ? 112 : 92, time: t0, detune: tTune });
            if (Math.random() < 0.3 + 0.4 * energy) o.taiko.start({ note: 40, velocity: 92, time: t0 });
          }
          // Licks: on ~45% of chords a violin or flute plays a fast scale run
          // (5-9 notes) landing on a chord tone an octave or two above the
          // root, or a quick turn around one. Placed to lead into the next
          // chord or mid-chord. 16ths, kept between 60 and 120 ms a note.
          const licks = Math.random() < 0.45 + 0.45 * energy ? (energy > 0.6 ? 2 : 1) : 0;
          for (let li = 0; li < licks; li++) {
            const inst = Math.random() < 0.6 ? o.violin : o.flute;
            const sp = Math.min(0.12, Math.max(0.06, beat / 4));
            const land = orchDeg + [0, 2, 4][Math.floor(Math.random() * 3)] + L * (1 + Math.floor(Math.random() * 2));
            let ks;
            if (Math.random() < 0.7) {
              const n = 5 + Math.floor(Math.random() * 5), dir = Math.random() < 0.6 ? 1 : -1;
              ks = Array.from({ length: n }, (_, i) => land - dir * (n - 1 - i));
            } else ks = [land, land + 1, land, land - 1, land];
            const span = ks.length * sp;
            const ls = Math.random() < 0.6 ? t0 + hold - span : t0 + beat * (1 + Math.floor(Math.random() * Math.max(1, hold / beat - 2)));
            ks.forEach((k, i) => {
              const semi = semiOf(k);
              const last = i === ks.length - 1;
              inst.start({ note: rootMidi + semi, velocity: last ? 88 : 62 + Math.round(20 * i / ks.length), time: ls + i * sp, duration: last ? sp * 4 : sp * 1.1, detune: tune(semi) });
            });
          }

          rollIn = !boom && Math.random() < 0.3 + 0.4 * energy;
          if (rollIn) {
            // Roll over the last bar (or half the chord), crescendo into the next
            const len = Math.min(240 / b, hold / 2), rs = t0 + hold - len;
            for (let tr = rs; tr < t0 + hold - 0.03; tr += 0.07)
              o.timpani.start({ note: tn, velocity: Math.round(35 + 65 * (tr - rs) / len), time: tr, detune: tTune });
          }
        }
      } catch (e) { console.error("orchestra:", e); }
      orchT = setTimeout(orchTick, hold * 1000);
    };

    let steppeInst = "lute";
    const playNote = (semi, dur, vel) => {
      const { rootIdx: ri, timbre: t, noteVol: nv, aRef: ar, tuning: tu } = stRef.current;
      const b = tg.cur ?? stRef.current.bpm;
      let inst = stRef.current.instrument;
      if (isSteppe(stRef.current)) {
        if (b <= 90) steppeInst = "fiddle"; else if (b >= 100) steppeInst = "lute";
        inst = steppeInst;
      } else if (isNeon(stRef.current)) inst = "dx7";
      else if (isDesert(stRef.current)) inst = "duduk";
      const ac = getCtx();
      const rev = getOrCreateReverb(ac);
      const del = getOrCreateDelay(ac);
      const an = getOrCreateAnalyser(ac);
      // Endless keeps the line low: an octave down, folded to stay under G4
      const sleep = !!JOURNEYS[journeyRef.current?.id]?.endless;
      let sv = semi;
      if (sleep) { sv -= 12; while (sv > 7) sv -= 12; }
      const freq = ar * 2 ** ((60 + OFFS[ri] + (sv - semi) - 69) / 12) * tunedRatio(semi, tu);
      const beatDur = (dur * 60 / b / 2) * stRef.current.sustainMult;
      const snd = { inst, t };
      const same = (a, b) => a && a.inst === b.inst && (a.inst || a.t === b.t);
      if (!same(sb.to, snd)) {
        sb.from = stRef.current.soundBlend && sb.to ? sb.to : null;
        sb.to = snd; sb.t0 = Date.now();
      }
      const x = sb.from ? Math.min(1, (Date.now() - sb.t0) / sbDur()) : 1;
      if (x >= 1) sb.from = null;
      // Equal-power crossfade so the level holds steady through the swap
      const out = sleep ? getDark(ac).input
        : stRef.current.symphonic && orchRef.current && orchRef.current.ac === ac ? orchRef.current.lead : getLeadSoft(ac).input;
      const revSend = null;   // every lead bus has its own reverb send
      // High notes are where it gets piercing: softer the higher they go (-3 dB an octave above F5)
      if (freq > 700) vel *= Math.sqrt(700 / freq);
      const delSend = sleep ? null : del.delayNode;  // ...and the dark bus its own delay send
      if (sb.from) synthNote(ac, freq, vel * nv * Math.cos(x * Math.PI / 2), sb.from.inst, sb.from.t, beatDur, revSend, delSend, an.node, out);
      synthNote(ac, freq, vel * nv * (sb.from ? Math.sin(x * Math.PI / 2) : 1), inst, t, beatDur, revSend, delSend, an.node, out);
      noteCountRef.current++;
      setPlaying(((semi % 12) + 12) % 12);  // grouped runs can dip below the root
    };

    // Build chord tones from a root index within the scale
    const RAND_VOICES = ["power", "sus2", "sus4", "triad", "7th"];
    const buildChord = (notes, rootNoteIdx, voice) => {
      const n = notes.length;
      const v = voice === "rand" ? RAND_VOICES[Math.floor(Math.random() * RAND_VOICES.length)] : voice;
      if (v === "off")   return [notes[rootNoteIdx % n]];
      if (v === "power") return [notes[rootNoteIdx % n], notes[(rootNoteIdx + 2) % n] + (rootNoteIdx + 2 >= n ? 12 : 0)];
      if (v === "sus2")  return [notes[rootNoteIdx % n], notes[(rootNoteIdx + 1) % n] + (rootNoteIdx + 1 >= n ? 12 : 0), notes[(rootNoteIdx + 4) % n] + (rootNoteIdx + 4 >= n ? 12 : 0)];
      if (v === "sus4")  return [notes[rootNoteIdx % n], notes[(rootNoteIdx + 3) % n] + (rootNoteIdx + 3 >= n ? 12 : 0), notes[(rootNoteIdx + 4) % n] + (rootNoteIdx + 4 >= n ? 12 : 0)];
      if (v === "triad") return [0, 2, 4].map(s => notes[(rootNoteIdx + s) % n] + (rootNoteIdx + s >= n ? 12 : 0));
      if (v === "7th")   return [0, 2, 4, 6].map(s => notes[(rootNoteIdx + s) % n] + (rootNoteIdx + s >= n ? 12 : 0));
      if (voice === "all")   return notes; // whole scale at once
      return [notes[rootNoteIdx % n]];
    };

    const playChord = (rootNoteIdx, dur, vel, notes) => {
      const { chordVoice: cv } = stRef.current;
      const tones = buildChord(notes, rootNoteIdx, cv);
      // Slightly lower velocity per voice to avoid clipping
      const vMult = cv === "all" ? 0.4 : cv === "7th" ? 0.65 : cv === "triad" ? 0.7 : (cv === "sus2" || cv === "sus4") ? 0.72 : 0.8;
      tones.forEach((semi, i) => {
        // Very slight strum delay (0-18ms) for natural feel
        setTimeout(() => playNote(semi, dur, vel * vMult), i * 18);
      });
      // Show all chord tones on the wheel
      setPlaying(tones[0] % 12);
    };

    // The scale notes to play this tick (semitones above the root, ascending).
    // With blend on, a change of scale or key is planned as voice-leading moves:
    // each departing note is paired with the nearest arriving one (smallest
    // moves first), unpaired ones are plain adds/removes, and one move is
    // applied per bar (every 6 notes when there are many). Retargets mid-blend
    // start from whatever is sounding.
    const blendedNotes = (pattern, root, on) => {
      const target = pcsOf(pattern, root);
      const key = pattern + "@" + root;
      if (!on || !mo.cur) {
        mo.cur = target; mo.key = key; mo.steps = [];
        setMorphSemis(null);
      } else if (key !== mo.key) {
        mo.key = key;
        const cur = new Set(mo.cur), tgt = new Set(target);
        const out = mo.cur.filter(x => !tgt.has(x));
        const inn = target.filter(x => !cur.has(x));
        const dist = (a, c) => { const d = Math.abs(a - c) % 12; return Math.min(d, 12 - d); };
        const steps = [];
        while (out.length && inn.length) {
          let best = null;
          for (const o of out) for (const i of inn)
            if (!best || dist(o, i) < best.d) best = { o, i, d: dist(o, i) };
          steps.push(best);
          out.splice(out.indexOf(best.o), 1); inn.splice(inn.indexOf(best.i), 1);
        }
        inn.forEach(i => steps.push({ o: null, i, d: 6 }));
        out.forEach(o => steps.push({ o, i: null, d: 6 }));
        mo.steps = steps;
        mo.every = Math.round((steps.length > 3 ? 6 : 8) * (1 + smoothRef.current));   // Smooth: up to twice as slow
        mo.wait = 0;                             // first move right away
      }
      if (mo.steps.length && --mo.wait <= 0) {
        const { o, i } = mo.steps.shift();
        mo.cur = mo.cur.filter(x => x !== o);
        if (i !== null) mo.cur.push(i);
        mo.wait = mo.every;
        const rel = mo.cur.map(x => (x - root + 12) % 12).sort((a, c) => a - c);
        setMorphSemis(mo.steps.length ? rel : null);
      }
      return mo.cur.map(x => (x - root + 12) % 12).sort((a, c) => a - c);
    };

    // Any throw inside a tick would end the setTimeout chain and leave only
    // the drone playing, so a failed tick logs and schedules the next one.
    const melTick = () => {
      try { melTickBody(); }
      catch (e) {
        console.error("note scheduler:", e);
        clearTimeout(melTimeout);
        melTimeout = setTimeout(melTick, 60000 / (stRef.current.bpm || 100) / 2);
      }
    };

    let desertLeft = 5;
    const melTickBody = () => {
      // Check for pending scale transition
      const pending = pendingSelRef.current;
      if (pending) {
        const elapsed = Date.now() - pendingSelTimeRef.current;
        const atRoot = (arpIdxRef.current % (toSemis(stRef.current.sel?.pattern || 0).length || 1)) === 0;
        if (atRoot || elapsed > 2000) {
          pendingSelRef.current = null;
          setSelRaw(pending);
          stRef.current = { ...stRef.current, sel: pending };
          arpIdxRef.current = 0;
          melPrevRef.current = 0;
          grp.pos = 0; grp.start = 0; grp.motif = null; grp.left = 0; grp.tick = 0; grp.pat = null;
          // Brief pause (breath) then continue
          melTimeout = setTimeout(melTick, 350);
          return;
        }
      }
      const { sel: s, melMode: mm, chordVoice: cv, arpOct: aOct = 1, rootIdx: ri, blend: bl } = stRef.current;
      if (!s) return;
      const baseNotes = blendedNotes(s.pattern, ri, bl);
      lastBase = baseNotes;
      updateEnergy(baseNotes);
      const notes = [];
      for (let o = 0; o < aOct; o++) baseNotes.forEach(n => notes.push(n + o * 12));
      melPrevRef.current = Math.min(melPrevRef.current, notes.length - 1);
      const eighth = 60000 / (playBpm() * leadTempoRef.current) / 2;
      const isChord = cv !== "off";  // "rand" also counts as chord
      const G = stRef.current.grouping || 0;
      // Group size changed mid-group (Auto or a click): start a fresh group,
      // or the old position runs past the end of the new motif
      if (G !== grp.G) { grp.G = G; grp.pos = 0; grp.left = 0; grp.tick = 0; grp.pat = null; }

      // Desert: the duduk sings phrases of 4-9 long notes, the last one held,
      // then real silence (2-6 beats). No runs, no chords.
      if (isDesert(stRef.current)) {
        if (--desertLeft < 0) {
          desertLeft = 4 + Math.floor(Math.random() * 6);
          setPlaying(null);
          melTimeout = setTimeout(melTick, eighth * (4 + Math.random() * 8));
          return;
        }
        const durUnits = desertLeft === 0 ? 8 : [2, 3, 4, 4, 6][Math.floor(Math.random() * 5)];
        playNote(pickMelNote(notes), durUnits, 0.14 + Math.random() * 0.12);
        melTimeout = setTimeout(melTick, eighth * durUnits);
        return;
      }

      if (G && !isChord) {
        // Grouped line: even 8ths, group start accented, a lighter accent every
        // 4th note as the pulse, so N-note groups audibly cross the 4-count.
        const L = baseNotes.length;
        const span = notes.length;              // degrees available across aOct octaves
        const degSemi = (k) => baseNotes[((k % L) + L) % L] + 12 * Math.floor(k / L);
        if (grp.pos === 0) {
          // This group's size: fixed, or the next entry of a bar-filling mix
          // pattern (each pattern is played 1-2 times before another is drawn)
          if (G === "mix") {
            if (!grp.pat || grp.pi >= grp.pat.length) {
              if (!grp.pat || --grp.reps <= 0) {
                grp.pat = MIX_PATTERNS[Math.floor(Math.random() * MIX_PATTERNS.length)];
                grp.reps = 1 + Math.floor(Math.random() * 2);
              }
              grp.pi = 0;
            }
            grp.size = grp.pat[grp.pi++];
          } else grp.size = G;
          const size = grp.size;
          if (!mm) {
            // Arpeggio: a run of `size` degrees, each group starting one step on
            // (asc/desc follow the arp direction, rand picks per group)
            const { arpDir: ad } = stRef.current;
            const d = ad === "desc" ? -1 : ad === "rand" ? (Math.random() < 0.5 ? -1 : 1) : 1;
            if (grp.motif === null) { grp.start = d > 0 ? 0 : span - 1; }
            else grp.start += d;
            if (grp.start > span - 1) grp.start = 0;
            if (grp.start < 0) grp.start = span - 1;
            grp.motif = Array.from({ length: size }, (_, i) => i * d);
            grp.cur = grp.motif;
          } else {
            // Melody: draw a stepwise 7-note motif and sequence it up or down a
            // step per repeat, 3-6 times, before drawing a new one. Each group
            // plays the first `size` notes of it, so mixed sizes share one idea.
            if (!grp.motif || grp.left <= 0) {
              const m = [0];
              for (let i = 1; i < 7; i++) {
                const r = Math.random();
                m.push(m[i - 1] + (r < 0.38 ? 1 : r < 0.76 ? -1 : r < 0.88 ? 2 : -2));
              }
              grp.motif = m;
              grp.dir = Math.random() < 0.5 ? -1 : 1;
              grp.left = 3 + Math.floor(Math.random() * 4);
              grp.start = melPrevRef.current;
            } else grp.start += grp.dir;
            grp.cur = grp.motif.slice(0, size);
            // Turn the sequence around rather than run off the playing range
            const lo = Math.min(...grp.cur), hi = Math.max(...grp.cur);
            if (grp.start + hi > span - 1 || grp.start + lo < 0) {
              grp.dir = -grp.dir;
              grp.start = Math.max(-lo, Math.min(span - 1 - hi, grp.start + 2 * grp.dir));
            }
            grp.left--;
          }
        }
        const k = grp.start + grp.cur[grp.pos];
        melPrevRef.current = Math.max(0, Math.min(span - 1, k));
        arpIdxRef.current = ((k % L) + L) % L;   // lets a pending scale change land on the root
        // Mix patterns start on the bar line: the resolution back onto the
        // downbeat gets the strongest accent
        const vel = grp.pos === 0 ? (G === "mix" && grp.pi === 1 ? 0.36 : 0.3) : grp.tick % 4 === 0 ? 0.2 : 0.14;
        playNote(degSemi(k), 1, vel);
        grp.pos = (grp.pos + 1) % grp.size;
        grp.tick++;
        melTimeout = setTimeout(melTick, eighth);
      } else if (!mm) {
        // Arpeggio/chord step mode
        const { arpDir: ad, rhythm: rhy } = stRef.current;
        const n = notes.length;
        let idx;
        if (ad === "desc") {
          idx = (n - 1) - (arpIdxRef.current++ % n);
        } else if (ad === "rand") {
          arpIdxRef.current = (arpIdxRef.current + (Math.random() < 0.5 ? 1 : n - 1)) % n;
          idx = arpIdxRef.current;
        } else {
          idx = arpIdxRef.current++ % n;
        }
        const pat = ARP_RHYTHM_PATS[rhy] || ARP_RHYTHM_PATS.even;
        const mult = pat[rhythmIdxRef.current % pat.length];
        rhythmIdxRef.current++;
        if (isChord) {
          playChord(idx, mult * 2, 0.22, notes);
          melTimeout = setTimeout(melTick, eighth * mult * 2);
        } else {
          playNote(notes[idx], mult, 0.22);
          melTimeout = setTimeout(melTick, eighth * mult);
        }
      } else {
        // Melody mode
        if (isChord) {
          // Random root walking + chord voicing
          const idx = Math.floor(Math.random() * notes.length);
          const durUnits = [2, 2, 4, 4, 6][Math.floor(Math.random() * 5)];
          const vel = 0.14 + Math.random() * 0.12;
          if (Math.random() < 0.06) {
            setPlaying(null);
            melTimeout = setTimeout(melTick, eighth * durUnits);
          } else {
            playChord(idx, durUnits, vel, notes);
            melTimeout = setTimeout(melTick, eighth * durUnits);
          }
        } else {
          const semi = pickMelNote(notes);
          // With the orchestra on, tension breaks the line into fast notes:
          // 16ths when urgent, 8ths when restless, the usual rhythms when calm
          const urg = stRef.current.symphonic ? energy : 0;
          const durUnits = urg > 0.55 ? 0.5 : urg > 0.35 ? 1 : RHYTHMS[Math.floor(Math.random() * RHYTHMS.length)];
          const vel = 0.12 + Math.random() * 0.16 + 0.06 * urg;
          if (Math.random() < 0.08 * (1 - urg)) {
            setPlaying(null);
            melTimeout = setTimeout(melTick, eighth * durUnits);
          } else {
            playNote(semi, durUnits, vel);
            melTimeout = setTimeout(melTick, eighth * durUnits);
          }
        }
      }
    };

    // Beat: look-ahead scheduler on the audio clock, one 16th per step at the
    // tempo actually playing (half-time above 160 BPM). Fill on the last beat of
    // every 4th bar, crash every 16 bars. Tension doubles the hats and adds kicks.
    // A style change cuts on a downbeat without stopping the clock: the next
    // bar for a click, the bar after a fill for Auto. With Smooth up, on/off
    // (and Auto's rests) fade over 1-8 s. beatStyleNow is the style actually playing.
    let beatT = null, beatNext = 0, beatStep = 0, beatBar = 0, beatStyleNow = null;
    // Rise riffs (RISE_RIFFS): at the peaks, now and then, on a kit beat. The
    // tempo picks the key: the riff is sped up or slowed by whole semitones to
    // the one nearest the current tempo, Chloe's root moves to the riff's key (so
    // as Rise speeds up the riffs modulate upward), the tempo settles on exactly
    // the riff's, then it plays 2-3 times, restarted on every 2-bar line so it
    // can't drift off the beat. riff: null, or { buf, rate, bpm, phase, bar, left, giveUp }
    let riff = null, riffNext = 0, riffForce = false;
    const loadRiffs = (ac) => {
      const R = riffBufsRef.current;
      if (R) return R.ready ? R.bufs : null;
      riffBufsRef.current = { ready: false, bufs: [] };
      Promise.all(RISE_RIFFS.map(({ f }) => fetch(import.meta.env.BASE_URL + "samples/guitar/" + f)
        .then(r => r.arrayBuffer()).then(b => ac.decodeAudioData(b))))
        .then(bufs => { riffBufsRef.current = { ready: true, bufs }; })
        .catch(e => { console.error("riffs:", e); });
      return null;
    };
    const riffDone = () => { riff = null; riffHoldRef.current = 0; riffNext = Date.now() + 40000 + Math.random() * 40000; };
    const riffBar = (k, ac, t, b0) => {
      if (riff) {
        if (riff.phase === "settle") {
          // Wait until the tempo has arrived, then start on a 2-bar line
          if (Math.abs(b0 - riff.bpm) / riff.bpm < 0.004 && beatBar % RIFF_BARS === 0) riff.phase = "play";
          else { if (Date.now() > riff.giveUp) riffDone(); return; }
        }
        if (riff.bar % RIFF_BARS === 0) {
          if (riff.left === 0) { riffDone(); return; }
          const src = ac.createBufferSource(), g = ac.createGain();
          src.buffer = riff.buf; src.playbackRate.value = riff.rate; g.gain.value = RIFF_GAIN;
          src.connect(g); g.connect(k.vol);
          src.start(Math.max(ac.currentTime, t - RIFF_PRE / riff.rate));
          src.onended = () => { try { g.disconnect(); } catch {} };
          riff.left--;
        }
        riff.bar++;
        return;
      }
      const J = journeyRef.current;
      if (!JOURNEYS[J?.id]?.epic || !autoOnRef.current) return;
      const bufs = loadRiffs(ac);
      if (!bufs || beatBar % 4 !== 0) return;
      if (!riffForce && ((J.vals?.e ?? 0) < 0.6 || Date.now() < riffNext || Math.random() > 0.35)) return;
      riffForce = false;
      const semi = Math.max(-5, Math.min(5, Math.round(12 * Math.log2(b0 / RIFF_BPM))));
      const bpm = Math.round(RIFF_BPM * 2 ** (semi / 12));
      const which = Math.floor(Math.random() * bufs.length);
      riff = { buf: bufs[which], rate: bpm / RISE_RIFFS[which].bpm, bpm, phase: "settle", bar: 0,
               left: 2 + (Math.random() < 0.4 ? 1 : 0), giveUp: Date.now() + 20000 };
      riffHoldRef.current = Date.now() + 60000;
      setBpm(bpm);
      setRootIdx((RIFF_ROOT + semi + 12) % 12);
    };
    // Console: __chloeRiff() brings one in at the next 4-bar line (Rise, kit beat); __chloeRiff(false) shows the state
    window.__chloeRiff = (go = true) => { if (go) { riffForce = true; riffNext = 0; } return riff && { phase: riff.phase, bpm: riff.bpm, left: riff.left, bar: riff.bar }; };
    let beatFadeTo = null, beatFadeEnd = 0, beatFadeAc = null, beatAc = null, beatNoCrash = false, beatSwapTo = null;
    // A rainstick through the kit's volume, distance and fade. kind: shake
    // (1-1.5 s accent), fall (2.5-5 s) or pour (6-8 s, slow). The stick is
    // picked each time; never glass in Endless (nothing shrill for sleep).
    // Takes are made on first use, two per stick and kind.
    const RAIN_LEN = { shake: [1, 1.5], fall: [2.5, 5], pour: [6, 8] };
    const rainstick = (k, ac, t, level, kind = "fall") => {
      const sleep = !!JOURNEYS[journeyRef.current?.id]?.endless;
      const r = Math.random();
      const stick = sleep ? (r < 0.6 ? "wood" : "mid") : r < 0.35 ? "wood" : r < 0.75 ? "mid" : "glass";
      if (!k.rain) k.rain = {};
      const key = stick + "-" + kind, takes = k.rain[key] || (k.rain[key] = []);
      if (takes.length < 2) {
        const [lo, hi] = RAIN_LEN[kind];
        takes.push(makeRainstick(ac, lo + Math.random() * (hi - lo), RAIN_STICKS[stick]));
      }
      const src = ac.createBufferSource(), g = ac.createGain();
      src.buffer = takes[Math.floor(Math.random() * takes.length)];
      src.playbackRate.value = 0.85 + Math.random() * 0.3;
      g.gain.value = level * (kind === "shake" ? 0.75 : 1) * (stick === "glass" ? 0.8 : 1);
      src.connect(g); g.connect(k.vol); src.start(t);
    };
    // A synthesized hand drum through the kit's volume, distance and fade; to
    // the room too (like the snare) when it's played hard
    const handDrum = (k, ac, note, v, t, room) => {
      const d = HAND_DRUMS[note];
      if (!k.hand) k.hand = {};
      const takes = k.hand[note] || (k.hand[note] = [0, 1, 2].map(() => makeHandDrum(ac, d)));
      const src = ac.createBufferSource(), g = ac.createGain(), p = ac.createStereoPanner();
      src.buffer = takes[Math.floor(Math.random() * takes.length)];
      src.playbackRate.value = 0.99 + Math.random() * 0.02;
      g.gain.value = 0.75 * (d.g ?? 1) * Math.pow(Math.min(127, v) / 127, 1.6);
      p.pan.value = d.pan;
      src.connect(g); g.connect(p); p.connect(k.vol);
      if (room) p.connect(k.roomSend);
      src.start(Math.max(t, ac.currentTime));
      src.onended = () => { try { p.disconnect(); } catch {} };
    };
    window.__chloeRain = (kind) => { const ac = getCtx(); rainstick(getKit(ac), ac, ac.currentTime + 0.05, 0.32, kind); };
    const rampBeat = (k, ac, v, sec) => {
      for (const g of [k.fade, k.fadeRoom]) {
        const p = g.gain;
        p.cancelScheduledValues(ac.currentTime); p.setValueAtTime(p.value, ac.currentTime);
        p.linearRampToValueAtTime(v, ac.currentTime + Math.max(0.01, sec));
      }
    };
    // One 16th of the fusion groove. Group accents: with GROUPS on, a kick +
    // ride accent every 3/5/6/7 16ths, crossing the bar line and resolving to
    // the 1 every 4 bars. Calm = cross-stick backbeat; tense = more ghosts and
    // kicks. Velocities ±8 and timing ±4 ms so it breathes.
    let fusionTick = 0, fillPat = null;
    const fusionStep = (kit, snareKit, i, bar, t0, grouping) => {
      const P = BREAKS.fusion;
      const hit = (note, v, k2 = kit) => v > 0 && k2.start({ note, velocity: Math.max(1, Math.min(127, Math.round(v + (Math.random() - 0.5) * 16))), time: t0 + (Math.random() - 0.5) * 0.008 });
      if (i === 0 && bar % 4 === 0) fusionTick = 0;
      const longFill = bar % 8 === 7 && i >= 8, shortFill = bar % 4 === 3 && i >= 12;
      if ((longFill && i === 8) || (shortFill && !longFill && i === 12)) {
        const v = FUSION_FILLS[longFill ? "long" : "short"]; fillPat = v[Math.floor(Math.random() * v.length)];
      }
      if (longFill || shortFill) {
        const n = fillPat?.[i - (longFill ? 8 : 12)];
        if (n) hit(n, 70 + (i % 4) * 12 + (n === "kick" ? 20 : 0));
        if (i % 4 === 0) hit("ride", 40);
      } else {
        const g = typeof grouping === "number" && grouping > 0 ? grouping : grouping === "mix" ? 5 : 0;
        const accent = g && fusionTick % g === 0 && !P.s[i];
        const calm = energy < 0.25, tense = energy > 0.6;
        hit("kick", P.k[i] || (accent ? 92 : 0) || (tense && i === 15 ? 74 : 0));
        if (P.s[i]) { calm ? hit("stick-m", P.s[i] * 0.85) : (hit("snare-m", P.s[i]), hit("snare-m", P.s[i] * 0.75, snareKit)); }
        else hit("snare-l", P.g[i] ? P.g[i] + (tense ? 10 : 0) : tense && i % 2 && !P.k[i] ? 22 : 0);
        hit("ride", accent ? 108 : P.r[i] || 0);
        if (i === 4 || i === 12) hit("hhclosed-short", 36);
      }
      fusionTick++;
    };
    // One 16th of downtempo / hand: swung off-16ths, ±6 velocity, ±5 ms.
    // Snares and conga accents also go to the room. Calm thins the shaker and
    // congas; tense adds a kick. A conga run ends every 4th bar; every 16 bars
    // a deep boom (kick + low tom) instead of a crash.
    const worldStep = (K0, ac, style, i, bar, t0, stepDur, noBoom) => {
      const { kit, snareKit } = K0;
      const P = WORLD[style], t = t0 + (i % 2 ? 0.17 * stepDur : 0);
      const hit = (note, v, k2 = kit) => v > 0 && (HAND_DRUMS[note] && (note.startsWith("conga") || note.startsWith("frame") || note === "tek" || style === "hand")
        ? k2 === kit && handDrum(K0, ac, note, v + (Math.random() - 0.5) * 12, t + (Math.random() - 0.5) * 0.01, v > 70)
        : k2.start({ note, velocity: Math.max(1, Math.min(127, Math.round(v + (Math.random() - 0.5) * 12))), time: t + (Math.random() - 0.5) * 0.01 }));
      const calm = energy < 0.25, tense = energy > 0.6;
      if (style === "desert") {
        // A soft rim roll into every 4th bar; calm drops the extra strokes; a deep dum every 16
        if (bar % 4 === 3 && i >= 12) { hit("tek", 40 + (i - 12) * 8); return; }
        if (calm && (i === 11 || i === 14)) return;
        if (i === 0 && bar % 16 === 0 && !noBoom) hit("frame", 120);
      } else if (style === "shaman") {
        // A roll building into every 4th bar; a big stroke every 16
        if (bar % 4 === 3 && i >= 12) { hit("frame", 70 + (i - 12) * 12); hit("tambourine", 20 + (i - 12) * 4); return; }
        if (energy > 0.5 && i % 4 === 2) hit("frame", 58 + 20 * (energy - 0.5));
        if (i === 0 && bar % 16 === 0 && !noBoom) { hit("frame", 127); hit("tom-ll", 70); }
      } else if (style === "brushes") {
        if (bar % 8 === 7 && i === 12) hit("tom-l", 34);
        if (bar % 8 === 7 && i === 14) hit("tom-ll", 30);
      } else if (bar % 4 === 3 && i >= 12) { hit(WORLD_FILL[i - 12], 58 + (i - 12) * 10); if (style === "hand" && i === 12) hit("tom-ll", 84); return; }
      for (const [note, steps] of Object.entries(P)) {
        let v = steps[i] || 0;
        if (!v) continue;
        if (calm && (note === "cabasa" && i % 2 || note === "conga-h")) continue;
        hit(note, v);
        if (note === "snare-m" || note === "snare-l") hit(note, v * 0.9, snareKit);
        if (note === "conga-m" && v > 65) hit("conga-m", v * 0.5, snareKit);
      }
      if (style === "brushes" || style === "shaman" || style === "desert") return;
      if (tense && i === 14) hit(style === "hand" ? "tom-l" : "kick", 76);
      if (i === 0 && bar % 16 === 0 && !noBoom) { hit("kick-alt", 110); hit("tom-ll", 90); }
    };
    // New wave extras on top of the kit pattern: the snare also through the
    // gated reverb (its own LM-2 instance), a clap on it, a tom run down the
    // last two beats of every 8th bar, and the synth bass pulsing 8ths on the
    // chord root (NEON_PROGS over the scale, two bars a chord, octave pops)
    let neonProg = NEON_PROGS[0];
    const neonStep = (K0, ac, i, bar, t, sd, st) => {
      if (!K0.gate) {
        const conv = ac.createConvolver(); conv.buffer = gatedIR(ac);
        const gg = ac.createGain(); gg.gain.value = 0.9; conv.connect(gg); gg.connect(K0.vol);
        K0.gate = DrumMachine(ac, { instrument: "LM-2", destination: conv });
        K0.bass = ac.createGain(); K0.bass.gain.value = 1; K0.bass.connect(K0.fade);
      }
      if (BREAKS.newwave.s[i]) { K0.gate.start({ note: "snare-m", velocity: 120, time: t }); K0.kit.start({ note: "clap", velocity: 72, time: t }); }
      if (bar % 8 === 7 && i >= 8) K0.kit.start({ note: ["tom-hh", "tom-hh", "tom-h", "tom-h", "tom-m", "tom-m", "tom-l", "tom-ll"][i - 8], velocity: 96 + (i - 8) * 3, time: t });
      if (i % 2 === 0 && lastBase && lastBase.length) {
        if (i === 0 && bar % 8 === 0) neonProg = NEON_PROGS[Math.floor(Math.random() * NEON_PROGS.length)];
        const L = lastBase.length, deg = neonProg[Math.floor(bar / 2) % 4] % L;
        let m = 36 + OFFS[st.rootIdx] + lastBase[deg];
        while (m > 47) m -= 12;
        m += NEON_BASS[(i / 2) % 8];
        const fr = st.aRef * 2 ** ((m - 69) / 12);
        neonBass(ac, K0.bass, fr, t, sd * 1.7, i % 8 === 0 ? 1 : 0.75);
      }
    };
    const beatLoop = () => {
      try {
        const st = stRef.current, sm = smoothRef.current, F = 1 + 7 * sm;
        const resting = (beatRestRef.current && Date.now() < beatRestRef.current) || journeyRef.current?.vals?.perc === false;
        const want = st.beatStyle === "off" || resting ? "off" : st.beatStyle;
        const playing = beatStyleNow !== null && beatStyleNow !== "off";
        const ac = playing || want !== "off" ? getCtx() : null;
        beatSwapTo = playing && want !== "off" && want !== beatStyleNow && beatFadeTo === null ? want : null;
        if (beatSwapTo) {
          // Style to style: swapped on a downbeat inside the scheduler below
        } else if (beatFadeTo !== null && want === beatStyleNow) {
          // Changed back mid-fade: bring it up again
          beatFadeTo = null; rampBeat(getKit(ac), ac, 1, F / 2);
        } else if (want !== beatStyleNow) {
          if (!sm || !playing) {
            if (want !== "off") {
              const k = getKit(ac);
              if (!playing && sm) { rampBeat(k, ac, 0, 0.01); rampBeat(k, ac, 1, F); } else rampBeat(k, ac, 1, 0.01);
            }
            beatStyleNow = want; beatFadeTo = null;
          } else if (beatFadeTo === null) {
            beatFadeTo = want; beatFadeAc = ac;
            beatFadeEnd = ac.currentTime + (want === "off" ? F : F / 2);
            rampBeat(getKit(ac), ac, 0, beatFadeEnd - ac.currentTime);
          } else if (ac !== beatFadeAc || ac.currentTime >= beatFadeEnd) {
            beatStyleNow = want; beatFadeTo = null;
            if (want !== "off") rampBeat(getKit(ac), ac, 1, F / 2);
          }
        }
        if (beatStyleNow === "off" || beatStyleNow === null) { beatNext = 0; }
        else {
          const K0 = getKit(ac), { kit, snareKit } = K0;
          // Far and dreamy in Endless, fairly far for brushes, up close otherwise
          setBeatDistance(K0, JOURNEYS[journeyRef.current?.id]?.endless ? 0.9 : beatStyleNow === "brushes" ? 0.7 : 0);
          // A fresh context (the periodic swap) restarts its clock near 0: carry on
          // from where the pattern is instead of waiting for the old clock time
          if (ac !== beatAc) { if (beatAc) beatNext = ac.currentTime + 0.05; beatAc = ac; }
          if (beatNext < ac.currentTime) {
            beatNext = ac.currentTime + 0.05; beatStep = 0; beatBar = 0;
            beatNoCrash = sm > 0;   // fading in: no crash on the way in
          }
          while (beatNext < ac.currentTime + 0.12) {
            // The new style comes in on the downbeat with a crash, in time with the old one
            if (beatSwapTo && beatStep === 0 && (!beatPhraseRef.current || beatBar % 4 === 0)) {
              beatStyleNow = beatSwapTo; beatSwapTo = null; beatBar = 0; beatNoCrash = false;
              beatPhraseRef.current = false;
            }
            const b0 = tg.cur ?? st.bpm, bb = b0 > 160 ? b0 / 2 : b0;
            beatStepHookRef.current?.(ac, beatNext, beatStep, WORLD[beatStyleNow] ? 60 / (b0 > 120 ? b0 / 2 : b0) / 4 : 60 / bb / 4);
            if (WORLD[beatStyleNow]) {
              const lb = b0 > 120 ? b0 / 2 : b0, sd = 60 / lb / 4;   // laid back: half-time above 120
              worldStep(K0, ac, beatStyleNow, beatStep, beatBar, beatNext, sd, beatNoCrash);
              // Now and then a rainstick falls across the bar (about one in every 16
              // bars; in calm stretches, Endless or brushes about one in 8, often a
              // long pour), and now and then a quick shake leads into a 4-bar line
              const calm = JOURNEYS[journeyRef.current?.id]?.endless || beatStyleNow === "brushes" || energy < 0.3;
              const rl = beatStyleNow === "brushes" ? 0.26 : 0.32;
              if (beatStep === 0 && (calm ? beatBar % 4 === 0 && Math.random() < 0.5 : beatBar % 8 === 4 && Math.random() < 0.5))
                rainstick(K0, ac, beatNext, rl, calm && Math.random() < 0.4 ? "pour" : "fall");
              else if (beatStep === 8 && beatBar % 4 === 3 && Math.random() < 0.2)
                rainstick(K0, ac, beatNext, rl, "shake");
              if (beatStep === 0 && beatBar > 0) beatNoCrash = false;
              beatNext += sd;
              beatStep = (beatStep + 1) % 16;
              if (beatStep === 0) beatBar++;
              continue;
            }
            if (beatStyleNow === "fusion") {
              fusionStep(kit, snareKit, beatStep, beatBar, beatNext, st.grouping);
              if (beatStep === 0 && beatBar % 16 === 0 && !beatNoCrash) kit.start({ note: "crash", velocity: 84, time: beatNext });
              if (beatStep === 0 && beatBar > 0) beatNoCrash = false;
              beatNext += 60 / bb / 4;
              beatStep = (beatStep + 1) % 16;
              if (beatStep === 0) beatBar++;
              continue;
            }
            const P = BREAKS[beatStyleNow] || BREAKS.break, i = beatStep, t = beatNext;
            if (beatStyleNow === "newwave") neonStep(K0, ac, i, beatBar, t, 60 / bb / 4, st);
            const fill = beatBar % 4 === 3 && i >= 12 && beatStyleNow !== "newwave";
            const hit = (note, v, k2 = kit) => v && k2.start({ note, velocity: Math.min(127, Math.round(v)), time: t });
            // Tension thickens each style without turning it into another one:
            // an extra kick on the last 16th, quiet ghost hats on the off-16ths
            hit("kick", P.k[i] || (energy > 0.7 && i === 14 && beatStyleNow !== "heavy" ? 90 : 0));
            if (fill) { hit("snare-h", 50 + (i - 12) * 22); }
            else {
              if (P.s[i]) { hit("snare-m", P.s[i]); hit("snare-m", P.s[i] * 0.8, snareKit); }
              hit("snare-l", P.g[i]);
            }
            const hv = P.h[i] || (energy > 0.5 && i % 2 && !P.o[i] ? 30 : 0);
            hit("hhclosed-short", hv);
            hit("hhopen", P.o[i]);
            if (i === 0 && beatBar % 16 === 0 && !beatNoCrash) hit("crash", 90);
            if (i === 0 && beatBar > 0) beatNoCrash = false;
            if (i === 0) riffBar(K0, ac, t, b0);
            beatNext += 60 / bb / 4;
            beatStep = (beatStep + 1) % 16;
            if (beatStep === 0) beatBar++;
          }
        }
      } catch (e) { console.error("beat:", e); }
      beatT = setTimeout(beatLoop, 25);
    };

    melTick();
    orchT = setTimeout(orchTick, 50);
    beatT = setTimeout(beatLoop, 0);
    return () => {
      clearTimeout(melTimeout); clearInterval(arpRef.current); clearTimeout(orchT); clearTimeout(beatT);
      if (orchRef.current) orchRef.current.all.forEach(i => i.stop());
    };
  // melTick/playNote read all playback state live from stRef — only arpOn is needed
  // as a dep (for the guard). sel changes are handled via pendingSelRef for smooth transitions.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arpOn, getCtx]);

  useEffect(() => () => clearInterval(arpRef.current), []);

  /* ── Demo mode: Claude autonomously explores scales ── */
  useEffect(() => {
    if (!demoOn || !demoKey) return;

    let cancelled = false;
    let timeout = null;

    const callClaude = async () => {
      if (loopOnRef.current) { timeout = setTimeout(callClaude, 1000); return; }
      callClaudeNowRef.current = null; // consuming — clear so double-trigger can't happen
      const capturedUserMsg = pendingUserMsgRef.current; // snapshot before async call
      // Build scale catalogue — named scales + custom names, or all scales if demoAllScales
      const allScales = demoAllScalesRef.current;
      const cNames = customNamesRef.current;
      const catalogue = [];
      for (const fam of activeFamiliesRef.current) {
        fam.modes.forEach((pat, mi) => {
          const name = KNOWN[pat] || cNames[pat];
          if (name || allScales) {
            const semis = toSemis(pat);
            const ivs = semis.slice(1).map((v, i) => v - semis[i]).concat(12 - semis[semis.length - 1]);
            catalogue.push({ familyId: fam.id, modeIdx: mi, name: name || `${fam.id}.${mi}`, notes: fam.n, intervals: ivs.join("-"), pattern: pat });
          }
        });
      }

      // Snapshot EEG brain state if proxy is streaming
      const _eeg = eegData;
      const brainState = (_eeg && _eeg.connected && _eeg.bands && _eeg.derived) ? {
        dominant_active:    _eeg.derived.dominant_active_band,
        alpha_pct:          Math.round((_eeg.bands.alpha.left_pct + _eeg.bands.alpha.right_pct) / 2),
        theta_pct:          Math.round((_eeg.bands.theta.left_pct + _eeg.bands.theta.right_pct) / 2),
        beta_pct:           Math.round((_eeg.bands.beta.left_pct  + _eeg.bands.beta.right_pct)  / 2),
        gamma_pct:          Math.round((_eeg.bands.gamma.left_pct + _eeg.bands.gamma.right_pct) / 2),
        alpha_theta_ratio:  _eeg.derived.alpha_theta_ratio,
        relaxation_index:   _eeg.derived.relaxation_index,
        theta_alpha_ratio:  parseFloat(((_eeg.bands.theta.left_pct + _eeg.bands.theta.right_pct) / Math.max(_eeg.bands.alpha.left_pct + _eeg.bands.alpha.right_pct, 0.01)).toFixed(2)),
        beta_alpha_ratio:   parseFloat(((_eeg.bands.beta.left_pct  + _eeg.bands.beta.right_pct)  / Math.max(_eeg.bands.alpha.left_pct + _eeg.bands.alpha.right_pct, 0.01)).toFixed(2)),
        hemispheric_balance: (() => {
          const bs = ['gamma','beta','alpha','theta'].map(b => {
            const l = _eeg.bands[b]?.left_pct || 0, r = _eeg.bands[b]?.right_pct || 0;
            return (l + r) > 0.5 ? 0.5 + 0.5 * (r - l) / (l + r) : null;
          }).filter(v => v !== null);
          return bs.length ? parseFloat((bs.reduce((a,b) => a+b, 0) / bs.length).toFixed(3)) : 0.5;
        })(),
        ...((_eeg.heart_rate > 0) ? { heart_rate: _eeg.heart_rate } : {}),
      } : null;

      // Brightness-based scale selection — priority: lock > slider > claude > eeg > free
      let brightnessSelected = null;
      let effectiveTarget = null;
      const override   = overrideTargetRef.current;
      const locked     = brightnessLockedRef.current;
      const claudeOvr  = claudeOverrideRef.current;

      if (override !== null) {
        // User manual override (slider or lock) — highest priority
        effectiveTarget = override;
      } else if (claudeOvr !== null) {
        // Claude-set override — above EEG, below user manual
        effectiveTarget = claudeOvr;
      } else if (brainState) {
        // EEG-driven
        const effectiveConfig = monasticModeRef.current
          ? { ...BRIGHTNESS_CONFIG, smoothingWindow: 30, transitionThreshold: 0.15 }
          : BRIGHTNESS_CONFIG;
        const rawTarget = targetBrightness(
          { derived:              { dominant_active_band: brainState.dominant_active },
            bands:                { alpha_pct: brainState.alpha_pct, theta_pct: brainState.theta_pct, beta_pct: brainState.beta_pct },
            hemispheric_balance:  brainState.hemispheric_balance },
          effectiveConfig
        );
        const hist = brightnessHistoryRef.current;
        hist.push(rawTarget);
        if (hist.length > effectiveConfig.smoothingWindow) hist.shift();
        effectiveTarget = hist.reduce((a, b) => a + b, 0) / hist.length;
        setEegTarget(effectiveTarget);
      }

      if (effectiveTarget !== null) {
        const effectiveConfig = monasticModeRef.current
          ? { ...BRIGHTNESS_CONFIG, smoothingWindow: 30, transitionThreshold: 0.15 }
          : BRIGHTNESS_CONFIG;
        const currentPattern = stRef.current.sel?.pattern;
        // An outside scale has no brightness position — always move back onto the brightness line
        const onOutside = isOutsideId(stRef.current.sel?.id);
        const currentNorm = currentPattern ? normalizedBrightness(currentPattern) : 0.5;
        if (onOutside || Math.abs(effectiveTarget - currentNorm) >= effectiveConfig.transitionThreshold) {
          brightnessSelected = findClosestScale(effectiveTarget, catalogue.filter(e => !isOutsideId(e.familyId)), currentPattern, effectiveConfig);
          if (brightnessSelected) {
            const bsFam = FAMILIES.find(f => f.id === brightnessSelected.familyId);
            if (bsFam) pick(bsFam, brightnessSelected.modeIdx, brightnessSelected.pattern);
          }
        }
      }

      const bSource = override !== null ? (locked ? 'locked' : 'slider')
        : claudeOvr !== null ? 'claude'
        : brainState ? 'eeg' : 'free';

      const currentState = {
        currentScale: stRef.current.sel ? (KNOWN[stRef.current.sel.pattern] || stRef.current.sel.id) : "none",
        currentBrightness: stRef.current.sel && !isOutsideId(stRef.current.sel.id) ? brightnessScore(stRef.current.sel.pattern) : null,
        currentBrightnessNorm: stRef.current.sel && !isOutsideId(stRef.current.sel.id) ? parseFloat(normalizedBrightness(stRef.current.sel.pattern).toFixed(3)) : null,
        diatonicNeighborhood: stRef.current.sel ? diatonicNeighborhood(stRef.current.sel.pattern) : null,
        diatonicContextActive: showDiatonicRef.current,
        brightnessSource: bSource,
        ...(brightnessSelected ? {
          brightnessSelected: brightnessSelected.name || `${brightnessSelected.familyId}.${brightnessSelected.modeIdx}`,
          targetBrightnessNorm: parseFloat(effectiveTarget.toFixed(3)),
        } : {}),
        rootNote: CHROMATIC[stRef.current.rootIdx],
        rhythm: stRef.current.rhythm,
        arpDir: stRef.current.arpDir,
        bpm: stRef.current.bpm,
        sustainMult,
        ...(brainState ? { brainState } : {}),
        ...(claudeBpmOverrideRef.current !== null ? { claudeBpmOverride: claudeBpmOverrideRef.current } : {}),
        ...(monasticModeRef.current ? { monasticMode: true } : {}),
      };

      const recentHistory = demoLogRef.current.slice(0, 20).map(e =>
        `ID="${e.famId}.${e.modeIdx}" name="${e.scaleName}" root=${CHROMATIC[e.rootNote]} rhythm=${e.rhythm} bpm=${e.bpm}`
      );

      const recentChat = chatLogRef.current.slice(-6).map(e =>
        `${e.role === "user" ? "User" : "Claude"}: ${e.text}`
      ).join("\n");

      const { Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: demoKey, dangerouslyAllowBrowser: true });

      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: `You are exploring a musical scale app. Each turn you choose a scale to play and settings to use.
Respond ONLY with valid JSON matching this schema exactly:
{"scaleId":"string","rootNote":number,"rhythm":"even"|"swing"|"gallop"|"waltz"|"clave","arpDir":"asc"|"desc"|"rand","chordVoice":"off"|"power"|"sus2"|"sus4"|"triad"|"7th"|"all","bpm":number,"reverbAmt":number,"delayAmt":number,"delayTime":number,"sustainMult":number,"droneOn":boolean,"droneVol":number,"droneOct":number,"droneWave":"sine"|"organ"|"pad"|"strings"|"tanpura"|"throat"|"jawharp","commentary":"string","reply":"string","request":"string","brightnessOverride":number|null,"bpmOverride":"heart_rate"|number|null}
scaleId is the exact ID from the scale list (e.g. "hep-6.5"). rootNote is 0=C 1=C# 2=D 3=D# 4=E 5=F 6=F# 7=G 8=G# 9=A 10=A# 11=B. bpm between 60-160. reverbAmt 0.0-1.0 (reverb wet level). delayAmt 0.0-1.0 (delay wet level). delayTime 0.05-1.5 (delay time in seconds — try rhythmic values like 0.125, 0.25, 0.375, 0.5, 0.75). sustainMult 0.1-3.0 (note duration multiplier: 0.1 = very staccato, 1.0 = default, 2.0 = legato, 3.0 = long overlapping notes — particularly effective with sparse scales and slow BPM). droneOn: whether to enable the drone. droneVol 0.0-2.0 (drone volume). droneOct: semitone drop for drone — 0 (same octave), -12 (1 oct down), -24 (2 oct down), -36 (3 oct down). droneWave: drone timbre — sine (clean), organ (harmonic series), pad (shimmer), strings (bowed), tanpura (Indian pulsing), throat (Mongolian throat singing, whistled overtones), jawharp (plucked jaw harp, rhythmic). commentary is 1-2 sentences about this scale's character. reply is a brief conversational response to the user's message if they sent one — omit if no user message. request is optional — if there is a genuinely missing capability you wish the app had, describe it briefly. Omit if you have no request.
The app already has: drone (sustained root note, independently volume-controlled, up to 3 octaves down, 5 timbres), beat (kick/snare/hat patterns), reverb (with wet level control), delay (with wet level and time controls), 4 instruments (piano/guitar/xylo/space), chord voicing (power/sus2/sus4/triad/7th/all), melody mode, arpeggio with direction and rhythm patterns, concert pitch tuning, URL sharing, and favourites. Only request things not on this list.
${activeFamiliesRef.current.some(f => f.outside) ? "IMPORTANT: The catalogue includes \"outside\" scales (IDs starting with x-) that contain 3 consecutive semitones — chromatic clusters with a tense, crowded sound. Treat them like passing tones: a brief moment of chromatic confusion or human imperfection between normal scales. Use one fairly often — about 1 turn in 3 — but only for a single turn before returning to a normal scale. Strongly prefer ones with short semitone runs (3 in a row); runs of 6-8 consecutive semitones should be rare. They have no brightness position." : "IMPORTANT: All scales in this app exclude any scale containing 3 or more consecutive semitones. This means common scales like the blues scale, chromatic scale, and others with clustered half-steps are NOT available."} Only reference scales that are actually in the available scale list — do not mention or promise scales by name unless they appear in the catalogue provided.
currentState.currentBrightnessNorm is the normalized brightness of the active scale (0.0 = darkest possible for this note count, 1.0 = brightest, 0.5 = Dorian-equivalent neutral). currentState.brightnessSource tells you what is driving scale selection: 'eeg' = EEG headband is active and has pre-selected a scale; 'slider' = user has manually set a brightness target with the slider; 'locked' = user has locked the current brightness zone; 'claude' = you have set a brightnessOverride and are actively driving toward a goal; 'free' = no EEG, no override — you choose freely. When brightnessSource is 'eeg': a brightness-matching algorithm has pre-selected a scale (currentState.brightnessSelected) — your role is to choose BPM, rhythm, voicing, and effects to complement it; only override the scale if you have a strong musical reason. When brightnessSource is 'slider' or 'locked': the user has taken manual control of brightness — describe the musical character of the scale rather than brain state. When brightnessSource is 'free': choose scales autonomously.
brightnessOverride: you may set this field (0.0–1.0) to lock a brightness target toward a goal state. When set, it overrides EEG-driven selection until you explicitly clear it (set to null) or the user takes manual control. OMIT this field entirely when you are not changing the current override state — omitting it preserves whatever is currently set. Set to null only when explicitly releasing a goal you've been holding. Target ranges: gamma/alertness/focus → 0.80–0.95; alpha/calm/balance → 0.45–0.55; theta/deep meditation → 0.15–0.30. When the user asks you to target a brain state: set brightnessOverride, choose BPM/rhythm/voicing to reinforce the goal, and HOLD the override across subsequent cycles. Report EEG as progress feedback, not as a state to mirror: "Gamma still at 4% — holding bright scales to keep pushing" not "Your gamma suggests high cognition." Ease or clear the override when the goal is clearly achieved or the user changes direction.
bpmOverride: you may set this field to lock BPM persistently. The value "heart_rate" is a special literal string token — output it exactly as written, do NOT substitute the current heart rate number. When set to the string "heart_rate" (e.g. {"bpmOverride":"heart_rate"}), the app reads the live heart rate itself every cycle. Set to a number only to lock to a specific static tempo. Set null to release. Omit to preserve current state. When the user asks to sync BPM with their pulse or heart rate, output {"bpmOverride":"heart_rate"} and hold it until they ask to stop or change direction. While active, report as feedback: "Syncing BPM to your heart rate (N bpm)."
Monastic mode: when currentState.monasticMode is true, your role changes — hold each scale for the full cycle interval (3+ minutes). Choose the slowest BPM you can justify (10–30 range). Prefer sparse scales (3–5 notes). Use sustained drone types (tanpura, pad, strings) — the drone is the primary voice. Commentary should be minimal — one short sentence about the scale character. Do not narrate the brain state unless it has changed significantly. Do not suggest feature improvements (omit the request field entirely). If the EEG brightness target hasn't shifted beyond the transition threshold, keep the current scale.
Brain state interpretation guidelines: Ignore delta — it is always the highest-amplitude band from forehead EEG and does not indicate sleep or drowsiness on its own. Use dominant_active (the strongest band excluding delta): alpha = calm, relaxed, meditative; theta = deepening meditation, drowsy, inward; beta = engaged, focused, active; gamma = high cognitive processing. Use theta_alpha_ratio to judge depth: > 1.5 suggests deep meditation or drowsiness, < 0.5 suggests alert wakefulness. Use beta_alpha_ratio to judge activation: > 1.5 suggests active focus, < 0.5 suggests relaxation. Only describe the state as deep/drowsy/sleep-like when theta_alpha_ratio actually supports it (> 1.5).
Commentary discipline: The brain state is context, not the headline every cycle. Only mention the brain state in commentary when it has meaningfully shifted from the previous cycle (different dominant_active band, or ratio crossing a threshold). When the brain state is stable, focus commentary entirely on the musical choices — why this scale after the previous one, what the harmonic or tonal relationship is, how the texture or mood is evolving. Do not produce variations of the same brain state observation cycle after cycle.
Diatonic neighborhood: currentState.diatonicNeighborhood shows which standard diatonic modes share the most pitches with the current scale (relatives, sharedPitches, totalPitches, ambiguity). currentState.diatonicContextActive tells you whether the user has turned on diatonic mode context. When diatonicContextActive is true: actively reference diatonic neighborhoods in commentary — anchor the scale in familiar modal language. When ambiguity is 1: name the parent mode directly — "this hexatonic is a Dorian variant with the 6th removed." When ambiguity is 2–3: describe the space between modes — "this pentatonic sits equally in Ionian and Lydian territory — the missing pitches are left to the listener." High ambiguity in sparse scales (tritonics, tetratonics) is musically meaningful, not a gap — a 3-note scale is inherently participatory, the listener fills in the missing pitches. Do not force a single mode label on an ambiguous scale. When diatonicContextActive is false: the neighborhood data is available if genuinely useful, but don't foreground modal labels — focus on the scale's own character.`,
        messages: [{
          role: "user",
          content: `${recentChat.length ? `Recent conversation:\n${recentChat}\n\n` : ""}${capturedUserMsg ? `New message: "${capturedUserMsg}"\n\n` : ""}Current state: ${JSON.stringify(currentState)}${recentHistory.length ? `\n\nRecent history (most recent first):\n${recentHistory.join("\n")}` : ""}\n\nAvailable scales (use the ID exactly as shown):\n${catalogue.map(s => `ID="${s.familyId}.${s.modeIdx}" name="${s.name}" notes=${s.notes} intervals=${s.intervals}`).join("\n")}\n\nChoose the next scale to explore.${capturedUserMsg ? " Respond to the user's new message and pick a scale accordingly." : " Vary musically — contrast brightness, note density, and feel with the recent history. Avoid repeating scales just played."}`
        }]
      });

      if (cancelled) return;

      const raw = msg.content[0].text.trim();
      const json = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
      const choice = JSON.parse(json);

      // Claude brightness override — only act if field is present in response
      if (Object.prototype.hasOwnProperty.call(choice, 'brightnessOverride')) {
        if (choice.brightnessOverride === null) {
          claudeOverrideRef.current = null;
          setClaudeOverride(null);
        } else if (typeof choice.brightnessOverride === 'number') {
          const v = Math.max(0, Math.min(1, choice.brightnessOverride));
          claudeOverrideRef.current = v;
          setClaudeOverride(v);
        }
      }

      // Claude BPM override — only act if field is present in response
      if (Object.prototype.hasOwnProperty.call(choice, 'bpmOverride')) {
        if (choice.bpmOverride === null) {
          claudeBpmOverrideRef.current = null;
          setClaudeBpmOverride(null);
        } else if (choice.bpmOverride === "heart_rate") {
          claudeBpmOverrideRef.current = "heart_rate";
          setClaudeBpmOverride("heart_rate");
        } else if (typeof choice.bpmOverride === 'number') {
          const v = Math.max(monasticModeRef.current ? 1 : 40, Math.min(240, choice.bpmOverride));
          claudeBpmOverrideRef.current = v;
          setClaudeBpmOverride(v);
        }
      }

      // Ensure AudioContext is running before we trigger the arpeggio effect
      const ac = getCtx();
      if (ac.state === "suspended") await ac.resume();

      // Parse scaleId "hep-6.5" → famId="hep-6", modeIdx=5
      const dotPos = (choice.scaleId || "").lastIndexOf(".");
      const famId = dotPos > 0 ? choice.scaleId.slice(0, dotPos) : "";
      const modeIdx = dotPos > 0 ? parseInt(choice.scaleId.slice(dotPos + 1)) : NaN;
      const fam = FAMILIES.find(f => f.id === famId);
      if (fam && !isNaN(modeIdx) && fam.modes[modeIdx] !== undefined) {
        pick(fam, modeIdx, fam.modes[modeIdx]);
      }
      const rootNote = Math.max(0, Math.min(11, choice.rootNote));
      const rhythm   = choice.rhythm    || "even";
      const arpDir   = choice.arpDir    || "asc";
      const chordVoice = choice.chordVoice || "off";
      const bpm      = Math.max(monasticModeRef.current ? 1 : 40, Math.min(240, choice.bpm || 100));
      const AL = autoLocksRef.current;
      if (AL.rootNote) setRootIdx(rootNote);
      if (AL.rhythm)     setRhythm(rhythm);
      if (AL.arpDir)     setArpDir(arpDir);
      if (AL.chordVoice) setChordVoice(chordVoice);
      if (AL.melMode)    setMelMode(!!choice.melMode);
      if (AL.bpm)        setBpm(bpm);
      // BPM override takes priority over Claude's chosen bpm — apply after
      if (!autoLocksRef.current.bpm) {
        // user has locked bpm in modal — don't override
      } else if (claudeBpmOverrideRef.current === "heart_rate" && eegDataRef.current && eegDataRef.current.heart_rate > 0) {
        setBpm(Math.max(monasticModeRef.current ? 1 : 40, Math.min(240, Math.round(eegDataRef.current.heart_rate))));
      } else if (typeof claudeBpmOverrideRef.current === 'number') {
        setBpm(claudeBpmOverrideRef.current);
      }
      if (AL.reverb    && choice.reverbAmt != null) setReverbAmt(Math.max(0, Math.min(1, choice.reverbAmt)));
      if (AL.delay     && choice.delayAmt  != null) setDelayAmt(Math.max(0, Math.min(1, choice.delayAmt)));
      if (AL.delayTime && choice.delayTime != null) setDelayTime(Math.max(0.05, Math.min(1.5, choice.delayTime)));
      if (AL.sustain && choice.sustainMult != null) setSustainMult(Math.max(0.1, Math.min(3, choice.sustainMult)));
      if (AL.droneOn   && choice.droneOn   != null) setDroneOn(!!choice.droneOn);
      if (AL.droneVol  && choice.droneVol  != null) setDroneVol(Math.max(0, Math.min(2, choice.droneVol)));
      if (AL.droneOct  && choice.droneOct  != null) setDroneOct([0, -12, -24, -36].includes(choice.droneOct) ? choice.droneOct : -24);
      if (AL.droneWave && choice.droneWave != null && ["sine", "organ", "pad", "strings", "tanpura", "throat", "jawharp", "juno", "dam"].includes(choice.droneWave)) setDroneWave(choice.droneWave);
      setArpOn(true);
      // Commentary and requests go to chat panel; banner shows parameter summary only
      const chatParts = [choice.commentary, choice.request ? `✦ ${choice.request}` : null].filter(Boolean);
      if (chatParts.length) setChatLog(prev => [...prev, { role: "claude", text: chatParts.join("\n"), ts: Date.now() }].slice(-40));
      if (choice.reply) { setChatLog(prev => [...prev, { role: "claude", text: choice.reply, ts: Date.now() }].slice(-40)); if (capturedUserMsg) setChatOpen(true); }
      // Only clear the pending message if it was the one we used — a new message may have arrived during the API call
      if (pendingUserMsgRef.current === capturedUserMsg) pendingUserMsgRef.current = null;

      if (fam && !isNaN(modeIdx)) {
        setDemoLog(prev => [{
          scaleName: KNOWN[fam.modes[modeIdx]] || choice.scaleId,
          famId, modeIdx, rootNote, rhythm, arpDir, chordVoice, bpm,
          commentary: choice.commentary || "",
          request: choice.request || "",
          ts: Date.now(),
        }, ...prev].slice(0, 200));
      }

      // If a new user message arrived while we were waiting for the API, respond immediately
      if (pendingUserMsgRef.current) {
        timeout = setTimeout(callClaude, 0);
      } else {
        const delay = monasticModeRef.current ? 180000 : 12000 + Math.random() * 4000;
        timeout = setTimeout(callClaude, delay);
      }
      callClaudeNowRef.current = () => { clearTimeout(timeout); callClaude(); };
    };

    callClaude().catch(err => {
      if (!cancelled) setDemoComment(`Error: ${err.message}`);
    });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      callClaudeNowRef.current = null;
    };
  }, [demoOn, demoKey, getCtx]); // reads live state via stRef/FAMILIES; getCtx is stable (useCallback [])

  /* ── Free auto-demo: random named scale explorer, no API key ── */
  useEffect(() => {
    if (!autoOn) return;
    let cancelled = false;
    let timeout = null;

    // Rebuilt each pick so the outside / all-scales toggles take effect mid-run
    const buildCatalogue = () => activeFamiliesRef.current.flatMap(fam =>
      fam.modes.map((pat, i) => ({ fam, modeIdx: i, pat }))
    ).filter(({ fam, pat }) => fam.outside || demoAllScalesRef.current || KNOWN[pat] || customNamesRef.current[pat]);

    const RHYTHMS = ["even", "swing", "gallop", "waltz", "clave"];
    const DIRS    = ["asc", "desc", "rand"];
    const VOICES  = ["off", "off", "off", "power", "sus2", "triad"];

    // Tempo drifts: each pick moves at most ~±10% from the current BPM, pulled
    // a quarter of the way back toward the tempo Auto started at (in log space)
    const homeBpm = Math.min(240, Math.max(60, stRef.current.bpm));
    const driftBpm = (cur) => {
      const step = Math.log2(cur) + 0.14 * (Math.random() * 2 - 1);
      const next = 2 ** (step + 0.25 * (Math.log2(homeBpm) - step));
      return Math.round(Math.min(240, Math.max(60, next)));
    };

    // Bursts: tempo holds at home; every 20-60 s a 2-4 bar surprise, then back.
    // Double/half time snap in and out; push/pull glide.
    // Every 45-120 s (longer with Smooth), 4-8 bars. With Smooth at half or more,
    // no double/half-time snaps, only the gentle push and pull. Double and half
    // time are mostly the lead's alone (it races or lags over a band that keeps
    // its tempo); now and then, and for push and pull, everything moves.
    const BURSTS = [
      { f: 2,    snap: true,  w: 30 },  // double time
      { f: 1.15, snap: false, w: 35 },  // push
      { f: 0.87, snap: false, w: 25 },  // pull back
      { f: 0.5,  snap: true,  w: 10 },  // half time
    ];
    let burstT = null, burstHome = null;
    const scheduleBurst = () => { burstT = setTimeout(doBurst, (45000 + Math.random() * 75000) * (1 + smoothRef.current)); };
    const doBurst = () => {
      if (cancelled) return;
      const st = stRef.current;
      if (st.autoTempo !== "bursts" || !autoLocksRef.current.bpm || JOURNEYS[journeyRef.current?.id]?.endless || riffHoldRef.current > Date.now()) { scheduleBurst(); return; }
      // Rise only ever pushes forward
      const fwd = JOURNEYS[journeyRef.current?.id]?.epic ? BURSTS.filter(x => x.f > 1) : BURSTS;
      const pool = smoothRef.current >= 0.5 ? fwd.filter(x => !x.snap) : fwd;
      let r = Math.random() * pool.reduce((a, x) => a + x.w, 0), b = pool[0];
      for (const x of pool) { if ((r -= x.w) < 0) { b = x; break; } }
      const bars = 4 + Math.floor(Math.random() * 5);
      if (b.snap && Math.random() < 0.75) {
        leadTempoRef.current = Math.min(480, Math.max(40, st.bpm * b.f)) / st.bpm;
        burstT = setTimeout(() => {
          if (cancelled) return;
          leadTempoRef.current = 1;
          scheduleBurst();
        }, bars * 4 * 60000 / st.bpm);
        return;
      }
      burstHome = st.bpm;
      const to = Math.round(Math.min(480, Math.max(40, burstHome * b.f)));
      tempoSnapRef.current = b.snap;
      setBpm(to);
      burstT = setTimeout(() => {
        if (cancelled) return;
        // A Rise riff took the tempo over mid-burst: leave it there
        if (riffHoldRef.current > Date.now()) { burstHome = null; scheduleBurst(); return; }
        tempoSnapRef.current = b.snap;
        setBpm(burstHome); burstHome = null;
        scheduleBurst();
      }, bars * 4 * 60000 / to);
    };
    scheduleBurst();

    const pickNext = () => {
      if (cancelled) return;
      if (loopOnRef.current) { timeout = setTimeout(pickNext, 1000); return; }
      const { sel: cur } = stRef.current;
      const all = buildCatalogue();
      const outsideOpts = all.filter(e => e.fam.outside && (!cur || e.pat !== cur.pattern));
      const catalogue = all.filter(e => !e.fam.outside);

      // Now and then, a passing outside scale (only when the outside toggle is on)
      let entry = null;
      if (outsideOpts.length && Math.random() < OUTSIDE_CHANCE)
        entry = pickOutside(outsideOpts);

      // Journey: walk toward its brightness target one note at a time (a one-note
      // change, or a note added / dropped), Storm also pulled toward its tension.
      // Far from the target (the start) it jumps straight there instead.
      // ♥ likes bend every brightness target toward the liked brightness, and
      // now and then bring back a liked scale outright
      const likes = likesRef.current, likeB = likes.length ? likedMean(likes, "b") : null;
      const neon = isNeon(stRef.current), desert = isDesert(stRef.current);
      const bend = b => { if (b === null) return b; if (likeB) b += likeB.k * 0.6 * (likeB.v - b); return neon ? b + 0.35 * (0.7 - b) : b; };
      const jv = journeyRef.current?.vals, jb = jv ? bend(jv.b) : null;
      // Desert: mostly a Middle Eastern scale (in a journey, one near its brightness)
      if (!entry && desert && Math.random() < 0.7) {
        const cands = DESERT_SCALES.map(([pat, w]) => ({ e: catalogue.find(e => e.pat === pat), w }))
          .filter(c => c.e && c.e.pat !== cur?.pattern && (jb === null || Math.abs(normalizedBrightness(c.e.pat) - jb) <= 0.2));
        let r = Math.random() * cands.reduce((a, c) => a + c.w, 0);
        for (const c of cands) if ((r -= c.w) < 0) { entry = c.e; break; }
      }
      // (in a journey, only a liked scale near where the journey is heading)
      if (!entry && likes.length) {
        const lp = likedPick(likes, "pat", catalogue.map(e => e.pat));
        if (lp !== null && lp !== cur?.pattern && Math.random() < 0.25 && (jb === null || Math.abs(normalizedBrightness(lp) - jb) <= 0.15))
          entry = catalogue.find(e => e.pat === lp) || null;
      }
      if (!entry && jv && cur && !isOutsideId(cur.id) && Math.abs(normalizedBrightness(cur.pattern) - jb) <= 0.12) {
        const scored = catalogue.filter(e => e.pat !== cur.pattern).map(e => {
          const d = popcount(e.pat ^ cur.pattern);
          let sc = Math.abs(normalizedBrightness(e.pat) - jb) + 0.03 * d + Math.random() * 0.02;
          if (jv.tn !== undefined) sc += 0.4 * Math.abs(tensionOf(patSemis(e.pat)) - jv.tn);
          return { e, sc };
        }).sort((x, y) => x.sc - y.sc);
        if (scored.length) entry = scored[Math.floor(Math.random() * Math.min(3, scored.length))].e;
      }

      // Brightness-aware selection — priority: slider / lock / arc override > EEG > random
      const override = overrideTargetRef.current;
      const brainTarget = eegBrainTarget(eegDataRef.current, BRIGHTNESS_CONFIG);
      if (brainTarget !== null) setEegTarget(brainTarget);
      const brightTarget = bend(override !== null ? override : brainTarget ?? (likeB && Math.random() < likeB.k ? likeB.v : neon ? 0.7 : null));
      if (!entry && brightTarget !== null) {
        const catFlat = catalogue.map(e => ({ familyId: e.fam.id, modeIdx: e.modeIdx, pattern: e.fam.modes[e.modeIdx] }));
        // A set target (slider, lock, arc) is held tighter than EEG wandering
        const tol = override !== null ? BRIGHTNESS_CONFIG.randomTolerance : BRIGHTNESS_CONFIG.randomTolerance * 2;
        const picked = randomAtBrightness(brightTarget, tol, catFlat, cur?.pattern, BRIGHTNESS_CONFIG)
          ?? findClosestScale(brightTarget, catFlat, cur?.pattern, BRIGHTNESS_CONFIG);
        if (picked) {
          const fam = catalogue.find(e => e.fam.id === picked.familyId && e.modeIdx === picked.modeIdx)?.fam;
          if (fam) entry = { fam, modeIdx: picked.modeIdx, pat: picked.pattern };
        }
      }
      if (!entry) {
        const options = catalogue.filter(e => !cur || e.fam.modes[e.modeIdx] !== cur.pattern);
        entry = options[Math.floor(Math.random() * options.length)];
      }
      const rhythm     = RHYTHMS[Math.floor(Math.random() * RHYTHMS.length)];
      const arpDir     = DIRS[Math.floor(Math.random() * DIRS.length)];
      const chordVoice = VOICES[Math.floor(Math.random() * VOICES.length)];
      const likeT = likes.length ? likedMean(likes, "bpm", true) : null;
      const bendT = b => { if (likeT) b *= Math.pow(likeT.v / b, likeT.k * 0.5); return desert ? b * Math.pow(66 / b, 0.5) : b; };
      let bpm          = Math.round(bendT(driftBpm(stRef.current.bpm)));

      const ac = getCtx();
      if (ac.state === "suspended") ac.resume();

      pick(entry.fam, entry.modeIdx, entry.fam.modes[entry.modeIdx]);
      const _al = autoLocksRef.current;
      const J0 = journeyRef.current;
      const gap = monasticModeRef.current ? 180000 : 12000 + Math.random() * 4000;
      // Smooth: each setting changes on fewer picks (down to 40%) and at its own
      // moment somewhere in the gap before the next pick, never all at once
      const sm = smoothRef.current;
      const maybe = () => Math.random() < 1 - 0.6 * sm;
      const later = (fn) => {
        if (!sm) { fn(); return; }
        laterTs.push(setTimeout(() => { if (!cancelled) fn(); }, Math.random() * sm * gap * 0.9));
      };
      if (_al.rhythm && maybe())     later(() => setRhythm(rhythm));
      if (_al.arpDir && maybe())     later(() => setArpDir(arpDir));
      // Off ~27% of the time; 5s, 6s and bar-filling mixes favoured
      if (_al.grouping && maybe())   { const g = [0, 0, 0, 3, 5, 5, 6, 6, 7, "mix", "mix"][Math.floor(Math.random() * 11)]; later(() => setGrouping(g)); }
      if (_al.chordVoice && maybe()) later(() => setChordVoice(chordVoice));
      // Sound changes on ~40% of picks so it doesn't jump every time; instruments favoured over raw waves
      // Endless: soft sounds only, and a harsh one playing now is swapped out right away
      // Rise: bold sounds only, the same way
      const sleepJ = !!J0?.vals && JOURNEYS[J0.id]?.endless;
      const epicJ = !!J0?.vals && JOURNEYS[J0.id]?.epic;
      const SOFT = ["space", "space", "sine", "piano", "triangle", "duduk"];
      const BOLD = ["guitar", "guitar", "sawtooth", "sawtooth", "piano", "square", "xylo"];
      const only = sleepJ ? SOFT : epicJ ? BOLD : null;
      const curSnd = stRef.current.instrument || stRef.current.timbre;
      if (_al.sound && only && !only.includes(curSnd)) {
        const s = only[Math.floor(Math.random() * only.length)];
        if (INSTRUMENTS.includes(s)) setInstrument(s); else { setTimbre(s); setInstrument(null); }
      } else if (_al.sound && Math.random() < 0.4 && maybe()) {
        const pool = only || ["piano","piano","guitar","guitar","xylo","space","space","sine","triangle","sawtooth","duduk"];
        const s = likedPick(likes, "snd", pool) ?? pool[Math.floor(Math.random() * pool.length)];
        later(() => { if (INSTRUMENTS.includes(s)) setInstrument(s); else { setTimbre(s); setInstrument(null); } });
      }
      // Tuning changes on ~30% of picks; equal stays the most common
      // Beat style changes on ~30% of picks, only when a beat is on (never
      // switches it on or off); drive likelier when tense, break when calm
      if (_al.beat && stRef.current.beatStyle !== "off" && Math.random() < 0.3 && maybe()) {
        const e = energyRef.current;
        // Switches only within a family, so the feel holds: kit = break/drive/heavy,
        // world = downtempo/hand (hand likelier when calm). Fusion stays put.
        // Wander roams every style instead: soft and earthy when calm (brushes,
        // hand, shaman), kit grooves when tense; Endless keeps to the soft ones,
        // Rise to the kit and shaman.
        const fam = BEAT_FAMILY[stRef.current.beatStyle];
        const w = stRef.current.beatWander
          ? (sleepJ ? { brushes: 1, hand: 0.7, shaman: 0.8, desert: 0.8 }
            : epicJ ? { break: 0.6, drive: 1, heavy: 0.6, shaman: 0.5, newwave: 0.7 }
            : { brushes: 0.8 * (1 - e) ** 2, downtempo: 0.9, hand: 1 - 0.6 * e, shaman: 1, desert: 0.9 * (1 - 0.5 * e),
                break: 0.3 + 0.8 * e, drive: 0.1 + 1.2 * e, heavy: 0.6 * e, fusion: 0.35, newwave: 0.5 + 0.6 * e })
          : fam === "world" ? { downtempo: 0.4 + e, hand: 1.1 - e }
                : fam === "kit" ? { break: 1.2 - e, drive: 0.3 + 1.2 * e, heavy: 0.6 } : null;
        if (w && stRef.current.beatWander) delete w[stRef.current.beatStyle];
        if (w) {
          const ks = Object.keys(w);
          let r = Math.random() * ks.reduce((a, k) => a + w[k], 0), pickB = ks[ks.length - 1];
          for (const k of ks) { if ((r -= w[k]) < 0) { pickB = k; break; } }
          pickB = likedPick(likes, "beat", ks) ?? pickB;
          if (pickB !== stRef.current.beatStyle) later(() => { beatPhraseRef.current = true; setBeatStyle(pickB); });
          // Wandering into shaman brings the steppe with it now and then: a throat or jaw-harp drone
          if (pickB === "shaman" && stRef.current.beatWander && stRef.current.droneOn && _al.droneWave && Math.random() < 0.5)
            later(() => setDroneWave(Math.random() < 0.6 ? "throat" : "jawharp"));
          // ...into the desert, the dam
          if (pickB === "desert" && stRef.current.beatWander && stRef.current.droneOn && _al.droneWave && Math.random() < 0.5)
            later(() => setDroneWave("dam"));
          // ...and into new wave, now and then the Juno pad
          if (pickB === "newwave" && stRef.current.beatWander && stRef.current.droneOn && _al.droneWave && Math.random() < 0.5)
            later(() => setDroneWave("juno"));
        }
      }
      // Smooth: the beat sometimes rests for 1-3 picks, fading out and back in
      if (_al.beat && sm && stRef.current.beatStyle !== "off") {
        if (beatRestRef.current) { if (Date.now() > beatRestRef.current) beatRestRef.current = 0; }
        else if (Math.random() < 0.25 * sm) { const until = Date.now() + gap * (1 + Math.floor(Math.random() * 3)); later(() => { beatRestRef.current = until; }); }
      } else beatRestRef.current = 0;
      if (_al.tuning && Math.random() < 0.3 && maybe()) { const tu = ["equal", "equal", "just", "just", "pyth"][Math.floor(Math.random() * 5)]; later(() => setTuning(tu)); }
      // A journey sets tempo, reverb and sustain from its shape (a little wobble
      // around it) instead of picking them at random
      const J = journeyRef.current;
      if (_al.bpm && J?.vals && riffHoldRef.current > Date.now()) { /* a Rise riff owns the tempo */ }
      else if (_al.bpm && J?.vals) {
        const jb = bendT(J.homeBpm * J.vals.t);
        const to = Math.round(Math.min(240, Math.max(40, stRef.current.autoTempo === "drift" ? jb * (0.95 + Math.random() * 0.1) : jb)));
        bpm = to;
        later(() => { if (burstHome !== null) burstHome = to; else setBpm(to); });
      } else if (_al.bpm && stRef.current.autoTempo === "drift" && maybe()) later(() => setBpm(bpm));
      if (_al.reverb && J?.vals) { const rv = parseFloat(Math.min(1, Math.max(0, J.vals.rv + (Math.random() - 0.5) * 0.08)).toFixed(2)); later(() => setReverbAmt(rv)); }
      else if (_al.reverb && maybe()) { const rv = parseFloat((0.3 + Math.random() * 0.65).toFixed(2)); later(() => setReverbAmt(rv)); }
      if (_al.reverb && desert) { const rv = parseFloat((0.85 + Math.random() * 0.1).toFixed(2)); later(() => setReverbAmt(rv)); }   // the desert night
      if (_al.delay && J?.vals?.dl !== undefined) { const d = parseFloat(J.vals.dl.toFixed(2)); later(() => setDelayAmt(d)); }
      else if (_al.delay && maybe()) { const d = parseFloat((0.1 + Math.random() * 0.5).toFixed(2)); later(() => setDelayAmt(d)); }
      // Endless holds one slow echo (a delay time change mid-echo clicks or bends)
      if (_al.delayTime && J?.vals?.dl !== undefined) { if (stRef.current.delayTime !== 0.75) later(() => setDelayTime(0.75)); }
      else if (_al.delayTime && maybe()) { const d = parseFloat([0.125, 0.25, 0.375, 0.5, 0.75][Math.floor(Math.random() * 5)].toFixed(3)); later(() => setDelayTime(d)); }
      // Delay feedback: the journey's (Endless: long trails), otherwise the usual 0.4
      if (delayRef.current) { const fb = J?.vals?.fb ?? 0.4; later(() => glideParam(delayRef.current?.feedbackGain.gain, fb)); }
      if (_al.sustain && J?.vals) { const su = parseFloat((J.vals.su * (0.85 + Math.random() * 0.3)).toFixed(2)); later(() => setSustainMult(su)); }
      else if (_al.sustain && maybe()) { const su = [0.5, 0.7, 0.8, 1.0, 1.0, 1.0, 1.2, 1.5, 2.0][Math.floor(Math.random() * 9)]; later(() => setSustainMult(su)); }
      if (_al.droneOn && maybe())   { const on = likedPick(likes, "droneOn") ?? Math.random() > (epicJ ? 0.15 : 0.35); later(() => setDroneOn(on)); }
      const drones = sleepJ ? ["sine", "pad", "dam"] : epicJ ? ["organ", "strings"] : ["sine", "organ", "pad", "strings", "tanpura", "throat", "jawharp", "juno", "dam"];
      if (_al.droneWave && (sleepJ || epicJ) && !drones.includes(stRef.current.droneWave)) later(() => setDroneWave(sleepJ ? "pad" : "organ"));
      else if (_al.droneWave && maybe()) { const w = likedPick(likes, "drone", drones) ?? drones[Math.floor(Math.random() * drones.length)]; later(() => setDroneWave(w)); }
      if (_al.droneOct && maybe())  { const o = [-12, -24, -36][Math.floor(Math.random() * 3)]; later(() => setDroneOct(o)); }
      if (_al.droneVol && maybe())  { const v = parseFloat((0.3 + Math.random() * 0.7).toFixed(2)); later(() => setDroneVol(v)); }
      setArpOn(true);

      const scaleName = KNOWN[entry.fam.modes[entry.modeIdx]] || customNamesRef.current[entry.fam.modes[entry.modeIdx]] || `${entry.fam.id}.${entry.modeIdx}`;

      // Build EEG commentary if brain state drove the pick
      let eegNote = "";
      const _eegSnap = eegDataRef.current;
      if (_eegSnap && _eegSnap.connected && _eegSnap.bands && _eegSnap.derived) {
        const bs = ['gamma','beta','alpha','theta'].map(b => {
          const l = _eegSnap.bands[b]?.left_pct || 0, r = _eegSnap.bands[b]?.right_pct || 0;
          return (l + r) > 0.5 ? 0.5 + 0.5 * (r - l) / (l + r) : null;
        }).filter(v => v !== null);
        const hem = bs.length ? bs.reduce((a,b) => a+b,0) / bs.length : 0.5;
        const brightTarget = targetBrightness(
          { derived:             { dominant_active_band: _eegSnap.derived.dominant_active_band },
            bands:               { alpha_pct: (_eegSnap.bands.alpha.left_pct + _eegSnap.bands.alpha.right_pct) / 2,
                                   theta_pct: (_eegSnap.bands.theta.left_pct + _eegSnap.bands.theta.right_pct) / 2,
                                   beta_pct:  (_eegSnap.bands.beta.left_pct  + _eegSnap.bands.beta.right_pct)  / 2 },
            hemispheric_balance: hem },
          BRIGHTNESS_CONFIG
        );
        const dom = _eegSnap.derived.dominant_active_band || "?";
        const hemDir = hem > 0.55 ? "R" : hem < 0.45 ? "L" : "C";
        const brightLabel = brightTarget > 0.65 ? "bright" : brightTarget < 0.35 ? "dark" : "neutral";
        eegNote = `EEG → ${brightLabel} (${brightTarget.toFixed(2)}) · dom:${dom} · L/R:${hemDir} (${hem.toFixed(2)})`;
      }

      setDemoLog(prev => [{
        scaleName,
        famId: entry.fam.id, modeIdx: entry.modeIdx,
        rootNote: stRef.current.rootIdx,
        rhythm, arpDir, chordVoice, bpm,
        commentary: eegNote || `${scaleName} — ${entry.fam.n} notes · ${rhythm} · ${bpm}bpm`,
        ts: Date.now(),
      }, ...prev].slice(0, 200));

      timeout = setTimeout(pickNext, gap);
    };

    const laterTs = [];
    pickNext();
    return () => {
      cancelled = true; clearTimeout(timeout); clearTimeout(burstT); laterTs.forEach(clearTimeout); beatRestRef.current = 0; leadTempoRef.current = 1;
      if (burstHome !== null) { tempoSnapRef.current = false; setBpm(burstHome); }
    };
  }, [autoOn]); // reads live state via stRef; getCtx/pick/set* are stable

  /* ── Interval pattern match e.g. "2-2-1" or "2 2 1" ──
     Normalise to array of ints and check if any mode's interval vector starts with or contains it */
  const matchesInterval = (pattern, mode) => {
    // Only treat as interval pattern if it contains ONLY digits and separators
    if (!/^[0-9][\d\s\-,]*[0-9]$/.test(pattern.trim())) return false;
    const nums = pattern.split(/[\s\-,]+/).map(Number).filter(n => !isNaN(n) && n > 0);
    if (nums.length < 2) return false;
    const semis = toSemis(mode);
    const ivs = semis.slice(1).map((v, i) => v - semis[i]).concat(12 - semis[semis.length - 1]);
    // Check if ivs contains nums as a subsequence (contiguous)
    const str = ivs.join("-");
    return str.includes(nums.join("-"));
  };

  /* ── Filter ── */
  const filtered = useMemo(() => {
    // When favsOnly, restrict each family to only its starred modes
    // Carry origIdx so favId stays correct after filtering
    let base = ACTIVE_FAMILIES.map(f => {
      if (!favsOnly) return { ...f, origIdxs: f.modes.map((_, i) => i) };
      const origIdxs = f.modes.map((_, i) => i).filter(i => favs.has(f.id + "." + i));
      const modes = origIdxs.map(i => f.modes[i]);
      return modes.length ? { ...f, modes, origIdxs } : null;
    }).filter(Boolean);

    // Note count chip filter
    if (noteCountFilter !== null) {
      base = base.filter(f => f.n === noteCountFilter);
    }

    // Sidebar name search — filters modes by name within each family
    if (listSearch.trim()) {
      const q = listSearch.trim().toLowerCase();
      const noteNum = (q === String(parseInt(q)) && parseInt(q) >= 3 && parseInt(q) <= 8) ? parseInt(q) : null;
      base = base.map(f => {
        if (noteNum !== null) return f.n === noteNum ? f : null;
        const matchIdxs = f.modes.reduce((acc, m, mi) => {
          const name = (KNOWN[m] || customNames[m] || "").toLowerCase();
          if (name.includes(q) || f.id.toLowerCase().includes(q)) acc.push(mi);
          return acc;
        }, []);
        if (!matchIdxs.length) return null;
        return { ...f, modes: matchIdxs.map(mi => f.modes[mi]), origIdxs: matchIdxs.map(mi => f.origIdxs ? f.origIdxs[mi] : mi) };
      }).filter(Boolean);
    }

    // Header filter (existing — unchanged)
    if (!filter.trim()) return base;
    const terms = filter.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
    return base.filter(f =>
      terms.some(t =>
        f.id.includes(t) ||
        GRP_PFX[f.n].startsWith(t) ||
        f.modes.some(m =>
          toBin(m).includes(t) ||
          (KNOWN[m] || customNames[m] || "").toLowerCase().includes(t) ||
          matchesInterval(t, m)
        )
      )
    );
  }, [ACTIVE_FAMILIES, filter, favs, favsOnly, customNames, listSearch, noteCountFilter]);

  const grouped = useMemo(() => {
    const g = {};
    for (const f of filtered) (g[grpKey(f)] = g[grpKey(f)] || []).push(f);
    return g;
  }, [filtered]);

  const commitName = (pattern) => {
    const trimmed = nameInput.trim();
    setCustomNames(prev => {
      const next = { ...prev };
      if (trimmed) next[pattern] = trimmed; else delete next[pattern];
      return next;
    });
    setEditingName(null);
  };

  const toggleFav = (e, id) => {
    e.stopPropagation();
    setFavs(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      try { localStorage.setItem("chloe2-favs", JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  /* ── Selection ── */
  const pick = (fam, origIdx, pattern) => {
    setSel({ id: `${fam.id}.${origIdx}`, pattern });
    arpIdxRef.current = 0;
  };

  const pickById = (id) => {
    const dotPos = id.lastIndexOf(".");
    const fam = FAMILIES.find(f => f.id === id.slice(0, dotPos));
    const origIdx = parseInt(id.slice(dotPos + 1));
    if (fam && fam.modes[origIdx] !== undefined) pick(fam, origIdx, fam.modes[origIdx]);
  };

  // Keep prePinSel tracking whatever is selected when NOT on the pinned scale
  useEffect(() => {
    if (pinnedScale && sel && sel.id !== pinnedScale.id)
      setPrePinSel({ id: sel.id, pattern: sel.pattern });
  }, [sel, pinnedScale]);

  const onPinned = !!pinnedScale && sel?.id === pinnedScale.id;

  const handlePin = () => {
    if (!sel) return;
    setPinnedScale({ id: sel.id, pattern: sel.pattern });
  };
  const handleABToggle = () => {
    if (!pinnedScale) return;
    if (onPinned) { if (prePinSel) pickById(prePinSel.id); }
    else pickById(pinnedScale.id);
  };
  const handleUnpin = () => { setPinnedScale(null); setPrePinSel(null); };

  /* ── Save / replay moments ── */
  const saveMoment = () => {
    const st = stRef.current;
    if (!st.sel) return;
    const dotPos = st.sel.id.lastIndexOf(".");
    const famId = st.sel.id.slice(0, dotPos);
    const modeIdx = parseInt(st.sel.id.slice(dotPos + 1));
    const scaleName = KNOWN[st.sel.pattern] || customNames[st.sel.pattern] || st.sel.id;
    setSavedMoments(prev => [{
      ts: Date.now(),
      scaleName,
      famId, modeIdx,
      rootIdx: st.rootIdx,
      timbre: st.timbre,
      bpm: st.bpm,
      melMode: st.melMode,
      arpDir: st.arpDir,
      arpOct: st.arpOct,
      grouping: st.grouping,
      rhythm: st.rhythm,
      chordVoice: st.chordVoice,
      instrument: st.instrument,
      noteVol: st.noteVol,
      reverbAmt: st.reverbAmt,
      delayAmt: st.delayAmt,
      aRef: st.aRef,
      beatVol,
      droneOn, droneVol, droneTone, droneWave, droneOct,
      beatOn,
    }, ...prev]);
  };

  const playMoment = (m) => {
    const fam = FAMILIES.find(f => f.id === m.famId);
    if (!fam || fam.modes[m.modeIdx] === undefined) return;
    wake();
    setDemoOn(false); setAutoOn(false); setLoopOn(false);
    pick(fam, m.modeIdx, fam.modes[m.modeIdx]);
    setRootIdx(m.rootIdx);
    setTimbre(m.timbre);
    setBpm(m.bpm);
    setMelMode(m.melMode);
    setArpDir(m.arpDir);
    if (m.arpOct) setArpOct(m.arpOct);
    setGrouping(m.grouping || 0);
    setRhythm(m.rhythm);
    setChordVoice(m.chordVoice);
    if (m.instrument !== undefined) setInstrument(m.instrument);
    setNoteVol(m.noteVol);
    setReverbAmt(m.reverbAmt);
    setDelayAmt(m.delayAmt);
    setARef(m.aRef);
    setBeatVol(m.beatVol);
    setDroneVol(m.droneVol);
    setDroneTone(m.droneTone);
    setDroneWave(m.droneWave);
    setDroneOct(m.droneOct);
    setDroneOn(m.droneOn);
    setBeatOn(m.beatOn);
    setArpOn(true);
  };

  const selSemis = morphSemis ? new Set(morphSemis) : sel ? new Set(toSemis(sel.pattern)) : new Set();
  const selNotes = sel ? toSemis(sel.pattern).map(s => CHROMATIC[(rootIdx + s) % 12]) : [];
  const selIvs = sel
    ? (() => { const s = toSemis(sel.pattern); return s.slice(1).map((v, i) => v - s[i]).concat(12 - s[s.length - 1]); })()
    : [];
  const selName = sel ? (KNOWN[sel.pattern] || customNames[sel.pattern] || null) : null;

  const toggleGrp = k => setExpanded(p => { const s = new Set(p); s.has(k) ? s.delete(k) : s.add(k); return s; });
  const isExp = k => (filter.trim() || listSearch.trim() || noteCountFilter !== null) ? true : expanded.has(k);
  const wake = () => getCtx();

  const buildURL = useCallback(() => {
    const p = new URLSearchParams();
    if (rootIdx)     p.set("r",  rootIdx);
    if (timbre !== "sine") p.set("t", timbre);
    if (instrument)  p.set("i",  instrument);
    if (noteVol !== 0.7)   p.set("v",  noteVol.toFixed(2));
    if (reverbAmt !== 0.75) p.set("rv", reverbAmt.toFixed(2));
    if (delayAmt  !== 0.15) p.set("dl", delayAmt.toFixed(2));
    if (sustainMult !== 1) p.set("su", sustainMult.toFixed(2));
    if (bpm !== 100) p.set("b",  bpm);
    if (filter)      p.set("f",  filter);
    if (sel)         p.set("s",  sel.id);
    if (aRef !== 440) p.set("a", aRef);
    if (droneOct)    p.set("do", droneOct);
    if (droneOn)     p.set("dr", "1");
    if (droneWave !== "tanpura") p.set("dw", droneWave);
    if (melMode)     p.set("m",  "1");
    if (grouping)    p.set("g",  grouping);
    if (!blend)      p.set("bl", "0");
    if (!tempoGlide) p.set("tg", "0");
    if (!soundBlend) p.set("sb", "0");
    if (tuning !== "equal") p.set("tu", tuning);
    if (autoTempo !== "bursts") p.set("at", autoTempo);
    if (symphonic) p.set("sy", "1");
    if (beatStyle !== "off") p.set("bt", beatStyle);
    if (beatWander) p.set("bw", "1");
    if (journey !== "off") { p.set("jo", journey); if (journeyMins !== 15) p.set("jm", journeyMins); if (sleepMins) p.set("sl", sleepMins); }
    if (smooth) p.set("sm", Math.round(smooth * 100));
    // Only differences from the defaults travel: al = unticked, an = ticked-but-off-by-default
    const autoOff = Object.keys(AUTO_LOCKS_DEFAULT).filter(k => AUTO_LOCKS_DEFAULT[k] && !autoLocks[k]);
    const autoOn  = Object.keys(AUTO_LOCKS_DEFAULT).filter(k => !AUTO_LOCKS_DEFAULT[k] && autoLocks[k]);
    if (autoOff.length) p.set("al", autoOff.join(","));
    if (autoOn.length)  p.set("an", autoOn.join(","));
    if (sidebarW !== 520) p.set("sw", sidebarW);
    const qs = p.toString();
    return window.location.origin + window.location.pathname + (qs ? "?" + qs : "");
  }, [rootIdx, timbre, instrument, noteVol, reverbAmt, delayAmt, sustainMult, bpm, filter, sel, aRef, droneOct, droneOn, droneWave, melMode, grouping, blend, tempoGlide, soundBlend, tuning, autoTempo, symphonic, beatStyle, beatWander, journey, journeyMins, sleepMins, smooth, autoLocks, sidebarW]);

  // Record button: start tapping the master output; stop → download the WAV
  const toggleRec = useCallback(async () => {
    if (recording) {
      const blob = recording.rec.stop();
      setRecording(null);
      const d = new Date(), p2 = n => String(n).padStart(2, "0");
      const name = sel ? (KNOWN[sel.pattern] || customNames[sel.pattern] || sel.id) : "chloe";
      const safe = String(name).replace(/[^A-Za-z0-9♯♭#-]+/g, "-").replace(/^-|-$/g, "");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `chloe-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}-${safe}.wav`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return;
    }
    try {
      const ac = getCtx();
      if (ac.state === "suspended") await ac.resume();
      const rec = await startRecorder(ac);
      setRecSecs(0);
      setRecording({ rec, t0: Date.now() });
    } catch (e) { console.error("recorder:", e); }
  }, [recording, sel, customNames, getCtx]);
  toggleRecRef.current = toggleRec;
  useEffect(() => {
    if (!recording) return;
    const iv = setInterval(() => setRecSecs(Math.floor((Date.now() - recording.t0) / 1000)), 250);
    return () => clearInterval(iv);
  }, [recording]);

  const copyURL = useCallback(() => {
    const url = buildURL();
    // Update browser URL without reload
    window.history.replaceState(null, "", url);
    navigator.clipboard?.writeText(url).then(() => {
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 2000);
    }).catch(() => {
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 2000);
    });
  }, [buildURL]);

  const onDragStart = useCallback((e) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: sidebarW };
    const onMove = (ev) => {
      const delta = dragRef.current.startX - ev.clientX;
      setSidebarW(Math.max(220, Math.min(520, dragRef.current.startW + delta)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [sidebarW]);

  const onListDragStart = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX, startW = listW;
    const onMove = (ev) => setListW(Math.max(220, Math.min(600, startW + ev.clientX - startX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [listW]);

  /* ══════════════════════════════════════
     RENDER
  ══════════════════════════════════════ */
  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") setShowHelp(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const likeNow = () => {
    const st = stRef.current;
    const l = {
      t: Date.now(), pat: st.sel?.pattern ?? null, b: st.sel ? normalizedBrightness(st.sel.pattern) : null,
      bpm: st.bpm, beat: st.beatStyle, droneOn: !!st.droneOn, drone: st.droneOn ? st.droneWave : null,
      snd: st.instrument || st.timbre, steppe: isSteppe(st),
    };
    likesRef.current = [...likesRef.current, l].slice(-LIKE_KEEP);
    try { localStorage.setItem("chloe-likes", JSON.stringify(likesRef.current)); } catch {}
    setLikeFlash(Date.now()); setTimeout(() => setLikeFlash(f => (Date.now() - f >= 2500 ? 0 : f)), 2600);
    track("like", `like · ${journeyRef.current?.id ?? "free"} · beat ${l.beat} · drone ${l.drone ?? "off"} · ${l.snd} · ${l.bpm} bpm · bright ${l.b?.toFixed(2)}`);
  };
  const stopAuto = () => { setAutoOn(false); setLoopOn(false); setArpOn(false); setDemoComment(""); setDemoRequest(""); setShowDemoLog(false); setEegTarget(null); setOverrideTarget(null); setBrightnessLocked(false); setClaudeOverride(null); setClaudeBpmOverride(null); setSustainMult(1); overrideTargetRef.current = null; brightnessLockedRef.current = false; claudeOverrideRef.current = null; claudeBpmOverrideRef.current = null; };

  /* ── LISTEN VIEW ── */
  if (view === "listen") {
    const J = journey === "off" ? "dawn" : journey;
    const playingNow = autoOn;
    const W = 600, H = 120;
    // A journey's shape: brightness as a line (up = bright), Storm's intensity as a shaded hill
    const curve = (id, w, h, pad = 6) => {
      // (the hill is the bigger of tension and orchestra energy, so Rise shows its build)
      const pts = [...Array(61).keys()].map(i => { const v = journeyAt(JOURNEYS[id], i / 60); return { x: pad + (w - 2 * pad) * i / 60, b: v.b, tn: v.tn === undefined ? undefined : Math.max(v.tn, v.e ?? 0) }; });
      const y = b => pad + (h - 2 * pad) * (1 - (b - 0.25) / 0.5);
      const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${y(p.b).toFixed(1)}`).join(" ");
      const hill = pts[0].tn === undefined ? null
        : `M${pad},${h - pad} ` + pts.map(p => `L${p.x.toFixed(1)},${(h - pad - (h - 2 * pad) * 0.8 * p.tn).toFixed(1)}`).join(" ") + ` L${w - pad},${h - pad} Z`;
      return { line, hill, y, pad };
    };
    const BLURB = {
      dawn: "Dark to bright. For waking up and getting going.",
      dusk: "Bright to dark. For winding down.",
      descent: "Down into the dark, and back up into the light.",
      storm: "Calm, a gathering storm, calm again.",
      rise: "Builds and builds: bright, driving and big. For energy.",
      endless: "Never ends. A slow, calm wander, for sleep.",
    };
    const play = () => {
      wake();
      track(`listen/play/${J}`);
      if (journey === "off") setJourney(J);
      if (J === "endless") {
        setSmooth(Math.max(smooth, 0.9));   // sleep: hide every seam
        if (!["sine", "pad", "dam"].includes(droneWave)) setDroneWave("pad");   // no tanpura buzz
      }
      else if (JOURNEYS[J].epic) setSmooth(0.5);   // lively, but no double/half-time snaps
      else if (!smooth) setSmooth(0.7);
      setDemoOn(false); setAutoOn(true);
    };
    const f = journeyNow?.f ?? 0;
    const big = curve(J, W, H, 10);
    const dotB = journeyNow ? journeyAt(JOURNEYS[J], f).b : null;
    const chip = (on) => ({
      background: on ? K.a + "22" : "none", color: on ? K.a : K.t1,
      border: `1px solid ${on ? K.a : K.br}`, borderRadius: 20, padding: "6px 14px",
      fontSize: 11, cursor: "pointer", fontFamily: "inherit",
    });
    return (
      <div style={{ background: K.bg, color: K.t1, minHeight: "100vh", fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace", display: "flex", flexDirection: "column", alignItems: "center", padding: "24px 16px 40px" }}>
        <style>{`* { box-sizing: border-box; } button:hover:not(:disabled) { filter: brightness(1.18); }`}</style>
        <div style={{ width: "100%", maxWidth: 720, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 28 }}>
          <div>
            <div style={{ color: K.title, fontSize: 22, letterSpacing: 8, fontWeight: 600 }}>CHLOE</div>
            <div style={{ color: K.t2, fontSize: 11, marginTop: 4 }}>generative music that takes you somewhere</div>
          </div>
          <button onClick={() => goView("studio")} title="The full Chloe: every scale, every setting" style={{ ...chip(false), borderRadius: 4, fontSize: 10, letterSpacing: 2, whiteSpace: "nowrap", flexShrink: 0 }}>STUDIO →</button>
        </div>

        {/* Stage: the light show, with the journey's path and where you are on it */}
        <div style={{ width: "100%", maxWidth: 720, position: "relative", height: 260, borderRadius: 10, overflow: "hidden", border: `1px solid ${K.br}`, background: K.bg2 }}>
          <div style={{ position: "absolute", inset: 0, opacity: playingNow ? 0.85 : 0.25, transition: "opacity 2s" }}>
            <Visualizer analyserRef={analyserRef} playing={playing} rootIdx={rootIdx} active={selSemis} K={K} />
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ position: "absolute", left: 0, right: 0, bottom: 0, width: "100%", height: 110 }}>
            {big.hill && <path d={big.hill} fill={JOURNEY_COLOR} opacity={0.12} />}
            <path d={big.line} fill="none" stroke={JOURNEY_COLOR} strokeWidth={2} opacity={0.35} vectorEffect="non-scaling-stroke" />
            {dotB !== null && <circle cx={10 + (W - 20) * f} cy={big.y(dotB)} r={5} fill={JOURNEY_COLOR} />}
          </svg>
          <div style={{ position: "absolute", top: 14, left: 16, right: 16, display: "flex", justifyContent: "space-between", fontSize: 11, color: K.txt, textShadow: "0 1px 4px #000" }}>
            {/* While a scale change moves note by note, the wheel shows the notes sounding now and the name is where it's heading */}
            <span title={morphSemis ? "Changing one note at a time into this scale" : undefined}>
              {playingNow && sel ? (morphSemis ? <><span style={{ color: JOURNEY_COLOR }}>→ </span>{selName || sel.id}</> : (selName || sel.id)) : ""}
            </span>
            <span style={{ color: JOURNEY_COLOR, fontVariantNumeric: "tabular-nums" }}>
              {journeyNow ? (journeyNow.endless ? `${mmss(journeyNow.el)} · endless` : journeyNow.ending ? "ending…" : journeyNow.arrived ? "arrived" : `${mmss(journeyNow.el)} / ${journeyMins}:00`) : ""}
              {sleepLeft !== null && (sleepLeft <= SLEEP_FADE * 1000 ? " · fading out…" : ` · sleep in ${mmss(sleepLeft)}`)}
            </span>
          </div>
        </div>

        {/* Journeys */}
        <div style={{ width: "100%", maxWidth: 720, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(124px, 1fr))", gap: 10, marginTop: 18 }}>
          {Object.keys(JOURNEYS).map(id => {
            const on = J === id, c = curve(id, 140, 40, 3);
            return (
              <button key={id} onClick={() => {
                setJourney(id);
                if (id !== J) track(`listen/journey/${id}`);
                // Rise wants the whole band: orchestra on, and a kit beat (drive)
                if (JOURNEYS[id].epic) {
                  if (!symphonic) { setSymphonic(true); getOrchestra(getCtx()); }
                  if (BEAT_FAMILY[beatStyle] !== "kit") { setBeatStyle("drive"); getKit(getCtx()); }
                }
              }} style={{
                background: on ? K.bg3 : K.bg2, border: `1px solid ${on ? JOURNEY_COLOR : K.br}`, borderRadius: 8,
                padding: "12px 12px 10px", textAlign: "left", cursor: "pointer", fontFamily: "inherit", color: K.t1,
                display: "flex", flexDirection: "column", justifyContent: "flex-start",
              }}>
                <div style={{ color: on ? JOURNEY_COLOR : K.title, fontSize: 13, letterSpacing: 2, marginBottom: 6 }}>{id.toUpperCase()}</div>
                <svg viewBox="0 0 140 40" style={{ width: "100%", height: 40, display: "block", marginBottom: 6 }}>
                  {c.hill && <path d={c.hill} fill={JOURNEY_COLOR} opacity={0.15} />}
                  <path d={c.line} fill="none" stroke={on ? JOURNEY_COLOR : K.t2} strokeWidth={1.5} />
                </svg>
                <div style={{ color: K.t2, fontSize: 10, lineHeight: 1.45 }}>{BLURB[id]}</div>
              </button>
            );
          })}
        </div>

        {/* Length + extras */}
        <div style={{ width: "100%", maxWidth: 720, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 18 }}>
          {J === "endless" ? <span style={{ color: K.t2, fontSize: 11 }}>∞ plays until you stop it</span>
            : JOURNEY_MINS.map(m => <button key={m} onClick={() => setJourneyMins(m)} style={chip(journeyMins === m)}>{m} min</button>)}
          <span style={{ flex: 1 }} />
          <button onClick={() => { setSymphonic(v => !v); if (!symphonic) getOrchestra(getCtx()); }} style={chip(symphonic)}>orchestra</button>
          <button onClick={() => { const v = beatStyle === "off" ? (J === "endless" ? "brushes" : JOURNEYS[J].epic ? "drive" : "downtempo") : "off"; setBeatStyle(v); if (v !== "off") getKit(getCtx()); }} style={chip(beatStyle !== "off")}>drums</button>
          <button onClick={() => { wake(); setDroneOn(v => !v); }} style={chip(droneOn)}>drone</button>
        </div>

        {/* Drum feel, while drums are on */}
        {beatStyle !== "off" && (
          <div style={{ width: "100%", maxWidth: 720, display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
            <button onClick={() => setBeatWander(w => !w)} title="Wander: the drums roam across every style as the music goes, from brushes and shaman drums to breakbeats" style={{ ...chip(beatWander), fontSize: 10, padding: "4px 11px" }}>wander</button>
            {[["brushes", "brushes"], ["downtempo", "downtempo"], ["hand", "hand drums"], ["shaman", "shaman"], ["desert", "desert"], ["newwave", "new wave"], ["break", "breakbeat"], ["drive", "drive"]].map(([v, l]) => (
              <button key={v} onClick={() => { setBeatStyle(v); setBeatWander(false); }} style={{ ...chip(beatStyle === v && !beatWander), fontSize: 10, padding: "4px 11px", ...(beatWander && beatStyle === v ? { borderStyle: "dashed" } : {}) }}>{l}</button>
            ))}
          </div>
        )}

        {/* Sleep timer */}
        <div style={{ width: "100%", maxWidth: 720, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 14 }}>
          <span title={`Stop after this long, fading out gently over the last ${SLEEP_FADE} seconds. Counts from when you press play.`} style={{ color: K.t2, fontSize: 11, marginRight: 4, cursor: "help" }}>sleep timer</span>
          {[0, ...SLEEP_MINS].map(m => (
            <button key={m} onClick={() => setSleepMins(m)} style={{ ...chip(sleepMins === m), fontSize: 10, padding: "4px 11px" }}>{m ? `${m} min` : "off"}</button>
          ))}
          {sleepLeft !== null && <span style={{ color: JOURNEY_COLOR, fontSize: 11, marginLeft: 4, fontVariantNumeric: "tabular-nums" }}>{sleepLeft <= SLEEP_FADE * 1000 ? "fading out…" : `stops in ${mmss(sleepLeft)}`}</span>}
        </div>

        {/* Play */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginTop: 30 }}>
          <button onClick={() => playingNow ? stopAuto() : play()} style={{
            width: 84, height: 84, borderRadius: "50%", border: `2px solid ${JOURNEY_COLOR}`,
            background: playingNow ? JOURNEY_COLOR : "none", color: playingNow ? "#000" : JOURNEY_COLOR,
            fontSize: 28, cursor: "pointer", fontFamily: "inherit", lineHeight: 1,
          }}>{playingNow ? "■" : "▶"}</button>
          {playingNow && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <button onClick={likeNow} title="More of this: Chloe leans toward what's playing now (the scale's brightness, tempo, drums, drone and sound)" style={{
                ...chip(Date.now() - likeFlash < 2500), borderRadius: 20, fontSize: 15, padding: "6px 18px",
                borderColor: "#e05a6a", color: Date.now() - likeFlash < 2500 ? "#000" : "#ff8a96",
                background: Date.now() - likeFlash < 2500 ? "#ff8a96" : "none", transition: "all .3s",
              }}>♥ more of this</button>
              <span style={{ fontSize: 10, color: K.t2, minHeight: 13 }}>{Date.now() - likeFlash < 2500 ? "got it, heading that way" : ""}</span>
            </div>
          )}
          <button onClick={toggleRec} title="Record the journey. If it's still recording when the journey ends, Chloe fades out and saves the WAV for you." style={{ ...chip(!!recording), borderColor: recording ? "#c0392b" : K.br, color: recording ? "#e74c3c" : K.t2 }}>
            {recording ? `⏹ recording ${Math.floor(recSecs / 60)}:${String(recSecs % 60).padStart(2, "0")}` : "⏺ record this journey"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: K.bg, color: K.t1, height: "100vh", fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', 'Consolas', 'Courier New', monospace", display: "flex", flexDirection: "column", fontSize: 12, overflow: "hidden" }}>
      {showHelp && <HelpModal onClose={() => setShowHelp(false)} K={K} />}
      {showWelcome && <WelcomeModal onClose={() => { setShowWelcome(false); localStorage.setItem("chloe-welcomed", "1"); }} K={K} />}
      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 3px; }
        ::-webkit-scrollbar-track { background: ${K.bg}; }
        ::-webkit-scrollbar-thumb { background: ${K.br}; border-radius: 2px; }
        button:hover:not(:disabled) { filter: brightness(1.18); }
        input[type=range] { -webkit-appearance: none; appearance: none; height: 3px; border-radius: 2px; outline: none; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: ${K.a}; cursor: pointer; }
      `}</style>

      {/* ── HEADER ── */}
      <div style={{ background: K.bg2, borderBottom: `1px solid ${K.br}`, padding: "10px 18px", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
        <div style={{ userSelect: "none" }}>
          <div style={{ fontFamily: "'Trebuchet MS', 'Gill Sans', 'Century Gothic', sans-serif", fontSize: 20, fontWeight: 800, letterSpacing: 4, color: K.title, lineHeight: 1 }}>CHLOE</div>
          <div style={{ fontSize: 8, color: K.t2, letterSpacing: 5 }}>SCALE EXPLORER</div>
        </div>

        <div style={{ width: 1, height: 32, background: K.br, flexShrink: 0 }} />

        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {PRESETS.map(p => (
            <button key={p.l} onClick={() => setFilter(f => f === p.f ? "" : p.f)} style={{
              background: filter === p.f ? K.a : K.bg3,
              color: filter === p.f ? "#000" : K.txt,
              border: `1px solid ${filter === p.f ? K.a : K.br}`,
              borderRadius: 3, padding: "4px 9px",
              fontSize: 9, cursor: "pointer", fontFamily: "inherit", letterSpacing: 1,
            }}>{p.l}</button>
          ))}
        </div>

        <button onClick={() => setFavsOnly(p => !p)} style={{
          background: favsOnly ? K.a : K.bg3,
          color: favsOnly ? "#000" : favs.size > 0 ? K.a : K.txt,
          border: `1px solid ${favsOnly ? K.a : favs.size > 0 ? K.a + "88" : K.br}`,
          borderRadius: 3, padding: "4px 9px", fontSize: 10,
          cursor: "pointer", fontFamily: "inherit", letterSpacing: 1, flexShrink: 0,
        }}>
          {favsOnly ? "★ favs" : "☆ favs"}{favs.size > 0 ? " (" + favs.size + ")" : ""}
        </button>

        <div style={{ flex: 1 }} />

        <div style={{ position: "relative" }}>
          <input
            value={filter} onChange={e => setFilter(e.target.value)}
            placeholder="filter: hep-6, Dorian, 2-2-1, pen…"
            style={{ background: K.bg3, border: `1px solid ${K.br}`, color: K.t1, padding: "6px 28px 6px 10px", borderRadius: 4, fontFamily: "inherit", fontSize: 11, width: 280, outline: "none" }}
          />
          {filter && (
            <button onClick={() => setFilter("")} style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: K.t2, cursor: "pointer", fontSize: 15, padding: 0, lineHeight: 1 }}>×</button>
          )}
        </div>

        <a href="https://ko-fi.com/ronnienorth" target="_blank" rel="noreferrer" style={{
          background: K.bg3, color: K.txt,
          border: `1px solid ${K.br}`,
          borderRadius: 3, padding: "5px 12px",
          fontSize: 9, cursor: "pointer", fontFamily: "inherit", letterSpacing: 1,
          flexShrink: 0, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5,
        }}><span style={{color:"#e03030", fontSize:16, lineHeight:1}}>♥</span> tip</a>
        {(autoOn || demoOn) && <button onClick={likeNow} title="More of this: Auto leans toward what's playing now (the scale's brightness, tempo, drums, drone and sound). Each like's pull halves every 15 minutes." style={{
          background: Date.now() - likeFlash < 2500 ? "#ff8a96" : K.bg3, color: Date.now() - likeFlash < 2500 ? "#000" : "#ff8a96",
          border: "1px solid #e05a6a", borderRadius: 3, padding: "5px 12px",
          fontSize: 9, cursor: "pointer", fontFamily: "inherit", letterSpacing: 1, transition: "all .3s", flexShrink: 0,
        }}>♥ more of this</button>}
        <button onClick={toggleRec} title="Record exactly what you hear to a 24-bit stereo WAV. Click again to stop and download." style={{
          background: recording ? "#c0392b" : K.bg3,
          color: recording ? "#fff" : K.txt,
          border: `1px solid ${recording ? "#c0392b" : K.br}`,
          borderRadius: 3, padding: "5px 12px",
          fontSize: 9, cursor: "pointer", fontFamily: "inherit", letterSpacing: 1,
          transition: "all .2s", flexShrink: 0, fontVariantNumeric: "tabular-nums",
        }}>{recording ? `⏹ ${Math.floor(recSecs / 60)}:${String(recSecs % 60).padStart(2, "0")}` : "⏺ rec"}</button>
        <button onClick={() => goView("listen")} title="Listen: pick a journey and press play" style={{
          background: K.bg3, color: K.txt, border: `1px solid ${K.br}`, borderRadius: 3,
          padding: "4px 10px", fontSize: 9, letterSpacing: 2, cursor: "pointer", fontFamily: "inherit",
        }}>LISTEN</button>
        <button onClick={copyURL} style={{
          background: urlCopied ? K.a : K.bg3,
          color: urlCopied ? "#000" : K.txt,
          border: `1px solid ${urlCopied ? K.a : K.br}`,
          borderRadius: 3, padding: "5px 12px",
          fontSize: 9, cursor: "pointer", fontFamily: "inherit", letterSpacing: 1,
          transition: "all .2s", flexShrink: 0,
        }}>{urlCopied ? "✓ copied!" : "⬡ share"}</button>
        <button onClick={() => setShowHelp(true)} style={{
          background: K.bg3, color: K.txt,
          border: `1px solid ${K.br}`,
          borderRadius: "50%", width: 26, height: 26,
          fontSize: 12, cursor: "pointer", fontFamily: "inherit",
          flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
        }}>?</button>
        <button onClick={() => {
          const next = theme === "dark" ? "light" : "dark";
          setTheme(next);
          localStorage.setItem("chloe-theme", next);
        }} style={{
          background: K.bg3, color: K.t1,
          border: `1px solid ${K.br}`,
          borderRadius: "50%", width: 26, height: 26,
          fontSize: 13, cursor: "pointer", fontFamily: "inherit",
          flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
        }}>{theme === "dark" ? "☀" : "☾"}</button>
        <div style={{ color: K.t2, fontSize: 9, letterSpacing: 1, flexShrink: 0, opacity: 0.8 }}>{filtered.length} fam.</div>
      </div>


      {/* ── CONTROLS BAR ── */}
      <div style={{ background: K.bg2, borderBottom: `1px solid ${K.br}`, padding: "8px 18px", display: "flex", alignItems: "center", gap: 16, flexShrink: 0, flexWrap: "wrap" }}>

        {/* Instruments */}
        <div style={{ display: "flex", gap: 3 }}>
          {INSTRUMENTS.map(inst => (
            <button key={inst} onClick={() => setInstrument(p => p === inst ? null : inst)} style={{
              background: instrument === inst ? K.a : K.bg3,
              color: instrument === inst ? "#000" : K.txt,
              border: `1px solid ${instrument === inst ? K.a : K.br}`,
              borderRadius: 3, padding: "4px 9px",
              fontSize: 9, cursor: "pointer", fontFamily: "inherit",
            }}>{inst}</button>
          ))}
        </div>

        <div style={{ width: 1, height: 22, background: K.t2, opacity: 0.3, flexShrink: 0 }} />

        {/* Waveforms */}
        <div style={{ display: "flex", gap: 3, opacity: instrument ? 0.35 : 1, transition: "opacity .2s" }}>
          {TIMBRES.map(t => (
            <button key={t} onClick={() => { setTimbre(t); setInstrument(null); }} style={{
              background: !instrument && timbre === t ? K.a : K.bg3,
              color: !instrument && timbre === t ? "#000" : K.txt,
              border: `1px solid ${!instrument && timbre === t ? K.a : K.br}`,
              borderRadius: 3, padding: "4px 9px",
              fontSize: 9, cursor: "pointer", fontFamily: "inherit",
            }}>{t}</button>
          ))}
        </div>

        <div style={{ width: 1, height: 22, background: K.t2, opacity: 0.3, flexShrink: 0 }} />

        {/* VOL / REV / A= / BPM — flex: 1 so they fill remaining width */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>

          {/* VOL */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Note volume. Drone volume is independent." style={{ color: K.lbl, fontSize: 9, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>VOL</span>
            <input type="range" min={0} max={1} step={0.01} value={noteVol}
              onChange={e => setNoteVol(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(noteVol * 100)}</span>
          </div>

          {/* REV */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Reverb wet level. Convolution reverb shared by drone and all notes." style={{ color: K.lbl, fontSize: 9, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>REV</span>
            <input type="range" min={0} max={1} step={0.01} value={reverbAmt}
              onChange={e => setReverbAmt(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(reverbAmt * 100)}</span>
          </div>

          {/* DEL */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Delay wet level." style={{ color: K.lbl, fontSize: 9, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>DEL</span>
            <input type="range" min={0} max={1} step={0.01} value={delayAmt}
              onChange={e => setDelayAmt(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(delayAmt * 100)}</span>
          </div>

          {/* SUS */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Note sustain — multiplier on note duration. Below 1.0 = staccato, above 1.0 = legato/overlapping." style={{ color: K.lbl, fontSize: 9, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>SUS</span>
            <input type="range" min={0.1} max={3} step={0.05} value={sustainMult}
              onChange={e => setSustainMult(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{sustainMult.toFixed(1)}</span>
          </div>

          {/* DEL TIME */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Delay time in seconds." style={{ color: K.lbl, fontSize: 9, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>D.T</span>
            <input type="range" min={0.05} max={1.5} step={0.01} value={delayTime}
              onChange={e => setDelayTime(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 28 }}>{delayTime.toFixed(2)}s</span>
          </div>

          <div style={{ width: 1, height: 22, background: K.t2, opacity: 0.3, flexShrink: 0 }} />

          {/* TUNE */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Concert pitch reference. 440 Hz standard, 432 Hz alternative." style={{ color: K.lbl, fontSize: 9, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>A =</span>
            <input type="range" min={432} max={440} step={1} value={aRef}
              onChange={e => setARef(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 24 }}>{aRef}</span>
          </div>

          {/* BPM */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Tempo for arpeggio and melody modes (40-480 BPM). Above 240 is for fast runs — try it with GROUPS." style={{ color: K.lbl, fontSize: 9, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>BPM</span>
            <input type="range" min={monasticMode ? 1 : 40} max={480} value={bpm}
              onChange={e => setBpm(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 28 }}>{bpm}</span>
            <button onClick={() => setShowAutoLocks(true)}
              title="Configure which settings Auto and Demo modes can change"
              style={{ background: "none", border: `1px solid ${K.a}`, color: K.a, borderRadius: 3, padding: "2px 7px", fontSize: 11, cursor: "pointer", fontFamily: "inherit", flexShrink: 0, letterSpacing: 1 }}>⚙ auto</button>
            {eegData?.heart_rate > 0 && (
              <button
                onClick={() => setBpm(Math.max(40, Math.min(240, Math.round(eegData.heart_rate))))}
                title={`Set BPM to heart rate (${Math.round(eegData.heart_rate)} bpm)`}
                style={{ background: claudeBpmOverride === "heart_rate" ? K.a : "none", border: `1px solid ${claudeBpmOverride === "heart_rate" ? K.a : K.br}`, color: claudeBpmOverride === "heart_rate" ? "#000" : "#e84060", borderRadius: 3, padding: "1px 5px", fontSize: 9, cursor: "pointer", fontFamily: "inherit", flexShrink: 0, whiteSpace: "nowrap" }}
              >♥ {Math.round(eegData.heart_rate)}</button>
            )}
          </div>

        </div>

      </div>

      {(demoOn || autoOn) && (
        <div style={{ background: K.demoB, borderBottom: `1px solid ${K.demoBr}`, flexShrink: 0 }}>
          <div style={{ padding: "6px 18px", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: K.a, fontSize: 9, letterSpacing: 2, flexShrink: 0 }}>{autoOn ? "⟲ AUTO" : "★ DEMO"}</span>
            <span style={{ fontSize: 10, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: K.demoT }}>
              {sel ? [
                selName,
                CHROMATIC[rootIdx],
                `${bpm}bpm`,
                rhythm,
                chordVoice !== "off" ? chordVoice : null,
                `b${normalizedBrightness(sel.pattern).toFixed(2)}`,
              ].filter(Boolean).join(" · ") : "Starting…"}
            </span>
            {demoLog.length > 0 && (
              <button onClick={() => {
                const text = demoLog.slice().reverse().map(e =>
                  `${e.scaleName} · ${CHROMATIC[e.rootNote]} · ${e.rhythm} · ${e.bpm}bpm · ${e.arpDir}${e.chordVoice !== "off" ? " · " + e.chordVoice : ""}${e.commentary ? "\n  " + e.commentary : ""}${e.request ? "\n  ✦ " + e.request : ""}`
                ).join("\n\n");
                navigator.clipboard?.writeText(text).catch(() => {});
                setLogCopied(true);
                setTimeout(() => setLogCopied(false), 2000);
              }} style={{
                background: "none", border: `1px solid ${K.demoBr}`, color: logCopied ? K.a : K.demoT2,
                fontSize: 9, padding: "2px 7px", cursor: "pointer", borderRadius: 3, flexShrink: 0,
                transition: "color .2s",
              }}>{logCopied ? "✓ copied" : "⎘ copy"}</button>
            )}
            {demoOn && (
              <button onClick={() => setChatOpen(p => !p)} style={{
                background: chatOpen ? K.a : "none", border: `1px solid ${chatOpen ? K.a : K.demoBr}`,
                color: chatOpen ? "#000" : K.demoT2,
                fontSize: 9, padding: "2px 7px", cursor: "pointer", borderRadius: 3, flexShrink: 0,
              }}>💬 chat</button>
            )}
            {/* EEG indicator — shows when proxy is streaming */}
            {(() => {
              const eeg = eegData;
              const streaming = eeg && eeg.connected && eeg.bands && eeg.derived;
              const dominant = streaming ? eeg.derived.dominant_active_band : null;
              const bandColors = { theta:"#6060e8", alpha:"#3ee8d0", beta:"#f0a030", gamma:"#e84060" };
              const color = dominant ? (bandColors[dominant] || K.demoT2) : K.textDim;
              return (
                <div title={streaming
                  ? `EEG: ${dominant} dominant (excl. delta) · α/θ ${eeg.derived.alpha_theta_ratio} · relaxation ${Math.round(eeg.derived.relaxation_index*100)}%`
                  : "EEG proxy not connected (run eeg_proxy.py)"}
                  style={{ display:"flex", alignItems:"center", gap:4, flexShrink:0 }}>
                  <div style={{
                    width:6, height:6, borderRadius:"50%",
                    background: streaming ? color : K.textDim,
                    boxShadow: streaming ? `0 0 6px ${color}` : "none",
                    transition:"all 0.6s",
                  }}/>
                  {streaming && (
                    <span style={{ fontFamily:"inherit", fontSize:9, color, letterSpacing:1 }}>
                      {dominant} {Math.round((eeg.bands[dominant].left_pct + eeg.bands[dominant].right_pct)/2)}%
                    </span>
                  )}
                </div>
              );
            })()}
            <button onClick={() => setShowDemoLog(p => !p)} style={{
              background: "none", border: `1px solid ${K.demoBr}`, color: K.demoT2,
              fontSize: 9, padding: "2px 7px", cursor: "pointer", borderRadius: 3, flexShrink: 0,
            }}>{showDemoLog ? "▴ log" : `▾ log${demoLog.length ? ` (${demoLog.length})` : ""}`}</button>
          </div>

          {/* Brightness row */}
          {(() => {
            const eegStreaming = !!(eegData?.connected && eegData?.bands && eegData?.derived);
            const curNorm = sel ? normalizedBrightness(sel.pattern) : null;
            const displayTarget = overrideTarget !== null ? overrideTarget : claudeOverride !== null ? claudeOverride : eegTarget;
            const isOverride = overrideTarget !== null;
            const arcLead = arc?.mode === "lead" && arc.from !== null;
            const jOn = journeyNow !== null;
            const dotColor = jOn ? JOURNEY_COLOR : arcLead ? ARC_COLOR : brightnessLocked ? "#f0a030" : isOverride ? "#6060e8" : claudeOverride !== null ? "#e87020" : eegStreaming ? "#3ee8d0" : K.a;
            const sliderVal = overrideTarget !== null ? Math.round(overrideTarget * 100)
              : claudeOverride !== null ? Math.round(claudeOverride * 100)
              : eegTarget !== null ? Math.round(eegTarget * 100) : 50;
            const btnStyle = { background: "none", border: `1px solid ${K.demoBr}`, color: K.demoT2,
              fontSize: 9, padding: "2px 6px", cursor: "pointer", borderRadius: 3, flexShrink: 0 };
            return (
              <div style={{ borderTop: `1px solid ${K.demoBr}`, padding: "5px 18px", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: K.lbl, fontSize: 9, letterSpacing: 2, flexShrink: 0 }}>BRIGHT</span>
                {jOn && (
                  <span title={JOURNEYS[journey]?.tip} style={{ color: JOURNEY_COLOR, fontSize: 9, flexShrink: 0, fontVariantNumeric: "tabular-nums", cursor: "help" }}>
                    {journey} {journeyNow.endless ? `· ${mmss(journeyNow.el)}` : journeyNow.ending ? "· ending" : journeyNow.arrived ? "· arrived" : `${Math.round(journeyNow.f * 100)}%`}
                  </span>
                )}
                {/* Bar */}
                <div style={{ position: "relative", flex: 1, height: 18, minWidth: 80 }}>
                  {/* Track */}
                  <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 2, background: K.bg3, borderRadius: 1, transform: "translateY(-50%)" }} />
                  {/* Neutral tick at 0.5 */}
                  <div style={{ position: "absolute", top: "50%", left: "50%", width: 1, height: 8, background: K.t2 + "55", transform: "translate(-50%, -50%)" }} />
                  {/* Current scale dot */}
                  {curNorm !== null && (
                    <div style={{ position: "absolute", top: "50%", left: `${curNorm * 100}%`, width: 8, height: 8,
                      background: dotColor, borderRadius: "50%", transform: "translate(-50%, -50%)", transition: "left 0.4s ease, background 0.3s" }} />
                  )}
                  {/* Target arrow */}
                  {displayTarget !== null && (
                    <div style={{ position: "absolute", bottom: 0, left: `${displayTarget * 100}%`,
                      color: jOn ? JOURNEY_COLOR : arcLead ? ARC_COLOR : isOverride ? "#6060e8" : "#3ee8d0", fontSize: 6, transform: "translateX(-50%)", lineHeight: 1 }}>▲</div>
                  )}
                </div>
                {/* Value */}
                <span style={{ color: dotColor, fontSize: 9, fontVariantNumeric: "tabular-nums", minWidth: 28, flexShrink: 0 }}>
                  {curNorm !== null ? curNorm.toFixed(2) : "—"}
                </span>
                {/* Override slider */}
                <input type="range" min={0} max={100} step={1} value={sliderVal}
                  onChange={e => {
                    const v = +e.target.value / 100;
                    overrideTargetRef.current = v;
                    setBrightnessLocked(false); brightnessLockedRef.current = false;
                    setOverrideTarget(v);
                  }}
                  title="Manually set brightness target (overrides EEG)"
                  style={{ width: 64, accentColor: "#6060e8", cursor: "pointer", flexShrink: 0 }}
                />
                {/* Lock button */}
                <button onClick={() => {
                  if (brightnessLocked) {
                    overrideTargetRef.current = null; brightnessLockedRef.current = false;
                    setOverrideTarget(null); setBrightnessLocked(false);
                  } else {
                    const v = sel ? normalizedBrightness(sel.pattern) : 0.5;
                    overrideTargetRef.current = v; brightnessLockedRef.current = true;
                    setOverrideTarget(v); setBrightnessLocked(true);
                  }
                }} title={brightnessLocked ? "Unlock — resume EEG/free targeting" : "Lock current brightness zone"}
                  style={{ ...btnStyle, color: brightnessLocked ? "#f0a030" : K.demoT2 }}>
                  {brightnessLocked ? "🔒" : "🔓"}
                </button>
                {/* Clear override */}
                {isOverride && !brightnessLocked && (
                  <button onClick={() => { overrideTargetRef.current = null; setOverrideTarget(null); }}
                    title="Clear manual override — return to EEG/Claude targeting" style={btnStyle}>✕</button>
                )}
                {/* Claude override indicator + clear */}
                {claudeOverride !== null && !isOverride && !brightnessLocked && (
                  <button onClick={() => { claudeOverrideRef.current = null; setClaudeOverride(null); }}
                    title="Claude is holding a brightness goal — click to release and return to EEG"
                    style={{ ...btnStyle, color: "#e87020" }}>★✕</button>
                )}
                {/* Explore nearby */}
                <button onClick={() => {
                  const target = overrideTarget ?? claudeOverride ?? eegTarget ?? (sel ? normalizedBrightness(sel.pattern) : 0.5);
                  const result = randomAtBrightness(target, BRIGHTNESS_CONFIG.randomTolerance, fullCatalogue, sel?.pattern ?? null, BRIGHTNESS_CONFIG);
                  if (result) {
                    const fam = FAMILIES.find(f => f.id === result.familyId);
                    if (fam) pick(fam, result.modeIdx, result.pattern);
                  }
                }} title={`Pick random scale within ±${BRIGHTNESS_CONFIG.randomTolerance} brightness of current target`}
                  style={btnStyle}>⇄ explore</button>
                {/* Session arc */}
                <button onClick={() => setShowArc(p => !p)}
                  title="Session arc — lead your brightness over time, or log a mirror session"
                  style={{ ...btnStyle, color: arc ? ARC_COLOR : K.demoT2, borderColor: arc ? ARC_COLOR : K.demoBr }}>
                  {arc ? `● ${mmss(arcNow)}` : "↗ arc"}
                </button>
              </div>
            );
          })()}

          {/* Session arc panel */}
          {showArc && (() => {
            const chip = (on) => ({ background: on ? ARC_COLOR + "22" : "none", border: `1px solid ${on ? ARC_COLOR : K.demoBr}`,
              color: on ? ARC_COLOR : K.demoT2, fontSize: 9, padding: "2px 7px", cursor: arc ? "default" : "pointer",
              borderRadius: 3, fontFamily: "inherit" });
            const set = (k, v) => { if (!arc) setArcCfg(p => ({ ...p, [k]: v })); };
            const c = arc || arcCfg;
            const lbl = { color: K.lbl, fontSize: 9, letterSpacing: 2, minWidth: 52 };
            let status = null;
            if (arc) {
              if (arc.mode === "mirror") status = arcNow < arc.mins * 60000
                ? `Mirror · logging · ${mmss(arcNow)} of ${arc.mins}:00`
                : `Mirror · ${arc.mins} min done · still logging until you stop`;
              else if (arc.from === null) status = `Baseline · listening to where you are · ${mmss(ARC_BASELINE_MS - arcNow)} left`;
              else {
                const f = Math.min(1, (arcNow - ARC_BASELINE_MS) / (arc.mins * 60000));
                status = f < 1
                  ? `Lead · ${arc.from.toFixed(2)} → ${arc.to.toFixed(2)} · now ${(arc.from + (arc.to - arc.from) * f).toFixed(2)} · ${mmss(arc.mins * 60000 - (arcNow - ARC_BASELINE_MS))} left`
                  : `Holding at ${arc.to.toFixed(2)} · arc complete · still logging until you stop`;
              }
            }
            return (
              <div style={{ borderTop: `1px solid ${K.demoBr}`, padding: "8px 18px", display: "flex", flexDirection: "column", gap: 6, fontSize: 9 }}>
                <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={lbl}>SESSION</span>
                  <button style={chip(c.mode === "lead")} onClick={() => set("mode", "lead")}
                    title="Chloe leads: 1 min baseline, then the target glides away from where you started">Lead</button>
                  <button style={chip(c.mode === "mirror")} onClick={() => set("mode", "mirror")}
                    title="Chloe follows your brain as usual — logging only, a baseline to compare leads against">Mirror</button>
                  <span style={{ ...lbl, minWidth: 0, marginLeft: 10 }}>MIN</span>
                  {[5, 10, 15, 20, 30].map(m => <button key={m} style={chip(c.mins === m)} onClick={() => set("mins", m)}>{m}</button>)}
                </div>
                {c.mode === "lead" && (
                  <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={lbl}>TOWARD</span>
                    <button style={chip(c.dir === 1)} onClick={() => set("dir", 1)}>brighter</button>
                    <button style={chip(c.dir === -1)} onClick={() => set("dir", -1)}>darker</button>
                    <span style={{ ...lbl, minWidth: 0, marginLeft: 10 }}>BY</span>
                    {[[0.1, "a little"], [0.25, "some"], [0.4, "a lot"]].map(([v, t]) =>
                      <button key={v} style={chip(c.amount === v)} onClick={() => set("amount", v)} title={`±${v} on the 0–1 brightness scale`}>{t}</button>)}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {arc
                    ? <button onClick={stopArc} style={{ ...chip(true), cursor: "pointer" }}>■ stop &amp; save</button>
                    : <button onClick={startArc} style={{ ...chip(true), cursor: "pointer" }}>▶ start</button>}
                  <span style={{ color: arc ? ARC_COLOR : K.demoT2 }}>
                    {status || (eegData?.connected ? "Headband data is coming in." : "No headband data — the log will hold scales only.")}
                  </span>
                </div>
                {sessions.length > 0 && (
                  <div style={{ borderTop: `1px solid ${K.demoBr}`, paddingTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={lbl}>PAST SESSIONS</span>
                    {sessions.slice(0, 8).map(sess => {
                      const sum = sessionSummary(sess);
                      return (
                        <div key={sess.id} style={{ display: "flex", gap: 8, alignItems: "center", color: K.demoT2 }}>
                          <span style={{ minWidth: 92 }}>{new Date(sess.id).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                          <span style={{ minWidth: 150 }}>
                            {sess.mode === "lead" && sess.from !== null ? `lead ${sess.from.toFixed(2)} → ${sess.to.toFixed(2)}` : sess.mode === "lead" ? "lead (baseline only)" : "mirror"}
                          </span>
                          <span style={{ flex: 1 }} title="Your brain-derived brightness: mean of the first 2 min → mean of the last 2 min">
                            {sum ? `brain ${sum.start.toFixed(2)} → ${sum.end.toFixed(2)} · ${sum.mins.toFixed(0)} min` : `${sess.rows.length} rows, no EEG`}
                          </span>
                          <button onClick={() => downloadSession(sess)} style={{ ...chip(false), cursor: "pointer" }} title="Download this session as CSV">csv</button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

          {showDemoLog && (
            <div style={{ borderTop: `1px solid ${K.demoBr}`, maxHeight: 440, overflowY: "auto" }}>
              {demoLog.map((e, i) => (
                <div key={e.ts} onClick={() => {
                  const fam = FAMILIES.find(f => f.id === e.famId);
                  if (fam && fam.modes[e.modeIdx] !== undefined) pick(fam, e.modeIdx, fam.modes[e.modeIdx]);
                  setRootIdx(e.rootNote);
                  setRhythm(e.rhythm);
                  setArpDir(e.arpDir);
                  setChordVoice(e.chordVoice);
                  setBpm(e.bpm);
                  setArpOn(true);
                }} style={{
                  padding: "5px 18px", cursor: "pointer", display: "flex", gap: 10, alignItems: "baseline",
                  borderBottom: `1px solid ${K.demoEL}`,
                  background: i === 0 ? K.demoE1 : "transparent",
                }}>
                  <span style={{ color: K.a, fontSize: 10, fontWeight: "bold", minWidth: 130 }}>{e.scaleName}</span>
                  <span style={{ color: K.demoT2, fontSize: 9 }}>{CHROMATIC[e.rootNote]}</span>
                  <span style={{ color: K.demoT3, fontSize: 9 }}>{e.bpm}bpm {e.rhythm} {e.arpDir} {e.chordVoice !== "off" ? e.chordVoice : ""}</span>
                  <span style={{ color: K.demoT4, fontSize: 9, fontStyle: "italic", flex: 1 }}>{e.commentary}</span>
                  {e.request && <span style={{ color: K.a, fontSize: 9, fontStyle: "italic", opacity: 0.8 }}>✦ {e.request}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", flex: 1, overflow: "hidden", minHeight: 0 }}>

        {/* ══════════════════════════════════════
            SCALE LIST (LEFT)
        ══════════════════════════════════════ */}
        <div style={{ width: listW, flexShrink: 0, position: "relative", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div onMouseDown={onListDragStart} style={{
            position: "absolute", right: 0, top: 0, bottom: 0, width: 5,
            cursor: "col-resize", zIndex: 20, background: "transparent",
            borderRight: `1px solid ${K.br}`, transition: "border-color .15s",
          }}
          onMouseEnter={e => e.currentTarget.style.borderColor = K.a}
          onMouseLeave={e => e.currentTarget.style.borderColor = K.br}
          />
        {/* Search + note count filter */}
        <div style={{ flexShrink: 0, padding: "7px 10px 6px", borderBottom: `1px solid ${K.br}`, background: K.bg2 }}>
          <div style={{ position: "relative", marginBottom: 5 }}>
            <input
              value={listSearch}
              onChange={e => setListSearch(e.target.value)}
              placeholder="search by name…"
              style={{
                width: "100%", boxSizing: "border-box",
                background: K.bg3, border: `1px solid ${listSearch ? K.a : K.br}`,
                color: K.txt, padding: "5px 22px 5px 8px",
                borderRadius: 3, fontFamily: "inherit", fontSize: 10, outline: "none",
              }}
            />
            {listSearch && (
              <button onClick={() => setListSearch("")} style={{
                position: "absolute", right: 5, top: "50%", transform: "translateY(-50%)",
                background: "none", border: "none", color: K.t2, cursor: "pointer", fontSize: 14, padding: 0, lineHeight: 1,
              }}>×</button>
            )}
          </div>
          <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
            {[3, 4, 5, 6, 7, 8].map(n => (
              <button key={n} onClick={() => setNoteCountFilter(p => p === n ? null : n)} style={{
                background: noteCountFilter === n ? K.a : K.bg3,
                color: noteCountFilter === n ? "#000" : K.txt,
                border: `1px solid ${noteCountFilter === n ? K.a : K.br}`,
                borderRadius: 3, padding: "2px 7px", fontSize: 9,
                cursor: "pointer", fontFamily: "inherit", letterSpacing: 0.5,
              }}>{n}</button>
            ))}
            {(listSearch || noteCountFilter !== null) && (
              <button onClick={() => { setListSearch(""); setNoteCountFilter(null); }} style={{
                background: "none", border: `1px solid ${K.br}`, color: K.t2,
                borderRadius: 3, padding: "2px 6px", fontSize: 9,
                cursor: "pointer", fontFamily: "inherit", marginLeft: 2,
              }}>clear</button>
            )}
            <button
              onClick={() => setShowDiatonic(p => !p)}
              title={showDiatonic ? "Hide diatonic mode context" : "Show nearest diatonic mode for each scale"}
              style={{
                background: showDiatonic ? K.ag : "none",
                border: `1px solid ${showDiatonic ? K.a : K.br}`,
                color: showDiatonic ? K.a : K.t2,
                borderRadius: 3, padding: "2px 6px", fontSize: 9,
                cursor: "pointer", fontFamily: "inherit", marginLeft: "auto",
              }}>≈ mode</button>
            <button
              onClick={() => setShowOutside(p => !p)}
              title={showOutside
                ? "Hide outside scales (patterns with three consecutive semitones)"
                : "Show outside scales — patterns with three consecutive semitones, normally excluded. When on, demo and auto modes can pick them too."}
              style={{
                background: showOutside ? K.ag : "none",
                border: `1px solid ${showOutside ? K.a : K.br}`,
                color: showOutside ? K.a : K.t2,
                borderRadius: 3, padding: "2px 6px", fontSize: 9,
                cursor: "pointer", fontFamily: "inherit",
              }}>outside</button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
          {Object.keys(grouped).sort((a, b) => {
            const fa = grouped[a][0], fb = grouped[b][0];
            return (fa.outside - fb.outside) || fa.n - fb.n;
          }).map(gk => {
            const fams = grouped[gk], n = fams[0].n, outside = fams[0].outside, exp = isExp(gk);
            return (
              <div key={gk} style={outside ? { opacity: 0.7 } : undefined}>
                {/* Group header */}
                <div onClick={() => toggleGrp(gk)} title={outside ? "Outside scales: contain three consecutive semitones, so Chloe's main rules exclude them" : undefined} style={{
                  padding: "7px 16px", background: K.bg2, borderBottom: `1px solid ${K.br}`,
                  display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                  position: "sticky", top: 0, zIndex: 10, userSelect: "none",
                }}>
                  <span style={{ color: K.a, fontSize: 9, letterSpacing: 3, fontWeight: 600 }}>{outside ? "OUTSIDE · " : ""}{GRP_NAME[n].toUpperCase()}</span>
                  <span style={{ color: K.txt, fontSize: 9 }}>{fams.length} scale{fams.length !== 1 ? "s" : ""}</span>
                  <span style={{ marginLeft: "auto", color: K.txt, fontSize: 11 }}>{exp ? "▾" : "▸"}</span>
                </div>

                {exp && fams.map(fam => (
                  <div key={fam.id}>
                    {/* Family label */}
                    <div style={{ padding: "2px 16px", background: K.bg3, borderBottom: `1px solid ${K.br}`, display: "flex", gap: 10, alignItems: "center" }}>
                      <span style={{ color: K.txt, fontSize: 9, letterSpacing: 2 }}>{fam.id}</span>
                      <span style={{ color: K.t2, fontSize: 9 }}>{fam.modes.length}m</span>
                    </div>

                    {/* Modes */}
                    {fam.modes.map((mode, mi) => {
                      const origIdx = fam.origIdxs ? fam.origIdxs[mi] : mi;
                      const isSel = sel?.id === `${fam.id}.${origIdx}`;
                      const name = KNOWN[mode];
                      const customName = customNames[mode];
                      const isEditingThis = editingName === mode;
                      // Brightness tint: bright modes (low mi) get a faint light overlay,
                      // dark modes (high mi) get nothing. Range 0..1 across the family.
                      const total = fam.origIdxs ? (fam.origIdxs[fam.origIdxs.length-1] + 1) : fam.modes.length;
                      const bFrac = total > 1 ? (1 - origIdx / (total - 1)) : 0.5;
                      const tintAlpha = Math.round(bFrac * 28); // 0–28 out of 255
                      const tintHex = tintAlpha.toString(16).padStart(2, "0");
                      const brightTint = isSel ? "transparent" : `#ffffff${tintHex}`;
                      const favId = fam.id + "." + origIdx;
                      const isFav = favs.has(favId);
                      return (
                        <div key={mode} ref={isSel ? selRowRef : null} onClick={() => pick(fam, origIdx, mode)} style={{
                          padding: "5px 16px 5px 18px",
                          display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                          background: isSel ? K.ag : brightTint,
                          borderLeft: `3px solid ${isSel ? K.a : "transparent"}`,
                          borderBottom: `1px solid ${K.br}18`,
                          transition: "background .1s",
                        }}>
                          <button onClick={e => toggleFav(e, favId)} style={{
                            background: "none", border: "none", padding: "0 4px",
                            cursor: "pointer", fontSize: 14, lineHeight: 1, flexShrink: 0,
                            color: isFav ? K.a : K.txt,
                            transition: "color .15s",
                          }}>{isFav ? "★" : "☆"}</button>
                          <span style={{ color: isSel ? K.a : K.txt, fontSize: 10, letterSpacing: 1.5, fontWeight: isSel ? 500 : 300, minWidth: 130, fontFamily: "inherit" }}>
                            {toBin(mode)}
                          </span>
                          <span style={{ color: K.t2, fontSize: 9, minWidth: 40 }}>({mode})</span>
                          <span style={{ color: K.t2, fontSize: 9, opacity: 0.7, minWidth: 28 }}>{fam.outside ? "b—" : `b${bright(mode)}`}</span>
                          {name && (
                            <span style={{ color: isSel ? K.a : K.t1, fontSize: 10 }}>{name}</span>
                          )}
                          {!name && isEditingThis && (
                            <input
                              autoFocus
                              value={nameInput}
                              onChange={e => setNameInput(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === "Enter") { e.stopPropagation(); commitName(mode); }
                                if (e.key === "Escape") { e.stopPropagation(); setEditingName(null); }
                              }}
                              onBlur={() => commitName(mode)}
                              onClick={e => e.stopPropagation()}
                              placeholder="name this scale…"
                              style={{
                                background: K.bg3, border: `1px solid ${K.a}`,
                                color: K.txt, borderRadius: 3,
                                padding: "1px 5px", fontSize: 9,
                                fontFamily: "inherit", outline: "none", width: 130,
                              }}
                            />
                          )}
                          {!name && !isEditingThis && customName && (
                            <>
                              <span style={{ color: isSel ? K.a : K.t1, fontSize: 10 }}>{customName}</span>
                              <button onClick={e => { e.stopPropagation(); setEditingName(mode); setNameInput(customName); }} title="Edit name" style={{ background: "none", border: "none", color: K.lbl, cursor: "pointer", fontSize: 12, padding: "0 2px", flexShrink: 0 }}>✎</button>
                            </>
                          )}
                          {!name && !isEditingThis && !customName && (
                            <button onClick={e => { e.stopPropagation(); setEditingName(mode); setNameInput(""); }} title="Name this scale" style={{ background: "none", border: "none", color: K.lbl, cursor: "pointer", fontSize: 12, padding: "0 2px", flexShrink: 0 }}>✎</button>
                          )}
                          {showDiatonic && (() => {
                            const nb = diatonicNeighborhood(mode);
                            return (
                              <span
                                title={`${nb.sharedPitches}/${nb.totalPitches} pitches shared with ${nb.relatives.join(', ')}`}
                                style={{ color: K.t2, fontSize: 9, opacity: 0.75, marginLeft: "auto", flexShrink: 0, whiteSpace: "nowrap" }}
                              >≈ {nb.relatives.join(' / ')}</span>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ padding: 32, color: K.t2, textAlign: "center", fontSize: 11 }}>
              No results{filter ? ` for "${filter}"` : listSearch ? ` for "${listSearch}"` : noteCountFilter ? ` for ${noteCountFilter}-note scales` : ""}
            </div>
          )}
        </div>
        </div>

        {/* ══════════════════════════════════════
            CENTRE PANEL
        ══════════════════════════════════════ */}
        <div style={{ flex: 1, overflow: "hidden", background: K.bg, borderRight: `1px solid ${K.br}`, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* Tab strip */}
          <div style={{ display: "flex", borderBottom: `1px solid ${K.br}`, flexShrink: 0, background: K.bg2 }}>
            {[["viz", "◎ visualizer"], ["info", "ℹ info"]].map(([id, label]) => (
              <button key={id} onClick={() => setCenterTab(id)} style={{
                background: "none", border: "none",
                borderBottom: `2px solid ${centerTab === id ? K.a : "transparent"}`,
                color: centerTab === id ? K.a : K.t2,
                cursor: "pointer", fontFamily: "inherit",
                fontSize: 9, letterSpacing: 2, padding: "8px 16px",
                transition: "color .15s",
              }}>{label}</button>
            ))}
          </div>
          <div style={{ flex: 1, overflow: "hidden" }}>
            {centerTab === "viz"
              ? <Visualizer analyserRef={analyserRef} playing={playing} rootIdx={rootIdx} active={selSemis} K={K} />
              : <ScaleInfo sel={sel} selName={selName} selIvs={selIvs} selNotes={selNotes} demoKey={demoKey} K={K} />
            }
          </div>
        </div>

        {/* ══════════════════════════════════════
            RIGHT PANEL
        ══════════════════════════════════════ */}
        <div style={{ width: sidebarW, display: "flex", flexDirection: "column", background: K.bg2, flexShrink: 0, position: "relative", minHeight: 0 }}>
          {/* Drag handle */}
          <div onMouseDown={onDragStart} style={{
            position: "absolute", left: 0, top: 0, bottom: 0, width: 5,
            cursor: "col-resize", zIndex: 20,
            background: "transparent",
            borderLeft: `1px solid ${K.br}`,
            transition: "border-color .15s",
          }}
          onMouseEnter={e => e.currentTarget.style.borderColor = K.a}
          onMouseLeave={e => e.currentTarget.style.borderColor = K.br}
          />

          {/* Root Note */}
          <Sec label="ROOT NOTE" K={K}>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(32px, 1fr))`, gap: 3 }}>
              {ROOTS.map((r, i) => (
                <button key={i} onClick={() => { wake(); setRootIdx(i); }} style={{
                  background: rootIdx === i ? K.a : K.bg3,
                  color: rootIdx === i ? "#000" : K.txt,
                  border: `1px solid ${rootIdx === i ? K.a : K.br}`,
                  borderRadius: 3, padding: "4px 0",
                  fontSize: 10, cursor: "pointer", fontFamily: "inherit",
                  fontWeight: rootIdx === i ? 600 : 400,
                }}>{r}</button>
              ))}
            </div>
          </Sec>



          {/* Playback */}
          <Sec label="PLAYBACK" K={K}>
            {/* Drone octave */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="Drop the drone 1-3 octaves for a deep bass foundation." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>DRONE OCT</span>
              <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
                {[0, -12, -24, -36].map(o => (
                  <button key={o} onClick={() => setDroneOct(o)} style={{
                    background: droneOct === o ? K.a : K.bg3,
                    color: droneOct === o ? "#000" : K.txt,
                    border: `1px solid ${droneOct === o ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 7px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: droneOct === o ? 600 : 400,
                  }}>{o === 0 ? "0" : o === -12 ? "-1" : o === -24 ? "-2" : "-3"}</button>
                ))}
              </div>
            </div>
            {/* Drone vol */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="Drone volume." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>DRONE VOL</span>
              <input type="range" min={0} max={3} step={0.01} value={droneVol}
                onChange={e => setDroneVol(+e.target.value)}
                style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
              />
              <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(droneVol * 100)}</span>
            </div>
            {/* Drone tone */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="Drone tone — lowpass filter cutoff. Left = dark/muffled, right = bright/open." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>DRONE TONE</span>
              <input type="range" min={0} max={1} step={0.01} value={droneTone}
                onChange={e => setDroneTone(+e.target.value)}
                style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
              />
              <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(droneTone * 100)}</span>
            </div>
            {/* Drone type */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="Drone sound type — sine: clean + sub-octave. organ: additive harmonic series. pad: detuned shimmer. strings: bowed saws with tremolo. tanpura: root/fifth/octaves with pulsing amplitude. throat: Mongolian throat singing, a buzzing voice with a whistled overtone melody on the root's own harmonics (only those in the scale), a growl an octave under, breathing every 15-25 s. jaw harp: a plucked reed in a gallop or straight rhythm, the mouth jumping between its harmonics; plucks on the beat when drums play. dam: a second duduk holding the home note, as under Armenian duduk melodies, breathing and swelling. juno: an 80s polysynth pad, root/fifth/octave (+9th) detuned saws through a stereo chorus." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>DRONE TYPE</span>
              <select value={droneWave} onChange={e => setDroneWave(e.target.value)} style={{
                marginLeft: "auto", background: K.bg3, color: K.txt, border: `1px solid ${K.br}`,
                borderRadius: 3, padding: "3px 6px", fontSize: 9, fontFamily: "inherit",
                cursor: "pointer", letterSpacing: 1,
              }}>
                {["sine", "organ", "pad", "strings", "tanpura", "throat", "jawharp", "juno", "dam"].map(w => (
                  <option key={w} value={w}>{w === "jawharp" ? "jaw harp" : w}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
              {[
                { label: "● Drone", on: droneOn, onClick: () => { wake(); setDroneOn(p => !p); } },
                { label: arpOn && !demoOn && !autoOn ? "■ Stop" : "▶ Play", on: arpOn && !demoOn && !autoOn, disabled: !sel, onClick: () => { wake(); setArpOn(p => !p); } },
                { label: autoOn ? "⟲ Stop" : "⟲ Auto", on: autoOn, onClick: () => {
                  wake();
                  if (autoOn) stopAuto();
                  else { setDemoOn(false); setAutoOn(true); }
                }, gear: true },
                { label: demoOn ? "★ Stop" : "★ Claude", on: demoOn, onClick: () => {
                  if (!demoKey) { setDemoKeyInput(true); return; }
                  if (demoOn) { setDemoOn(false); setLoopOn(false); setArpOn(false); setDemoComment(""); setDemoRequest(""); setChatLog([]); setChatInput(""); setChatOpen(false); setShowDemoLog(false); setEegTarget(null); setOverrideTarget(null); setBrightnessLocked(false); setClaudeOverride(null); setClaudeBpmOverride(null); setSustainMult(1); overrideTargetRef.current = null; brightnessLockedRef.current = false; claudeOverrideRef.current = null; claudeBpmOverrideRef.current = null; }
                  else { wake(); setAutoOn(false); setDemoOn(true); }
                }},
                { label: monasticMode ? "◎ Still" : "◎ Monastic", on: monasticMode, onClick: () => {
                  if (monasticMode) {
                    // Toggle OFF
                    setMonasticMode(false);
                    if (preMonasticBpmRef.current !== null) {
                      setBpm(preMonasticBpmRef.current);
                      preMonasticBpmRef.current = null;
                    }
                  } else {
                    // Toggle ON
                    preMonasticBpmRef.current = stRef.current.bpm;
                    setMonasticMode(true);
                    setBpm(15);
                    setDroneOn(true);
                    setDroneWave("tanpura");
                  }
                }},
                // { label: beatOn ? "♩ Stop" : "♩ Beat", on: beatOn, onClick: () => { wake(); setBeatOn(p => !p); }},
              ].map(b => (<Fragment key={b.label}>
                <button onClick={b.onClick} disabled={b.disabled} style={{
                  flex: 1, background: b.on ? K.a : K.bg3,
                  color: b.on ? "#000" : b.disabled ? K.txt + "70" : K.txt,
                  border: `1px solid ${b.on ? K.a : K.br}`,
                  borderRadius: 3, padding: "7px 4px",
                  fontSize: 10, cursor: b.disabled ? "default" : "pointer",
                  fontFamily: "inherit", fontWeight: b.on ? 600 : 400,
                  transition: "all .15s",
                }}>{b.label}</button>
                {b.gear && <button onClick={() => setShowAutoLocks(true)} title="Auto settings: journey, smooth, and which settings Auto may change"
                  style={{ background: K.bg3, border: `1px solid ${K.a}`, color: K.a, borderRadius: 3, padding: "0 7px", fontSize: 14, cursor: "pointer", fontFamily: "inherit", flexShrink: 0, marginLeft: -2 }}>⚙</button>}
              </Fragment>))}
            </div>
            {/* Scale pool toggle */}
            <div style={{ display: "flex", gap: 0, border: `1px solid ${K.br}`, borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
              {[{ l: "named scales", v: false }, { l: "all scales", v: true }].map(opt => (
                <button key={String(opt.v)} onClick={() => setDemoAllScales(opt.v)} style={{
                  flex: 1, background: demoAllScales === opt.v ? K.bg3 : "transparent",
                  color: demoAllScales === opt.v ? K.a : K.t2,
                  border: "none", borderRight: !opt.v ? `1px solid ${K.br}` : "none",
                  padding: "4px 4px", fontSize: 9, cursor: "pointer",
                  fontFamily: "inherit", letterSpacing: 0.5,
                  fontWeight: demoAllScales === opt.v ? 600 : 400,
                  transition: "all .15s",
                }}>{opt.l}</button>
              ))}
            </div>
            {/* Loop button — visible when Demo or Auto is running */}
            {(demoOn || autoOn) && (
              <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                <button onClick={() => setLoopOn(p => !p)} style={{
                  flex: 3, background: loopOn ? K.a : K.bg3,
                  color: loopOn ? "#000" : K.txt,
                  border: `1px solid ${loopOn ? K.a : K.br}`,
                  borderRadius: 3, padding: "7px 4px",
                  fontSize: 10, cursor: "pointer",
                  fontFamily: "inherit", fontWeight: loopOn ? 600 : 400,
                  transition: "all .15s",
                }}>⟳ {loopOn ? "Looping — click to advance" : "Loop this scale"}</button>
                {loopOn && (
                  <button onClick={saveMoment} title="Save this scale and all current settings for later replay" style={{
                    flex: 1, background: K.bg3,
                    color: K.a, border: `1px solid ${K.a}`,
                    borderRadius: 3, padding: "7px 4px",
                    fontSize: 10, cursor: "pointer",
                    fontFamily: "inherit", fontWeight: 600,
                    transition: "all .15s",
                  }}>⊕ Save</button>
                )}
              </div>
            )}
            {/* Saved moments toggle + panel */}
            {savedMoments.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                <button onClick={() => setShowSaved(p => !p)} style={{
                  width: "100%", background: "none",
                  color: K.t2, border: `1px solid ${K.br}`,
                  borderRadius: 3, padding: "4px 8px",
                  fontSize: 9, cursor: "pointer",
                  fontFamily: "inherit", letterSpacing: 1,
                  transition: "all .15s",
                }}>{showSaved ? "▴" : "▾"} saved moments ({savedMoments.length})</button>
                {showSaved && (
                  <div style={{ marginTop: 4, border: `1px solid ${K.br}`, borderRadius: 3, overflow: "hidden", maxHeight: 220, overflowY: "auto" }}>
                    {savedMoments.map((m, i) => (
                      <div key={m.ts} style={{
                        display: "flex", alignItems: "center", gap: 4,
                        padding: "5px 6px",
                        borderBottom: i < savedMoments.length - 1 ? `1px solid ${K.br}` : "none",
                        background: K.bg3,
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: K.a, fontSize: 10, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.scaleName}</div>
                          <div style={{ color: K.t2, fontSize: 9, letterSpacing: 0.5 }}>{CHROMATIC[m.rootIdx]} · {m.bpm}bpm · {m.rhythm} · {m.arpDir}{m.chordVoice !== "off" ? ` · ${m.chordVoice}` : ""}</div>
                        </div>
                        <button onClick={() => playMoment(m)} title="Restore all settings and play" style={{
                          background: K.a, color: "#000", border: "none",
                          borderRadius: 3, padding: "4px 7px",
                          fontSize: 9, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, flexShrink: 0,
                        }}>▶</button>
                        <button onClick={() => { if (window.confirm(`Delete "${m.scaleName}"?`)) setSavedMoments(prev => prev.filter((_, j) => j !== i)); }} title="Delete" style={{
                          background: "none", color: K.t2, border: `1px solid ${K.br}`,
                          borderRadius: 3, padding: "4px 6px",
                          fontSize: 9, cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
                        }}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {/* Beat vol — hidden for now
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, marginBottom: 2 }}>
              <span title="Beat volume." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>BEAT VOL</span>
              <input type="range" min={0} max={1} step={0.01} value={beatVol}
                onChange={e => setBeatVol(+e.target.value)}
                style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
              />
              <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(beatVol * 100)}</span>
            </div>
            */}
            {demoKey && !demoOn && !autoOn && !demoKeyInput && (
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
                <button onClick={() => {
                  setDemoKey("");
                  localStorage.removeItem("chloe-demo-key");
                  setDemoKeyInput(true);
                }} style={{
                  background: "none", border: "none", color: K.t2, fontSize: 9,
                  cursor: "pointer", fontFamily: "inherit", padding: "0 2px",
                  letterSpacing: 0.5,
                }} title="Change or clear API key">⚿ change key</button>
              </div>
            )}
            {demoKeyInput && (
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                <input type="password" placeholder="sk-ant-..." value={demoKey}
                  onChange={e => setDemoKey(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && demoKey) { localStorage.setItem("chloe-demo-key", demoKey); setDemoKeyInput(false); setDemoOn(true); } }}
                  style={{ flex: 1, fontSize: 9, background: K.bg3, border: `1px solid ${K.br}`,
                           color: K.t1, borderRadius: 3, padding: "4px 6px", fontFamily: "inherit", outline: "none" }}
                />
                <button onClick={() => {
                  if (!demoKey) return;
                  localStorage.setItem("chloe-demo-key", demoKey);
                  setDemoKeyInput(false);
                  setDemoOn(true);
                }} style={{
                  fontSize: 9, background: K.a, color: "#000", border: "none",
                  borderRadius: 3, padding: "4px 10px", cursor: "pointer", fontFamily: "inherit", fontWeight: 600,
                }}>Go</button>
              </div>
            )}
            {/* Arp / Melody toggle */}
            <div style={{ display: "flex", gap: 0, border: `1px solid ${K.br}`, borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
              {[{ l: arpDir === "desc" ? "↓ Arpeggio" : arpDir === "rand" ? "↕ Arpeggio" : "↑ Arpeggio", v: false }, { l: "⁓ Melody", v: true }].map(opt => (
                <button key={opt.v} onClick={() => {
                  if (opt.v === false && melMode === false) {
                    // Already in arpeggio mode — cycle direction
                    setArpDir(d => d === "asc" ? "desc" : d === "desc" ? "rand" : "asc");
                  } else {
                    setMelMode(opt.v);
                    if (opt.v === false) setArpDir("asc");
                  }
                }} style={{
                  flex: 1, background: melMode === opt.v ? K.bg3 : "transparent",
                  color: melMode === opt.v ? K.a : K.txt,
                  border: "none",
                  borderRight: opt.v ? "none" : `1px solid ${K.br}`,
                  padding: "5px 4px", fontSize: 9, cursor: "pointer",
                  fontFamily: "inherit", letterSpacing: 0.5,
                  fontWeight: melMode === opt.v ? 600 : 400,
                  transition: "all .15s",
                }}>{opt.l}</button>
              ))}
            </div>
            {/* Octaves */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="Number of octaves to span when playing. 1 = single octave, 2 = two octaves, 3 = three octaves." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>OCTAVES</span>
              <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
                {[1, 2, 3].map(o => (
                  <button key={o} onClick={() => setArpOct(o)} style={{
                    background: arpOct === o ? K.a : K.bg3,
                    color: arpOct === o ? "#000" : K.txt,
                    border: `1px solid ${arpOct === o ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 10px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: arpOct === o ? 600 : 400,
                  }}>{o}</button>
                ))}
              </div>
            </div>
            {/* Grouping — overrides rhythm with even notes in groups of N */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="Play the line in repeating groups of N even notes, each group moved one scale step. Groups of 5 or 6 run against the 4-count, Eric Johnson style, so the line sounds faster and more tangled than it is. The first note of each group is accented. mix = group sizes change within the bar (5+5+6, 3+3+5+5, 5+4+5+5+4+5+4…) and always add up to whole bars, so the line lands back on the downbeat. Off = normal rhythm." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>GROUPS</span>
              <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
                {[0, 3, 5, 6, 7, "mix"].map(g => (
                  <button key={g} onClick={() => setGrouping(g)} style={{
                    background: grouping === g ? K.a : K.bg3,
                    color: grouping === g ? "#000" : K.txt,
                    border: `1px solid ${grouping === g ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 6px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: grouping === g ? 600 : 400,
                  }}>{g || "off"}</button>
                ))}
              </div>
            </div>
            {/* Scale change — hard cut, or blend through voice-leading moves */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="How the line moves to a new scale while playing. Cut = switch at once. Blend = swap the notes that differ one at a time, each to its nearest new note, about one per bar; shared notes stay put, so close scales glide and distant ones take a few bars. The wheel shows the in-between shape." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>SCALE CHANGE</span>
              <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
                {[{ l: "cut", v: false }, { l: "blend", v: true }].map(o => (
                  <button key={o.l} onClick={() => setBlend(o.v)} style={{
                    background: blend === o.v ? K.a : K.bg3,
                    color: blend === o.v ? "#000" : K.txt,
                    border: `1px solid ${blend === o.v ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 8px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: blend === o.v ? 600 : 400,
                  }}>{o.l}</button>
                ))}
              </div>
            </div>
            {/* Tempo change — jump, or glide between BPMs */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="How the tempo moves when the BPM changes (Auto, Claude or the slider). Cut = jump at once. Glide = ease to the new tempo, about 12 seconds per doubling or halving (4 to 30 seconds, up to twice as long with Smooth), so it never drops from fast straight to very slow." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>TEMPO CHANGE</span>
              <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
                {[{ l: "cut", v: false }, { l: "glide", v: true }].map(o => (
                  <button key={o.l} onClick={() => setTempoGlide(o.v)} style={{
                    background: tempoGlide === o.v ? K.a : K.bg3,
                    color: tempoGlide === o.v ? "#000" : K.txt,
                    border: `1px solid ${tempoGlide === o.v ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 8px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: tempoGlide === o.v ? 600 : 400,
                  }}>{o.l}</button>
                ))}
              </div>
            </div>
            {/* Journey — a shape over time that steers Auto (brightness, tempo, reverb, tension) */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: journey === "off" ? 8 : 4 }}>
              <span title="Pick a journey and Auto travels it over the length you choose: Dawn = dark to bright, Dusk = bright to dark, Descent = bright, down into the dark and back up, Storm = calm, a building storm, calm again, Rise = an epic, energizing build to a bright peak. Scales move one note at a time so the change is gradual, and the tempo, reverb and note length follow the shape. Choosing one starts Auto. When it arrives it keeps playing at the destination; if you're recording, it settles on a home scale, fades out and saves the WAV, a finished piece." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>JOURNEY</span>
              <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
                {["off", ...Object.keys(JOURNEYS)].map(v => (
                  <button key={v} title={JOURNEYS[v]?.tip} onClick={() => {
                    setJourney(v);
                    if (v !== "off" && !autoOn) { wake(); setDemoOn(false); setAutoOn(true); }
                  }} style={{
                    background: journey === v ? K.a : K.bg3,
                    color: journey === v ? "#000" : K.txt,
                    border: `1px solid ${journey === v ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 6px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: journey === v ? 600 : 400,
                  }}>{v}</button>
                ))}
              </div>
            </div>
            {journey !== "off" && journey !== "endless" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <span title="How long the journey takes. Changing it mid-journey keeps the clock running, so it may jump ahead or back along the shape." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>LENGTH</span>
                <span style={{ color: JOURNEY_COLOR, fontSize: 9, fontVariantNumeric: "tabular-nums" }}>
                  {journeyNow ? (journeyNow.ending ? "ending…" : journeyNow.arrived ? "arrived · holding" : `${mmss(journeyNow.el)} / ${journeyMins}:00`) : autoOn ? "" : "starts with Auto"}
                </span>
                <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
                  {JOURNEY_MINS.map(m => (
                    <button key={m} onClick={() => setJourneyMins(m)} style={{
                    background: journeyMins === m ? K.a : K.bg3,
                    color: journeyMins === m ? "#000" : K.txt,
                    border: `1px solid ${journeyMins === m ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 7px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: journeyMins === m ? 600 : 400,
                  }}>{m}m</button>
                  ))}
                </div>
              </div>
            )}
            {journeyNow && !journeyNow.endless && (
              <div style={{ height: 2, background: K.bg3, borderRadius: 1, margin: "-4px 0 8px" }}>
                <div style={{ height: 2, width: `${journeyNow.f * 100}%`, background: JOURNEY_COLOR, borderRadius: 1, transition: "width 1s linear" }} />
              </div>
            )}
            {/* Auto tempo — wander, or hold steady with short surprise bursts */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="How Auto moves the tempo. Drift = wander in small steps (about ±10%) around the BPM you started at. Bursts = hold your BPM steady, and every 45-120 seconds (longer with Smooth) throw in a 4-8 bar surprise: double time, a push up, a pull back or half time, then return. Double and half time are usually the lead's alone, over a band that keeps its tempo; sometimes everything moves. With Smooth at 50% or more, only the gentle push and pull. Untick BPM in Auto's ⚙ to stop all tempo changes." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>AUTO TEMPO</span>
              <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
                {["drift", "bursts"].map(v => (
                  <button key={v} onClick={() => setAutoTempo(v)} style={{
                    background: autoTempo === v ? K.a : K.bg3,
                    color: autoTempo === v ? "#000" : K.txt,
                    border: `1px solid ${autoTempo === v ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 8px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: autoTempo === v ? 600 : 400,
                  }}>{v}</button>
                ))}
              </div>
            </div>
            {/* Sound change — switch instrument at once, or crossfade */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="How the sound moves when the instrument or wave changes (Auto or a click). Cut = switch at once. Blend = crossfade over about 4 seconds; each note plays on both sounds, the old one fading out as the new one fades in." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>SOUND CHANGE</span>
              <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
                {[{ l: "cut", v: false }, { l: "blend", v: true }].map(o => (
                  <button key={o.l} onClick={() => setSoundBlend(o.v)} style={{
                    background: soundBlend === o.v ? K.a : K.bg3,
                    color: soundBlend === o.v ? "#000" : K.txt,
                    border: `1px solid ${soundBlend === o.v ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 8px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: soundBlend === o.v ? 600 : 400,
                  }}>{o.l}</button>
                ))}
              </div>
            </div>
            {/* Tuning — equal temperament, or pure ratios above the root */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="How the notes are tuned. Equal = standard 12-tone equal temperament, like a piano or fretted guitar. Just = pure ratios above the root (5/4 major 3rd, 3/2 fifth): very still against the drone; major 3rds are 14 cents flatter than a guitar's. Pyth = Pythagorean, built only from pure 3/2 fifths: fifths are pure, major 3rds come out 8 cents sharp and bright." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>TUNING</span>
              <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
                {["equal", "just", "pyth"].map(v => (
                  <button key={v} onClick={() => setTuning(v)} style={{
                    background: tuning === v ? K.a : K.bg3,
                    color: tuning === v ? "#000" : K.txt,
                    border: `1px solid ${tuning === v ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 8px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: tuning === v ? 600 : 400,
                  }}>{v}</button>
                ))}
              </div>
            </div>
            {/* Symphonic — sampled strings + double bass under the line */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="Adds an orchestra under the line: a string section swells on chords built from the current scale, cellos drive a low pulse, a double bass holds the roots, and timpani and taiko drums hit the changes (a big boom on a new scale), violin and flute weave fast runs through it, all in a cathedral reverb. Uses real recorded samples, a one-time download of about 20 MB the first time you switch it on." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>SYMPHONIC{orchLoading ? " · loading…" : ""}</span>
              <div style={{ display: "flex", gap: 3, marginLeft: "auto" }}>
                {[{ l: "off", v: false }, { l: "orchestra", v: true }].map(o => (
                  <button key={o.l} onClick={() => { setSymphonic(o.v); if (o.v) getOrchestra(getCtx()); }} style={{
                    background: symphonic === o.v ? K.a : K.bg3,
                    color: symphonic === o.v ? "#000" : K.txt,
                    border: `1px solid ${symphonic === o.v ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 8px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: symphonic === o.v ? 600 : 400,
                  }}>{o.l}</button>
                ))}
              </div>
            </div>
            {/* Beat — sampled breakbeat under everything */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="A sampled drum beat (LinnDrum) under the music, compressed for punch, snare in the reverb. Break = big-beat breakbeat with ghost notes. Drive = busier kick, 16th hats. Heavy = half-time slam. Fusion = a session-player groove in the Shrapnel-era fusion style: syncopated kick, ghost notes, ride instead of hats, linear tom fills, accents that follow GROUPS across the bar line, cross-stick when it's calm. Downtempo = a laid-back, swung '90s downtempo groove (think Enigma, Deep Forest): big room snare, clap, shaker, tambourine, congas, no crash. Hand = no kit: congas, shaker and tambourine over a low tom pulse. Brushes = very soft: a shaker swirl, cross-stick taps on 2 and 4, a feathered kick; made for sleep (in Endless, the beat comes and goes on its own). New wave = 1980s LinnDrum: kick on 1 and 3, a huge gated-reverb snare with clap on 2 and 4, 16th hats, a tom run every 8th bar, and a pulsing 8th-note synth bass on the chord roots (I-vi-IV-V and friends); it makes the lead a DX7 electric piano and lifts the scales bright. Desert = a sparse daf/bendir: a deep dum, crisp rim teks, barely-there jingles; it makes the lead a duduk singing phrases with silence between them, leans to Middle Eastern scales (Hijaz and friends), slows the tempo and opens a long reverb (the dam drone does the same). Shaman = a deep frame drum's steady pulse with a heartbeat lead-in and softly jingling pendants, doubling to 8ths as tension rises, a roll into every 4th bar. Downtempo and hand play half-time above 120 BPM, and Auto only switches between styles of the same kind, unless WANDER is on: then it roams every style (calm leans to brushes, hand and shaman, tension to the kit grooves), and wandering into shaman sometimes brings a throat-singing or jaw-harp drone. Fill every 4th bar, crash every 16. Plays half-time above 160 BPM. With the orchestra on, tension doubles the hats and adds kicks." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>BEAT</span>
              <div style={{ display: "flex", gap: 3, marginLeft: "auto", flexWrap: "wrap", justifyContent: "flex-end" }}>
                {["off", "break", "drive", "heavy", "fusion", "downtempo", "hand", "brushes", "shaman", "desert", "newwave"].map(v => (
                  <button key={v} onClick={() => { setBeatStyle(v); if (v !== "off") getKit(getCtx()); }} style={{
                    background: beatStyle === v ? K.a : K.bg3,
                    color: beatStyle === v ? "#000" : K.txt,
                    border: `1px solid ${beatStyle === v ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 8px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: beatStyle === v ? 600 : 400,
                  }}>{v}</button>
                ))}
                <button onClick={() => setBeatWander(w => !w)} title="Wander: under Auto, the beat roams across every style instead of staying in one family. Calm leans to brushes, hand drums and shaman; tension to breakbeat, drive and heavy." style={{
                  background: beatWander ? K.a : K.bg3, color: beatWander ? "#000" : K.txt,
                  border: `1px solid ${beatWander ? K.a : K.br}`, borderRadius: 3, padding: "3px 8px",
                  fontSize: 9, cursor: "pointer", fontFamily: "inherit", fontWeight: beatWander ? 600 : 400,
                }}>wander</button>
              </div>
            </div>
            {/* Rhythm — only applies in arpeggio mode */}
            <div style={{ marginBottom: 8, opacity: melMode || grouping ? 0.35 : 1, transition: "opacity .2s" }}>
              <div title="Arpeggio rhythm pattern. Even = straight quarters. Swing = long-short. Gallop = short-short-long. Waltz = 3/4 feel. Clave = son clave." style={{ color: K.lbl, fontSize: 9, letterSpacing: 2, marginBottom: 5, cursor: "help" }}>RHYTHM</div>
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                {[
                  { l: "even",   v: "even" },
                  { l: "swing",  v: "swing" },
                  { l: "gallop", v: "gallop" },
                  { l: "waltz",  v: "waltz" },
                  { l: "clave",  v: "clave" },
                ].map(opt => (
                  <button key={opt.v} onClick={() => setRhythm(opt.v)} style={{
                    background: rhythm === opt.v ? K.a : K.bg3,
                    color: rhythm === opt.v ? "#000" : K.txt,
                    border: `1px solid ${rhythm === opt.v ? K.a : K.br}`,
                    borderRadius: 3, padding: "3px 7px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                  }}>{opt.l}</button>
                ))}
              </div>
            </div>
            {/* Chord voicing */}
            <div style={{ marginBottom: 2 }}>
              <div title="Chord voicing: off, power (root+5th), sus2 (root+2nd+5th), sus4 (root+4th+5th), triad, 7th, all (whole scale). Notes strum with a slight delay." style={{ color: K.lbl, fontSize: 9, letterSpacing: 2, marginBottom: 5, cursor: "help" }}>CHORD</div>
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                {[
                  { l: "off",   v: "off" },
                  { l: "power", v: "power" },
                  { l: "sus2",  v: "sus2" },
                  { l: "sus4",  v: "sus4" },
                  { l: "triad", v: "triad" },
                  { l: "7th",   v: "7th" },
                  { l: "all",   v: "all" },
                  { l: "rand",  v: "rand" },
                ].map(opt => (
                  <button key={opt.v} onClick={() => setChordVoice(opt.v)} style={{
                    background: chordVoice === opt.v ? K.a : K.bg3,
                    color: chordVoice === opt.v ? "#000" : K.txt,
                    border: `1px solid ${chordVoice === opt.v ? K.a : K.br}`,
                    borderRadius: 3, padding: "4px 7px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit",
                    fontWeight: chordVoice === opt.v ? 600 : 400,
                    transition: "all .15s",
                  }}>{opt.l}</button>
                ))}
              </div>
            </div>
          </Sec>

          {/* Scale info */}
          <div style={{ flex: 1, overflowY: "auto", padding: "14px 14px" }}>
            {sel ? (
              <>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3 }}>
                  {selName && (
                    <div style={{ fontFamily: "'Trebuchet MS', 'Gill Sans', 'Century Gothic', sans-serif", fontSize: 15, fontWeight: 700, color: K.a, letterSpacing: 0.5 }}>
                      {selName}
                    </div>
                  )}
                  <button onClick={handlePin} title="Pin for A/B comparison" style={{
                    background: onPinned ? K.ag : "none", border: `1px solid ${onPinned ? K.a : K.br}`,
                    color: onPinned ? K.a : K.t2, borderRadius: 3, padding: "1px 6px",
                    fontSize: 9, cursor: "pointer", fontFamily: "inherit", letterSpacing: 0.5, flexShrink: 0,
                  }}>⊿ {onPinned ? "pinned" : "pin"}</button>
                </div>
                <div style={{ color: K.t1, fontSize: 11, marginBottom: pinnedScale ? 8 : 14, opacity: 0.75, letterSpacing: 0.5 }}>
                  {ROOTS[rootIdx]} · {selNotes.join("  ")}
                </div>

                {/* A/B comparison panel */}
                {pinnedScale && (() => {
                  const aName = prePinSel ? (KNOWN[prePinSel.pattern] || customNames[prePinSel.pattern] || prePinSel.id) : "—";
                  const bName = KNOWN[pinnedScale.pattern] || customNames[pinnedScale.pattern] || pinnedScale.id;
                  return (
                    <div style={{ display: "flex", border: `1px solid ${K.br}`, borderRadius: 4, marginBottom: 14, overflow: "hidden" }}>
                      {[{side: "a", name: aName, target: prePinSel}, {side: "b", name: bName, target: pinnedScale}].map(({side, name, target}) => {
                        const isActive = onPinned ? side === "b" : side === "a";
                        return (
                          <button key={side} onClick={handleABToggle} disabled={!target}
                            style={{
                              flex: 1, background: isActive ? K.ag : "transparent",
                              color: isActive ? K.a : target ? K.txt : K.t2,
                              border: "none", borderRight: side === "a" ? `1px solid ${K.br}` : "none",
                              padding: "5px 8px", fontSize: 9, cursor: target ? "pointer" : "default",
                              fontFamily: "inherit", fontWeight: isActive ? 600 : 400, textAlign: "left",
                            }}>
                            <div style={{ fontSize: 8, letterSpacing: 2, opacity: 0.6, marginBottom: 1 }}>{side.toUpperCase()}{isActive ? " ▶" : ""}</div>
                            <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
                          </button>
                        );
                      })}
                      <button onClick={handleUnpin} title="Clear A/B" style={{
                        background: "none", border: "none", borderLeft: `1px solid ${K.br}`,
                        color: K.t2, cursor: "pointer", fontSize: 14, padding: "0 9px", flexShrink: 0,
                      }}>×</button>
                    </div>
                  );
                })()}

                <Lbl K={K}>INTERVALS</Lbl>
                <div style={{ color: K.a, fontSize: 14, letterSpacing: 3, fontWeight: 500, marginBottom: 14 }}>
                  {selIvs.join(" - ")}
                </div>

                <Lbl K={K}>BINARY PATTERN</Lbl>
                <div style={{ color: K.t2, fontSize: 10, letterSpacing: 2, marginBottom: 2 }}>{toBin(sel.pattern)}</div>
                <div style={{ color: K.t2, fontSize: 9, opacity: 0.6, marginBottom: 14 }}>decimal {sel.pattern} · brightness {bright(sel.pattern)}</div>

                <Lbl K={K}>KEYBOARD</Lbl>
                <Piano active={selSemis} playing={playing} K={K} />
                <div style={{ display: "flex", marginTop: 5, marginBottom: 16 }}>
                  {CHROMATIC.map((n, i) => (
                    <span key={i} style={{ color: selSemis.has(i) ? K.a : K.t2 + "35", fontSize: 8, width: `${100 / 12}%`, textAlign: "center" }}>{n}</span>
                  ))}
                </div>

                {/* Octave reference */}
                <Lbl K={K}>ALL OCTAVES</Lbl>
                <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                  {selNotes.map((n, i) => (
                    <span key={i} style={{ background: K.bg3, border: `1px solid ${K.br}`, color: K.a, padding: "3px 7px", borderRadius: 3, fontSize: 10 }}>{n}</span>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ color: K.t2, fontSize: 11, lineHeight: 1.8 }}>
                <div style={{ color: K.t1, fontSize: 13, fontWeight: 600, marginBottom: 16, letterSpacing: 0.5 }}>
                  Pick a scale to get started.
                </div>
                {[
                  { step: "1", text: "Click any scale in the left panel — try the Heptatonic group for familiar sounds like Dorian or Lydian." },
                  { step: "2", text: "Hit ▶ Play to arpeggiate through it, or ● Drone for a sustained root tone." },
                  { step: "3", text: "Try ⟲ Auto to explore automatically, or ★ Claude Demo for AI-guided exploration with live commentary." },
                ].map(({ step, text }) => (
                  <div key={step} style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: "50%", background: K.ag,
                      border: `1px solid ${K.a}`, color: K.a, fontSize: 9, fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1,
                    }}>{step}</div>
                    <div style={{ fontSize: 10, lineHeight: 1.7 }}>{text}</div>
                  </div>
                ))}
                <button onClick={() => setShowWelcome(true)} style={{
                  marginTop: 6, background: "none", border: `1px solid ${K.br}`,
                  color: K.t2, borderRadius: 3, padding: "4px 10px",
                  fontSize: 9, cursor: "pointer", fontFamily: "inherit", letterSpacing: 1,
                }}>show intro again</button>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* ── Floating chat panel ── */}
      {demoOn && chatOpen && (
        <div style={{
          position: "fixed", bottom: 24, right: 24, width: 320, zIndex: 500,
          background: K.bg2, border: `1px solid ${K.a}`, borderRadius: 6,
          boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
          display: "flex", flexDirection: "column",
        }}>
          <div style={{ display: "flex", alignItems: "center", padding: "8px 12px", borderBottom: `1px solid ${K.br}`, flexShrink: 0 }}>
            <span style={{ color: K.a, fontSize: 9, letterSpacing: 2, fontWeight: 600 }}>★ CLAUDE CHAT</span>
            <button onClick={() => setChatOpen(false)} style={{
              marginLeft: "auto", background: "none", border: "none",
              color: K.t2, cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px",
            }}>×</button>
          </div>
          <div ref={chatScrollRef} style={{ overflowY: "auto", padding: "10px 12px", maxHeight: 280, minHeight: 60 }}>
            {chatLog.length === 0 ? (
              <div style={{ color: K.t2, fontSize: 10, fontStyle: "italic" }}>Say something to Claude…</div>
            ) : chatLog.map((msg, i) => (
              <div key={msg.ts} style={{ marginBottom: i < chatLog.length - 1 ? 8 : 0, textAlign: msg.role === "user" ? "right" : "left" }}>
                <span style={{
                  display: "inline-block", maxWidth: "85%",
                  background: msg.role === "user" ? K.a + "22" : K.bg3,
                  border: `1px solid ${msg.role === "user" ? K.a + "44" : K.br}`,
                  color: msg.role === "user" ? K.a : K.t1,
                  borderRadius: 4, padding: "5px 9px", fontSize: 10, lineHeight: 1.5,
                }}>{msg.text}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, padding: "8px 10px", borderTop: `1px solid ${K.br}`, flexShrink: 0 }}>
            <input
              autoFocus
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && chatInput.trim()) {
                  const msg = chatInput.trim();
                  setChatLog(prev => [...prev, { role: "user", text: msg, ts: Date.now() }].slice(-40));
                  pendingUserMsgRef.current = msg;
                  setChatInput("");
                  callClaudeNowRef.current?.();
                }
              }}
              placeholder="say something…"
              style={{
                flex: 1, background: K.bg3, border: `1px solid ${K.br}`,
                color: K.txt, padding: "6px 8px", borderRadius: 3,
                fontFamily: "inherit", fontSize: 10, outline: "none",
              }}
            />
            <button onClick={() => {
              if (!chatInput.trim()) return;
              const msg = chatInput.trim();
              setChatLog(prev => [...prev, { role: "user", text: msg, ts: Date.now() }].slice(-40));
              pendingUserMsgRef.current = msg;
              setChatInput("");
              callClaudeNowRef.current?.();
            }} style={{
              background: K.a, border: "none", color: "#000",
              borderRadius: 3, padding: "6px 12px",
              fontSize: 13, cursor: "pointer", fontWeight: 700,
            }}>→</button>
          </div>
        </div>
      )}

      {/* ── Auto/Demo control locks modal ── */}
      {showAutoLocks && (
        <div onClick={() => setShowAutoLocks(false)} style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 600,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: K.bg2, border: `1px solid ${K.br}`, borderRadius: 6,
            padding: "20px 24px", minWidth: 320, maxWidth: 420,
            fontFamily: "inherit", boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <span style={{ color: K.a, fontSize: 10, letterSpacing: 2, fontWeight: 600 }}>AUTO / DEMO CONTROLS</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={() => setAutoLocks(Object.fromEntries(Object.keys(AUTO_LOCKS_DEFAULT).map(k => [k, true])))}
                  style={{ background: "none", border: `1px solid ${K.br}`, color: K.t2, borderRadius: 3, padding: "2px 7px", fontSize: 9, cursor: "pointer", fontFamily: "inherit" }}>all on</button>
                <button onClick={() => setAutoLocks(Object.fromEntries(Object.keys(AUTO_LOCKS_DEFAULT).map(k => [k, false])))}
                  style={{ background: "none", border: `1px solid ${K.br}`, color: K.t2, borderRadius: 3, padding: "2px 7px", fontSize: 9, cursor: "pointer", fontFamily: "inherit" }}>all off</button>
                <button onClick={() => setShowAutoLocks(false)}
                  style={{ background: "none", border: "none", color: K.t2, fontSize: 16, cursor: "pointer", padding: "0 4px", lineHeight: 1 }}>×</button>
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div title="Give Auto a destination: dawn = dark to bright, dusk = bright to dark, descent = down into the dark and back up, storm = calm, storm, calm, rise = an epic build to a bright peak. Starts when Auto starts (or right away if it's running)." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, marginBottom: 6, cursor: "help" }}>JOURNEY</div>
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 6 }}>
                {["off", ...Object.keys(JOURNEYS)].map(v => (
                  <button key={v} title={JOURNEYS[v]?.tip} onClick={() => setJourney(v)} style={{
                      background: journey === v ? K.a : K.bg3, color: journey === v ? "#000" : K.txt,
                      border: `1px solid ${journey === v ? K.a : K.br}`, borderRadius: 3, padding: "3px 6px",
                      fontSize: 9, cursor: "pointer", fontFamily: "inherit", fontWeight: journey === v ? 600 : 400,
                    }}>{v}</button>
                ))}
              </div>
              {journey !== "off" && journey !== "endless" && (
                <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
                  <span style={{ color: K.t2, fontSize: 9, letterSpacing: 2, marginRight: 4 }}>LENGTH</span>
                  {JOURNEY_MINS.map(m => (
                    <button key={m} onClick={() => setJourneyMins(m)} style={{
                      background: journeyMins === m ? K.a : K.bg3, color: journeyMins === m ? "#000" : K.txt,
                      border: `1px solid ${journeyMins === m ? K.a : K.br}`, borderRadius: 3, padding: "3px 6px",
                      fontSize: 9, cursor: "pointer", fontFamily: "inherit", fontWeight: journeyMins === m ? 600 : 400,
                    }}>{m}m</button>
                  ))}
                </div>
              )}
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span title="How hard it is to hear where Auto's changes happen. 0 = everything changes together on each pick, as before. Higher: each setting changes at its own moment between picks, fewer change per pick, reverb/delay/drone levels glide, the sound crossfade stretches to 12 s, scales morph note by note at half speed, the drone fades in and out, and the beat fades (sometimes resting for a while and fading back in) instead of cutting." style={{ color: K.t2, fontSize: 9, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>SMOOTH</span>
                <input type="range" min={0} max={100} step={5} value={Math.round(smooth * 100)}
                  onChange={e => setSmooth(+e.target.value / 100)}
                  style={{ flex: 1, accentColor: K.a, cursor: "pointer" }} />
                <span style={{ color: K.txt, fontSize: 9, minWidth: 28, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{Math.round(smooth * 100)}%</span>
              </div>
            </div>
            <p style={{ color: K.t2, fontSize: 9, margin: "0 0 14px", lineHeight: 1.5 }}>
              Check to allow Auto / Demo to change that setting. Uncheck to keep your current value.
            </p>
            {[
              { label: "PLAYBACK", items: [
                { key: "sound",     label: "Instrument / Wave" },
                { key: "tuning",    label: "Tuning" },
                { key: "beat",      label: "Beat Style" },
                { key: "bpm",       label: "BPM" },
                { key: "reverb",    label: "Reverb" },
                { key: "delay",     label: "Delay" },
                { key: "delayTime", label: "Delay Time" },
                { key: "sustain",   label: "Sustain" },
                { key: "rootNote",  label: "Root Note", demoOnly: true },
              ]},
              { label: "ARPEGGIO / MELODY", items: [
                { key: "rhythm",     label: "Rhythm" },
                { key: "arpDir",     label: "Arp Direction" },
                { key: "grouping",   label: "Groups" },
                { key: "chordVoice", label: "Chord Voicing" },
                { key: "melMode",    label: "Melody Mode", demoOnly: true },
              ]},
              { label: "DRONE", items: [
                { key: "droneOn",   label: "Drone On/Off" },
                { key: "droneVol",  label: "Drone Volume" },
                { key: "droneOct",  label: "Drone Octave" },
                { key: "droneWave", label: "Drone Type" },
              ]},
            ].map(group => (
              <div key={group.label} style={{ marginBottom: 14 }}>
                <div style={{ color: K.t2, fontSize: 9, letterSpacing: 2, marginBottom: 6 }}>{group.label}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 12px" }}>
                  {group.items.map(({ key, label, demoOnly }) => (
                    <label key={key} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                      <input type="checkbox" checked={!!autoLocks[key]}
                        onChange={e => setAutoLocks(prev => ({ ...prev, [key]: e.target.checked }))}
                        style={{ accentColor: K.a, cursor: "pointer" }}
                      />
                      <span style={{ color: autoLocks[key] ? K.txt : K.t2, fontSize: 10 }}>{label}</span>
                      {demoOnly && <span style={{ color: K.t2, fontSize: 9, opacity: 0.6 }}>demo</span>}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}
