export const BRIGHTNESS_CONFIG = {
  neutralPattern:       1709,   // Dorian
  smoothingWindow:      3,      // polls to average
  transitionThreshold:  3,      // min brightness shift to trigger change
  alphaNeutralWeight:   0.6,    // alpha pulls toward neutral
  noteCountPreference:  true,   // prefer same cardinality
  commonTonePreference: true,   // prefer scales sharing pitches with current
  allowUnnamedScales:   false,
};

export function brightnessScore(pattern) {
  let s = 0;
  for (let i = 0; i < 12; i++) if ((pattern >> i) & 1) s += i;
  return s;
}

export function targetBrightness(eegState, config, B_min, B_max, B_neutral) {
  const { relaxation_index, dominant_band } = eegState.derived;
  let t = 1.0 - relaxation_index; // high relaxation → dark (low t)
  let target = B_min + t * (B_max - B_min);
  if (dominant_band === 'alpha') {
    target = target * (1 - config.alphaNeutralWeight) + B_neutral * config.alphaNeutralWeight;
  }
  return Math.round(target);
}

export function findClosestScale(target, catalogue, currentPattern, config) {
  // catalogue entries: { familyId, modeIdx, name, notes, pattern }
  const currentNotes = currentPattern
    ? [...Array(12)].filter((_, i) => (currentPattern >> i) & 1).length
    : null;

  let best = null;
  let bestScore = Infinity;

  for (const entry of catalogue) {
    const bs = brightnessScore(entry.pattern);
    let dist = Math.abs(bs - target);
    // Prefer same note count
    if (config.noteCountPreference && currentNotes && entry.notes !== currentNotes) dist += 2;
    // Prefer common tones with current scale
    if (config.commonTonePreference && currentPattern) {
      const shared = [...Array(12)].filter((_, i) =>
        ((entry.pattern >> i) & 1) && ((currentPattern >> i) & 1)
      ).length;
      dist -= shared * 0.3;
    }
    if (dist < bestScore) { bestScore = dist; best = entry; }
  }
  return best;
}
