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
