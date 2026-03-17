# EEG Signal Fix — Delta Dominance Problem

## The Problem

Delta is always the dominant band in raw EEG from forehead-mounted consumer electrodes like the FlowTime. In a typical session, delta sits at 60-80% of total power regardless of whether the user is focused, relaxed, meditating, or drowsy. Reporting `dominant_band: "delta"` for 90% of all polls tells the system nothing.

The current consequences:

1. **Alpha-neutral pull never activates.** `targetBrightness()` only blends toward 0.5 when `dominant_band === 'alpha'`. Since dominant_band is almost always `'delta'`, the alpha moderation rarely kicks in. During eyes-closed meditation — exactly when alpha should be driving the system — delta still wins raw power and the system drifts dark.

2. **Claude fixates on delta.** The brainState sent to Claude includes delta at 80%. Claude narrates "profound rest," "delta sleep mode," "near-sleep" every single cycle, even when the user is awake and meditating. Every commentary sounds the same because the dominant signal never changes.

3. **Brightness target is too dark.** With relaxation_index moderately high and no alpha pull to counterbalance, the system consistently selects dark scales — sparse tritonics, low BPM, everything oriented toward "sleep" when the actual state is calm wakefulness.

## Root Cause

Delta power reflects volume of low-frequency neural oscillation, which is always large at Fp1/Fp2 forehead sites. It is not a useful state indicator in this context. The meaningful signals are the **ratios between alpha, theta, beta, and gamma** — these shift meaningfully between cognitive/emotional states. Delta does not.

## Changes

### 1. New derived field: `dominant_active_band`

In `eeg_proxy.py`, add a derived field that reports the dominant band **excluding delta**:

```python
# In the derived metrics computation
active_bands = {k: v for k, v in bands.items() if k != 'delta'}
derived['dominant_active_band'] = max(active_bands, key=active_bands.get)
```

Keep `dominant_band` as-is for display/logging purposes. But `dominant_active_band` is what the brightness system and Claude should use for decision-making.

### 2. Rework `targetBrightness()` in `src/brightness.js`

Replace the current relaxation_index + dominant_band approach with ratio-based targeting.

The key ratios:

| Ratio | What it indicates | Brightness direction |
|-------|-------------------|---------------------|
| alpha / beta | High = relaxed, low = engaged/anxious | High → toward neutral (0.5) |
| theta / alpha | High = deepening/drowsy, low = alert | High → darker |
| beta / alpha | High = active/focused, low = relaxed | High → brighter |
| gamma (raw %) | Elevated = high cognitive load | High → brighter |

Proposed implementation:

```javascript
function targetBrightness(eegState, config) {
  const bands = eegState.bands;
  const dominantActive = eegState.derived.dominant_active_band;

  // Compute ratios (guard against division by zero)
  const alphaTotal = bands.alpha || 0.01;
  const thetaAlphaRatio = (bands.theta || 0) / alphaTotal;
  const betaAlphaRatio = (bands.beta || 0) / alphaTotal;

  // Start at neutral
  let target = 0.5;

  // Theta pushes darker (deeper meditation / drowsiness)
  // thetaAlphaRatio > 1 means theta exceeds alpha
  target -= Math.min(thetaAlphaRatio - 0.5, 0.4) * config.thetaDarkWeight;

  // Beta pushes brighter (engagement / focus / energy)
  // betaAlphaRatio > 1 means beta exceeds alpha
  target += Math.min(betaAlphaRatio - 0.5, 0.4) * config.betaBrightWeight;

  // Alpha-dominant pull toward neutral
  if (dominantActive === 'alpha') {
    target = target * (1 - config.alphaNeutralWeight) + 0.5 * config.alphaNeutralWeight;
  }

  // Clamp to 0-1
  return Math.max(0.0, Math.min(1.0, target));
}
```

**This is a starting-point formula, not a final answer.** The weights and offsets need to be tunable and will require adjustment by ear during real sessions. The important structural change is: delta is gone from the calculation, ratios replace percentages, and the system starts at neutral rather than deriving everything from relaxation_index.

### 3. Update `BRIGHTNESS_CONFIG`

Replace the single `alphaNeutralWeight` with the ratio-based weights:

