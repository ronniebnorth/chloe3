# Chloe EEG Brightness-Based Scale Selection

## Overview

When Claude mode is running with a live EEG headband connected, Chloe now uses an algorithmic **brightness-matching** system to select scales automatically before each Claude call. Claude's role shifts from *picking* scales to *articulating* them — choosing BPM, rhythm, voicing, and effects that complement the pre-selected scale's emotional character.

---

## How Scale Brightness Works

Every scale in the app is stored as a **12-bit integer** where each bit represents a semitone (bit 0 = root, bit 1 = minor 2nd, etc.). The brightness score sums the active bit positions:

```
brightnessScore(pattern) = sum of active semitone positions
```

Higher scores = brighter/more raised intervals (Lydian-like). Lower scores = darker (Locrian-like).

**Diatonic mode reference:**

| Mode        | Pattern | Brightness |
|-------------|---------|------------|
| Lydian      | 2773    | 39         |
| Ionian      | 2741    | 38         |
| Mixolydian  | 1717    | 37         |
| **Dorian**  | **1709**| **36** ← neutral |
| Aeolian     | 1453    | 35         |
| Phrygian    | 1451    | 34         |
| Locrian     | 1387    | 33         |

Dorian (brightness 36) is used as the **neutral point** — the midpoint the system gravitates toward during relaxed/alpha-dominant states.

---

## EEG → Target Brightness

Each Claude call cycle:

1. **Raw target** is computed from `relaxation_index` (0–1 from the EEG proxy):
   ```
   t = 1.0 - relaxation_index       // high relaxation → low t → dark
   target = B_min + t × (B_max - B_min)
   ```
   Where `B_min` and `B_max` are the actual min/max brightness across all loaded scales.

2. **Alpha pull**: If `dominant_band === 'alpha'`, the target is blended 60% toward Dorian (neutral). This prevents alpha states (meditative, eyes-closed) from drifting too dark.
   ```
   target = target × 0.4 + B_neutral × 0.6
   ```

3. **Smoothing**: The last 3 raw targets are averaged to prevent rapid flipping on noisy EEG signals.

4. **Transition threshold**: A scale change is only triggered if the smoothed target differs from the current scale's brightness by ≥ 3 points.

---

## Scale Selection (`findClosestScale`)

Given a smoothed target brightness, the system searches the full scale catalogue and scores each candidate:

```
dist = |brightnessScore(candidate) - target|
     + 2  (if different note count from current scale)
     - 0.3 × shared_pitch_count
```

- **Note count preference**: Pentatonics stay pentatonic, heptatonics stay heptatonic — prevents jarring jumps in density.
- **Common tone preference**: Scales that share more pitches with the current scale are preferred, making transitions smoother.

The lowest-scoring entry wins and is immediately applied via `pick()` before the Claude API call is made.

---

## Claude's New Role

Before the update, Claude received raw EEG percentages and a set of hand-authored rules ("high alpha → pentatonic, slow BPM"). Now:

- The scale has **already been selected** algorithmically before Claude sees it.
- `currentState` includes `brightnessSelected` (the scale name) and `targetBrightnessScore`.
- Claude's job is to choose **BPM, rhythm, chord voicing, drone, reverb, and delay** to musically articulate that scale's character.
- Claude explains *why* the selected scale fits the brain state in its commentary.
- Claude **may override** the scale selection if it has a strong musical reason, but must explain the override.

---

## Data Flow (per cycle)

```
EEG proxy (localhost:8520)
  → eegData state (polled every 2s)
  → brainState snapshot (relaxation_index, dominant_band, band %s)
  → targetBrightness()   ← relaxation_index + dominant_band
  → smoothing (brightnessHistoryRef, window=3)
  → findClosestScale()   ← searches catalogue with pattern field
  → pick()               ← applies scale immediately
  → currentState         ← includes currentBrightness, brightnessSelected, targetBrightnessScore
  → Claude API call      ← receives pre-selected scale, chooses musical parameters
  → Claude response      ← JSON with BPM, rhythm, voicing, drone, commentary
```

---

## Configuration (`src/brightness.js`)

```javascript
export const BRIGHTNESS_CONFIG = {
  neutralPattern:       1709,   // Dorian — the neutral point
  smoothingWindow:      3,      // polls to average before deciding
  transitionThreshold:  3,      // min brightness shift needed to trigger a change
  alphaNeutralWeight:   0.6,    // how strongly alpha pulls toward neutral (0–1)
  noteCountPreference:  true,   // prefer candidate scales with same note count
  commonTonePreference: true,   // prefer scales sharing pitches with current
  allowUnnamedScales:   false,  // (unused by brightness logic — governed by demoAllScales)
};
```

All parameters are in one place and can be tuned without touching App.jsx.

---

## Key Files

| File | Role |
|------|------|
| `src/brightness.js` | `BRIGHTNESS_CONFIG`, `brightnessScore()`, `targetBrightness()`, `findClosestScale()` |
| `src/App.jsx:1` | Import of brightness module |
| `src/App.jsx:964` | `brightnessRange` useMemo (min/max/neutral across loaded scales) |
| `src/App.jsx:1048` | `brightnessHistoryRef` — rolling window for smoothing |
| `src/App.jsx:1473` | `catalogue.push()` — now includes `pattern` field |
| `src/App.jsx:1491` | Brightness selection block — runs before Claude API call |
| `src/App.jsx:1518` | `currentState` — includes brightness fields |
| `src/App.jsx:1548` | Claude system prompt — updated role description |

---

## Example States

| Brain state | relaxation_index | dominant_band | Expected result |
|---|---|---|---|
| Eyes open, focused | 0.1 | beta | Bright scale (high brightness target) |
| Relaxed, reading | 0.5 | alpha | Target pulled ~60% toward Dorian (neutral) |
| Eyes closed, calm | 0.8 | alpha | Dark-ish, still alpha-moderated toward neutral |
| Deep theta | 0.9 | theta | Dark scale, no alpha moderation |

---

## Without EEG (headband disconnected)

If `eegData` is null or `connected` is false, `brainState` is null. In this case:
- `brightnessSelected` is never set
- No scale pre-selection occurs
- `currentState` omits both `brainState` and `brightnessSelected`
- Claude falls back to free exploration mode (choosing scales autonomously based on musical variety)
