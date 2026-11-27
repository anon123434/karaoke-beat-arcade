#!/usr/bin/env python3
"""Spot-check: compare song.json word starts with faster-whisper word times cached at ingest (.local/ingest/<src>.whisper.json). usage: lyric-vs-whisper.py id... | --all"""
import json, re, sys, numpy as np
from pathlib import Path
R = Path(__file__).resolve().parents[1]
def n(s): return re.sub(r"[^a-z']", '', s.lower())
ids = sys.argv[1:] if sys.argv[1:] != ['--all'] else sorted(p.parent.name for p in (R/'songs').glob('*/song.json'))
for sid in ids:
    try:
        S = json.loads((R/'songs'/sid/'song.json').read_text()); src = json.loads((R/'songs'/sid/'ingest-report.json').read_text())['source']
        W = json.loads((R/'.local/ingest'/(src.rsplit('.', 1)[0]+'.whisper.json')).read_text())
    except Exception: continue
    ws = [(w['t'], n(w['w'])) for w in W]; e = []
    for l in S.get('lines', []):
        for w in l['words']:
            c = [t for t, x in ws if x and x == n(w['text']) and abs(t - w['t']) < 25]
            if c: e.append(min(c, key=lambda t: abs(t - w['t'])) - w['t'])
    if len(e) < 15: print(f"{sid:45s} n={len(e)} (too few matches)"); continue
    e = np.array(e); late = e[len(e)//2:]; early = e[:len(e)//2]
    print(f"{sid:45s} n={len(e):4d} median={np.median(e):+5.2f}s p90abs={np.percentile(np.abs(e),90):5.2f}s  firsthalf={np.median(early):+5.2f} secondhalf={np.median(late):+5.2f}")
