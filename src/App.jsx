import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { BRIGHTNESS_CONFIG, brightnessScore, normalizedBrightness, targetBrightness, findClosestScale, countBits, randomAtBrightness, diatonicNeighborhood } from './brightness';

/* ═══════════════════════════════════════════════════════
   SCALE ENGINE
═══════════════════════════════════════════════════════ */

// Right-rotate a 12-bit pattern by n steps
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
};

function synthDrone(ac, freq, type) {
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

function synthKick(ac, vol, an) {
  const osc = ac.createOscillator(), g = ac.createGain();
  const now = ac.currentTime;
  osc.type = "sine";
  osc.frequency.setValueAtTime(150, now);
  osc.frequency.exponentialRampToValueAtTime(40, now + 0.08);
  g.gain.setValueAtTime(0.8 * vol, now);
  g.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
  osc.connect(g); g.connect(ac.destination); if (an) g.connect(an);
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
  src.connect(filt); filt.connect(g); g.connect(ac.destination); if (an) g.connect(an);
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
  src.connect(filt); filt.connect(g); g.connect(ac.destination); if (an) g.connect(an);
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

function buildFamilies() {
  const seen = new Map();
  for (let p = 1; p < 4096; p += 2) {
    const n = bitCt(p);
    if (n < 3 || n > 8 || hasTriple(p)) continue;
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
      return { id: `${pfx[n]}-${cnt[n]}`, n, canon, modes };
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

function synthNote(ac, freq, vel, instrument, timbre, beatDur, reverbSend, delaySend, analyserSend) {
  // reverbSend / delaySend / analyserSend: AudioNode or null
  const dest = ac.destination;
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
const INSTRUMENTS = ["piano", "guitar", "xylo", "space"];
const GRP_NAME = { 3: "Tritonic", 4: "Tetratonic", 5: "Pentatonic", 6: "Hexatonic", 7: "Heptatonic", 8: "Octatonic" };
const GRP_PFX  = { 3: "tri", 4: "tet", 5: "pen", 6: "hex", 7: "hep", 8: "oct" };

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
  br:  "#162030", t1:  "#aabec8", t2:  "#3e5868",
  a:   "#e8922a", ag:  "rgba(232,146,42,0.07)",
  txt: "#c8e4f0", lbl: "#a0c8dc", title: "#d8eaf2",
  demoB: "#0a1a0a", demoBr: "#1a3a1a", demoT: "#a0c8a0", demoT2: "#7ab87a", demoT3: "#5a8a5a", demoT4: "#3a6a3a",
  demoEL: "#0f2a0f", demoE1: "#0d220d",
  wh: "#0a1219", whBr: "#2a4055", whTxt: "#5a8499",
  keyW: "#c8dde4", keyWBr: "#8ab0bc", keyB: "#0e161b",
  modB: "#0d1520", modBr: "#2a3f54", modT: "#d8eaf2", modST: "#6a8fa0",
};

const LIGHT_K = {
  bg:  "#f0f4f7", bg2: "#ffffff", bg3: "#e4eaef",
  br:  "#c0cdd6", t1:  "#1a2830", t2:  "#5a7888",
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
      <div style={{ color: K.lbl, fontSize: 8, letterSpacing: 3, marginBottom: 7, display: "flex", alignItems: "center" }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function Lbl({ children, K }) {
  return <div style={{ color: K.lbl, fontSize: 8, letterSpacing: 3, marginBottom: 5 }}>{children}</div>;
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
  // Full catalogue of all scales (used by randomizer — includes unnamed)
  const fullCatalogue = useMemo(() => {
    const result = [];
    for (const fam of FAMILIES) {
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
        instrument: ["piano","guitar","xylo","space"].includes(p.get("i")) ? p.get("i") : null,
        noteVol:    parseFloat(p.get("v") ?? "0.7"),
        reverbAmt:  parseFloat(p.get("rv") ?? "0.75"),
        delayAmt:   parseFloat(p.get("dl") ?? "0.15"),
        bpm:        parseInt(p.get("b") ?? "100"),
        filter:     p.get("f") ?? "",
        selId:      p.get("s") ?? null,   // "hep-6.1" style
        aRef:       parseInt(p.get("a") ?? "440"),
        droneOct:   p.has("do") ? parseInt(p.get("do")) : null,
        melMode:    p.get("m") === "1",
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
  const [sel,        setSel]        = useState(null); // resolved after FAMILIES built
  const [aRef,       setARef]       = useState(_u.aRef       ?? 440);
  const [droneOn,    setDroneOn]    = useState(false);
  const [droneOct,   setDroneOct]   = useState(_u.droneOct   ?? -24);
  const [arpOn,      setArpOn]      = useState(false);
  const [arpDir,     setArpDir]     = useState("asc"); // "asc" | "desc" | "rand"
  const [arpOct,     setArpOct]     = useState(3);
  const [rhythm,     setRhythm]     = useState("even");
  const [melMode,    setMelMode]    = useState(_u.melMode     ?? false);
  const [chordVoice, setChordVoice] = useState("off"); // off | triad | 7th | sus2 | power | all | rand
  const [playing,    setPlaying]    = useState(null);
  const [expanded,   setExpanded]   = useState(new Set(["hep"]));
  const [sidebarW,   setSidebarW]   = useState(_u.sidebarW   ?? 520);
  const [listW,      setListW]      = useState(360);
  const [urlCopied,  setUrlCopied]  = useState(false);
  const [showHelp,    setShowHelp]    = useState(false);
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem("chloe-welcomed"));
  const [demoOn,      setDemoOn]      = useState(false);
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
  const [droneWave,   setDroneWave]   = useState("tanpura");
  const [beatVol,     setBeatVol]     = useState(1.0);
  const beatStepRef  = useRef(0);
  const beatTimeout  = useRef(null);
  const droneGainRef   = useRef(null);
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
  const AUTO_LOCKS_DEFAULT = { rootNote:true, rhythm:true, arpDir:true, chordVoice:true, melMode:true, bpm:true, reverb:true, delay:true, delayTime:true, sustain:true, droneOn:true, droneVol:true, droneOct:true, droneWave:true };
  const [autoLocks, setAutoLocks] = useState(AUTO_LOCKS_DEFAULT);
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
    if (fam) setExpanded(p => { const s = new Set(p); s.add(GRP_PFX[fam.n]); return s; });
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
  const stRef      = useRef({ rootIdx, timbre, bpm, sel, melMode, arpDir, arpOct, rhythm, chordVoice, instrument, noteVol, reverbAmt, delayAmt, sustainMult, aRef, beatVol });
  useEffect(() => { stRef.current = { rootIdx, timbre, bpm, sel, melMode, arpDir, arpOct, rhythm, chordVoice, instrument, noteVol, reverbAmt, delayAmt, delayTime, sustainMult, aRef, beatVol }; }, [rootIdx, timbre, bpm, sel, melMode, arpDir, arpOct, rhythm, chordVoice, instrument, noteVol, reverbAmt, delayAmt, delayTime, sustainMult, aRef, beatVol]);
  useEffect(() => { try { localStorage.setItem("chloe-saved-moments", JSON.stringify(savedMoments)); } catch {} }, [savedMoments]);
  useEffect(() => { try { localStorage.setItem("chloe-custom-names", JSON.stringify(customNames)); } catch {} }, [customNames]);

  const getCtx = useCallback(() => {
    if (!ctxRef.current || ctxRef.current.state === "closed")
      ctxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    if (ctxRef.current.state === "suspended") ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  const getOrCreateReverb = useCallback((ac) => {
    if (reverbRef.current && reverbRef.current.ac === ac) return reverbRef.current;
    const convolver = ac.createConvolver();
    convolver.buffer = makeImpulse(ac, 2.8, 3.0);
    const wetGain = ac.createGain();
    wetGain.gain.value = stRef.current.reverbAmt;
    convolver.connect(wetGain); wetGain.connect(ac.destination);
    reverbRef.current = { convolver, wetGain, ac };
    return reverbRef.current;
  }, []);

  // Keep reverb wet gain in sync with reverbAmt slider
  useEffect(() => {
    if (reverbRef.current) reverbRef.current.wetGain.gain.value = reverbAmt;
  }, [reverbAmt]);

  const getOrCreateDelay = useCallback((ac) => {
    if (delayRef.current && delayRef.current.ac === ac) return delayRef.current;
    const delayNode = ac.createDelay(2.0);
    delayNode.delayTime.value = stRef.current.delayTime ?? 0.375;
    const feedbackGain = ac.createGain();
    feedbackGain.gain.value = 0.4;
    const wetGain = ac.createGain();
    wetGain.gain.value = stRef.current.delayAmt;
    delayNode.connect(feedbackGain);
    feedbackGain.connect(delayNode);
    delayNode.connect(wetGain);
    wetGain.connect(ac.destination);
    delayRef.current = { delayNode, feedbackGain, wetGain, ac };
    return delayRef.current;
  }, []);

  // Periodic AudioContext recycler — Firefox retains AudioNodes in the context graph even after
  // disconnect() until the context is closed. Recycle every 2 minutes to prevent accumulation.
  useEffect(() => {
    const id = setInterval(() => {
      if (!ctxRef.current) return;
      const old = ctxRef.current;
      ctxRef.current = null;
      reverbRef.current = null;
      delayRef.current = null;
      analyserRef.current = null;
      noteCountRef.current = 0;
      setTimeout(() => { try { old.close(); } catch {} }, 3000);
      setRecycleGen(g => g + 1); // triggers drone to restart on fresh context
    }, 120000); // every 2 minutes
    return () => clearInterval(id);
  }, []);

  // Keep delay wet gain in sync with delayAmt slider
  useEffect(() => {
    if (delayRef.current) delayRef.current.wetGain.gain.value = delayAmt;
  }, [delayAmt]);

  // Keep delay time in sync with delayTime slider
  useEffect(() => {
    if (delayRef.current) delayRef.current.delayNode.delayTime.value = delayTime;
  }, [delayTime]);

  const noteFreq = (semi, ri) => aRef * 2 ** ((60 + OFFS[ri] + semi - 69) / 12);

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
    const voice = synthDrone(ac, dFreq, droneWave);
    droneVoiceRef.current = voice;
    droneFreqRef.current = dFreq;
    const volGain = ac.createGain();
    volGain.gain.setValueAtTime(0, ac.currentTime);
    volGain.gain.linearRampToValueAtTime(droneVol, ac.currentTime + 0.08);
    droneGainRef.current = volGain;
    voice.node.connect(f); f.connect(volGain);
    volGain.connect(ac.destination); volGain.connect(rev.convolver); volGain.connect(del.delayNode); volGain.connect(an.node);
    return () => {
      const now = ac.currentTime;
      volGain.gain.cancelScheduledValues(now);
      volGain.gain.setValueAtTime(volGain.gain.value, now);
      volGain.gain.linearRampToValueAtTime(0, now + 0.08);
      droneGainRef.current = null; droneFilterRef.current = null;
      droneVoiceRef.current = null; droneFreqRef.current = 0;
      setTimeout(() => {
        try { voice.stop(); } catch {}
        try { f.disconnect(); } catch {}
        try { volGain.disconnect(); } catch {}
      }, 100);
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
    const glideTime = 0.3; // 300ms glide
    for (const osc of voice.oscs) {
      const curFreq = osc.frequency.value;
      osc.frequency.cancelScheduledValues(now);
      osc.frequency.setValueAtTime(curFreq, now);
      osc.frequency.exponentialRampToValueAtTime(curFreq * ratio, now + glideTime);
    }
    droneFreqRef.current = newFreq;
  }, [rootIdx, droneOct, aRef]);

  // Keep drone volume in sync with droneVol slider
  useEffect(() => {
    if (droneGainRef.current) droneGainRef.current.gain.value = droneVol;
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
    if (!arpOn || !sel) { playGridRef.current = null; return; }

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

    const playNote = (semi, dur, vel) => {
      const { rootIdx: ri, timbre: t, bpm: b, instrument: inst, noteVol: nv, aRef: ar } = stRef.current;
      const ac = getCtx();
      const rev = getOrCreateReverb(ac);
      const del = getOrCreateDelay(ac);
      const an = getOrCreateAnalyser(ac);
      const freq = ar * 2 ** ((60 + OFFS[ri] + semi - 69) / 12);
      const beatDur = (dur * 60 / b / 2) * stRef.current.sustainMult;
      synthNote(ac, freq, vel * nv, inst, t, beatDur, rev.convolver, del.delayNode, an.node);
      noteCountRef.current++;
      setPlaying(semi % 12);
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

    const melTick = () => {
      const { sel: s, bpm: b, melMode: mm, chordVoice: cv, arpOct: aOct = 1 } = stRef.current;
      if (!s) return;
      const baseNotes = toSemis(s.pattern);
      const notes = [];
      for (let o = 0; o < aOct; o++) baseNotes.forEach(n => notes.push(n + o * 12));
      melPrevRef.current = Math.min(melPrevRef.current, notes.length - 1);
      const eighth = 60000 / b / 2;
      const isChord = cv !== "off";  // "rand" also counts as chord

      if (!mm) {
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
          const durUnits = RHYTHMS[Math.floor(Math.random() * RHYTHMS.length)];
          const vel = 0.12 + Math.random() * 0.16;
          if (Math.random() < 0.08) {
            setPlaying(null);
            melTimeout = setTimeout(melTick, eighth * durUnits);
          } else {
            playNote(semi, durUnits, vel);
            melTimeout = setTimeout(melTick, eighth * durUnits);
          }
        }
      }
    };

    melTick();
    return () => { clearTimeout(melTimeout); clearInterval(arpRef.current); };
  // melTick/playNote read all playback state live from stRef — only arpOn and sel
  // are needed as deps (for the guard). Stable callbacks (getCtx etc.) never change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arpOn, sel, getCtx]);

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
      for (const fam of FAMILIES) {
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
        const currentNorm = currentPattern ? normalizedBrightness(currentPattern) : 0.5;
        if (Math.abs(effectiveTarget - currentNorm) >= effectiveConfig.transitionThreshold) {
          brightnessSelected = findClosestScale(effectiveTarget, catalogue, currentPattern, effectiveConfig);
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
        currentBrightness: stRef.current.sel ? brightnessScore(stRef.current.sel.pattern) : null,
        currentBrightnessNorm: stRef.current.sel ? parseFloat(normalizedBrightness(stRef.current.sel.pattern).toFixed(3)) : null,
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
{"scaleId":"string","rootNote":number,"rhythm":"even"|"swing"|"gallop"|"waltz"|"clave","arpDir":"asc"|"desc"|"rand","chordVoice":"off"|"power"|"sus2"|"sus4"|"triad"|"7th"|"all","bpm":number,"reverbAmt":number,"delayAmt":number,"delayTime":number,"sustainMult":number,"droneOn":boolean,"droneVol":number,"droneOct":number,"droneWave":"sine"|"organ"|"pad"|"strings"|"tanpura","commentary":"string","reply":"string","request":"string","brightnessOverride":number|null,"bpmOverride":"heart_rate"|number|null}
scaleId is the exact ID from the scale list (e.g. "hep-6.5"). rootNote is 0=C 1=C# 2=D 3=D# 4=E 5=F 6=F# 7=G 8=G# 9=A 10=A# 11=B. bpm between 60-160. reverbAmt 0.0-1.0 (reverb wet level). delayAmt 0.0-1.0 (delay wet level). delayTime 0.05-1.5 (delay time in seconds — try rhythmic values like 0.125, 0.25, 0.375, 0.5, 0.75). sustainMult 0.1-3.0 (note duration multiplier: 0.1 = very staccato, 1.0 = default, 2.0 = legato, 3.0 = long overlapping notes — particularly effective with sparse scales and slow BPM). droneOn: whether to enable the drone. droneVol 0.0-2.0 (drone volume). droneOct: semitone drop for drone — 0 (same octave), -12 (1 oct down), -24 (2 oct down), -36 (3 oct down). droneWave: drone timbre — sine (clean), organ (harmonic series), pad (shimmer), strings (bowed), tanpura (Indian pulsing). commentary is 1-2 sentences about this scale's character. reply is a brief conversational response to the user's message if they sent one — omit if no user message. request is optional — if there is a genuinely missing capability you wish the app had, describe it briefly. Omit if you have no request.
The app already has: drone (sustained root note, independently volume-controlled, up to 3 octaves down, 5 timbres), beat (kick/snare/hat patterns), reverb (with wet level control), delay (with wet level and time controls), 4 instruments (piano/guitar/xylo/space), chord voicing (power/sus2/sus4/triad/7th/all), melody mode, arpeggio with direction and rhythm patterns, concert pitch tuning, URL sharing, and favourites. Only request things not on this list.
IMPORTANT: All scales in this app exclude any scale containing 3 or more consecutive semitones. This means common scales like the blues scale, chromatic scale, and others with clustered half-steps are NOT available. Only reference scales that are actually in the available scale list — do not mention or promise scales by name unless they appear in the catalogue provided.
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
      if (AL.droneWave && choice.droneWave != null && ["sine","organ","pad","strings","tanpura"].includes(choice.droneWave)) setDroneWave(choice.droneWave);
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

    const catalogue = FAMILIES.flatMap(fam =>
      fam.modes.map((pat, i) => ({ fam, modeIdx: i, pat }))
    ).filter(({ pat }) => demoAllScalesRef.current || KNOWN[pat] || customNamesRef.current[pat]);

    const RHYTHMS = ["even", "swing", "gallop", "waltz", "clave"];
    const DIRS    = ["asc", "desc", "rand"];
    const VOICES  = ["off", "off", "off", "power", "sus2", "triad"];

    const pickNext = () => {
      if (cancelled) return;
      if (loopOnRef.current) { timeout = setTimeout(pickNext, 1000); return; }
      const { sel: cur } = stRef.current;

      // EEG-aware scale selection: use brain state brightness when available
      let entry = null;
      const _eeg = eegDataRef.current;
      if (_eeg && _eeg.connected && _eeg.bands && _eeg.derived) {
        const bands = _eeg.bands;
        const balSamples = ['gamma','beta','alpha','theta'].map(b => {
          const l = bands[b]?.left_pct || 0, r = bands[b]?.right_pct || 0;
          return (l + r) > 0.5 ? 0.5 + 0.5 * (r - l) / (l + r) : null;
        }).filter(v => v !== null);
        const hemBalance = balSamples.length ? balSamples.reduce((a,b) => a+b,0) / balSamples.length : 0.5;
        const brightTarget = targetBrightness(
          { derived:             { dominant_active_band: _eeg.derived.dominant_active_band },
            bands:               { alpha_pct: (_eeg.bands.alpha.left_pct + _eeg.bands.alpha.right_pct) / 2,
                                   theta_pct: (_eeg.bands.theta.left_pct + _eeg.bands.theta.right_pct) / 2,
                                   beta_pct:  (_eeg.bands.beta.left_pct  + _eeg.bands.beta.right_pct)  / 2 },
            hemispheric_balance: hemBalance },
          BRIGHTNESS_CONFIG
        );
        const catFlat = catalogue.map(e => ({ familyId: e.fam.id, modeIdx: e.modeIdx, pattern: e.fam.modes[e.modeIdx] }));
        const picked = randomAtBrightness(brightTarget, BRIGHTNESS_CONFIG.randomTolerance * 2, catFlat, cur?.pattern, BRIGHTNESS_CONFIG);
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
      const bpm        = Math.round(65 + Math.random() * 85);

      const ac = getCtx();
      if (ac.state === "suspended") ac.resume();

      pick(entry.fam, entry.modeIdx, entry.fam.modes[entry.modeIdx]);
      const _al = autoLocksRef.current;
      if (_al.rhythm)    setRhythm(rhythm);
      if (_al.arpDir)    setArpDir(arpDir);
      if (_al.chordVoice) setChordVoice(chordVoice);
      if (_al.bpm)       setBpm(bpm);
      if (_al.reverb)    setReverbAmt(parseFloat((0.3 + Math.random() * 0.65).toFixed(2)));
      if (_al.delay)     setDelayAmt(parseFloat((Math.random() * 0.5).toFixed(2)));
      if (_al.delayTime) setDelayTime(parseFloat([0.125, 0.25, 0.375, 0.5, 0.75][Math.floor(Math.random() * 5)].toFixed(3)));
      if (_al.sustain) setSustainMult([0.5, 0.7, 0.8, 1.0, 1.0, 1.0, 1.2, 1.5, 2.0][Math.floor(Math.random() * 9)]);
      if (_al.droneOn)   setDroneOn(Math.random() > 0.35);
      if (_al.droneWave) setDroneWave(["sine","organ","pad","strings","tanpura"][Math.floor(Math.random() * 5)]);
      if (_al.droneOct)  setDroneOct([-12, -24, -36][Math.floor(Math.random() * 3)]);
      if (_al.droneVol)  setDroneVol(parseFloat((0.3 + Math.random() * 0.7).toFixed(2)));
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

      timeout = setTimeout(pickNext, monasticModeRef.current ? 180000 : 12000 + Math.random() * 4000);
    };

    pickNext();
    return () => { cancelled = true; clearTimeout(timeout); };
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
    let base = FAMILIES.map(f => {
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
  }, [FAMILIES, filter, favs, favsOnly, customNames, listSearch, noteCountFilter]);

  const grouped = useMemo(() => {
    const g = {};
    for (const f of filtered) (g[f.n] = g[f.n] || []).push(f);
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

  const selSemis = sel ? new Set(toSemis(sel.pattern)) : new Set();
  const selNotes = sel ? toSemis(sel.pattern).map(s => CHROMATIC[(rootIdx + s) % 12]) : [];
  const selIvs = sel
    ? (() => { const s = toSemis(sel.pattern); return s.slice(1).map((v, i) => v - s[i]).concat(12 - s[s.length - 1]); })()
    : [];
  const selName = sel ? (KNOWN[sel.pattern] || customNames[sel.pattern] || null) : null;

  const toggleGrp = n => setExpanded(p => { const s = new Set(p); s.has(GRP_PFX[n]) ? s.delete(GRP_PFX[n]) : s.add(GRP_PFX[n]); return s; });
  const isExp = n => (filter.trim() || listSearch.trim() || noteCountFilter !== null) ? true : expanded.has(GRP_PFX[n]);
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
    if (melMode)     p.set("m",  "1");
    if (sidebarW !== 520) p.set("sw", sidebarW);
    const qs = p.toString();
    return window.location.origin + window.location.pathname + (qs ? "?" + qs : "");
  }, [rootIdx, timbre, instrument, noteVol, reverbAmt, delayAmt, sustainMult, bpm, filter, sel, aRef, droneOct, melMode, sidebarW]);

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
          <div style={{ fontSize: 7, color: K.t2, letterSpacing: 5 }}>SCALE EXPLORER</div>
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
            <span title="Note volume. Drone volume is independent." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>VOL</span>
            <input type="range" min={0} max={1} step={0.01} value={noteVol}
              onChange={e => setNoteVol(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(noteVol * 100)}</span>
          </div>

          {/* REV */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Reverb wet level. Convolution reverb shared by drone and all notes." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>REV</span>
            <input type="range" min={0} max={1} step={0.01} value={reverbAmt}
              onChange={e => setReverbAmt(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(reverbAmt * 100)}</span>
          </div>

          {/* DEL */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Delay wet level." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>DEL</span>
            <input type="range" min={0} max={1} step={0.01} value={delayAmt}
              onChange={e => setDelayAmt(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(delayAmt * 100)}</span>
          </div>

          {/* SUS */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Note sustain — multiplier on note duration. Below 1.0 = staccato, above 1.0 = legato/overlapping." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>SUS</span>
            <input type="range" min={0.1} max={3} step={0.05} value={sustainMult}
              onChange={e => setSustainMult(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{sustainMult.toFixed(1)}</span>
          </div>

          {/* DEL TIME */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Delay time in seconds." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>D.T</span>
            <input type="range" min={0.05} max={1.5} step={0.01} value={delayTime}
              onChange={e => setDelayTime(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 28 }}>{delayTime.toFixed(2)}s</span>
          </div>

          <div style={{ width: 1, height: 22, background: K.t2, opacity: 0.3, flexShrink: 0 }} />

          {/* TUNE */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Concert pitch reference. 440 Hz standard, 432 Hz alternative." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>A =</span>
            <input type="range" min={432} max={440} step={1} value={aRef}
              onChange={e => setARef(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 24 }}>{aRef}</span>
          </div>

          {/* BPM */}
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1 }}>
            <span title="Tempo for arpeggio and melody modes (40-240 BPM)." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>BPM</span>
            <input type="range" min={monasticMode ? 1 : 40} max={240} value={bpm}
              onChange={e => setBpm(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 28 }}>{bpm}</span>
            <button onClick={() => setShowAutoLocks(true)}
              title="Configure which settings Auto and Demo modes can change"
              style={{ background: "none", border: `1px solid ${K.br}`, color: K.t2, borderRadius: 3, padding: "1px 6px", fontSize: 10, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>⚙</button>
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
            const dotColor = brightnessLocked ? "#f0a030" : isOverride ? "#6060e8" : claudeOverride !== null ? "#e87020" : eegStreaming ? "#3ee8d0" : K.a;
            const sliderVal = overrideTarget !== null ? Math.round(overrideTarget * 100)
              : claudeOverride !== null ? Math.round(claudeOverride * 100)
              : eegTarget !== null ? Math.round(eegTarget * 100) : 50;
            const btnStyle = { background: "none", border: `1px solid ${K.demoBr}`, color: K.demoT2,
              fontSize: 9, padding: "2px 6px", cursor: "pointer", borderRadius: 3, flexShrink: 0 };
            return (
              <div style={{ borderTop: `1px solid ${K.demoBr}`, padding: "5px 18px", display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, flexShrink: 0 }}>BRIGHT</span>
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
                      color: isOverride ? "#6060e8" : "#3ee8d0", fontSize: 6, transform: "translateX(-50%)", lineHeight: 1 }}>▲</div>
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
                borderRadius: 3, padding: "2px 7px", fontSize: 8,
                cursor: "pointer", fontFamily: "inherit", letterSpacing: 0.5,
              }}>{n}</button>
            ))}
            {(listSearch || noteCountFilter !== null) && (
              <button onClick={() => { setListSearch(""); setNoteCountFilter(null); }} style={{
                background: "none", border: `1px solid ${K.br}`, color: K.t2,
                borderRadius: 3, padding: "2px 6px", fontSize: 8,
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
                borderRadius: 3, padding: "2px 6px", fontSize: 8,
                cursor: "pointer", fontFamily: "inherit", marginLeft: "auto",
              }}>≈ mode</button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
          {Object.keys(grouped).sort((a, b) => +a - +b).map(nc => {
            const n = +nc, fams = grouped[n], exp = isExp(n);
            return (
              <div key={n}>
                {/* Group header */}
                <div onClick={() => toggleGrp(n)} style={{
                  padding: "7px 16px", background: K.bg2, borderBottom: `1px solid ${K.br}`,
                  display: "flex", alignItems: "center", gap: 10, cursor: "pointer",
                  position: "sticky", top: 0, zIndex: 10, userSelect: "none",
                }}>
                  <span style={{ color: K.a, fontSize: 9, letterSpacing: 3, fontWeight: 600 }}>{GRP_NAME[n].toUpperCase()}</span>
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
                          <span style={{ color: K.t2, fontSize: 9, opacity: 0.7, minWidth: 28 }}>b{bright(mode)}</span>
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
                              <button onClick={e => { e.stopPropagation(); setEditingName(mode); setNameInput(customName); }} title="Edit name" style={{ background: "none", border: "none", color: K.t2, cursor: "pointer", fontSize: 9, padding: "0 2px", flexShrink: 0 }}>✎</button>
                            </>
                          )}
                          {!name && !isEditingThis && !customName && (
                            <button onClick={e => { e.stopPropagation(); setEditingName(mode); setNameInput(""); }} title="Name this scale" style={{ background: "none", border: "none", color: K.t2, cursor: "pointer", fontSize: 9, padding: "0 2px", flexShrink: 0 }}>✎</button>
                          )}
                          {showDiatonic && (() => {
                            const nb = diatonicNeighborhood(mode);
                            return (
                              <span
                                title={`${nb.sharedPitches}/${nb.totalPitches} pitches shared with ${nb.relatives.join(', ')}`}
                                style={{ color: K.t2, fontSize: 8, opacity: 0.75, marginLeft: "auto", flexShrink: 0, whiteSpace: "nowrap" }}
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
              <span title="Drop the drone 1-3 octaves for a deep bass foundation." style={{ color: K.t2, fontSize: 8, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>DRONE OCT</span>
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
              <span title="Drone volume." style={{ color: K.t2, fontSize: 8, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>DRONE VOL</span>
              <input type="range" min={0} max={3} step={0.01} value={droneVol}
                onChange={e => setDroneVol(+e.target.value)}
                style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
              />
              <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(droneVol * 100)}</span>
            </div>
            {/* Drone tone */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="Drone tone — lowpass filter cutoff. Left = dark/muffled, right = bright/open." style={{ color: K.t2, fontSize: 8, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>DRONE TONE</span>
              <input type="range" min={0} max={1} step={0.01} value={droneTone}
                onChange={e => setDroneTone(+e.target.value)}
                style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
              />
              <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(droneTone * 100)}</span>
            </div>
            {/* Drone type */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
              <span title="Drone sound type — sine: clean + sub-octave. organ: additive harmonic series. pad: detuned shimmer. strings: bowed saws with tremolo. tanpura: root/fifth/octaves with pulsing amplitude." style={{ color: K.t2, fontSize: 8, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>DRONE TYPE</span>
              <select value={droneWave} onChange={e => setDroneWave(e.target.value)} style={{
                marginLeft: "auto", background: K.bg3, color: K.txt, border: `1px solid ${K.br}`,
                borderRadius: 3, padding: "3px 6px", fontSize: 9, fontFamily: "inherit",
                cursor: "pointer", letterSpacing: 1,
              }}>
                {["sine", "organ", "pad", "strings", "tanpura"].map(w => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
              {[
                { label: "● Drone", on: droneOn, onClick: () => { wake(); setDroneOn(p => !p); } },
                { label: arpOn && !demoOn && !autoOn ? "■ Stop" : "▶ Play", on: arpOn && !demoOn && !autoOn, disabled: !sel, onClick: () => { wake(); setArpOn(p => !p); } },
                { label: autoOn ? "⟲ Stop" : "⟲ Auto", on: autoOn, onClick: () => {
                  wake();
                  if (autoOn) { setAutoOn(false); setLoopOn(false); setArpOn(false); setDemoComment(""); setDemoRequest(""); setShowDemoLog(false); setEegTarget(null); setOverrideTarget(null); setBrightnessLocked(false); setClaudeOverride(null); setClaudeBpmOverride(null); setSustainMult(1); overrideTargetRef.current = null; brightnessLockedRef.current = false; claudeOverrideRef.current = null; claudeBpmOverrideRef.current = null; }
                  else { setDemoOn(false); setAutoOn(true); }
                }},
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
              ].map(b => (
                <button key={b.label} onClick={b.onClick} disabled={b.disabled} style={{
                  flex: 1, background: b.on ? K.a : K.bg3,
                  color: b.on ? "#000" : b.disabled ? K.txt + "28" : K.txt,
                  border: `1px solid ${b.on ? K.a : K.br}`,
                  borderRadius: 3, padding: "7px 4px",
                  fontSize: 10, cursor: b.disabled ? "default" : "pointer",
                  fontFamily: "inherit", fontWeight: b.on ? 600 : 400,
                  transition: "all .15s",
                }}>{b.label}</button>
              ))}
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
                          <div style={{ color: K.t2, fontSize: 8, letterSpacing: 0.5 }}>{CHROMATIC[m.rootIdx]} · {m.bpm}bpm · {m.rhythm} · {m.arpDir}{m.chordVoice !== "off" ? ` · ${m.chordVoice}` : ""}</div>
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
              <span title="Beat volume." style={{ color: K.t2, fontSize: 8, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>BEAT VOL</span>
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
              <span title="Number of octaves to span when playing. 1 = single octave, 2 = two octaves, 3 = three octaves." style={{ color: K.t2, fontSize: 8, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>OCTAVES</span>
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
            {/* Rhythm — only applies in arpeggio mode */}
            <div style={{ marginBottom: 8, opacity: melMode ? 0.35 : 1, transition: "opacity .2s" }}>
              <div title="Arpeggio rhythm pattern. Even = straight quarters. Swing = long-short. Gallop = short-short-long. Waltz = 3/4 feel. Clave = son clave." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, marginBottom: 5, cursor: "help" }}>RHYTHM</div>
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
              <div title="Chord voicing: off, power (root+5th), sus2 (root+2nd+5th), sus4 (root+4th+5th), triad, 7th, all (whole scale). Notes strum with a slight delay." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, marginBottom: 5, cursor: "help" }}>CHORD</div>
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
                    fontSize: 8, cursor: "pointer", fontFamily: "inherit", letterSpacing: 0.5, flexShrink: 0,
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
                            <div style={{ fontSize: 7, letterSpacing: 2, opacity: 0.6, marginBottom: 1 }}>{side.toUpperCase()}{isActive ? " ▶" : ""}</div>
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
                    <span key={i} style={{ color: selSemis.has(i) ? K.a : K.t2 + "35", fontSize: 7, width: `${100 / 12}%`, textAlign: "center" }}>{n}</span>
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
            <p style={{ color: K.t2, fontSize: 9, margin: "0 0 14px", lineHeight: 1.5 }}>
              Check to allow Auto / Demo to change that setting. Uncheck to keep your current value.
            </p>
            {[
              { label: "PLAYBACK", items: [
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
                <div style={{ color: K.t2, fontSize: 8, letterSpacing: 2, marginBottom: 6 }}>{group.label}</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "5px 12px" }}>
                  {group.items.map(({ key, label, demoOnly }) => (
                    <label key={key} style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                      <input type="checkbox" checked={!!autoLocks[key]}
                        onChange={e => setAutoLocks(prev => ({ ...prev, [key]: e.target.checked }))}
                        style={{ accentColor: K.a, cursor: "pointer" }}
                      />
                      <span style={{ color: autoLocks[key] ? K.txt : K.t2, fontSize: 10 }}>{label}</span>
                      {demoOnly && <span style={{ color: K.t2, fontSize: 8, opacity: 0.6 }}>demo</span>}
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
