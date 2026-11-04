// A journey you draw: one line, up = bright, across the whole length. Everything else
// follows its height the way Dawn and Dusk tie them together: high is brighter, a bit
// faster, drier, with shorter notes; low is darker, slower, wetter, with longer ones.
export const DRAW_POINTS = 60;

// Until you draw: a gentle hill, so the card always has something to play
export const defaultLine = () => Array.from({ length: DRAW_POINTS }, (_, i) => 0.3 + 0.4 * Math.sin(Math.PI * i / (DRAW_POINTS - 1)));

const clamp01 = x => Math.min(1, Math.max(0, x));
const lerp = (a, b, x) => a + (b - a) * x;

export const drawnVals = (line, f) => {
  const p = clamp01(f) * (line.length - 1), i = Math.min(line.length - 2, Math.floor(p)), h = lerp(line[i], line[i + 1], p - i);
  return { b: lerp(0.25, 0.75, h), t: lerp(0.75, 1.15, h), rv: lerp(0.9, 0.42, h), su: lerp(1.6, 0.85, h), e: 0 };
};

// Paint between two points of a stroke, so a fast drag leaves no gaps
export const paintLine = (line, f0, h0, f1, h1) => {
  const out = [...line], n = out.length - 1;
  const a = Math.round(clamp01(f0) * n), b = Math.round(clamp01(f1) * n), steps = Math.abs(b - a);
  for (let s = 0; s <= steps; s++) {
    const i = a + Math.sign(b - a) * s;
    out[i] = clamp01(steps ? lerp(h0, h1, s / steps) : h1);
  }
  return out;
};

// Takes the shake out of a hand-drawn line and leaves real cliffs steep
export const smoothLine = (line) => line.map((v, i) => {
  const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
  return Math.abs(b - a) > 0.35 ? v : (a + 2 * v + b) / 4;
});

// In a link: one base-36 character a point
export const encodeLine = (line) => line.map(v => Math.round(clamp01(v) * 35).toString(36)).join("");
export const decodeLine = (s) => {
  if (!s || s.length !== DRAW_POINTS || !/^[0-9a-z]+$/.test(s)) return null;
  return [...s].map(c => parseInt(c, 36) / 35);
};
