# Idea: tabla in Chloe — 2026-10-26

Ronnie's idea, captured as he said it: *tablas (drums). The lady involved with
Tim Scully mentioned the tablas going at alpha rhythm... but they can also have
pitch, so I can use them with Chloe for scales.*

## Where it comes from

Jean Millay, 1972: listening to Alla Rakha on tabla (Ravi Shankar, *Ragas and
Talas*) while in steady alpha, she felt **both hemispheres lock in phase with
the strokes, about 8 per second**. Full account:
`nerve/docs/vintage-eeg/jean-mayo-millay.md`. The BERM side (an alpha-rate
pulse to induce phase sync) is in `nerve/docs/addons/IDEAS.md`. This note is
the **Chloe** side.

## Why tabla fits Chloe

- **It has pitch.** The right-hand drum (dayan) is tuned to the tonic (Sa) of
  the raga and rings with near-harmonic overtones; the black spot (syahi) does
  that (C.V. Raman measured it in the 1920s). The left-hand bass (bayan) glides
  in pitch under the wrist (the "ghe" swoop).
- **Tabla tarang already exists:** a row of 10–16 dayans, each tuned to one
  note of the raga, played as a melody instrument. That is the "tablas for
  scales" idea, and it's a real tradition.
- **Alpha rate is musical.** 8 strokes/s = sixteenth notes at 120 BPM, or
  triplet eighths at 160. Fast tabla playing sits there naturally.

## Possible shapes (not decided)

1. **Tabla voice tuned to the current scale's root**: dayan on Sa, bayan
   gliding below it. The groove follows key changes.
2. **Tabla tarang**: the melody (or a counter-line) played on tuned dayans,
   one per scale degree.
3. **Alpha-rate layer**: strokes at ~8 Hz, either fixed or later set from
   Ronnie's measured alpha frequency (Base `alpha_freq`).

## Starting point in the code

The synthesized hand drums (`HAND_DRUMS`, `makeHandDrum` in `src/App.jsx`;
see `HANDOFF_2026-10-17.md`) already have pitch, modes, decay and a slap
layer. A dayan is mostly a hand drum with **harmonic** mode ratios
(1:2:3:4:5) and a long ring; the bayan adds a pitch glide.

Strokes to model first: **Na/Ta** (dayan rim, ringing), **Tin** (dayan,
softer), **Ge** (bayan open, with glide), **Ke** (bayan flat slap, dead),
**Dha** = Na + Ge.

## Open questions for Ronnie

- Which shape first: a tuned groove, tarang melody, or the alpha-rate layer?
- Should it replace the congas in some worlds, or be its own drum style?

## Built (2026-10-26): the `tabla` beat style

All three shapes went into one beat (`tablaStep` in `src/App.jsx`; URL `bt=tabla`):

- **Teental theka, one matra per 16th:** dha dhin dhin dha | dha dhin dhin
  dha | dha tin tin ta | ta dhin dhin dha. The claps (tali) are on 1, 5 and 13;
  9 is the wave (khali, no bayan). At 120 BPM that's **8 strokes a second**,
  Millay's rate. Half-time above 160 BPM, like the other beats.
- **Tuned:** the dayan is on Sa, folded into 200–400 Hz, and follows key
  changes. The bayan sits two octaves down (70–140 Hz).
- **Tarang:** bar 4 of every 8 (sometimes bar 6 too), the dayan walks the
  current scale (3 contours, `TARANG`) while the bayan keeps the claps.
- **Tihai:** bar 8 plays ti-ra-ki-ta-dha three times, the last dha landing on
  the next sam.
- **Energy:** calm plays softer; tension adds 32nd-note ti-ra-ki-ta
  flourishes and the wrist pushing the bayan's pitch up on the claps.
- **Synthesis:** `TABLA_STROKES` + `makeTabla` (harmonic modes, slap per
  stroke). It's in Wander's roster (weight 0.7).

**Not done yet:** an India world (sitar/sarangi lead + tanpura drone +
tabla), a tabla-only alpha mode set from Base `alpha_freq`, and the loudness
pass against the other kits.
