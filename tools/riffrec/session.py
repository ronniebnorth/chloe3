#!/usr/bin/python3
"""Guitar sample session for Chloe: plays a click into the phones and records
UM2 input 2 (guitar -> Body -> UM2) together with the click, sample-aligned,
so the takes can be sliced on the bar grid afterwards.

  /usr/bin/python3 session.py level            10 s level check (play hard)
  /usr/bin/python3 session.py <section> [bpm]   record one section

Sections (hits: one hit on each downbeat, 4 bars per step, a cue bar between):
  e-chugs    palm-muted single-note chugs, low E string, frets 0-12
  a-chugs    palm-muted single-note chugs, A string, frets 0-7
  pm-chords  palm-muted power chords, root on low E, frets 0-7
  chords     power chords let ring, root on low E, frets 0-12
  riffs      free: your own riffs over the click (default 4 minutes)

Setup (Bitwig): guitar (or guitar -> Body) -> UM2 input 2, UM2 Direct
Monitor OFF, Bitwig open and monitoring input 2 through NAM + cab, Chloe stopped.
Setup (no Bitwig): Body on the power bank -> UM2 input 2, Direct Monitor ON.
Raw takes land in ../../samples/guitar/raw/ as <section>_<time>.wav
(ch 1 dry guitar, ch 2 click, ch 3-4 Bitwig's output if it was open) with a
.json of where each step starts.
"""
import json, os, signal, socket, subprocess, sys, time
import numpy as np, scipy.io.wavfile as w

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "../../samples/guitar/raw"))
SECTIONS = {
    "e-chugs":   [("palm-muted chug, LOW E string", f) for f in range(13)],
    "a-chugs":   [("palm-muted chug, A string", f) for f in range(8)],
    "pm-chords": [("palm-muted POWER CHORD, root on low E", f) for f in range(8)],
    "test":      [("test", 0)],
    "chords":    [("POWER CHORD, let it RING, root on low E", f) for f in range(13)],
}
HIT_BARS = 4

def blip(freq, dur=0.04, amp=0.5):
    t = np.arange(int(SR * dur)) / SR
    return amp * np.sin(2 * np.pi * freq * t) * np.exp(-t / (dur / 4))

def click_track(bars, bpm, cue_bars=()):
    """bars of 4/4: beat 1 high, others low; a cue bar gets a rising two-tone bell instead."""
    beat = 60 / bpm
    y = np.zeros(int(SR * (bars * 4 * beat + 2)))
    def put(x, at):
        i = int(at * SR); y[i:i + len(x)] += x[:len(y) - i]
    for b in range(bars):
        for k in range(4):
            at = (b * 4 + k) * beat
            if b in cue_bars:
                if k == 0: put(blip(880, 0.25, 0.35), at)
                if k == 2: put(blip(1320, 0.25, 0.35), at)
            else:
                put(blip(1600 if k == 0 else 1000, 0.04, 0.6 if k == 0 else 0.35), at)
    return y

def big(msg):
    print("\n" + "=" * 60 + f"\n  {msg}\n" + "=" * 60, flush=True)

def mpv_cmd(sock, *args):
    s = socket.socket(socket.AF_UNIX); s.connect(sock)
    s.send((json.dumps({"command": list(args)}) + "\n").encode()); s.close()

def wet_ports():
    """Whatever (other than mpv and PulseAudio) feeds system:playback_1/2: Bitwig's master, while it's open."""
    out, cur = {}, None
    for line in subprocess.run(["jack_lsp", "-c"], capture_output=True, text=True).stdout.splitlines():
        if not line.startswith(" "): cur = line.strip(); continue
        src = line.strip()
        if cur in ("system:playback_1", "system:playback_2") and not src.startswith(("mpv", "PulseAudio")):
            out.setdefault(cur, src)
    return [out[k] for k in ("system:playback_1", "system:playback_2") if k in out]

