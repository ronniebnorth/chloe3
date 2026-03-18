# Chloe 3 — Claude Chat Context

Paste this at the start of a Claude Chat session to bring Claude up to speed on the full current state of the project.

---

## What Chloe Is

A React + Vite scale explorer. Every musical scale is a 12-bit binary integer (one bit per semitone). Chloe generates all valid scales (3–8 notes, no 3 consecutive semitones), groups them into families by interval pattern, and sorts modes within each family bright → dark by summing active semitone positions (raw brightness score). 560 scales, 124 families. Live at https://ronniebnorth.github.io/chloe3/

Repo: https://github.com/ronniebnorth/chloe3 — single main branch, `src/App.jsx` is ~2900 lines, all UI and logic in one file plus `src/brightness.js`.

---

## Core Concepts

**Binary encoding:** Major scale = `101011010101` = 2741 decimal. Pattern integer is the canonical ID. Modes are bit-rotations of the same pattern.

**Raw brightness:** `brightnessScore(pattern)` sums the active semitone positions (0–11). Dorian = 36, Lydian = 39, Locrian = 33. Used for sorting modes within a family and for display.

**Normalized brightness:** `normalizedBrightness(pattern)` maps raw score to 0.0–1.0 within its cardinality (note count). Dorian of any 7-note scale = exactly 0.5. Pentatonics and heptatonics are on the same 0–1 scale, so brightness comparisons are cross-cardinality. Used for the EEG brightness system.

**Families:** Scales sharing the same interval structure. `hep-6` = the 7 diatonic modes. Family ID is like `hep-6`, mode index within family is `modeIdx`. Full scale ID for demo mode: `"hep-6.1"` (family.modeIdx).

---

## UI Structure

Root flex column (100vh, overflow hidden):
1. **Header bar** — CHLOE logo, filter input, theme toggle, help button
2. **Controls bar** — instrument, waveform, VOL/REV/DEL/BPM sliders (flexWrap: wrap — 2 rows on typical screens)
3. **Demo/Auto block** (conditional, flexShrink:0) — appears only when demo or auto is running:
   - Banner row: `★ DEMO` or `⟲ AUTO` · scale name · key · BPM · rhythm · chord · b0.xx · copy/chat/EEG dot/log buttons
   - Brightness row: BRIGHT bar with current dot (●), neutral tick (0.5), target arrow (▲), value, override slider, lock button, explore button
   - Log panel (conditional, maxHeight 440): history of played scales, clickable to replay
4. **Main content** (flex:1, minHeight:0) — three-column flex row:
   - Left panel: search + note count filter + scale list (grouped, sorted, expandable)
   - Centre panel: visualizer (circle waveform) or info tab
   - Right panel: Root Note, Playback (drone, buttons, loop, save, A/B comparison, scale info)

**Firefox note:** All flex children in the main content row need `minHeight: 0` to prevent Firefox's min-height:auto flex bug. This is already applied.

---

## Playback

- **Drone:** sustained root note, 5 timbres (sine/organ/pad/strings/tanpura), independent volume, 0 to -3 octaves
- **Arpeggio:** steps through scale notes; direction asc/desc/rand; rhythms even/swing/gallop/waltz/clave
- **Melody:** weighted random walk with octave leaps
- **Chord voicing:** layers power/sus2/sus4/triad/7th/all notes per step
- **Instruments:** piano/guitar/xylo/space (all Web Audio synthesis)
- **Effects:** reverb (convolution), delay (wet + time), concert pitch 432–440 Hz

---

## Auto Mode (`autoOn`)

No API key needed. Randomly picks named scales every 12–16 seconds, randomises rhythm/direction/chord/BPM/reverb/delay/drone. All choices logged in the demo log panel. Loop button freezes the current scale; Save captures a full snapshot.

---

## Demo Mode (`demoOn`) — Claude AI

