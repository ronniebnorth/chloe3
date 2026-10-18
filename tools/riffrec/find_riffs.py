#!/usr/bin/python3
"""Find repeating riffs in a take without trusting the beat grid: in 8 s windows,
the best self-match lag (0.5-5 s) of a notes-and-loudness feature (pitch-class
energy + level, 20 ms frames) is the riff's loop length;
windows that repeat strongly become candidate riffs, cut as 2 loops starting
on a strong attack. Writes riff_NN.wav + riffs.json + preview.wav to <out_dir>.

  /usr/bin/python3 find_riffs.py <take.wav> <channel> <out_dir>
"""
import json, os, sys, numpy as np, scipy.io.wavfile as w
from scipy.signal import stft

src, ch, out = sys.argv[1], int(sys.argv[2]), sys.argv[3]
sr, x = w.read(src); g = x[:, ch].astype(float) / 2 ** 31
hop = 48                                                   # 1 ms frames
n = len(g) // hop
e = np.sqrt(np.mean(g[:n * hop].reshape(n, hop) ** 2, 1))
ons = np.maximum(0, np.diff(np.log(e + 1e-5)))
ons = np.convolve(ons, np.hanning(9) / np.hanning(9).sum(), "same")
loud = 20 * np.log10(e + 1e-9)

# Feature: which notes (pitch-class energy 70 Hz-1 kHz) and how loud, per 20 ms
fq, tt, Z = stft(g, sr, nperseg=4096, noverlap=4096 - 960)
M = np.abs(Z); midi = 69 + 12 * np.log2(np.maximum(fq, 1) / 440)
band = (fq > 70) & (fq < 1000)
C = np.array([M[band & (np.round(midi) % 12 == pc)].sum(0) for pc in range(12)]); C /= C.sum(0) + 1e-9
Lv = np.log(M[(fq > 70) & (fq < 5000)].sum(0) + 1e-6); Lv = (Lv - Lv.mean()) / Lv.std()
F = np.vstack([C * 3, Lv[None, :] * 0.5]); F = np.array([np.convolve(r, np.ones(3) / 3, "same") for r in F])
FR = 20                                                     # ms per feature frame
def sim(a, b, n):
    A = F[:, a:a + n].ravel(); B = F[:, b:b + n].ravel(); A = A - A.mean(); B = B - B.mean()
    return float(np.dot(A, B) / (np.linalg.norm(A) * np.linalg.norm(B) + 1e-9))
W, STEP, LMIN, LMAX = 8000, 2000, 500, 5000                 # ms
cands = []
for a in range(0, len(ons) - W - LMAX, STEP):
    if np.median(loud[a:a + W + LMAX]) < -45: continue      # not playing
    fa, fw = a // FR, W // FR
    scores = {L: sim(fa, fa + L // FR, fw) for L in range(LMIN, LMAX, FR)}
    bl = max(scores, key=scores.get); best = scores[bl]
    # prefer the shortest lag that is nearly as good (a 1-bar riff also repeats at 2 bars)
    for L in sorted(scores):
        if scores[L] > 0.93 * best and any(abs(bl - k * L) < 3 * FR for k in (2, 3, 4)): bl, best = L, scores[L]; break
    cands.append({"a": a, "L": bl, "r": best})

# Merge neighbouring windows with the same loop length into one riff; keep the best window
riffs = []
for c in cands:
    if riffs and c["a"] - riffs[-1]["end"] <= STEP and abs(c["L"] - riffs[-1]["L"]) < 0.06 * c["L"]:
        R = riffs[-1]; R["end"] = c["a"]
        if c["r"] > R["r"]: R.update(best_a=c["a"], r=c["r"], L=c["L"])
    else:
        riffs.append({"start": c["a"], "end": c["a"], "best_a": c["a"], "L": c["L"], "r": c["r"]})
riffs = [R for R in riffs if R["r"] > 0.55]

os.makedirs(out, exist_ok=True)
prev, meta = [], []
for i, R in enumerate(riffs):
    a = R["best_a"]
    s = a + int(np.argmax(ons[a:a + R["L"]]))              # start on the loop's strongest attack
    loops = max(2, int(np.ceil(2500 / R["L"])))             # at least 2.5 s of it
    i0, i1 = s * hop - int(0.005 * sr), (s + loops * R["L"]) * hop - int(0.005 * sr)
    clip = g[i0:i1].copy()
    f = int(0.01 * sr); clip[-f:] *= np.linspace(1, 0, f); clip[:48] *= np.linspace(0, 1, 48)
    name = f"riff_{i + 1:02d}.wav"
    w.write(os.path.join(out, name), sr, (clip * 2 ** 31 * 0.999).astype(np.int32))
    bpm16 = 60000 / (R["L"] / 4) / 4                       # if the loop is one 4/4 bar
    meta.append({"file": name, "at_s": round(i0 / sr, 2), "loop_s": R["L"] / 1000, "repeat_score": round(R["r"], 2),
                 "span_s": [round(R["start"] / 1000, 1), round((R["end"] + W) / 1000, 1)],
                 "bpm_if_1_bar": round(240000 / R["L"], 1), "bpm_if_2_bars": round(480000 / R["L"], 1)})
    prev += [clip, np.zeros(int(0.8 * sr))]
json.dump(meta, open(os.path.join(out, "riffs.json"), "w"), indent=1)
if prev:
    p = np.concatenate(prev); p *= 0.5 / np.abs(p).max()
    w.write(os.path.join(out, "preview.wav"), sr, (p * 32767).astype(np.int16))
    print(f"preview {len(p) / sr:.1f} s")
for m in meta:
    print(f"{m['file']}: from {m['at_s']:6.1f}s  loop {m['loop_s']:.2f}s (={m['bpm_if_1_bar']} BPM as 1 bar / {m['bpm_if_2_bars']} as 2)  "
          f"repeats {m['repeat_score']}  played {m['span_s'][0]}-{m['span_s'][1]}s")