def record(click, name, plan, bpm):
    """Play `click` paused-start in mpv, capture guitar + mpv's output (+ Bitwig's, if open), unpause; returns wav path."""
    os.makedirs(OUT, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    clk = os.path.join(OUT, f".click_{stamp}.wav")
    w.write(clk, SR, (click * 32767).astype(np.int16))
    wav = os.path.join(OUT, f"{name}_{stamp}.wav")
    sock = f"/tmp/riffrec-{os.getpid()}.sock"
    mpv = subprocess.Popen(["mpv", "--no-video", "--really-quiet", "--ao=jack", "--pause",
                            *(["--volume=0"] if os.environ.get("RIFFREC_MUTE") else []),
                            f"--input-ipc-server={sock}", clk])
    for _ in range(50):
        if os.path.exists(sock) and b"mpv:out_0" in subprocess.run(["jack_lsp"], capture_output=True).stdout: break
        time.sleep(0.1)
    dur = len(click) / SR + 1
    wet = wet_ports()
    print(f"  recording: dry guitar, click{', and what you hear from ' + ' + '.join(wet) if wet else ' (no Bitwig output found: dry only)'}", flush=True)
    ports = ["system:capture_2", "mpv:out_0", *wet]
    rec = subprocess.Popen(["jack_capture", "-b", "24", "-c", str(len(ports)), "-d", str(int(dur)),
                            *[a for p in ports for a in ("-p", p)], wav],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    mpv_cmd(sock, "set_property", "pause", False)
    t0 = time.time()
    beat = 60 / bpm
    for at, msg in plan:
        while time.time() - t0 < at: time.sleep(0.02)
        print("  " + msg, flush=True) if msg.startswith("bar ") else big(msg)
    rec.wait(); mpv.wait()
    os.remove(clk)
    return wav

def peak_db(x): return 20 * np.log10(max(1e-9, np.max(np.abs(x))))

def main():
    if len(sys.argv) < 2 or sys.argv[1] not in [*SECTIONS, "riffs", "level"]:
        print(__doc__); sys.exit(1)
    sec = sys.argv[1]
    bpm = float(sys.argv[2]) if len(sys.argv) > 2 and sec != "level" else 116.0
    beat, bar = 60 / bpm, 240 / bpm
    if sec == "level":
        click = click_track(int(10 / bar) + 1, bpm)
        wav = record(click, "level", [(0, "PLAY HARD CHUGS NOW (10 s)")], bpm)
        sr, x = w.read(wav); g = x[:, 0].astype(float) / 2 ** 31
        print(f"\nGuitar peak {peak_db(g):.1f} dBFS (aim for -12 to -6; over -3 turn the UM2 gain down)")
        os.remove(wav); return
    plan, meta = [], {"section": sec, "bpm": bpm, "count_in_bars": 2, "steps": []}
    if sec == "riffs":
        mins = 4
        bars = 2 + int(mins * 60 / bar)
        click = click_track(bars, bpm)
        plan.append((0, f"RIFFS at {bpm:g} BPM. Count-in: 2 bars"))
        plan.append((2 * bar, "GO: start each riff on a downbeat (high click), play it 2-4 times, then mute for a bar or more"))
        for b in range(2, bars, 8):
            plan.append((b * bar, f"bar {b - 1} / {bars - 2}"))
    else:
        steps = SECTIONS[sec]
        cue = [2 + i * (HIT_BARS + 1) for i in range(len(steps))]
        bars = 2 + len(steps) * (HIT_BARS + 1)
        click = click_track(bars, bpm, cue_bars=set(cue))
        plan.append((0, f"{sec.upper()}: one hit on each high click, 4 per step. Hits 1-2 HARD, 3-4 MEDIUM. Mute between hits for chugs."))
        for i, (what, fret) in enumerate(steps):
            cue_at = (2 + i * (HIT_BARS + 1)) * bar
            plan.append((max(0.01, cue_at - bar), f"NEXT: {what}, FRET {fret}"))
            plan.append((cue_at + bar - 0.01, f"GO  fret {fret}"))
            meta["steps"].append({"what": what, "fret": fret, "start_s": cue_at + bar, "bars": HIT_BARS})
    big(f"Recording '{sec}' at {bpm:g} BPM, {len(click) / SR / 60:.1f} min. Ctrl-C aborts.")
    wav = record(click, sec, plan, bpm)
    json.dump(meta, open(wav[:-4] + ".json", "w"), indent=1)
    sr, x = w.read(wav); g = x[:, 0].astype(float) / 2 ** 31
    big(f"Saved {os.path.basename(wav)}  (guitar peak {peak_db(g):.1f} dBFS)")

if __name__ == "__main__":
    main()
