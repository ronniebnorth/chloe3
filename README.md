# Chloe — Scale Explorer

An interactive musical scale explorer built on binary scale encoding. Every possible scale in the 12-tone system is a 12-bit binary number. Chloe generates them all, sorts their modes by brightness, and lets you hear any scale in any key.

**[Try it live](https://ronniebnorth.github.io/chloe3/)**

## How It Works

Every combination of notes within an octave can be represented as a 12-bit binary number — one bit per semitone, 1 if the pitch is present, 0 if absent. The major scale is `101011010101`, which is `2741` in decimal. There are 4096 possible combinations. Modes are rotations of the same binary pattern.

**Bit order.** Patterns are written root-first: the leftmost digit is the root, then each digit to the right is one semitone higher (C, C♯, D, D♯, E, F, … B when the root is C). Read left to right, the pattern is the scale as you would play it. This is the reverse of standard binary notation — 2741 in conventional binary is `101010110101`, with the root at the right. The decimal value is the same either way: bit *i* of the number is the note *i* semitones above the root, the same convention used by Ian Ring.

Chloe generates scales by iterating through binary numbers, filtering by note count and musical constraints (no three consecutive semitones), and deduplicating rotational equivalents. The result is every scale from tritonic (3 notes) through octatonic (8 notes) that satisfies these rules, with all their modes sorted from brightest to darkest.

### The rules, exactly

A pattern is included if:

1. The root is present (bit 0 is set).
2. It has 3 to 8 notes.
3. It contains no three consecutive semitones — checked **around the octave**, so B–C–C♯ counts as a run of three just as C–C♯–D does.

Patterns that are rotations of each other are the same family; each family is stored once and its modes are the rotations that start on a note of the scale. The family's reference pattern is the smallest decimal value among its modes.

These rules produce exactly **124 families and 560 modes**:

| Notes | Families |
|---|---|
| 3 (tritonic) | 18 |
| 4 (tetratonic) | 35 |
| 5 (pentatonic) | 38 |
| 6 (hexatonic) | 26 |
| 7 (heptatonic) | 6 |
| 8 (octatonic) | 1 |

The rules define Chloe's universe. Pitch collections with a three-semitone cluster, or with fewer than 3 or more than 8 notes, are valid pitch-class sets but are outside what Chloe explores.

### Brightness score

A mode's brightness is the sum of the semitone positions of its notes, counting the root as 0:

```
brightness = sum of the semitone positions present (0–11)
```

Ionian `{0,2,4,5,7,9,11}` scores 38; Lydian, with the raised 4th, scores 39; Dorian scores 36. Within a family every mode has the same number of notes, so the raw score sorts the modes directly.

To compare scales with different numbers of notes, Chloe also uses a normalized score from 0 (darkest possible for that note count) to 1 (brightest possible):

```
min = N(N−1)/2          // root plus the N−1 lowest semitones
max = (N−1)(24−N)/2     // root plus the N−1 highest semitones
normalized = (brightness − min) / (max − min)
```

where *N* is the number of notes. Dorian normalizes to exactly 0.5, which makes it the neutral point across all note counts.

The score is a precise, reproducible definition of brightness. It matches the familiar diatonic ordering, but it is a mathematical proxy: how bright a scale actually sounds also depends on harmony, register, melody and the listener.

The brightness ordering — modes arranged from most augmented (Lydian-like) to most diminished (Locrian-like) — falls directly out of the binary representation. It was observed immediately upon generating the first scales in December 2017 and is a core organising principle of the explorer.

## Features

- 560 scales across 124 families, grouped by interval pattern
- Binary encoding and decimal identification for every scale (e.g., `101011010101` = 2741 = Major)
- Modes sorted by brightness within each scale family
- Adjustable root note, BPM, rhythm, and arpeggio style
- Reverb, delay, and drone controls
- Piano keyboard and scale wheel visualisations
- AI demo mode — Claude improvises through scales with commentary
- AI-generated scale info — mood, history, and famous uses for each named scale
- Audio visualiser with chromatic note colours
- Light and dark themes

## The Brightness/Courage Framework

Chloe organises modes along a brightness axis. Brighter modes have wider intervals from the root (more augmented character — openness, lift, forward motion). Darker modes have narrower intervals (more diminished character — weight, gravity, introspection). For the familiar diatonic modes, the ordering runs: Lydian → Ionian → Mixolydian → Dorian → Aeolian → Phrygian → Locrian.

The same score orders the modes of every scale family — pentatonic, hexatonic, octatonic, everything. The "courage" dimension extends brightness into an emotional and compositional framework, with the "brave frog" metaphor providing an intuitive, non-technical way to understand modal character.

## History

Chloe has been in continuous development since December 2017 across three major iterations:

- **Chloe 1** (Dec 2017): Original scale explorer with MIDI playback
- **Chloe 2** (Dec 2017): Introduced binary scale encoding and brightness sorting. First shared publicly on the Facebook Music Theory group on December 14, 2017
- **Chloe 3** (2024–present): Major refactor. Formalised the brightness/courage framework, added environment-based emotional framing, the brave frog metaphor, printable A5 educational booklet, rendered MP4 animation, and AI-powered features

## Provenance

Binary scale encoding — representing scales as 12-bit numbers, modes as rotations, with decimal values as unique identifiers — was developed independently for Chloe in December 2017. The same encoding was previously published by Ian Ring in his 2009 essay *[A Study of Scales](https://ianring.com/musictheory/scales/)*. The independent convergence on the same representation reflects the natural mathematical structure of the 12-tone system.

The earliest verifiable public record of Chloe's binary encoding is a [Facebook post to the Music Theory group](docs/provenance/) dated December 14, 2017. The earliest verifiable code commit is [December 20, 2017](https://github.com/ronniebnorth/ronniebnorth.github.io/commit/afe96127d9daed61222eb4783f810e6c29291e2e).

The brightest-to-darkest order of the seven diatonic modes is long-standing music-theory teaching. What is original to Chloe — applying a brightness score to order the modes of all 124 scale families, the courage framework, the brave frog metaphor, the environment-based emotional framing, and the interactive exploration approach — is documented in [chloe_scale_explorer_provenance.docx](docs/provenance/chloe_scale_explorer_provenance.docx).

## Support

If you find Chloe useful, consider leaving a tip:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/ronnienorth)
