# Draw a journey — 2026-11-04

Ronnie's idea, as he said it: *"on the journey page, it shows a line, the path of the
journey. What if the user could draw the line?"*

Instead of choosing a journey, you compose one with a single gesture.

## First version (built)

Code: `src/drawn.js`, `JOURNEYS.draw` and the stage overlay in `src/App.jsx`.

- **DRAW card** on the Listen page. Draw straight on the stage with mouse or finger; left is
  the start, right the end, up is bright. A short stroke repaints just that part.
- **You can redraw while it plays.** The journey reads the line each second.
- **`clear`** goes back to the default gentle hill. **`copy link`** gives a link that plays the line.
- In links: `jo=draw&jl=` + 60 base-36 characters, one per point (`0` lowest, `z` highest).
- In the Studio, `draw` appears in the journey row and plays the current line, but you can't draw there.

What the line drives, by height (`drawnVals`). Ranges come from how Dawn and Dusk already tie
these together, extended slightly:

| Line | Brightness target | Tempo × | Reverb | Note length |
|---|---|---|---|---|
| Lowest | 0.25 | 0.75 | 0.90 | 1.6 |
| Highest | 0.75 | 1.15 | 0.42 | 0.85 |

Near the target Auto walks one note at a time; far from it, it jumps. So a gentle slope changes
scales note by note and a steep cliff jumps to a distant scale. Smoothing takes out hand shake
but deliberately leaves big cliffs steep. `steady: true`: no tempo bursts, so tempo follows the
line. Key changes stay on.

## Known limit

Picks come every 12–16 s, so wiggles shorter than that mostly get lost. Broad shapes will be
heard; fine detail won't. This is why it probably suits longer journeys. Not yet judged by ear.

## Later ideas, not built

1. **Markers on the line.** A single line can't do what The Wait does, because that depends on
   things happening at particular moments (drums falling away, the 3rd arriving, the jet). Tap a
   spot to say "the drop goes here." Deliberately left out of the first version: just drawing a
   line is the magic of the idea.
2. **A second line or lanes.** Separate lines for tempo or energy. Risks losing the simplicity.
3. **Your brain beside the line.** With a headband, draw the actual brain trace next to the line
   you drew and see how closely your state followed the journey you composed. Connects to
   "brain-paced journeys" (open since `HANDOFF_2026-10-16.md`). Needs a trustworthy signal; see
   the trigger section of the Linger opinion doc.
4. **Save drawn lines by name**, and a small gallery of them. Today a line only survives as a link.
5. **Playing it on a Fire TV.** You can't draw there, but a link should open it. Untested.
6. **Light.** The drawn line could also shape Bright, or the screen as room light. See the Light
   and Sound doc.

## Ronnie's vision, after first playing it (2026-11-04)

His words: *"Chloe just got a whole lot better, this is a trip. I imagine a future with multiple
touch screens, drawing lines for each instrument as the music flows, orchestrating by the
brightness and darkness of each. And a child can draw a line, which makes a song. I have a lot of
testing to do, to make sure it works best, but it does work. Probably need a user calibration
feature, but that's later. Hell, I could make a webcam follow a conductor's hands and do the same."*

Nothing here is built. Notes for when he gets to it, after his testing:

- **A line per instrument.** The catch: Chloe plays one scale at a time, so if each instrument's
  brightness picked its own scale they'd clash. Options: one master line sets the scale, and the
  others set each instrument's register, density or level; or every instrument shares a root and
  takes a different mode of it, which is richer but riskier. Try by ear; the second is the
  interesting experiment.
- **Live drawing.** Today's line is drawn ahead of the music, though it can be redrawn while it
  plays. Drawing right at the moving dot turns it into playing an instrument.
- **Conductor's hands by webcam.** Browser hand tracking (e.g. MediaPipe Hands) runs on an ordinary
  webcam with no new hardware. Hand height feeds the line live, and two hands could mean two lines.
  Slow moves suit it, since Chloe's scale picks take 12-16 s; tempo or level could respond faster.
- **User calibration.** He hasn't said what it should calibrate yet: ask.
- **"A child can draw a line, which makes a song."** Possibly the clearest one-sentence description
  of Chloe so far.
