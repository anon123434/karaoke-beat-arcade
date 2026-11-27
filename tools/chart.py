#!/usr/bin/env python3
"""Beat-mode instrument charts from Demucs 4-stem separation of each song's instrumental.
Lanes (DualSense, like a kit):  0 ✕ kick · 1 ○ snare · 2 □ hi-hat/perc · 3 △ crash/ride
                                4 ↑ bass rising · 5 ↓ bass falling · 6 ← bass repeat · 7 → bass jump (>= 5th)
                                8 L1 held synth/pad (dur) · 9 R1 accent (big ensemble hit)
song.json "chart": {v, lanes, ev: [[t, lane, dur, strength, level, midi]]}   level 1 easy / 2 normal / 3 hard
Times lightly quantized to a 16th grid from the beat map (snap only if within 35 ms).
Run: .venv-ingest/bin/python tools/chart.py [--force] [ids...]   (stems are temporary, deleted after each song)"""
import json, os, shutil, subprocess, sys
from pathlib import Path
import numpy as np, librosa
sys.path.insert(0, str(Path(__file__).resolve().parent)); import drums

ROOT = Path(__file__).resolve().parents[1]
TMP = ROOT / '.local/stems4' / str(os.getpid())   # per-process: the ingest's chart step may run concurrently
PY = ROOT / '.venv-ingest/bin/python'
SR, HOP = 22050, 256

