# Idea: maqam / quarter tones (maybe Chloe4) — 2026-11-08

Ronnie's idea, from a question about whether people in the Middle East would
type Chloe's binary right to left (they wouldn't: digits run left to right even
in Arabic, Hebrew and Persian text). The real barrier is the **number of
notes**, and Ronnie wants to build it now, possibly as Chloe4.

## Why Chloe3 can't do it

Chloe3's codes are 12 bits, one per Western semitone. Arabic maqam, Turkish
makam and Persian dastgah use pitches **between** the semitones. Maqam Rast's
3rd sits between major and minor; Bayati's 2nd sits between ♭2 and 2. Those
scales can't be written in 12 bits in either direction. The few that can
(Hijaz ≈ Phrygian dominant, Double Harmonic) are semitone approximations.

## The core change: 24 steps per octave

Each step is a quarter tone (50 cents). A scale becomes a 24-bit code, written
root-first as in Chloe3, so bit *i* is the note *i* quarter tones above the root.
Every Chloe3 scale still fits: double each position (a semitone = 2 quarter
steps).

## Brightness carries over, and the ladder fills in

Brightness is computed the same way: add each note's distance above the root,
counted in quarter steps, then halve it to stay on Chloe3's scale. Checked with
a script on the church modes plus four maqamat:

| Scale | Quarter-step positions | Brightness |
|---|---|---|
| Lydian | 0 4 8 12 14 18 22 | 39 |
| Ionian | 0 4 8 10 14 18 22 | 38 |
| Mixolydian | 0 4 8 10 14 18 20 | 37 |
| **Rast** | 0 4 7 10 14 18 21 | **37** |
| Dorian | 0 4 6 10 14 18 20 | 36 |
| Aeolian | 0 4 6 10 14 16 20 | 35 |
| **Hijaz** | 0 2 8 10 14 16 20 | **35** |
| **Bayati** | 0 3 6 10 14 16 20 | **34.5** |
| Phrygian | 0 2 6 10 14 16 20 | 34 |
| **Saba** | 0 3 6 8 14 16 20 | **33.5** |
| Locrian | 0 2 6 10 12 16 20 | 33 |

Rast ties Mixolydian and Hijaz ties Aeolian, so ties need a tie-break rule.
Bayati falls between Aeolian and Phrygian and Saba between Phrygian and
Locrian, so the EEG-driven brightness
movement gets half-steps on the ladder. (Rast here uses the half-flat 7th it
has going up; going down it's often a flat 7th, which gives 36.5.)

## The hard parts

1. **Enumeration blows up.** Chloe3 loops over all 4096 codes. A 24-bit rooted
   code has 2^23 ≈ 8.4 million possibilities, nearly all of them unmusical.
   Chloe4 should be built from a **catalogue**, not brute force: maqamat as
   stacks of *ajnas* (3–5 note fragments: Rast, Bayati, Hijaz, Saba, Sikah,
   Nahawand, Kurd, Ajam…). Most maqam theory works this way already.
2. **Quarter tones are an approximation too.** Real intonation varies by
   region and player. Bayati's 2nd is lower in Turkish practice, and Turkish
   theory uses 53 steps per octave. 24 steps is the standard Arabic teaching
   grid and a good first version. If needed later, store cents instead of
   bits.
3. **Maqam is more than a scale.** It has a starting jins, a characteristic
   path (sayr), notes that change going up versus down, and modulation
   between maqamat. That's a natural fit for Chloe's journeys, since
   wandering between related maqamat is how the music works anyway.
4. **Sound engine.** Web Audio can detune freely, so playback is the easy
   part. Every voice needs to accept fractional pitches (cents), not MIDI
   note numbers. Any tabla or sample voice tuned to semitones needs checking.
5. **The "no 3 consecutive semitones" rule** has to be restated for quarter
   steps (two adjacent quarter steps is common in maqam, e.g. Saba's 2-3).

## Open questions for Ronnie

- **Chloe4 or a mode in Chloe3?** A new app avoids touching a 9,200-line
  `App.jsx` that works. A mode reuses journeys, EEG brightness and the
  recorder. A middle path: start Chloe4 as a copy of Chloe3 and swap the scale
  core.
- **Which tradition first?** Arabic (24-step, ajnas) is the simplest and best
  documented starting point.
- **Sources** to check before building: maqamworld.com (Sami Abu Shumays &
  Johnny Farraj, *Inside Arabic Music*, 2019) for the ajnas/maqam catalogue
  and sayr.
