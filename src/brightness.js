export const BRIGHTNESS_CONFIG = {
  neutralPattern:       1709,   // Dorian — reference; neutral target in normalized space is 0.5
  smoothingWindow:      3,      // polls to average
  transitionThreshold:  0.05,   // min normalized shift to trigger change (5% of 0–1 range)
  alphaNeutralWeight:   0.6,    // alpha pulls toward neutral (0.5)
  noteCountPreference:  true,   // prefer same cardinality as tiebreaker
  commonTonePreference: true,   // prefer scales sharing pitches with current
};

// Raw brightness: sum of active semitone positions. Correct for within-group sorting and display.
export function brightnessScore(pattern) {
  let s = 0;
  for (let i = 0; i < 12; i++) if ((pattern >> i) & 1) s += i;
  return s;
}

// Precomputed min/max raw brightness per cardinality N (theoretical bounds, root always at 0).
// min: scale using positions 0,1,2,...,N-1  (chromatic cluster)
// max: scale using position 0 + top N-1 positions (12-N+1 ... 11)
// Verified against the full catalogue — no scale falls outside these bounds.
const cardinalityBounds = {};
for (let N = 1; N <= 12; N++) {
  cardinalityBounds[N] = {
    min: (N - 1) * N / 2,
    max: ((12 - N + 1) + 11) * (N - 1) / 2,
  };
}

// Normalized brightness: 0.0 (darkest possible for this note count) → 1.0 (brightest possible).
// Dorian (N=7) normalizes to exactly 0.5, making it the natural cross-cardinality neutral point.
export function normalizedBrightness(pattern) {
  const bits = [];
  for (let i = 0; i < 12; i++) if ((pattern >> i) & 1) bits.push(i);
  const N = bits.length;
  if (N <= 1) return 0.5;
  const raw = bits.reduce((sum, b) => sum + b, 0);
  const { min, max } = cardinalityBounds[N];
  if (max === min) return 0.5;
  return (raw - min) / (max - min);
}

// Returns a normalized target brightness (0.0–1.0) from EEG state.
// 0.0 = darkest possible, 1.0 = brightest possible, 0.5 = Dorian-neutral.
export function targetBrightness(eegState, config) {
  const { relaxation_index, dominant_band } = eegState.derived;
  let target = 1.0 - relaxation_index; // high relaxation → dark (low target)
  if (dominant_band === 'alpha') {
    target = target * (1 - config.alphaNeutralWeight) + 0.5 * config.alphaNeutralWeight;
  }
  return target;
}

// Find the scale in catalogue whose normalized brightness is closest to the normalized target.
// catalogue entries: { familyId, modeIdx, name, notes, pattern }
export function findClosestScale(normalizedTarget, catalogue, currentPattern, config) {
  const currentNotes = currentPattern
    ? [...Array(12)].filter((_, i) => (currentPattern >> i) & 1).length
    : null;

  let best = null;
  let bestScore = Infinity;

  for (const entry of catalogue) {
    const nb = normalizedBrightness(entry.pattern);
    let dist = Math.abs(nb - normalizedTarget);
    // Prefer same note count (tiebreaker — allows cross-cardinality when brightness match is strong)
    if (config.noteCountPreference && currentNotes && entry.notes !== currentNotes) dist += 0.08;
    // Prefer common tones with current scale
    if (config.commonTonePreference && currentPattern) {
      const shared = [...Array(12)].filter((_, i) =>
        ((entry.pattern >> i) & 1) && ((currentPattern >> i) & 1)
      ).length;
      dist -= shared * 0.01;
    }
    if (dist < bestScore) { bestScore = dist; best = entry; }
  }
  return best;
}