Requires Anthropic API key (stored in browser). Uses `claude-haiku-4-5-20251001`. Calls `callClaude()` every 12–16 seconds (or immediately if user sends a chat message).

**What Claude controls:** scaleId, rootNote, rhythm, arpDir, chordVoice, bpm, reverbAmt, delayAmt, delayTime, droneOn, droneVol, droneOct, droneWave

**What Claude does NOT control:** the actual scale selection when EEG is active (see below)

**Commentary:** Claude's `commentary` and `request` (✦) fields go to the **Claude Chat panel** — not the banner. The banner shows only the parameter summary.

**Chat panel:** Floating panel (bottom-right, position:fixed). User can type messages; Claude responds via `reply` field. Opens/closes via 💬 chat button in the banner.

**`brightnessSource`** in `currentState` tells Claude what's driving scale selection:
- `'eeg'` — EEG pre-selected a scale; Claude should complement, not override freely
- `'slider'` — user set brightness manually; describe musical character, not brain state
- `'locked'` — user locked the current brightness zone
- `'claude'` — Claude has set a `brightnessOverride` and is actively driving toward a goal
- `'free'` — no EEG, no override; Claude picks freely

**Claude goal-directed brightness override:** Claude's JSON response may include `brightnessOverride` (0.0–1.0) to lock a brightness target across cycles (e.g. "boost my gamma" → 0.85). Omitting the field preserves the existing override; returning `null` clears it. Priority chain: lock > slider > claude > eeg > free. The brightness bar shows an orange dot when Claude is driving. A `★✕` button lets the user release the Claude override manually.

---

## EEG Integration

**Proxy:** `~/rbn-projects/meditation-research-studio/eeg_proxy.py` — polls FlowTime headband via serial, exposes JSON at `localhost:8520`. App polls every 2 seconds.

**`dominant_active_band`:** strongest band excluding delta (always dominant at forehead, not meaningful). One of: alpha, theta, beta, gamma. Used for the EEG dot colour in the banner.

**Brightness targeting (ratio-based, in `src/brightness.js`):**
```
target = 0.5  (neutral = Dorian)
target -= min(theta/alpha - 0.5, 0.4) * 0.3   // high theta → darker
target += min(beta/alpha  - 0.5, 0.4) * 0.3   // high beta  → brighter
if dominant_active == 'alpha': blend 50% toward 0.5  // alpha = calm/neutral
target = clamp(0.0, 1.0)
```

**Scale selection:** `findClosestScale(target, catalogue, currentPattern, config)` — finds closest normalized brightness match, with +0.08 penalty for different note count and -0.01 per shared common tone.

**Transition threshold:** 0.05 (5%) — scale only changes if smoothed target has moved more than this from current scale's brightness.

**Smoothing:** 3-poll rolling average before comparing to threshold.

---

## Brightness UI (`src/brightness.js` + `src/App.jsx`)

**Brightness bar** (in demo/auto block):
- Horizontal track with current scale dot (●), neutral tick at 0.5, EEG target arrow (▲)
- Dot colour: amber = locked, blue = slider override, cyan = EEG-driven, amber = free
- Numeric value display
- **Override slider** (0–100 → 0.0–1.0): sets `overrideTargetRef` and `overrideTarget` state
- **Lock button** 🔒/🔓: locks current scale's brightness as override target
- **✕ clear**: appears when override active and not locked; returns to EEG/free targeting
- **⇄ explore**: picks random scale within ±0.1 brightness of current target (`randomAtBrightness()`)

State: `overrideTarget` (useState, for render), `overrideTargetRef` (useRef, for async callClaude), same pattern for `brightnessLocked`/`brightnessLockedRef`. `eegTarget` (useState) holds last smoothed EEG target for display.

All brightness state is reset when demo or auto is stopped.

---

## Key State

