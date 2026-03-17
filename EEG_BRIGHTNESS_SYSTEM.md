# Chloe EEG Brightness-Based Scale Selection

## Overview

When Claude mode is running with a live EEG headband connected, Chloe uses an algorithmic **brightness-matching** system to select scales automatically before each Claude call. Claude's role shifts from *picking* scales to *articulating* them — choosing BPM, rhythm, voicing, and effects that complement the pre-selected scale's emotional character.

---

## Two Brightness Measures

### Raw brightness (`brightnessScore`)
Sums the active bit positions of a scale's 12-bit pattern. Used for **within-group display sorting** — modes within a family are always listed bright to dark.

```
brightnessScore(pattern) = sum of active semitone positions
```

Diatonic mode reference:

| Mode | Pattern | Raw brightness |
|------|---------|---------------|
| Lydian | 2773 | 39 |
| Ionian | 2741 | 38 |
| Mixolydian | 1717 | 37 |
| **Dorian** | **1709** | **36** |
| Aeolian | 1453 | 35 |
| Phrygian | 1451 | 34 |
| Locrian | 1387 | 33 |

### Normalized brightness (`normalizedBrightness`)
Maps the raw score to a **0.0–1.0 range relative to the theoretical min/max for each note count**. Used by the EEG matching system.

```
normalizedBrightness(pattern):
  N    = number of notes in scale
  min  = 0 + 1 + 2 + ... + (N-1)           = N×(N-1)/2
  max  = 0 + (12-N+1) + ... + 11           = (23-N)×(N-1)/2
  norm = (rawScore - min) / (max - min)
```

**Why normalization is necessary:** Raw brightness is biased toward higher note counts. A heptatonic's range (33–39) doesn't overlap with a tetratonic's range (~6–30). Without normalization, the EEG system would be locked into heptatonics for mid-range targets. With normalization, a bright pentatonic (0.9) and a bright heptatonic (0.9) are equally reachable.

**Key property:** Dorian normalizes to exactly **0.5** — it is the natural neutral point in normalized space.

Normalized values for the diatonic modes and common pentatonics:

| Scale | N | Normalized |
|-------|---|-----------|
| Lydian | 7 | 0.60 |
| Ionian | 7 | 0.57 |
| Mixolydian | 7 | 0.53 |
| **Dorian** | **7** | **0.50** |
| Aeolian | 7 | 0.47 |
| Phrygian | 7 | 0.43 |
| Locrian | 7 | 0.40 |
| Min. Pentatonic | 5 | 0.54 |
| Maj. Pentatonic | 5 | 0.43 |

The bounds formulas are verified against the full scale catalogue — no scale falls outside its cardinality bounds.

---

## EEG → Normalized Target

Each Claude call cycle:

1. **Target** is computed from `relaxation_index` (0–1 from the EEG proxy):
   ```
   target = 1.0 - relaxation_index   // high relaxation → low target → dark
   ```

2. **Alpha pull**: If `dominant_band === 'alpha'`, the target is blended 60% toward 0.5 (neutral). This prevents alpha states from drifting too dark.
   ```
   target = target × 0.4 + 0.5 × 0.6
   ```

3. **Smoothing**: The last 3 raw targets are averaged to prevent rapid flipping on noisy EEG signals.

4. **Transition threshold**: A scale change only triggers if the smoothed target differs from the current scale's normalized brightness by ≥ 0.05 (5% of the 0–1 range).

---

## Scale Selection (`findClosestScale`)

Searches the full scale catalogue and scores each candidate against the normalized target:

```
dist = |normalizedBrightness(candidate) - normalizedTarget|
     + 0.08   (if different note count from current scale)
     - 0.01 × shared_pitch_count
```

- **Note count preference** (`+0.08`): Acts as a tiebreaker — same-cardinality is preferred, but a cross-cardinality scale that's 0.10 closer in normalized brightness will still win. Pentatonics can now appear at mid-range targets.
- **Common tone bonus** (`-0.01 per shared pitch`): Smooth transitions by favouring scales that share pitches with the current one.

The lowest-scoring entry wins and is immediately applied via `pick()` before the Claude API call.

---

## Claude's Role

- The scale is **pre-selected** algorithmically before Claude is called.
- `currentState` sent to Claude includes:
  - `brightnessSelected` — name of the selected scale
  - `currentBrightness` — raw brightness score (for display/commentary)
  - `currentBrightnessNorm` — normalized brightness (0.0–1.0)
  - `targetBrightnessNorm` — the smoothed normalized target that triggered the selection
- Claude's job is to choose **BPM, rhythm, chord voicing, drone, reverb, and delay** to musically articulate that scale's character.
- Claude may override the selection if it has a strong musical reason, but must explain the override.

---

## Data Flow (per cycle)

```
EEG proxy (localhost:8520)
  → eegData (polled every 2s)
  → brainState snapshot (relaxation_index, dominant_band, band %s)
  → targetBrightness()        ← returns normalized 0–1 value
  → smoothing (window=3)      ← brightnessHistoryRef
  → threshold check           ← |smoothed - currentNorm| ≥ 0.05
  → findClosestScale()        ← searches catalogue, uses normalizedBrightness()
  → pick()                    ← applies scale immediately
  → currentState              ← currentBrightness, currentBrightnessNorm, targetBrightnessNorm, brightnessSelected
  → Claude API call           ← receives pre-selected scale, chooses musical parameters
  → Claude response           ← JSON with BPM, rhythm, voicing, drone, commentary
```

---

## Configuration (`src/brightness.js`)

```javascript
export const BRIGHTNESS_CONFIG = {
  neutralPattern:       1709,   // Dorian — reference (normalizes to 0.5)
  smoothingWindow:      3,      // polls to average before deciding
  transitionThreshold:  0.05,   // min normalized shift to trigger a change
  alphaNeutralWeight:   0.6,    // how strongly alpha pulls toward 0.5 neutral
  noteCountPreference:  true,   // +0.08 penalty for different note count
  commonTonePreference: true,   // -0.01 per shared pitch with current scale
};
```

---

## Key Files

| File | Role |
|------|------|
| `src/brightness.js` | `BRIGHTNESS_CONFIG`, `brightnessScore()`, `normalizedBrightness()`, `targetBrightness()`, `findClosestScale()` |
| `src/App.jsx` (import) | Imports all brightness exports |
| `src/App.jsx` (~1491) | Brightness selection block — runs before Claude API call |
| `src/App.jsx` (~1518) | `currentState` — includes both raw and normalized brightness fields |

---

## Example States

| Brain state | relaxation_index | dominant_band | Norm target | Expected |
|---|---|---|---|---|
| Eyes open, focused | 0.1 | beta | ~0.90 | Bright scale (Lydian-like) |
| Relaxed, reading | 0.5 | alpha | ~0.50 | Alpha-pulled to neutral (Dorian range) |
| Eyes closed, calm | 0.8 | alpha | ~0.38 | Slightly dark, alpha-moderated toward 0.5 |
| Deep theta | 0.9 | theta | ~0.10 | Dark scale, no alpha moderation |

---

## Without EEG

If the headband is disconnected (`brainState` is null):
- No brightness selection runs
- `currentState` omits all brightness fields
- Claude falls back to free exploration (choosing scales autonomously)
