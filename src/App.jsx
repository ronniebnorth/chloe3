import { useState, useEffect, useRef, useMemo, useCallback } from "react";

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
  const connectOut = (node) => {
    node.connect(dest);
    if (reverbSend) node.connect(reverbSend);
    if (delaySend) node.connect(delaySend);
    if (analyserSend) node.connect(analyserSend);
  };
  const now = ac.currentTime;

  if (instrument === "piano") {
    const g = ac.createGain();
    const f = ac.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 4000;
    const oscs = [];
    [0, 4, -4].forEach(detune => {
      const o = ac.createOscillator(); o.type = "triangle";
      o.frequency.value = freq; o.detune.value = detune;
      o.connect(g); oscs.push(o);
    });
    // 2nd + 3rd harmonics for brightness
    [2, 3].forEach((mult, i) => {
      const o = ac.createOscillator(); o.type = "sine";
      o.frequency.value = freq * mult;
      const og = ac.createGain(); og.gain.value = [0.12, 0.04][i];
      o.connect(og); og.connect(g); oscs.push(o);
    });
    const dur = Math.min(beatDur * 1.6, 3.2);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vel * 0.7, now + 0.006);
    g.gain.setTargetAtTime(vel * 0.22, now + 0.018, 0.07);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    g.connect(f); connectOut(f);
    oscs.forEach(o => { o.start(now); o.stop(now + dur); });
    return { start: now, stop: now + dur };
  }

  if (instrument === "guitar") {
    // Karplus-Strong-ish: noise burst into resonant filter, decay
    const g = ac.createGain();
    const filt = ac.createBiquadFilter(); filt.type = "bandpass";
    filt.frequency.value = freq; filt.Q.value = 18;
    const buf = ac.createBuffer(1, ac.sampleRate * 0.04, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src2 = ac.createBufferSource(); src2.buffer = buf;
    src2.connect(filt); filt.connect(g);
    // Tone oscillator underneath
    const o = ac.createOscillator(); o.type = "triangle";
    o.frequency.value = freq;
    const og = ac.createGain(); og.gain.value = 0.3;
    o.connect(og); og.connect(g);
    const dur = Math.min(beatDur * 1.2, 2.2);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vel * 0.9, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    connectOut(g);
    src2.start(now); src2.stop(now + 0.05);
    o.start(now); o.stop(now + dur);
    return { start: now, stop: now + dur };
  }

  if (instrument === "xylo") {
    // Very percussive: fast attack, very fast decay, bright harmonics
    const g = ac.createGain();
    const f = ac.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 800;
    [1, 2.756, 5.404].forEach((ratio, i) => {
      const o = ac.createOscillator(); o.type = "sine";
      o.frequency.value = freq * ratio;
      const og = ac.createGain(); og.gain.value = [0.7, 0.25, 0.08][i];
      o.connect(og); og.connect(g);
      o.start(now); o.stop(now + 0.9);
    });
    const dur = 0.55;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vel, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    g.connect(f); connectOut(f);
    return { start: now, stop: now + dur };
  }

  if (instrument === "space") {
    // 4 detuned sines, slow attack, reverb-like long decay, slight LFO
    const g = ac.createGain();
    const f = ac.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 1600;
    const detunings = [-8, -3, 3, 8];
    const lfo = ac.createOscillator(); lfo.type = "sine"; lfo.frequency.value = 0.4;
    const lfoG = ac.createGain(); lfoG.gain.value = 4;
    lfo.connect(lfoG);
    detunings.forEach(d => {
      const o = ac.createOscillator(); o.type = "sine";
      o.frequency.value = freq; o.detune.value = d;
      lfoG.connect(o.frequency); // subtle vibrato
      const og = ac.createGain(); og.gain.value = 0.28;
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
    return { start: now, stop: now + dur };
  }

  // Fallback: raw oscillator (original timbre mode)
  const o = ac.createOscillator(); o.type = timbre;
  o.frequency.value = freq;
  const g = ac.createGain();
  const f = ac.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 2400;
  const dur = beatDur * 0.82;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(vel, now + 0.012);
  g.gain.exponentialRampToValueAtTime(0.001, now + dur);
  o.connect(g); g.connect(f); connectOut(f);
  o.start(now); o.stop(now + dur);
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
  { title: "BRIGHTNESS SORTING", body: "Within each family, modes are sorted bright to dark by summing their active semitone positions. Lydian scores highest (raised 4th), Locrian lowest (flatted 2nd and 5th). This mirrors the circle-of-fifths: Lydian -> Ionian -> Mixolydian -> Dorian -> Aeolian -> Phrygian -> Locrian." },
  { title: "SCALE WHEEL", body: "The circle shows all 12 chromatic notes. Active tones are highlighted and connected by a polygon. Wide polygons = sparse scales. Compact polygons = denser chromatic scales. A perfect regular polygon = equal temperament." },
  { title: "FILTER", body: "Accepts comma-separated terms. Search by family ID (hep-6), group prefix (pen, hep, hex), scale name (Dorian, Lydian), binary fragment (101011), decimal value (2741), or interval pattern (2-2-1, 2 1 2). The interval filter matches any contiguous run within the scale. Use the star button on any row to favourite a scale. The favs button in the header filters to starred scales only." },
  { title: "PLAYBACK", body: "Drone sustains the root note. DRONE OCT drops it 1-3 octaves. DRONE VOL sets its level independently. Beat adds a live-synthesised kick/snare/hat pattern that follows the current RHYTHM setting. Play steps through the scale in Arpeggio or Melody mode. Click the Arpeggio button repeatedly to cycle direction: ↑ ascending, ↓ descending, ↕ random walk. RHYTHM sets the note spacing pattern for arpeggio and beat: even (straight quarters), swing (long-short), gallop (short-short-long), waltz (3/4 feel), or clave (son clave). Melody uses a weighted random walk with its own rhythm variation and octave leaps. CHORD layers multiple scale tones per step - power (root+5th), sus2, triad, 7th, or all notes at once." },
  { title: "SOUND", body: "All instruments are synthesised in the browser using Web Audio. piano = detuned triangle oscillators with harmonic decay. guitar = Karplus-Strong style noise burst. xylo = marimba-ratio harmonic partials. space = detuned sines with LFO vibrato. VOL sets note volume. DRONE VOL sets drone level (up to 3×). BEAT VOL sets percussion level. REV adds convolution reverb. A= sets concert pitch (432-440 Hz). BPM sets tempo." },
  { title: "SHARE / URL", body: "The share button encodes all settings into the URL and copies it to clipboard. Paste or bookmark to restore the exact session: scale, root, instrument, BPM, tuning, chord mode, and more." },
  { title: "★ DEMO MODE", body: "Demo mode uses the Claude AI API to autonomously explore scales — picking which scale to play, root note, rhythm, arpeggio direction, chord voicing, and BPM every 12-16 seconds, with live commentary in the banner. Claude can also leave feature requests (shown in amber with ✦) if it notices something it wishes the app could do — these accumulate in the log. Click ★ Demo and enter your Anthropic API key (get one at console.anthropic.com under API Keys — requires separate billing from Claude.ai subscriptions). Your key is stored in your browser only and never sent anywhere except the Anthropic API. To change or clear your key, click the key icon that appears next to the Demo button when a key is saved." },
];

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
            <a href="chloe3-guide.html" target="_blank" rel="noreferrer" style={{ color: K.a, textDecoration: "none", letterSpacing: 1 }}>full guide ↗</a>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   VISUALIZER
═══════════════════════════════════════════════════════ */

function Visualizer({ analyserRef, playing, rootIdx, K }) {
  const canvasRef  = useRef(null);
  const rafRef     = useRef(null);
  const KRef       = useRef(K);
  useEffect(() => { KRef.current = K; }, [K]);
  const playingRef = useRef(playing);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  const rootIdxRef = useRef(rootIdx);
  useEffect(() => { rootIdxRef.current = rootIdx; }, [rootIdx]);
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
      const { whBr } = KRef.current;

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
      if (!analyser) return;
      analyser.getByteTimeDomainData(data);
      const N = data.length;

      // Waveform ring
      ctx.beginPath();
      for (let i = 0; i <= N; i++) {
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
      ctx.lineWidth = 1.5;
      ctx.shadowColor = noteColor;
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.shadowBlur = 0;
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
   MAIN APP
═══════════════════════════════════════════════════════ */

export default function Chloe() {
  const FAMILIES = useMemo(buildFamilies, []);

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
        droneOct:   parseInt(p.get("do") ?? "0"),
        melMode:    p.get("m") === "1",
        sidebarW:   parseInt(p.get("sw") ?? "280"),
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
  const [bpm,        setBpm]        = useState(_u.bpm        ?? 100);
  const [filter,     setFilter]     = useState(_u.filter     ?? "");
  const [sel,        setSel]        = useState(null); // resolved after FAMILIES built
  const [aRef,       setARef]       = useState(_u.aRef       ?? 440);
  const [droneOn,    setDroneOn]    = useState(false);
  const [droneOct,   setDroneOct]   = useState(_u.droneOct   ?? 0);
  const [arpOn,      setArpOn]      = useState(false);
  const [arpDir,     setArpDir]     = useState("asc"); // "asc" | "desc" | "rand"
  const [rhythm,     setRhythm]     = useState("even");
  const [melMode,    setMelMode]    = useState(_u.melMode     ?? false);
  const [chordVoice, setChordVoice] = useState("off"); // off | triad | 7th | sus2 | power | all | rand
  const [playing,    setPlaying]    = useState(null);
  const [expanded,   setExpanded]   = useState(new Set(["hep"]));
  const [sidebarW,   setSidebarW]   = useState(_u.sidebarW   ?? 280);
  const [urlCopied,  setUrlCopied]  = useState(false);
  const [showHelp,   setShowHelp]   = useState(false);
  const [demoOn,      setDemoOn]      = useState(false);
  const [demoKey,     setDemoKey]     = useState(() => localStorage.getItem("chloe-demo-key") || "");
  const [demoComment, setDemoComment] = useState("");
  const [demoRequest, setDemoRequest] = useState("");
  const [demoKeyInput, setDemoKeyInput] = useState(false);
  const [demoLog,     setDemoLog]     = useState([]);
  const [showDemoLog, setShowDemoLog] = useState(false);
  const [logCopied,   setLogCopied]   = useState(false);
  const [autoOn,      setAutoOn]      = useState(false);
  const [beatOn,      setBeatOn]      = useState(false);
  const [droneVol,    setDroneVol]    = useState(1.0);
  const [beatVol,     setBeatVol]     = useState(1.0);
  const beatStepRef  = useRef(0);
  const beatTimeout  = useRef(null);
  const droneGainRef = useRef(null);
  const demoLogRef   = useRef([]);
  useEffect(() => { demoLogRef.current = demoLog; }, [demoLog]);
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
  const [theme,      setTheme]      = useState(() => localStorage.getItem("chloe-theme") || "dark");
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
  const arpRef      = useRef(null);
  const arpIdxRef   = useRef(0);
  const rhythmIdxRef = useRef(0);
  const melPrevRef  = useRef(0);
  const stRef      = useRef({ rootIdx, timbre, bpm, sel, melMode, arpDir, rhythm, chordVoice, instrument, noteVol, reverbAmt, delayAmt, aRef, beatVol });
  useEffect(() => { stRef.current = { rootIdx, timbre, bpm, sel, melMode, arpDir, rhythm, chordVoice, instrument, noteVol, reverbAmt, delayAmt, aRef, beatVol }; }, [rootIdx, timbre, bpm, sel, melMode, arpDir, rhythm, chordVoice, instrument, noteVol, reverbAmt, delayAmt, aRef, beatVol]);

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
    delayNode.delayTime.value = (60 / stRef.current.bpm) * 0.75; // dotted eighth
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

  // Keep delay wet gain in sync with delayAmt slider
  useEffect(() => {
    if (delayRef.current) delayRef.current.wetGain.gain.value = delayAmt;
  }, [delayAmt]);

  // Keep delay time in sync with BPM
  useEffect(() => {
    if (delayRef.current) delayRef.current.delayNode.delayTime.value = (60 / bpm) * 0.75;
  }, [bpm]);

  const noteFreq = (semi, ri) => aRef * 2 ** ((60 + OFFS[ri] + semi - 69) / 12);

  /* ── Drone ── */
  useEffect(() => {
    if (!droneOn) return;
    const ac = getCtx();
    const rev = getOrCreateReverb(ac);
    const del = getOrCreateDelay(ac);
    const an = getOrCreateAnalyser(ac);
    const osc = ac.createOscillator(), g = ac.createGain(), f = ac.createBiquadFilter();
    f.type = "lowpass"; f.frequency.value = 1200;
    osc.type = instrument ? "sine" : timbre;
    const dFreq = aRef * 2 ** ((60 + OFFS[rootIdx] + droneOct - 69) / 12);
    osc.frequency.value = dFreq;
    g.gain.value = instrument === "space" ? 0.03 : 0.05;
    const volGain = ac.createGain(); volGain.gain.value = droneVol;
    droneGainRef.current = volGain;
    const droneOut = (node) => { node.connect(volGain); volGain.connect(ac.destination); volGain.connect(rev.convolver); volGain.connect(del.delayNode); volGain.connect(an.node); };
    if (instrument === "space") {
      const o2 = ac.createOscillator(); o2.type = "sine";
      o2.frequency.value = dFreq; o2.detune.value = 5;
      o2.connect(g); o2.start();
      osc.connect(g); g.connect(f); droneOut(f);
      osc.start();
      return () => { try { osc.stop(); o2.stop(); } catch(e){} droneGainRef.current = null; };
    }
    osc.connect(g); g.connect(f); droneOut(f);
    osc.start();
    return () => { try { osc.stop(); } catch (e) {} droneGainRef.current = null; };
  }, [droneOn, rootIdx, droneOct, aRef, timbre, instrument, getCtx, getOrCreateReverb, getOrCreateDelay, getOrCreateAnalyser]);

  // Keep drone volume in sync with droneVol slider
  useEffect(() => {
    if (droneGainRef.current) droneGainRef.current.gain.value = droneVol;
  }, [droneVol]);

  /* ── Beat ── */
  useEffect(() => {
    if (!beatOn) return;
    beatStepRef.current = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      const { bpm, beatVol: vol, rhythm: patKey } = stRef.current;
      const pat = BEAT_PATTERNS[patKey] ?? BEAT_PATTERNS.even;
      const step = beatStepRef.current % pat.loop.length;
      const [k, s, h] = pat.loop[step];
      const ac = getCtx();
      const an = getOrCreateAnalyser(ac);
      if (k) synthKick(ac, vol, an.node);
      if (s) synthSnare(ac, vol, an.node);
      if (h) synthHat(ac, vol, an.node);
      beatStepRef.current++;
      const quarterMs = 60000 / bpm;
      // swing: even steps get (1+sw) fraction, odd steps get (1-sw) fraction
      const ms = pat.sub * quarterMs * (step % 2 === 1 ? (1 - pat.sw) : (1 + pat.sw));
      beatTimeout.current = setTimeout(tick, ms);
    };

    tick();
    return () => { cancelled = true; clearTimeout(beatTimeout.current); };
  }, [beatOn, getCtx, getOrCreateAnalyser]);

  /* ── Arpeggio / Melody ── */
  useEffect(() => {
    clearInterval(arpRef.current);
    setPlaying(null);
    if (!arpOn || !sel) return;
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
      // 20% chance of playing it an octave higher
      const octShift = Math.random() < 0.2 ? 12 : 0;
      return notes[idx] + octShift;
    };

    // For melody mode, we schedule with variable intervals using setTimeout chains
    let melTimeout = null;
    const eighth = 60000 / stRef.current.bpm / 2;

    const playNote = (semi, dur, vel) => {
      const { rootIdx: ri, timbre: t, bpm: b, instrument: inst, noteVol: nv, aRef: ar } = stRef.current;
      const ac = getCtx();
      const rev = getOrCreateReverb(ac);
      const del = getOrCreateDelay(ac);
      const an = getOrCreateAnalyser(ac);
      const freq = ar * 2 ** ((60 + OFFS[ri] + semi - 69) / 12);
      const beatDur = (dur * 60 / b / 2);
      synthNote(ac, freq, vel * nv, inst, t, beatDur, rev.convolver, del.delayNode, an.node);
      setPlaying(semi % 12);
    };

    // Build chord tones from a root index within the scale
    const RAND_VOICES = ["power", "sus2", "triad", "7th"];
    const buildChord = (notes, rootNoteIdx, voice) => {
      const n = notes.length;
      const v = voice === "rand" ? RAND_VOICES[Math.floor(Math.random() * RAND_VOICES.length)] : voice;
      if (v === "off")   return [notes[rootNoteIdx % n]];
      if (v === "power") return [notes[rootNoteIdx % n], notes[(rootNoteIdx + 2) % n] + (rootNoteIdx + 2 >= n ? 12 : 0)];
      if (v === "sus2")  return [notes[rootNoteIdx % n], notes[(rootNoteIdx + 1) % n] + (rootNoteIdx + 1 >= n ? 12 : 0), notes[(rootNoteIdx + 4) % n] + (rootNoteIdx + 4 >= n ? 12 : 0)];
      if (v === "triad") return [0, 2, 4].map(s => notes[(rootNoteIdx + s) % n] + (rootNoteIdx + s >= n ? 12 : 0));
      if (v === "7th")   return [0, 2, 4, 6].map(s => notes[(rootNoteIdx + s) % n] + (rootNoteIdx + s >= n ? 12 : 0));
      if (voice === "all")   return notes; // whole scale at once
      return [notes[rootNoteIdx % n]];
    };

    const playChord = (rootNoteIdx, dur, vel, notes) => {
      const { chordVoice: cv } = stRef.current;
      const tones = buildChord(notes, rootNoteIdx, cv);
      // Slightly lower velocity per voice to avoid clipping
      const vMult = cv === "all" ? 0.4 : cv === "7th" ? 0.65 : cv === "triad" ? 0.7 : cv === "sus2" ? 0.72 : 0.8;
      tones.forEach((semi, i) => {
        // Very slight strum delay (0-18ms) for natural feel
        setTimeout(() => playNote(semi, dur, vel * vMult), i * 18);
      });
      // Show all chord tones on the wheel
      setPlaying(tones[0] % 12);
    };

    const melTick = () => {
      const { sel: s, bpm: b, melMode: mm, chordVoice: cv } = stRef.current;
      if (!s) return;
      const notes = toSemis(s.pattern);
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
  }, [arpOn, sel, rootIdx, timbre, instrument, bpm, melMode, arpDir, rhythm, chordVoice, getCtx, getOrCreateAnalyser]);

  useEffect(() => () => clearInterval(arpRef.current), []);

  /* ── Demo mode: Claude autonomously explores scales ── */
  useEffect(() => {
    if (!demoOn || !demoKey) return;

    let cancelled = false;
    let timeout = null;

    const callClaude = async () => {
      // Build scale catalogue from KNOWN scales
      const catalogue = [];
      for (const fam of FAMILIES) {
        fam.modes.forEach((pat, mi) => {
          const name = KNOWN[pat];
          if (name) {
            const semis = toSemis(pat);
            const ivs = semis.slice(1).map((v, i) => v - semis[i]).concat(12 - semis[semis.length - 1]);
            catalogue.push({ familyId: fam.id, modeIdx: mi, name, notes: fam.n, intervals: ivs.join("-") });
          }
        });
      }

      const currentState = {
        currentScale: stRef.current.sel ? (KNOWN[stRef.current.sel.pattern] || stRef.current.sel.id) : "none",
        rootNote: CHROMATIC[stRef.current.rootIdx],
        rhythm: stRef.current.rhythm,
        arpDir: stRef.current.arpDir,
        bpm: stRef.current.bpm,
      };

      const recentHistory = demoLogRef.current.slice(0, 20).map(e =>
        `ID="${e.famId}.${e.modeIdx}" name="${e.scaleName}" root=${CHROMATIC[e.rootNote]} rhythm=${e.rhythm} bpm=${e.bpm}`
      );

      const { Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: demoKey, dangerouslyAllowBrowser: true });

      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: `You are exploring a musical scale app. Each turn you choose a scale to play and settings to use.
Respond ONLY with valid JSON matching this schema exactly:
{"scaleId":"string","rootNote":number,"rhythm":"even"|"swing"|"gallop"|"waltz"|"clave","arpDir":"asc"|"desc"|"rand","chordVoice":"off"|"power"|"sus2"|"triad"|"7th"|"all","bpm":number,"commentary":"string","request":"string"}
scaleId is the exact ID from the scale list (e.g. "hep-6.5"). rootNote is 0=C 1=C# 2=D 3=D# 4=E 5=F 6=F# 7=G 8=G# 9=A 10=A# 11=B. bpm between 60-160. commentary is 1-2 sentences about this scale's character. request is optional — if there is a genuinely missing capability you wish the app had, describe it briefly. Omit if you have no request.
The app already has: drone (sustained root note, independently volume-controlled, up to 3 octaves down), beat (kick/snare/hat patterns), reverb, delay, 4 instruments (piano/guitar/xylo/space), chord voicing (power/sus2/triad/7th/all), melody mode, arpeggio with direction and rhythm patterns, concert pitch tuning, URL sharing, and favourites. Only request things not on this list.`,
        messages: [{
          role: "user",
          content: `Current state: ${JSON.stringify(currentState)}${recentHistory.length ? `\n\nRecent history (most recent first):\n${recentHistory.join("\n")}` : ""}\n\nAvailable scales (use the ID exactly as shown):\n${catalogue.map(s => `ID="${s.familyId}.${s.modeIdx}" name="${s.name}" notes=${s.notes} intervals=${s.intervals}`).join("\n")}\n\nChoose the next scale to explore. Vary musically — contrast brightness, note density, and feel with the recent history. Avoid repeating scales just played.`
        }]
      });

      if (cancelled) return;

      const raw = msg.content[0].text.trim();
      const json = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
      const choice = JSON.parse(json);

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
      const bpm      = Math.max(40, Math.min(240, choice.bpm || 100));
      setRootIdx(rootNote);
      setRhythm(rhythm);
      setArpDir(arpDir);
      setChordVoice(chordVoice);
      setMelMode(!!choice.melMode);
      setBpm(bpm);
      setArpOn(true);
      setDemoComment(choice.commentary || "");
      setDemoRequest(choice.request || "");

      if (fam && !isNaN(modeIdx)) {
        setDemoLog(prev => [{
          scaleName: KNOWN[fam.modes[modeIdx]] || choice.scaleId,
          famId, modeIdx, rootNote, rhythm, arpDir, chordVoice, bpm,
          commentary: choice.commentary || "",
          request: choice.request || "",
          ts: Date.now(),
        }, ...prev]);
      }

      const delay = 12000 + Math.random() * 4000;
      timeout = setTimeout(callClaude, delay);
    };

    callClaude().catch(err => {
      if (!cancelled) setDemoComment(`Error: ${err.message}`);
    });

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [demoOn, demoKey, getCtx]); // reads live state via stRef/FAMILIES; getCtx is stable (useCallback [])

  /* ── Free auto-demo: random named scale explorer, no API key ── */
  useEffect(() => {
    if (!autoOn) return;
    let cancelled = false;
    let timeout = null;

    const catalogue = FAMILIES.flatMap(fam =>
      fam.modes.map((pat, i) => ({ fam, modeIdx: i, pat }))
    ).filter(({ pat }) => KNOWN[pat]);

    const RHYTHMS = ["even", "swing", "gallop", "waltz", "clave"];
    const DIRS    = ["asc", "desc", "rand"];
    const VOICES  = ["off", "off", "off", "power", "sus2", "triad"];

    const pickNext = () => {
      if (cancelled) return;
      const { sel: cur } = stRef.current;

      const options = catalogue.filter(e => !cur || e.fam.modes[e.modeIdx] !== cur.pattern);
      const entry = options[Math.floor(Math.random() * options.length)];
      const rhythm     = RHYTHMS[Math.floor(Math.random() * RHYTHMS.length)];
      const arpDir     = DIRS[Math.floor(Math.random() * DIRS.length)];
      const chordVoice = VOICES[Math.floor(Math.random() * VOICES.length)];
      const bpm        = Math.round(65 + Math.random() * 85);

      const ac = getCtx();
      if (ac.state === "suspended") ac.resume();

      pick(entry.fam, entry.modeIdx, entry.fam.modes[entry.modeIdx]);
      setRhythm(rhythm);
      setArpDir(arpDir);
      setChordVoice(chordVoice);
      setBpm(bpm);
      setArpOn(true);

      const scaleName = KNOWN[entry.fam.modes[entry.modeIdx]];
      setDemoComment(`${scaleName} — ${entry.fam.n} notes · ${rhythm} · ${bpm}bpm`);

      setDemoLog(prev => [{
        scaleName,
        famId: entry.fam.id, modeIdx: entry.modeIdx,
        rootNote: stRef.current.rootIdx,
        rhythm, arpDir, chordVoice, bpm,
        commentary: `${scaleName} — ${entry.fam.n} notes · ${rhythm} · ${bpm}bpm`,
        ts: Date.now(),
      }, ...prev]);

      timeout = setTimeout(pickNext, 12000 + Math.random() * 4000);
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

    if (!filter.trim()) return base;
    const terms = filter.split(",").map(t => t.trim().toLowerCase()).filter(Boolean);
    return base.filter(f =>
      terms.some(t =>
        f.id.includes(t) ||
        GRP_PFX[f.n].startsWith(t) ||
        f.modes.some(m =>
          toBin(m).includes(t) ||
          (KNOWN[m] || "").toLowerCase().includes(t) ||
          matchesInterval(t, m)
        )
      )
    );
  }, [FAMILIES, filter, favs, favsOnly]);

  const grouped = useMemo(() => {
    const g = {};
    for (const f of filtered) (g[f.n] = g[f.n] || []).push(f);
    return g;
  }, [filtered]);

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

  const selSemis = sel ? new Set(toSemis(sel.pattern)) : new Set();
  const selNotes = sel ? toSemis(sel.pattern).map(s => CHROMATIC[(rootIdx + s) % 12]) : [];
  const selIvs = sel
    ? (() => { const s = toSemis(sel.pattern); return s.slice(1).map((v, i) => v - s[i]).concat(12 - s[s.length - 1]); })()
    : [];
  const selName = sel ? KNOWN[sel.pattern] : null;

  const toggleGrp = n => setExpanded(p => { const s = new Set(p); s.has(GRP_PFX[n]) ? s.delete(GRP_PFX[n]) : s.add(GRP_PFX[n]); return s; });
  const isExp = n => filter.trim() ? true : expanded.has(GRP_PFX[n]);
  const wake = () => getCtx();

  const buildURL = useCallback(() => {
    const p = new URLSearchParams();
    if (rootIdx)     p.set("r",  rootIdx);
    if (timbre !== "sine") p.set("t", timbre);
    if (instrument)  p.set("i",  instrument);
    if (noteVol !== 0.7)   p.set("v",  noteVol.toFixed(2));
    if (reverbAmt !== 0.75) p.set("rv", reverbAmt.toFixed(2));
    if (delayAmt  !== 0.15) p.set("dl", delayAmt.toFixed(2));
    if (bpm !== 100) p.set("b",  bpm);
    if (filter)      p.set("f",  filter);
    if (sel)         p.set("s",  sel.id);
    if (aRef !== 440) p.set("a", aRef);
    if (droneOct)    p.set("do", droneOct);
    if (melMode)     p.set("m",  "1");
    if (sidebarW !== 280) p.set("sw", sidebarW);
    const qs = p.toString();
    return window.location.origin + window.location.pathname + (qs ? "?" + qs : "");
  }, [rootIdx, timbre, instrument, noteVol, reverbAmt, delayAmt, bpm, filter, sel, aRef, droneOct, melMode, sidebarW]);

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
        <div style={{ display: "flex", alignItems: "center", gap: 16, flex: 1 }}>

          {/* VOL */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
            <span title="Note volume. Drone volume is independent." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>VOL</span>
            <input type="range" min={0} max={1} step={0.01} value={noteVol}
              onChange={e => setNoteVol(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(noteVol * 100)}</span>
          </div>

          {/* REV */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
            <span title="Reverb wet level. Convolution reverb shared by drone and all notes." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>REV</span>
            <input type="range" min={0} max={1} step={0.01} value={reverbAmt}
              onChange={e => setReverbAmt(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(reverbAmt * 100)}</span>
          </div>

          {/* DEL */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
            <span title="Delay wet level. BPM-synced dotted-eighth delay with feedback." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>DEL</span>
            <input type="range" min={0} max={1} step={0.01} value={delayAmt}
              onChange={e => setDelayAmt(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(delayAmt * 100)}</span>
          </div>

          <div style={{ width: 1, height: 22, background: K.t2, opacity: 0.3, flexShrink: 0 }} />

          {/* TUNE */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
            <span title="Concert pitch reference. 440 Hz standard, 432 Hz alternative." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>A =</span>
            <input type="range" min={432} max={440} step={1} value={aRef}
              onChange={e => setARef(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 42 }}>{aRef} Hz</span>
          </div>

          {/* BPM */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1 }}>
            <span title="Tempo for arpeggio and melody modes (40-240 BPM)." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, cursor: "help", flexShrink: 0 }}>BPM</span>
            <input type="range" min={40} max={240} value={bpm}
              onChange={e => setBpm(+e.target.value)}
              style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
            />
            <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 28 }}>{bpm}</span>
          </div>

        </div>

      </div>

      {(demoOn || autoOn) && (
        <div style={{ background: K.demoB, borderBottom: `1px solid ${K.demoBr}`, flexShrink: 0 }}>
          <div style={{ padding: "6px 18px", display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: K.a, fontSize: 9, letterSpacing: 2, flexShrink: 0 }}>{autoOn ? "⟲ AUTO" : "★ DEMO"}</span>
            <span style={{ fontSize: 10, flex: 1 }}>
              <span style={{ color: K.demoT, fontStyle: "italic" }}>{demoComment || "Starting…"}</span>
              {demoRequest && <span style={{ color: K.a, fontStyle: "italic" }}> · ✦ {demoRequest}</span>}
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
            <button onClick={() => setShowDemoLog(p => !p)} style={{
              background: "none", border: `1px solid ${K.demoBr}`, color: K.demoT2,
              fontSize: 9, padding: "2px 7px", cursor: "pointer", borderRadius: 3, flexShrink: 0,
            }}>{showDemoLog ? "▴ log" : `▾ log${demoLog.length ? ` (${demoLog.length})` : ""}`}</button>
          </div>
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

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* ══════════════════════════════════════
            SCALE LIST (LEFT)
        ══════════════════════════════════════ */}
        <div style={{ width: 340, flexShrink: 0, overflowY: "auto", overflowX: "hidden", borderRight: `1px solid ${K.br}` }}>
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
                        <div key={mode} onClick={() => pick(fam, origIdx, mode)} style={{
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
                            color: isFav ? K.a : K.t2,
                            transition: "color .15s",
                          }}>{isFav ? "★" : "☆"}</button>
                          <span style={{ color: isSel ? K.a : K.txt, fontSize: 10, letterSpacing: 1.5, fontWeight: isSel ? 500 : 300, minWidth: 130, fontFamily: "inherit" }}>
                            {toBin(mode)}
                          </span>
                          <span style={{ color: K.t2, fontSize: 9, minWidth: 40 }}>({mode})</span>
                          {name && (
                            <span style={{ color: isSel ? K.a : K.t1, fontSize: 10 }}>{name}</span>
                          )}
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
              No results for "{filter}"
            </div>
          )}
        </div>

        {/* ══════════════════════════════════════
            VISUALIZER (CENTRE)
        ══════════════════════════════════════ */}
        <div style={{ flex: 1, overflow: "hidden", background: K.bg, borderRight: `1px solid ${K.br}` }}>
          <Visualizer analyserRef={analyserRef} playing={playing} rootIdx={rootIdx} K={K} />
        </div>

        {/* ══════════════════════════════════════
            RIGHT PANEL
        ══════════════════════════════════════ */}
        <div style={{ width: sidebarW, display: "flex", flexDirection: "column", background: K.bg2, flexShrink: 0, position: "relative" }}>
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
            <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
              {[
                { label: "● Drone", on: droneOn, onClick: () => { wake(); setDroneOn(p => !p); } },
                { label: arpOn && !demoOn && !autoOn ? "■ Stop" : "▶ Play", on: arpOn && !demoOn && !autoOn, disabled: !sel, onClick: () => { wake(); setArpOn(p => !p); } },
                { label: autoOn ? "⟲ Stop" : "⟲ Auto", on: autoOn, onClick: () => {
                  wake();
                  if (autoOn) { setAutoOn(false); setArpOn(false); setDemoComment(""); setDemoRequest(""); }
                  else { setDemoOn(false); setAutoOn(true); }
                }},
                { label: demoOn ? "★ Stop" : "★ Claude", on: demoOn, onClick: () => {
                  if (!demoKey) { setDemoKeyInput(true); return; }
                  if (demoOn) { setDemoOn(false); setArpOn(false); setDemoComment(""); setDemoRequest(""); }
                  else { wake(); setAutoOn(false); setDemoOn(true); }
                }},
                { label: beatOn ? "♩ Stop" : "♩ Beat", on: beatOn, onClick: () => { wake(); setBeatOn(p => !p); }},
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
            {/* Beat vol */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, marginBottom: 2 }}>
              <span title="Beat volume." style={{ color: K.t2, fontSize: 8, letterSpacing: 2, flexShrink: 0, cursor: "help" }}>BEAT VOL</span>
              <input type="range" min={0} max={1} step={0.01} value={beatVol}
                onChange={e => setBeatVol(+e.target.value)}
                style={{ flex: 1, minWidth: 40, accentColor: K.a, background: K.br, cursor: "pointer" }}
              />
              <span style={{ color: K.a, fontSize: 9, fontWeight: 600, minWidth: 22 }}>{Math.round(beatVol * 100)}</span>
            </div>
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
              <div title="Chord voicing: off, power (root+5th), sus2, triad, 7th, all (whole scale). Notes strum with a slight delay." style={{ color: K.lbl, fontSize: 8, letterSpacing: 2, marginBottom: 5, cursor: "help" }}>CHORD</div>
              <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                {[
                  { l: "off",   v: "off" },
                  { l: "power", v: "power" },
                  { l: "sus2",  v: "sus2" },
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
                {selName && (
                  <div style={{ fontFamily: "'Trebuchet MS', 'Gill Sans', 'Century Gothic', sans-serif", fontSize: 15, fontWeight: 700, color: K.a, marginBottom: 3, letterSpacing: 0.5 }}>
                    {selName}
                  </div>
                )}
                <div style={{ color: K.t1, fontSize: 11, marginBottom: 14, opacity: 0.75, letterSpacing: 0.5 }}>
                  {ROOTS[rootIdx]} · {selNotes.join("  ")}
                </div>

                <Lbl K={K}>INTERVALS</Lbl>
                <div style={{ color: K.a, fontSize: 14, letterSpacing: 3, fontWeight: 500, marginBottom: 14 }}>
                  {selIvs.join(" - ")}
                </div>

                <Lbl K={K}>BINARY PATTERN</Lbl>
                <div style={{ color: K.t2, fontSize: 10, letterSpacing: 2, marginBottom: 2 }}>{toBin(sel.pattern)}</div>
                <div style={{ color: K.t2, fontSize: 9, opacity: 0.6, marginBottom: 14 }}>decimal {sel.pattern}</div>

                <Lbl K={K}>SCALE SHAPE</Lbl>
                <ScaleWheel active={selSemis} rootOffset={rootIdx} playing={playing} size={Math.min(sidebarW - 30, 320)} K={K} />

                <Lbl style={{ marginTop: 14 }} K={K}>KEYBOARD</Lbl>
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
              <div style={{ color: K.t2, fontSize: 11, lineHeight: 1.9 }}>
                <div style={{ color: K.t1, marginBottom: 12, fontSize: 12 }}>Select a scale.</div>
                <div style={{ marginBottom: 8 }}>Modes are sorted bright -> dark — same direction as Lydian -> Locrian for heptatonic.</div>
                <div style={{ marginBottom: 8 }}>The binary string shows which of the 12 chromatic tones are active, starting from the root.</div>
                <div>Drone a single key to hear the modal color of a scale.</div>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