def stems(sid):
    src = ROOT / 'songs' / sid / 'instrumental.mp3'
    if not src.exists():
        meta = json.loads((ROOT / 'songs' / sid / 'song.json').read_text()); src = ROOT / 'songs' / sid / meta['audio']
    out = TMP / 'htdemucs' / src.stem
    if out.exists(): shutil.rmtree(out)
    subprocess.run([str(PY), '-m', 'demucs', '-n', 'htdemucs', '-d', 'cpu', '-o', str(TMP), str(src)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out

def norm(env):
    r = np.percentile(env, 98); return env / (r if r > 0 else 1.0)

def band_env(S, freqs, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    return norm(librosa.onset.onset_strength(S=librosa.power_to_db(S[m] + 1e-10), sr=SR, hop_length=HOP, aggregate=np.mean))

def peaks(env, delta=0.12, wait=4):
    return librosa.util.peak_pick(env, pre_max=3, post_max=3, pre_avg=8, post_avg=8, delta=delta, wait=wait)

def t_of(f): return float(librosa.frames_to_time(f, sr=SR, hop_length=HOP))

def grid16(beats, dur):
    g = []
    for a, b in zip(beats[:-1], beats[1:]):
        for k in range(4): g.append(a + (b - a) * k / 4)
    if beats: g.append(beats[-1])
    return np.array(g)

def snap(t, G, tol=0.015):
    if not len(G): return t, 3
    i = int(np.searchsorted(G, t)); best = None
    for j in (i - 1, i):
        if 0 <= j < len(G) and (best is None or abs(G[j] - t) < abs(G[best] - t)): best = j
    d = abs(G[best] - t)
    return (float(G[best]) if d <= tol else t), (best % 4 if d <= 0.06 else 3)   # 0 = on beat, 2 = 8th, 1/3 = 16th

def load_stems(sid, d, meta):
    """Stems on the instrumental's (= the TV's) timeline: Demucs keeps the mp3 encoder-delay padding (~25 ms), the browser trims it."""
    st = {k: librosa.load(str(d / (k + '.wav')), sr=SR, mono=True)[0] for k in ('drums', 'bass', 'other')}
    src = ROOT / 'songs' / sid / 'instrumental.mp3'
    if not src.exists(): src = ROOT / 'songs' / sid / meta['audio']
    yinst, _ = librosa.load(str(src), sr=SR, mono=True)
    n = min(len(v) for v in st.values()); lag = drums.stem_lag(sum(v[:n] for v in st.values()), yinst)
    if abs(lag) > 0.12: lag = 0.0
    sh = int(round(lag * SR))
    if sh > 0: st = {k: v[sh:] for k, v in st.items()}
    elif sh < 0: st = {k: np.concatenate([np.zeros(-sh, dtype=v.dtype), v]) for k, v in st.items()}
    return st, lag

def rephase(beats, kicks):
    """Shift the beat grid onto the kick drum when the kicks agree on a phase (librosa often locks to the off-beat)."""
    b = np.array(beats)
    if len(b) < 16 or len(kicks) < 32: return beats, 0.0
    ph = []
    for t in kicks:
        j = int(np.searchsorted(b, t)) - 1
        if 0 <= j < len(b) - 1: ph.append((t - b[j]) / (b[j + 1] - b[j]))
    z = np.mean(np.exp(2j * np.pi * np.array(ph))); R = abs(z); off = (np.angle(z) / (2 * np.pi) + 0.5) % 1 - 0.5
    if R < 0.25 or abs(off) < 0.06: return beats, 0.0
    step = np.diff(b, append=b[-1] + (b[-1] - b[-2])); nb = b + off * step
    k = np.array(kicks); on = lambda g: np.mean([np.min(np.abs(g - t)) < 0.03 for t in k])
    if on(nb) < on(b) + 0.15: return beats, 0.0          # only when the kicks clearly agree with the shifted grid
    return [round(float(x), 3) for x in nb], float(off)

def analyse(sid, d):
    meta = json.loads((ROOT / 'songs' / sid / 'song.json').read_text())
    STEMS, lag = load_stems(sid, d, meta)
    ev = []
    # ---- drums v2 (tools/drums.py): band-split transcription, times = audible attack, NOT snapped to a grid ----
    y = STEMS['drums']
    rms_d = librosa.feature.rms(y=y, hop_length=HOP)[0]
    yi = STEMS['other']
    D = drums.transcribe(y)
    beats = (meta.get('beats') or {}).get('t') or []
    strong = [t for t, v in D['kick'] if v >= 0.35]
    beats, phase_fix = rephase(beats, strong)
    G = grid16(beats, meta.get('duration', 0))
    dur = len(y) / SR
    share = float(np.sqrt(np.mean(y ** 2)) / (np.sqrt(np.mean(yi ** 2)) + 1e-9))
    has_drums = (len(D['kick']) + len(D['snare'])) / max(dur, 1) > 0.5 and share > 0.12
    if has_drums:
        for t, v in D['kick']: ev.append([round(t, 3), 0, 0, round(v, 2), 1 if v >= 0.35 else 2 if v >= 0.2 else 3, 0])
        for t, v in D['snare']: ev.append([round(t, 3), 1, 0, round(v, 2), 1 if v >= 0.35 else 2 if v >= 0.2 else 3, 0])
        for t, v in D['hat']: ev.append([round(t, 3), 2, 0, round(v, 2), 2 if v >= 0.5 else 3, 0])
        for t, v in D['crash']: ev.append([round(t, 3), 3, 0, round(v, 2), 1 if v >= 0.6 else 2, 0])
    kick = np.zeros(len(rms_d)); tot = norm(rms_d)   # (tot feeds the R1 accent detector below)
    # ---- bass: onsets + pitch direction -> D-pad ----
    yb = STEMS['bass']
    rb = librosa.feature.rms(y=yb, hop_length=HOP)[0]; bq = np.percentile(rb, 99) * 0.08
    benv = norm(librosa.onset.onset_strength(y=yb, sr=SR, hop_length=HOP))
    y11 = librosa.resample(yb, orig_sr=SR, target_sr=11025)
    f0 = librosa.yin(y11, fmin=35, fmax=330, sr=11025, frame_length=2048, hop_length=128)
    r11 = librosa.feature.rms(y=y11, frame_length=2048, hop_length=128)[0][:len(f0)]
    f0 = np.where(r11 > np.percentile(r11, 99) * 0.15, f0, np.nan)
    ft = librosa.times_like(f0, sr=11025, hop_length=128)
    prev = None
    for f in librosa.util.peak_pick(benv, pre_max=3, post_max=3, pre_avg=10, post_avg=10, delta=0.3, wait=8):
        if rb[f] < bq: continue
        t0 = t_of(f); m = (ft >= t0 + 0.03) & (ft <= t0 + 0.2)
        hz = f0[m]; hz = hz[~np.isnan(hz)]
        if not len(hz): continue
        midi = float(np.median(librosa.hz_to_midi(hz)))
        if prev is None: lane = 6
        else:
            dm = midi - prev
            lane = 6 if abs(dm) < 0.6 else 7 if abs(dm) >= 6.5 else 4 if dm > 0 else 5
        prev = midi
        t, pos = snap(t0, G); st = float(benv[f])
        ev.append([t, lane, 0, round(st, 2), 2 if (pos in (0, 2) and st > 0.45) else 3, round(midi)])
    # ---- other (synths/keys/guitar): sustained notes -> L1 holds ----
    yo = STEMS['other']
    ro = librosa.feature.rms(y=yo, hop_length=HOP)[0]; oref = np.percentile(ro, 98) or 1
    oenv = norm(librosa.onset.onset_strength(y=yo, sr=SR, hop_length=HOP))
    last_end = -1
    for f in peaks(oenv, 0.2, 10):
        t0 = t_of(f)
        if t0 < last_end or ro[f] < oref * 0.25: continue
        pk = ro[f:f + 8].max(); n = f
        while n < len(ro) and ro[n] > pk * 0.55 and (n == f or oenv[n] < 0.5 or n - f < 6): n += 1
        dur = t_of(n) - t0
        if dur >= 0.8:
            t, pos = snap(t0, G); dur = min(dur, 3.0)
            ev.append([t, 8, round(dur, 2), round(float(oenv[f]), 2), 2 if dur >= 1.4 and pos == 0 else 3, 0]); last_end = t0 + dur + 0.4
    # ---- R1 accents: drums + bass + other all hit hard together ----
    n = min(len(tot), len(benv), len(oenv)); comb = tot[:n] * 0.5 + benv[:n] * 0.25 + oenv[:n] * 0.25
    thr = np.percentile(comb, 99.3); last = -9
    for f in peaks(comb, 0.2, 20):
        if comb[f] < thr or t_of(f) - last < 3.5: continue
        t, pos = snap(t_of(f), G); last = t
        ev.append([t, 9, 0, round(float(min(1, comb[f])), 2), 2, 0])
    ev.sort(key=lambda e: (e[0], e[1]))
    return {'v': 3, 'lag_ms': round(lag * 1000, 1), 'grid_fix_beats': round(phase_fix, 3), 'beats_t': beats if phase_fix else None, 'src': 'demucs-4stem-cpu+drums-v2', 'drums': has_drums, 'ev': ev}

def main(argv):
    force = '--force' in argv
    ids = [a for a in argv if not a.startswith('--')] or [e['id'] for e in json.loads((ROOT / 'songs/index.json').read_text())]
    for sid in ids:
        sj = ROOT / 'songs' / sid / 'song.json'
        meta = json.loads(sj.read_text())
        if meta.get('chart') and meta['chart'].get('v', 1) >= 3 and not force: print('skip', sid, flush=True); continue
        try:
            d = stems(sid); ch = analyse(sid, d)
        except Exception as e:
            print('FAIL', sid, e, flush=True); continue
        finally:
            shutil.rmtree(TMP / 'htdemucs', ignore_errors=True)
        meta = json.loads(sj.read_text()); bt = ch.pop('beats_t', None)
        if bt and meta.get('beats'): meta['beats'].setdefault('t0', meta['beats']['t']); meta['beats']['t'] = bt   # grid re-phased onto the kick
        meta['chart'] = ch; tmp = sj.with_suffix('.json.tmp'); tmp.write_text(json.dumps(meta)); tmp.replace(sj)   # atomic: the TV may be fetching it
        c = {}
        for e in ch['ev']: c[e[1]] = c.get(e[1], 0) + 1
        dur = meta.get('duration', 1) / 60
        print('%s: %d events  per-lane %s  lvl1 %.0f/min lvl<=2 %.0f/min all %.0f/min' % (sid, len(ch['ev']), dict(sorted(c.items())),
              sum(1 for e in ch['ev'] if e[4] <= 1) / dur, sum(1 for e in ch['ev'] if e[4] <= 2) / dur, len(ch['ev']) / dur), flush=True)

if __name__ == '__main__': main(sys.argv[1:])
