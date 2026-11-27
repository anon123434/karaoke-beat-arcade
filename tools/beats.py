#!/usr/bin/env python3
"""Beat map for Beat mode: librosa beat tracking on each song's instrumental -> song.json "beats".
  beats: { bpm, t: [beat times s], s: [onset strength at each beat 0..1], off: [[t, s] strong off-beats (8ths)] }
Run with the ingest venv:  .venv-ingest/bin/python tools/beats.py [--all] [--force] [song-id ...]
Songs that already have beats are skipped unless --force."""
import json, sys
from pathlib import Path
import numpy as np, librosa

ROOT = Path(__file__).resolve().parents[1]

def beatmap(path):
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    hop = 256
    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, aggregate=np.median)
    tempo, frames = librosa.beat.beat_track(onset_envelope=env, sr=sr, hop_length=hop, tightness=120, start_bpm=100, units='frames')
    bpm = float(np.atleast_1d(tempo)[0])
    if len(frames) < 8: return None
    ref = np.percentile(env, 98) or 1.0
    def strength(f):
        a, b = max(0, f - 2), min(len(env), f + 3)
        return float(min(1.0, env[a:b].max() / ref))
    frames = np.asarray(frames, dtype=int)
    # fold tempo octave errors into a comfortable tapping range (70-140 bpm)
    while bpm > 140 and len(frames) > 16:
        a, b = frames[0::2], frames[1::2]
        frames = a if sum(strength(int(f)) for f in a) >= sum(strength(int(f)) for f in b) else b
        bpm /= 2
    while bpm < 70:
        mids = ((frames[:-1] + frames[1:]) // 2).astype(int)
        frames = np.sort(np.concatenate([frames, mids])); bpm *= 2
    times = librosa.frames_to_time(frames, sr=sr, hop_length=hop)
    s = [round(strength(int(f)), 3) for f in frames]
    off = []
    for i in range(len(frames) - 1):
        mid = int((frames[i] + frames[i + 1]) / 2); st = strength(mid)
        if st > 0.45: off.append([round(float(librosa.frames_to_time(mid, sr=sr, hop_length=hop)), 3), round(st, 3)])
    # RMS energy per beat (quiet intros/breaks get fewer prompts)
    rms = librosa.feature.rms(y=y, hop_length=hop)[0]; rref = np.percentile(rms, 95) or 1.0
    e = [round(float(min(1.0, rms[max(0, int(f) - 4):int(f) + 4].mean() / rref)), 3) for f in frames]
    return {'bpm': round(bpm, 2), 't': [round(float(x), 3) for x in times], 's': s, 'e': e, 'off': off}

def main(argv):
    force = '--force' in argv
    ids = [a for a in argv if not a.startswith('--')]
    if '--all' in argv or not ids: ids = [e['id'] for e in json.loads((ROOT / 'songs/index.json').read_text())]
    for sid in ids:
        sj = ROOT / 'songs' / sid / 'song.json'
        if not sj.exists(): continue
        meta = json.loads(sj.read_text())
        if meta.get('beats') and not force: print('skip', sid); continue
        bm = beatmap(ROOT / 'songs' / sid / meta['audio'])
        if not bm: print('no beats', sid); continue
        meta['beats'] = bm
        sj.write_text(json.dumps(meta))
        print('%s: %.1f bpm, %d beats, %d off-beats' % (sid, bm['bpm'], len(bm['t']), len(bm['off'])))

if __name__ == '__main__': main(sys.argv[1:])