```javascript
export const BRIGHTNESS_CONFIG = {
  neutralPattern:       1709,
  smoothingWindow:      3,
  transitionThreshold:  0.05,
  alphaNeutralWeight:   0.5,    // how strongly alpha-dominant pulls toward 0.5
  thetaDarkWeight:      0.3,    // how strongly theta/alpha ratio pushes darker
  betaBrightWeight:     0.3,    // how strongly beta/alpha ratio pushes brighter
  noteCountPreference:  true,
  commonTonePreference: true,
};
```

All three weights should be adjustable without code changes.

### 4. Update `currentState` sent to Claude

Currently includes raw band percentages. Change to emphasize the useful signals:

```javascript
// In the currentState object passed to Claude
brainState: {
  dominantActiveBand: eegState.derived.dominant_active_band,  // NOT dominant_band
  alpha: bands.alpha,
  theta: bands.theta,
  beta: bands.beta,
  gamma: bands.gamma,
  // Omit delta from what Claude sees, or include it with a note
  thetaAlphaRatio: (bands.theta / (bands.alpha || 0.01)).toFixed(2),
  betaAlphaRatio: (bands.beta / (bands.alpha || 0.01)).toFixed(2),
  relaxationIndex: eegState.derived.relaxation_index,
}
```

Omitting delta entirely from Claude's view is the simplest way to prevent it from narrating "profound delta sleep" every cycle. If you want to keep it for completeness, include it but deprioritize it in the prompt.

### 5. Update the Claude system prompt

The current prompt lets Claude see delta percentage and draw conclusions from it. Replace the brain state guidance section with something like:

```
Brain state interpretation guidelines:
- Ignore delta percentage. Delta is always the highest-amplitude band from 
  forehead EEG. It does not indicate sleep or drowsiness on its own.
- Focus on dominant_active_band (the strongest band excluding delta):
  - Alpha dominant: calm, relaxed, meditative. Stay near neutral brightness.
  - Theta dominant: deepening meditation, drowsy, inward. Lean darker.
  - Beta dominant: engaged, focused, active. Lean brighter.
  - Gamma dominant: high cognitive processing. Lean brighter.
- Use theta/alpha ratio to judge depth: ratio > 1.5 suggests deep meditation 
  or drowsiness. Ratio < 0.5 suggests alert wakefulness.
- Use beta/alpha ratio to judge activation: ratio > 1.5 suggests active 
  focus or anxiety. Ratio < 0.5 suggests relaxation.
- The scale has already been selected based on these ratios. Your job is 
  to articulate the scale musically, not to re-diagnose the brain state.
- Avoid repetitive commentary about "deep rest" or "profound relaxation" 
  unless the theta/alpha ratio actually supports it (> 1.5).
```

### 6. Update the EEG indicator dot in the UI

The coloured dot currently reflects `dominant_band`, which is almost always delta. Change it to reflect `dominant_active_band` so the user gets useful visual feedback. The dot should show cyan for alpha, purple for theta, amber for beta, etc. — not delta-grey for every session.

## What NOT to Change

- `eeg_proxy.py` band power calculations — delta is still computed and available, just not used for decision-making
- `relaxation_index` formula — it already excludes delta, it's fine
- `brightnessScore()` and `normalizedBrightness()` — the scale-side math is correct
- `findClosestScale()` — the selection logic is correct
- The smoothing and transition threshold logic — unchanged
- The Brain Machine integration — it has its own guided mode that may use delta differently

## Testing

1. **Log the dominant_active_band** for a full session and confirm it actually varies (alpha during calm meditation, beta during eyes-open focus, theta during deep relaxation). If it doesn't vary, the FlowTime band calculations may need investigation.

2. **Compare old vs new target brightness** over the same session data. The old system should show targets consistently in the 0.1-0.3 range (dark). The new system should show targets near 0.5 during alpha-dominant meditation, drifting darker only when theta genuinely rises.

3. **Read Claude's commentary.** It should no longer say "profound delta sleep" every cycle. During calm meditation it should describe the state as balanced or meditative. It should only narrate darkness/depth when theta is actually dominant.

4. **Listen.** The scale selections during a normal meditation should now spend more time in the mid-brightness range (Dorian-like territory) rather than always drifting to sparse tritonics and very low BPM.
