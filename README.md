# Chloe — Scale Explorer

An interactive musical scale explorer built on binary scale encoding. Every possible scale in the 12-tone system is a 12-bit binary number. Chloe generates them all, sorts their modes by brightness, and lets you hear any scale in any key.

**[Try it live](https://ronniebnorth.github.io/chloe3/)**

## How It Works

Every combination of notes within an octave can be represented as a 12-bit binary number — one bit per semitone, 1 if the pitch is present, 0 if absent. The major scale is written `101011010101` in Chloe, and its value is `2741` (see Bit order below for why a binary calculator reads that string differently). There are 4096 possible combinations. Modes are rotations of the same binary pattern.

**Bit order.** Patterns are written root-first: the leftmost digit is the root, then each digit to the right is one semitone higher (C, C♯, D, D♯, E, F, … B when the root is C). Read left to right, the pattern is the scale as you would play it. This is the reverse of standard binary notation — 2741 in conventional binary is `101010110101`, with the root at the right. The decimal value is the same either way: bit *i* of the number is the note *i* semitones above the root, the same convention used by Ian Ring. I arrived at the binary representation independently while building Chloe 1, and only found Ian Ring's site afterward, when I searched for the codes I was using. His catalogue is the deeper reference and worth exploring. Root-first writing also has a precedent: Rich Cochrane's *Scale and Arpeggio Resources: A Guitar Encyclopedia* (Creative Commons, released 2012), chapter 18, writes the major scale as `1 0 1 0 1 1 0 1 0 1 0 1`, reading left to right from the root. Cochrane reads that string as a plain binary number, so his major scale is 2773; Chloe uses Ian Ring's values, so its major scale is 2741.

**Why root-first, and please don't flip it.** This has been debated more than once, and AI assistants tend to "correct" it to standard binary. It's deliberate. Chloe is a tool for musicians: root-first reads like the scale on a keyboard, and the search box matches binary fragments against the root-first string (`toBin` in `src/App.jsx`), so you type a pattern the way you think it, starting with the root's `1`. With standard order you would have to type from the top of the octave down and end on the root. Standard binary is the right reading for math, code, and outside references; the decimal value is identical either way. The one thing to watch: never write that a root-first string "equals" its number. Pasted into a calculator, `101011010101` reads as 2773, not 2741.

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
- Binary encoding and decimal identification for every scale (e.g., Major is `101011010101` root-first, value 2741)
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
- **Chloe 2** (Dec 2017): Generated every scale family as binary, sorted each family's modes bright to dark (first committed 04:56 EST, December 14, 2017). First shared publicly on the Facebook Music Theory group the same day
- **Chloe 3** (2024–present): Major refactor. Formalised the brightness/courage framework, added environment-based emotional framing, the brave frog metaphor, printable A5 educational booklet, rendered MP4 animation, and AI-powered features

## Provenance

Binary scale encoding (scales as 12-bit numbers, modes as rotations, decimal values as identifiers) was found independently for Chloe in December 2017. It was not new. Ian Ring had published the same numbering, with the root as the lowest bit and the major scale as 2741, in a scale calculator committed to his public code library on November 8, 2015 (his original repository is gone; a copy survives at [imarco/PHPMusicXML](https://github.com/imarco/PHPMusicXML), which GitHub dates to December 14, 2015). That became his essay *[A Study of Scales](https://ianring.com/musictheory/scales/)*, whose preface dates it to 2009. Ring's 2015 code cites William Zeitler's list of scales, and Rich Cochrane's *Scale and Arpeggio Resources* (2012) also writes scales as binary.

Chloe's record: Chloe 1 (first commit December 8, 2017) already wrote modes as hand-made rows of 0s and 1s. The first code that generates every scale family, rotates each into its modes and sorts them is [commit 4613095](https://github.com/ronniebnorth/ronniebnorth.github.io/commit/4613095), at 04:56 EST on December 14, 2017; [commit b86e37c](https://github.com/ronniebnorth/ronniebnorth.github.io/commit/b86e37c2a14c3775ebba1fe27ae7116d36b011e4) added the binary strings and decimal values at 07:04 the same morning. The [Facebook post to the Music Theory group](docs/provenance/) followed that day.

What is Chloe's own: sorting each family's modes by their binary number, and the observation that this lays them out from bright to dark, used from the first version as the explorer's organising principle. In 2017 the numbers counted the root as the highest bit (major = 2773) and the order came from the sort itself, with no brightness formula; the sum-of-positions score came later and is a known measure. No publication stating that the binary sort gives the brightness order was found in a November 2026 search, and neither Ring's code nor his essay ranks scales by brightness. The bright-to-dark order of the seven diatonic modes is long-standing teaching. Later original work: the courage framework, the brave frog metaphor, the environment-based emotional framing, felt brightness and the generative journeys.

How it was noticed: by colour. The first version (04:56, December 14, 2017) coloured each family on a red-yellow-green gradient down its sorted list (starting from a widely shared percentage-to-colour snippet); by 07:04 the colour came straight from the binary number. Over the next twelve minutes the colours were honed in three commits: blue added to soften everything to pastels (07:08), the dark half's blue raised to full (07:12), and its red lowered (07:16). The dark modes went from red through pink and magenta to light blue and purple, the bright modes stayed warm yellow-green, and the finished scale read warm for bright and cool for dark. No line of the 2017 code mentions brightness. On the Greek modes the colours ran from Lydian to Locrian, the bright-to-dark order already known, and the binary order matched it; from there the same sort ordered every other family. In the author's words: "brightness was just obvious when I assigned colors to the scales. It just worked." The gradient is the one in the Facebook screenshot. Ring, Cochrane and Zeitler had the same numbers and listed modes in numeric order, but none coloured the sorted list or tied it to brightness.

The March 2026 documents in [docs/provenance/](docs/provenance/) predate the 2015 evidence and carry errors; see the correction notice at the top of each.

## Support

If you find Chloe useful, consider leaving a tip:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/ronnienorth)
