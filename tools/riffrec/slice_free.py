#!/usr/bin/python3
"""Slice a free-played chug take (no click) into single hits: spectral-flux
onsets, each hit cut to the next onset (max 0.6 s), pitch-labelled relative to
low E, then the cleanest few per pitch kept in two loudness layers.

  /usr/bin/python3 slice_free.py <take.wav> <channel> <out_dir>
"""
import json, os, sys, numpy as np, scipy.io.wavfile as w
from scipy.signal import stft

src, ch, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
sr, x = w.read(src); r = x[:, ch].astype(float) / 2 ** 31
f, t, Z = stft(r, sr, nperseg=1024, noverlap=1024 - 240)
S = np.log1p(100 * np.abs(Z))
flux = np.maximum(0, np.diff(S, axis=1)).sum(0)
flux = (flux - np.median(flux)) / (np.percentile(flux, 95) + 1e-9)
pk = [i for i in range(2, len(flux) - 2) if flux[i] > 0.35 and flux[i] == flux[i - 2:i + 3].max()]
on = []
for i in pk:
    if not on or t[i] - on[-1] > 0.07: on.append(t[i])
# Refine each onset to the first sample above 15% of the hit's early peak
ons = []
for a in on:
    i0 = max(0, int((a - 0.02) * sr)); seg = np.abs(r[i0:i0 + int(0.05 * sr)])
    ons.append(i0 + int(np.argmax(seg > 0.15 * seg.max())))
ons = np.array(ons)

def pitch(seg):
    seg = seg - seg.mean(); ac = np.correlate(seg, seg, "full")[len(seg) - 1:]
    lo, hi = int(sr / 400), int(sr / 70)
    k = lo + int(np.argmax(ac[lo:hi]))
    if 2 * k < hi and ac[2 * k] > 0.9 * ac[k]: k *= 2      # octave-up error guard
    return sr / k, ac[k] / ac[0]

hits = []
for n, i in enumerate(ons):
    end = ons[n + 1] if n + 1 < len(ons) else len(r)
    L = min(end - i, int(0.6 * sr)) - int(0.003 * sr)
    if L < int(0.09 * sr): continue
    p, conf = pitch(r[i + int(0.015 * sr): i + int(0.095 * sr)])
    if conf < 0.5: continue
    midi = 69 + 12 * np.log2(p / 440)
    fret = int(round(midi - 40))
    seg = r[max(0, i - int(0.002 * sr)): i + L].copy()
    fi, fo = int(0.001 * sr), int(0.015 * sr)
    seg[:fi] *= np.linspace(0, 1, fi); seg[-fo:] *= np.linspace(1, 0, fo)
    hits.append({"i": int(i), "fret": fret, "cents": round(100 * (midi - 40 - fret)), "peak": float(np.abs(seg).max()),
                 "len": round(len(seg) / sr, 3), "conf": round(float(conf), 2), "seg": seg})

os.makedirs(out, exist_ok=True)
kept = []
for fret in sorted({h["fret"] for h in hits}):
    g = [h for h in hits if h["fret"] == fret and abs(h["cents"]) < 30]
    if len(g) < 2: continue
    g.sort(key=lambda h: -h["conf"])
    g = sorted(g[:max(4, len(g) // 2)], key=lambda h: -h["peak"])   # cleanest half, loudest first
    n = min(6, len(g)); hard, med = g[:(n + 1) // 2], g[len(g) // 2: len(g) // 2 + n // 2]
    for layer, grp in (("h", hard), ("m", med)):
        for k, h in enumerate(grp):
            name = f"chug_E{fret:+03d}_{layer}{k + 1}.wav"
            w.write(os.path.join(out, name), sr, (h["seg"] * 2 ** 31 * 0.999).astype(np.int32))
            kept.append({**{k2: v for k2, v in h.items() if k2 != "seg"}, "file": name, "layer": layer})
json.dump({"source": os.path.basename(src), "channel": ch, "hits_found": len(hits), "kept": kept},
          open(os.path.join(out, "chugs.json"), "w"), indent=1)
print(f"{len(ons)} onsets, {len(hits)} usable hits, kept {len(kept)}:")
for fr in sorted({k['fret'] for k in kept}):
    ks = [k for k in kept if k["fret"] == fr]
    print(f"  fret {fr:+3d}: {len(ks)} hits, lengths {[k['len'] for k in ks]}, cents {[k['cents'] for k in ks]}")
