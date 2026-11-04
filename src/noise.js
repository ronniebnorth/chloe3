// White, pink and brown noise for the drone. White is equal energy per Hz, hissy;
// pink falls 3 dB an octave, like steady rain; brown falls 6 dB an octave, a soft low rumble.
export const NOISE_TYPES = ["white", "pink", "brown"];
const TARGET_RMS = 0.25;

const whiteGen = () => () => Math.random() * 2 - 1;
// Paul Kellet's filter: white noise shaped to about -3 dB an octave
const pinkGen = () => {
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  return () => {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    const out = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    return out;
  };
};
// A leaky integrator: -6 dB an octave, without drifting off to one side
const brownGen = () => { let last = 0; return () => (last = 0.995 * last + 0.1 * (Math.random() * 2 - 1)); };
const GEN = { white: whiteGen, pink: pinkGen, brown: brownGen };

// n samples that loop without a seam (the end is crossfaded into the start), at a set level
export const noiseData = (type, n, fadeN) => {
  const gen = GEN[type](), raw = new Float32Array(n + fadeN);
  for (let i = 0; i < 2000; i++) gen();   // let the filters settle
  for (let i = 0; i < raw.length; i++) raw[i] = gen();
  const out = raw.slice(0, n);
  for (let i = 0; i < fadeN; i++) { const x = i / fadeN; out[i] = raw[i] * Math.sqrt(x) + raw[n + i] * Math.sqrt(1 - x); }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += out[i] * out[i];
  const k = TARGET_RMS / Math.sqrt(sum / n);
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
};

// Buffers can be shared between audio contexts, so the 2-minute swap doesn't rebuild them
const cache = new Map();
const LOOP_S = 8, FADE_S = 0.25;
export const noiseBuffer = (ac, type) => {
  const key = `${type}@${ac.sampleRate}`;
  if (!cache.has(key)) {
    const n = Math.round(LOOP_S * ac.sampleRate), buf = ac.createBuffer(2, n, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) buf.copyToChannel(noiseData(type, n, Math.round(FADE_S * ac.sampleRate)), ch);   // separate channels: wide, not a point in the middle
    cache.set(key, buf);
  }
  return cache.get(key);
};
