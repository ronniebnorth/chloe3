# Brightness UI Features

## Overview

Three features to make the brightness system visible and controllable. Build them in order — each one builds on the previous.

---

## 1. Brightness Display

**Priority: Build this first.**

Show a persistent, compact visual indicator of where the system is in brightness space. This should be visible whenever a scale is playing, not just during EEG sessions.

### What to show

- **Current normalized brightness** (0.0–1.0) of the active scale
- **Target normalized brightness** from the EEG system (only when headband is connected)
- **Neutral marker** at 0.5 (Dorian equivalent)

### Suggested implementation

A horizontal bar or meter, compact enough to fit in the existing controls area without dominating it. Something like:

```
Dark ◄━━━━━━━━●━━━━━━━━━► Bright
            ▲ target
```

- A filled position marker showing current scale brightness
- A second marker (different color or style) showing the EEG target when connected
- A center tick or line at 0.5 for neutral reference
- The normalized value displayed as a number next to it (e.g., "0.43")

### Behavior

- **With EEG connected:** Shows both current and target. The gap between them tells the user whether the system is about to change scales (target has moved away from current) or is settled (target matches current).
- **Without EEG:** Shows only current brightness. Still useful for understanding what you're listening to.
- **Updates on every scale change**, not on every poll. The meter shouldn't jitter.

### Where it goes

Near the existing EEG dot indicator, or in the demo controls area. It should be visible in both manual and Claude mode. Don't bury it in a settings panel.

---

## 2. Brightness Override (Slider + Lock)

**Priority: Build second.**

Let the user manually control the brightness target, either overriding or supplementing the EEG system.

### Components

**Brightness target slider:**
- Range 0.0 to 1.0
- When the user moves it, the slider value becomes the brightness target instead of the EEG-derived target
- Scale selection immediately responds (subject to existing smoothing and transition threshold)
- Works with or without the headband connected

**Lock toggle:**
- A small button or checkbox next to the brightness display
- When locked, the current brightness zone is held — the EEG system continues reading but its target is ignored
- The display should make it clear when override/lock is active (different color, icon, label)

**EEG resume:**
- When the slider is released or lock is toggled off, the system returns to EEG-driven targeting
- Transition back should use the same smoothing as normal operation — no abrupt jump

### Implementation notes

- Add an `overrideTarget` state to App.jsx. When non-null, `findClosestScale()` uses it instead of the EEG-computed target.
- The lock stores the current normalized brightness as the override target.
- The slider sets the override target directly.
- Clearing either (releasing slider to a "reset" position, or unchecking lock) sets overrideTarget back to null.
- Claude's `currentState` should include a field indicating whether the target is EEG-driven or user-overridden, so Claude's commentary can reference it.

### Interaction with Claude mode

When the user overrides brightness, Claude should know. Add to currentState:

```javascript
brightnessSource: 'eeg' | 'slider' | 'locked'
```

The Claude prompt should tell it: if brightnessSource is 'slider' or 'locked', the user has taken manual control of brightness. Don't try to justify the scale choice in terms of brain state — describe the musical character instead.

---

## 3. Brightness-Constrained Randomizer

**Priority: Build third.**

A mode that picks random scales but only within a brightness band around the current target.

### Behavior

- Activated by a button (e.g., "Explore" or "Random in zone")
- Picks a random scale from the catalogue where `normalizedBrightness` is within ± a configurable tolerance of the current target (default ± 0.1)
- Applies it via `pick()` like normal selection
- Can be pressed repeatedly to cycle through different scales at similar brightness
- Respects `noteCountPreference` if enabled — prefers same cardinality but doesn't require it

### Why this is useful

The brightness system tends to converge on the same "best match" scale for a given target. This randomizer lets you explore the full set of scales that live at a particular brightness level — including unnamed ones you'd never find by browsing groups. It's a discovery tool.

### Implementation

```javascript
function randomAtBrightness(target, tolerance, catalogue, currentScale, config) {
  const candidates = catalogue.filter(s => 
    Math.abs(normalizedBrightness(s.pattern) - target) <= tolerance
  );
  
  if (candidates.length === 0) return null;
  
  // Optionally prefer same note count
  let pool = candidates;
  if (config.noteCountPreference && currentScale) {
    const currentN = countBits(currentScale.pattern);
    const sameN = candidates.filter(s => countBits(s.pattern) === currentN);
    if (sameN.length > 0) pool = sameN;
  }
  
  // Pick randomly, avoiding the current scale
  const filtered = pool.filter(s => s.pattern !== currentScale?.pattern);
  if (filtered.length === 0) return pool[Math.floor(Math.random() * pool.length)];
  return filtered[Math.floor(Math.random() * filtered.length)];
}
```

### Where it goes

A button in the demo controls area, near the brightness display. Only active when a scale is loaded (so there's a current brightness to anchor to). Label it something simple — "Explore nearby" or just a shuffle icon with a tooltip.

---

## What NOT to Change

- The brightness computation (brightnessScore, normalizedBrightness) — unchanged
- The EEG proxy — unchanged
- The smoothing and transition threshold logic — unchanged
- The findClosestScale algorithm — unchanged (the override and randomizer work alongside it, not replacing it)
- The audio engine — unchanged

---

## Config Additions

```javascript
// Add to BRIGHTNESS_CONFIG
randomTolerance: 0.1,   // ± range for brightness-constrained randomizer
```

No other config changes needed. The display is purely visual, the override is a state toggle, and the randomizer uses the existing config values.
