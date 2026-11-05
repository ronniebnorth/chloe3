// Wake: a journey built to keep you awake. Everywhere else Chloe hides its seams, and
// that smoothness is what makes it hypnotic. This one climbs fast, never dips, and keeps
// breaking its own pattern at uneven times, more often as it goes, so you can't settle.
export const WAKE_PTS = [
  { at: 0, b: 0.5, t: 0.85, rv: 0.6, su: 1, e: 0.1, tn: 0.1 },
  { at: 0.25, b: 0.66, t: 1.1, rv: 0.42, su: 0.8, e: 0.5, tn: 0.2 },
  { at: 1, b: 0.75, t: 1.35, rv: 0.35, su: 0.7, e: 0.9, tn: 0.25 },
];

// stop: everything cuts out for a moment    drums: the drums drop out and slam back
// tempo: a lurch, until the next scale pick  key: a jump to a new root
// rhythm: flips between line and arpeggio    beat: a different drum style
export const WAKE_EVENTS = ["stop", "drums", "tempo", "key", "rhythm", "beat"];
export const WAKE_KEY_MOVES = [2, 3, 5, 7, 9, 10];
export const WAKE_TEMPO_LURCH = [1.3, 1.2, 0.75];
export const WAKE_BEATS = ["drive", "break", "samba", "jungle", "heavy"];

// Time to the next surprise: 40-70 s at the start, 15-35 s by the end
export const wakeGapMs = (f, r = Math.random()) => {
  const x = Math.min(1, Math.max(0, f));
  const lo = 40 + (15 - 40) * x, hi = 70 + (35 - 70) * x;
  return Math.round((lo + (hi - lo) * r) * 1000);
};

// Any surprise but the last one. `allowed` drops those your ⚙ settings have locked
export const pickWakeEvent = (prev, allowed = WAKE_EVENTS, r = Math.random()) => {
  const opts = allowed.filter(e => e !== prev);
  return opts.length ? opts[Math.floor(r * opts.length) % opts.length] : prev ?? null;
};

// A different choice from a list, for the things that have to audibly change
export const another = (list, cur, r = Math.random()) => {
  const opts = list.filter(x => x !== cur);
  return opts[Math.floor(r * opts.length) % opts.length];
};
