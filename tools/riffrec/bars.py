#!/usr/bin/python3
"""Map a riffs take onto its bar grid: where the beat starts, the guitar's
latency against it, Bitwig's extra latency, and how loud each bar is.

  /usr/bin/python3 bars.py <riffs_take.wav>
Writes <take>.bars.json next to the take.
"""
import json, sys, numpy as np, scipy.io.wavfile as w

src = sys.argv[1]
meta = json.load(open(src[:-4] + ".json"))
sr, x = w.read(src); x = x.astype(float) / 2 ** 31
dry, beat = x[:, 0], x[:, 1]
wet = x[:, 2:4].mean(1) if x.shape[1] >= 4 else None
bar = 240 / meta["bpm"]; s16 = bar / 16
t0 = int(np.argmax(np.abs(beat) > 0.05)) / sr               # first count-in stick
grid0 = t0 + meta["count_in_bars"] * bar                       # bar 1 of the riffs

def onsets(sig):
    hop = int(0.002 * sr); n = len(sig) // hop
    e = np.sqrt(np.mean(sig[:n * hop].reshape(n, hop) ** 2, 1)); db = 20 * np.log10(e + 1e-9)
    rise = db[4:] - db[:-4]
    on = [i + 4 for i in range(len(rise)) if rise[i] > 10 and db[i + 4] > -40]
    out = []
    for i in on:
        if not out or i - out[-1] > 25: out.append(i)
    return np.array(out) * hop / sr

# Guitar latency: onsets land late by the round trip; take the most common lag modulo a 16th
on = onsets(dry); on = on[on > grid0]
ph = ((on - grid0) % s16)
ph[ph > s16 * 0.75] -= s16                                    # a hair early counts as early
hist, edges = np.histogram(ph, bins=60, range=(-s16 / 4, s16 * 0.75))
lat = float(edges[np.argmax(hist)] + (edges[1] - edges[0]) / 2) if len(on) > 10 else 0.0
# Bitwig's extra delay: cross-correlate dry and wet envelopes
wlag = 0.0
if wet is not None:
    hop = 48; n = min(len(dry), len(wet)) // hop
    ed = np.sqrt(np.mean(dry[:n * hop].reshape(n, hop) ** 2, 1)); ew = np.sqrt(np.mean(wet[:n * hop].reshape(n, hop) ** 2, 1))
    ed -= ed.mean(); ew -= ew.mean()
    lags = range(0, int(0.1 * sr / hop))
    c = [np.dot(ed[:n - L], ew[L:]) for L in lags]
    wlag = int(np.argmax(c)) * hop / sr
nb = int((len(dry) / sr - grid0) / bar)
sig = wet if wet is not None else dry
rms = []
for b in range(nb):
    a = int((grid0 + lat + wlag + b * bar) * sr); seg = sig[a:a + int(bar * sr)]
    rms.append(round(float(20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9)), 1))
res = {"t0": t0, "grid0": grid0, "bar": bar, "guitar_latency": lat, "wet_extra_latency": wlag, "bar_rms": rms,
       "onsets_counted": int(len(on))}
json.dump(res, open(src[:-4] + ".bars.json", "w"), indent=1)
print(f"beat starts {t0:.3f}s, bar 1 at {grid0:.3f}s, guitar latency {lat * 1000:.1f} ms, Bitwig +{wlag * 1000:.1f} ms")
for b in range(0, nb, 8):
    print(f"bars {b + 1:3d}-{min(nb, b + 8):3d}: " + " ".join(f"{v:6.1f}" for v in rms[b:b + 8]))
