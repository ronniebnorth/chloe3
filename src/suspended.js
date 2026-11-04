// Suspended harmony: a 2nd or 4th standing in for the 3rd, under a perfect 5th.
// With no 3rd the music is neither major nor minor; the ear waits for one.

const HAS = (p, semis) => (p >> (((semis % 12) + 12) % 12)) & 1;

// A suspended scale: no 3rd above the root (minor or major), a perfect 5th,
// and a 2nd or a 4th. Egyptian (0 2 5 7 10) is the classic one.
export const isSuspended = p => !HAS(p, 3) && !HAS(p, 4) && !!HAS(p, 7) && !!(HAS(p, 2) || HAS(p, 5));

// What the search box takes to mean "suspended scales": sus, susp, suspen...
export const isSusQuery = q => q.length >= 3 && "suspended".startsWith(q);

export const SUS_INTERVAL = { sus2: 2, sus4: 5 };

// A sus chord built by interval on notes[idx], using only notes the scale has:
// when the 2nd/4th or the 5th isn't there it's left out, never replaced by
// whatever note happens to sit in that position. notes can span octaves.
export const susChord = (notes, idx, voice) => {
  const pcs = notes.reduce((m, n) => m | (1 << (((n % 12) + 12) % 12)), 0);
  const base = notes[idx % notes.length];
  return [base, ...[SUS_INTERVAL[voice], 7].filter(iv => HAS(pcs, base + iv)).map(iv => base + iv)];
};

// How many notes of a scale can carry the whole sus chord: { full, n }
export const susCoverage = (p, voice) => {
  let full = 0, n = 0;
  for (let i = 0; i < 12; i++) {
    if (!HAS(p, i)) continue;
    n++;
    if (HAS(p, i + SUS_INTERVAL[voice]) && HAS(p, i + 7)) full++;
  }
  return { full, n };
};

const bitsDiff = (a, b) => { let n = 0, x = a ^ b; while (x) { n += x & 1; x >>= 1; } return n; };

// The next stop on a tour of the suspended scales: only scales not yet heard
// this lap, leaning toward the fewest changed notes so it travels rather than
// jumps. weigh(entry) can add a cost (a journey's brightness target, say).
// seen is a Set of patterns; when everything's been heard it clears for a new
// lap. Returns { entry, lapped }; entry is null with nothing to choose from.
export const nextSusStop = (sus, seen, curPat, weigh = () => 0, rnd = Math.random) => {
  let left = sus.filter(e => !seen.has(e.pat) && e.pat !== curPat);
  const lapped = !left.length;
  if (lapped) { seen.clear(); left = sus.filter(e => e.pat !== curPat); }
  if (!left.length) return { entry: null, lapped: false };
  let best = null, bestCost = Infinity;
  for (const e of left) {
    const cost = (curPat == null ? 0 : bitsDiff(e.pat, curPat)) + weigh(e) + rnd() * 1.5;
    if (cost < bestCost) { bestCost = cost; best = e; }
  }
  seen.add(best.pat);
  return { entry: best, lapped };
};
