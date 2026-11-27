#!/usr/bin/env python3
"""Measure chart kick/snare times against the audible attacks in the audio the TV actually plays (instrumental.mp3 as the
browser decodes it, via librosa/ffmpeg). Independent of the chart's own onset code: time-domain band-passed envelope,
attack = first 1 ms-resolution point where the envelope reaches 35% of its local peak after the preceding trough.
delta = audio attack - chart time  (negative: chart EARLIER than the sound -> note reaches the line early).
Usage: .venv-ingest/bin/python tools/measure-timing.py id [id...]   -> JSON lines"""
import json, sys
from pathlib import Path
import numpy as np, librosa
from scipy.signal import butter, sosfiltfilt
ROOT = Path(__file__).resolve().parents[1]; SR = 44100

def attack_times(yb, ts, pre=0.07, post=0.07, frac=0.35, sm=0.002):
    k = max(2, int(sm * SR)); env = np.convolve(np.abs(yb), np.ones(k) / k, mode='same'); out = []
    for t in ts:
        a, b = int(max(0, (t - pre) * SR)), int(min(len(env), (t + post) * SR))
        if b - a < 100: out.append(None); continue
        w = env[a:b]; pk = int(np.argmax(w))
        if w[pk] < np.percentile(env, 90) * 0.5: out.append(None); continue
        tr = int(np.argmin(w[:pk + 1])); seg = w[tr:pk + 1]; lvl = w[tr] + frac * (w[pk] - w[tr])
        j = int(np.argmax(seg >= lvl)); out.append((a + tr + j) / SR)
    return out

def measure(sid):
    meta = json.loads((ROOT / 'songs' / sid / 'song.json').read_text())
    y, _ = librosa.load(str(ROOT / 'songs' / sid / 'instrumental.mp3'), sr=SR, mono=True)
    res = {'id': sid, 'bpm': (meta.get('beats') or {}).get('bpm'), 'lag_ms': meta['chart'].get('lag_ms')}
    for name, lane, band in (('kick', 0, (60, 200)), ('snare', 1, (1500, 6000))):
        ts = [e[0] for e in meta['chart']['ev'] if e[1] == lane and e[3] >= 0.5]
        yb = sosfiltfilt(butter(4, band, 'bandpass', fs=SR, output='sos'), y)
        at = attack_times(yb, ts); d = np.array([(a - t) * 1000 for a, t in zip(at, ts) if a is not None])
        d = d[np.abs(d) < 60]
        if len(d) < 8: res[name] = None; continue
        res[name] = {'n': int(len(d)), 'median_ms': round(float(np.median(d)), 1), 'mad_ms': round(float(np.median(np.abs(d - np.median(d)))), 1), 'p10': round(float(np.percentile(d, 10)), 1), 'p90': round(float(np.percentile(d, 90)), 1)}
    return res

if __name__ == '__main__':
    for sid in sys.argv[1:]:
        try: print(json.dumps(measure(sid)), flush=True)
        except Exception as e: print(json.dumps({'id': sid, 'err': str(e)}), flush=True)
