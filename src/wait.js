// The Wait: a journey built on waiting for the drop.
//   pulse   : drums and a walk through suspended scales, long enough to become your clock
//   wait    : the drums fall away, one suspended scale holds, sus4 chords, everything
//             slowly widens and slows. No 3rd anywhere, so the ear keeps waiting
//   release : a little later than expected (drop varies per run), the 3rd arrives,
//             one note, major or minor; the music finally has a mood and the pulse returns
import { nextSusStop } from "./suspended.js";

export const WAIT_PULSE_END = 0.35;
export const WAIT_DROP_MIN = 0.80, WAIT_DROP_MAX = 0.88;
export const WAIT_HOLDS = [1189, 677];   // Egyptian, Ritusen: one note apart, and one note from having a 3rd

export const waitPhase = (f, drop) => f < WAIT_PULSE_END ? "pulse" : f < drop ? "wait" : "release";

const lerp = (a, b, x) => a + (b - a) * x;
const ease = x => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, x)))) / 2;

// The journey's targets at fraction f. dr = drums on or resting
export const waitVals = (f, drop = (WAIT_DROP_MIN + WAIT_DROP_MAX) / 2) => {
  const ph = waitPhase(f, drop);
  if (ph === "pulse") return { ph, b: 0.45, t: 1, rv: 0.6, su: 1, dl: 0.2, e: 0, dr: true };
  if (ph === "wait") {
    const x = ease((f - WAIT_PULSE_END) / (drop - WAIT_PULSE_END));
    return { ph, b: lerp(0.45, 0.58, x), t: lerp(1, 0.82, x), rv: lerp(0.6, 0.95, x), su: lerp(1, 1.9, x), dl: lerp(0.2, 0.45, x), e: 0, dr: false };
  }
  // The release clears quickly, over the first quarter of what's left
  const x = ease((f - drop) / ((1 - drop) * 0.25));
  return { ph, b: lerp(0.58, 0.7, x), t: lerp(0.82, 0.95, x), rv: lerp(0.95, 0.62, x), su: lerp(1.9, 1.1, x), dl: lerp(0.45, 0.25, x), e: 0, dr: true };
};

export const WAIT_VOICE = { pulse: "off", wait: "sus4", release: "triad" };

export const addThird = (p, third) => p | (1 << third);

const diff = (a, b) => { let n = 0, x = a ^ b; while (x) { n += x & 1; x >>= 1; } return n; };
const nearestHold = cur => cur == null ? WAIT_HOLDS[0] : diff(WAIT_HOLDS[0], cur) <= diff(WAIT_HOLDS[1], cur) ? WAIT_HOLDS[0] : WAIT_HOLDS[1];

// The scale for this pick. run keeps { hold, third, release, seen } between picks.
// pool = suspended scales for the pulse, as { pat, ... }
export const waitPattern = (run, ph, cur, pool, rnd = Math.random) => {
  if (ph === "pulse") {
    run.seen ??= new Set();
    return nextSusStop(pool, run.seen, cur, undefined, rnd).entry?.pat ?? WAIT_HOLDS[0];
  }
  run.hold ??= nearestHold(cur);
  if (ph === "release") return run.release ??= addThird(run.hold, run.third);
  if (rnd() < 0.15) run.hold = run.hold === WAIT_HOLDS[0] ? WAIT_HOLDS[1] : WAIT_HOLDS[0];
  return run.hold;
};