```
sel              — currently selected scale object {id, pattern, modes, n, ...}
rootIdx          — 0–11
bpm, rhythm, arpDir, chordVoice
droneOn, droneVol, droneOct, droneWave
reverbAmt, delayAmt, delayTime, noteVol
demoOn, autoOn, loopOn, arpOn
demoKey          — Anthropic API key
chatLog          — [{role, text, ts}], last 40 entries
chatOpen
demoLog          — [{scaleName, famId, modeIdx, rootNote, rhythm, arpDir, chordVoice, bpm, commentary, ts}]
showDemoLog
eegData          — live from proxy poll
eegTarget        — last smoothed EEG brightness target (0.0–1.0)
overrideTarget   — manual brightness override (null = not set)
brightnessLocked — bool
claudeOverride   — Claude-set brightness override (null = not set)
showDiatonic     — bool; shows diatonic neighborhood annotations in scale list + signals Claude to use modal language
```

**Refs for async (stale closure) access:** `stRef` (mirrors all playback state), `overrideTargetRef`, `brightnessLockedRef`, `claudeOverrideRef`, `loopOnRef`, `brightnessHistoryRef`, `callClaudeNowRef`, `showDiatonicRef`

---

## `src/brightness.js` Exports

```javascript
BRIGHTNESS_CONFIG    // { neutralPattern:1709, smoothingWindow:3, transitionThreshold:0.05,
                     //   alphaNeutralWeight:0.5, thetaDarkWeight:0.3, betaBrightWeight:0.3,
                     //   randomTolerance:0.1, noteCountPreference:true, commonTonePreference:true }
brightnessScore(pattern)                          // raw sum of active semitone positions
normalizedBrightness(pattern)                     // 0.0–1.0 per cardinality
targetBrightness(eegState, config)                // ratio-based EEG → normalized target
findClosestScale(target, catalogue, currentPattern, config)
randomAtBrightness(target, tolerance, catalogue, currentPattern, config)
countBits(pattern)
DIATONIC_MODES                                    // [{name, pattern}] bright→dark, Lydian→Locrian
diatonicNeighborhood(pattern)                     // { relatives[], sharedPitches, totalPitches, ambiguity }
```

---

## Recent Changes (March 2026)

- **EEG delta fix:** proxy now computes `dominant_active_band` (excluding delta). Brightness targeting switched from `relaxation_index` to theta/alpha + beta/alpha ratios.
- **Brightness UI:** brightness bar with current/target display, override slider, lock, explore-nearby button.
- **Demo banner fix:** banner reduced to single-line parameter summary (scale · key · BPM · rhythm · chord · bX.XX). Commentary and ✦ requests routed to chat panel only.
- **Firefox flex fix:** added `minHeight: 0` to main content row and all three panel children to fix Firefox's min-height:auto flex bug.
- **Claude prompt discipline:** Claude only mentions brain state when it meaningfully shifts; focuses on musical choices when stable.
- **Claude goal-directed brightness override:** Claude can set `brightnessOverride` (0.0–1.0) to hold a target brightness across cycles (e.g. for "boost my gamma"). Orange dot in brightness bar. User can release via `★✕` button or manual slider/lock.
- **Diatonic neighborhood:** `diatonicNeighborhood(pattern)` in brightness.js finds which of the 7 diatonic modes share the most pitches with any scale. `≈ mode` toggle in the scale list shows the annotation inline. When on, Claude actively uses modal language in commentary; when off it has the data but doesn't emphasise it.

---

## File Locations

```
~/rbn-projects/chloe3/
  src/App.jsx              — ~2900 lines, entire UI + logic
  src/brightness.js        — brightness scoring, EEG targeting, scale selection
  public/                  — static assets
  screenshots/             — screenshots by date
  CLAUDE_CHAT_CONTEXT.md   — this file

~/rbn-projects/meditation-research-studio/
  eeg_proxy.py             — FlowTime headband → localhost:8520 JSON proxy

~/rbn-projects/brain-machine-research-studio/
  brain_machine_ui.html    — separate EEG biofeedback UI (not Chloe)
```
