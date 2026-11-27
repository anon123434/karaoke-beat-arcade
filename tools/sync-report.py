#!/usr/bin/env python3
"""Independent lyric-sync check: for each ingested song compare raw LRCLIB line starts and the aligned line starts
against vocal onsets in the vocal stem (a line start 'hits' if vocal activity begins within +-0.5 s)."""
import json, re, sys, urllib.request
from pathlib import Path
import numpy as np, librosa
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from ingest import parse_lrc, UA

def onsets(path):
    y, sr = librosa.load(str(path), sr=11025, mono=True)
    hop = sr // 50
    db = 20 * np.log10(librosa.feature.rms(y=y, frame_length=hop * 4, hop_length=hop)[0] + 1e-6)
    act = db > np.percentile(db, 50)
    # rising edges after >= 0.25 s of silence
    on, quiet = [], 0
    for i, a in enumerate(act):
        if a and quiet >= 12: on.append(i / 50)
        quiet = 0 if a else quiet + 1
    return np.array(on), act

def hit_rate(starts, on, act):
    hits = 0
    for t in starts:
        i = int(t * 50)
        near = on[np.abs(on - t) <= 0.5] if len(on) else []
        if len(near) or (0 <= i < len(act) and act[i] and not act[max(0, i - 25):i].all()):
            hits += 1
    return hits / max(1, len(starts))

rows = []
for d in sorted((ROOT / 'songs').glob('user-*')):
    s = json.loads((d / 'song.json').read_text()); r = s['ingest']
    stem = ROOT / '.local/ingest/stems' / r['source'].rsplit('.', 1)[0] / 'vocals.flac'
    raw = None
    if r.get('lrclib_id'):
        req = urllib.request.Request('https://lrclib.net/api/get/%d' % r['lrclib_id'], headers={'User-Agent': UA})
        raw = [l['t'] for l in parse_lrc(json.loads(urllib.request.urlopen(req, timeout=20).read())['syncedLyrics'] or '') if l['text']]
    new = [l['t'] for l in s['lines']]
    on, act = onsets(stem)
    ls = r.get('lyric_sync', {})
    shifts = np.array(new[:len(raw)]) - np.array(raw[:len(new)]) if raw else np.array([0.0])
    rows.append((s['title'], ls.get('global_offset_s'), round(float(np.median(np.abs(shifts))), 2), round(float(np.percentile(np.abs(shifts), 90)), 2),
                 round(hit_rate(raw, on, act), 2) if raw else None, round(hit_rate(new, on, act), 2), ls.get('confidence')))
print('%-34s %7s %9s %8s %8s %8s %s' % ('song', 'offset', '|shift|md', 'p90', 'raw-hit', 'new-hit', 'conf'))
for row in rows:
    print('%-34s %7s %9s %8s %8s %8s %s' % row)
