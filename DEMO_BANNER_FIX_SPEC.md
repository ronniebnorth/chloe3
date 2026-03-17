# Demo Commentary UI Fix

## The Problem

During EEG Claude mode sessions, the demo commentary bar at the top wraps to 2-3 lines when Claude writes verbose descriptions. Stacked on top of the brightness bar, it pushes the visualizer, playback controls, and everything else down significantly. On a 1080p screen the important interactive elements end up below the fold.

The brightness bar, slider, lock button, and explore button are all compact and fine. The problem is purely the multi-line commentary banner.

## The Fix

Move Claude's per-scale commentary out of the top banner and into the Claude Chat panel, where it belongs. The commentary is conversational content — it's Claude explaining its choices. That's what the chat panel is for.

### What the top banner should show

Keep it to a **single line** with just the essentials:

```
◆ DEMO  Min. Pentatonic · C · 54bpm · swing · sus2 · b0.54                    [copy] [chat] ● theta 14% · log (8)
```

That's: the scale name, key, BPM, rhythm, chord voicing, and normalized brightness. All the parameters at a glance, one line, no wrapping. The brightness value (b0.54) ties into the brightness bar directly below.

No prose description in the banner. No feature suggestions. No emotional narrative. Just the facts of what's playing.

### Where the commentary goes

Into the Claude Chat panel as a new message each cycle. It's already going there — Claude's commentary appears in the chat. The banner was duplicating it. Remove the duplication.

If the chat panel is closed, the banner still shows the parameter summary so the user knows what's playing. If they want the narrative, they open the chat.

### Feature suggestions (the ✦ items)

Claude's feature suggestions (✦ Consider adding variable reverb decay...) should also go into the chat panel only, not the banner. They're interesting but they're not playback status.

## Implementation

### `src/App.jsx` — demo commentary area

Replace the current multi-line commentary render with a single-line parameter summary:

```jsx
// Instead of rendering the full Claude commentary text in the banner:
<div className="demo-banner">
  {currentScale?.name || currentScale?.pattern} · {rootNote} · {bpm}bpm · {rhythm} · {chord}
  {currentBrightnessNorm !== null && ` · b${currentBrightnessNorm.toFixed(2)}`}
</div>
```

Style it as a single line with `white-space: nowrap` and `overflow: hidden` / `text-overflow: ellipsis` as a safety net.

### Claude Chat panel

No changes needed — the commentary is already being sent there. Removing it from the banner just eliminates the duplication.

### Banner height

With the commentary gone, the banner should be a fixed, predictable height — one line of text. This means the brightness bar and everything below it stays in a stable position. No layout shift when Claude writes a longer or shorter description.

## What NOT to Change

- The brightness bar — it's compact and working well
- The EEG dot indicator — fine where it is
- The slider, lock, and explore controls — fine
- The Claude Chat panel content — unchanged
- The log entries — unchanged (they can stay verbose since they're in a scrollable panel)
- The copy button — keep it in the banner, it copies the parameter summary

## Result

The top of the UI during a session should be:

```
[one-line parameter summary]                                    [copy] [chat] [EEG dot] [log]
BRIGHT ━━━━━━━━━━━━●━━━━━━━━━━━━━━━━ 0.54  [slider] [lock] [explore]
```

Two compact lines of status, then straight into the visualizer and controls. No wrapping, no layout shift, no scrolling to reach the circle.
