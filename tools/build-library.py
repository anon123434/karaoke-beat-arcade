"""v13.9 song-select library: categories (data/library-meta.txt), Beat difficulty bars + vocal stars, and a 18 s hook PREVIEW per song.
Hook = the 18 s window (20-80% of the song) with the most vocal + mix energy, nudged to start on a lyric line; fallback 35% in.
Writes songs/<id>/preview.mp3 (96 kb/s, 0.8 s fade in, 1.5 s fade out) and songs/library.json. Re-run any time (skips existing previews unless --force)."""
import json, subprocess, sys, math
from pathlib import Path
import numpy as np
ROOT = Path(__file__).resolve().parents[1]; SONGS = ROOT / 'songs'; FORCE = '--force' in sys.argv
PLEN = 18.0
CAT_NAMES = [('all', 'All Songs'), ('fav', 'Favorites'), ('90s-rnb', "90s R&B"), ('rnb', 'R&B'), ('hiphop', 'Hip-Hop'), ('throwbacks', 'Throwbacks'), ('rock', 'Rock'),
             ('pop', 'Pop'), ('soul', 'Soul'), ('country', 'Country'), ('ballads', 'Ballads'), ('reggae-latin', 'Reggae & Latin'), ('dance', 'Dance'), ('christmas', 'Christmas'), ('classics', 'Sing-Along')]
meta = {}; extra = {}
for l in (ROOT / 'data/library-meta.txt').read_text().splitlines():
    if not l.strip() or l.startswith('#'): continue
    f = [x.strip() for x in l.split('|')]; i, g, y, b = f[:4]; meta[i] = (g, int(y), b == '1'); extra[i] = [x for x in (f[4].split(',') if len(f) > 4 else []) if x]   # optional 5th column: extra category ids (e.g. pop)
def cats(g, y, ballad):
    c = []
    if g == 'rnb': c.append('90s-rnb' if 1990 <= y < 2000 else 'rnb')
    if g == 'rnb' and 1990 <= y < 2000: c.append('rnb')
    if g == 'hiphop': c.append('hiphop')
    if y < 1990 and g not in ('kids', 'gospel'): c.append('throwbacks')
    if g == 'rock': c.append('rock')
    if g == 'pop': c.append('pop')
    if g == 'soul': c.append('soul')
    if g == 'country': c.append('country')
    if ballad and g not in ('kids', 'gospel'): c.append('ballads')
    if g in ('reggae', 'latin'): c.append('reggae-latin')
    if g == 'dance': c.append('dance')
    if g == 'xmas': c.append('christmas')
    if g in ('kids', 'gospel'): c.append('classics')
    return c
def pcm(path, sr=4000):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-ac', '1', '-ar', str(sr), '-f', 's16le', '-'], capture_output=True)
    return np.frombuffer(r.stdout, dtype=np.int16).astype(np.float32) / 32768.0
def rms1(x, sr=4000):
    n = len(x) // sr; return np.sqrt(np.mean(x[:n * sr].reshape(n, sr) ** 2, axis=1) + 1e-12) if n else np.zeros(0)
def hook(d, s, sid):
    dur = float(s.get('duration') or 0)
    if dur < PLEN + 4: return 0.0, 'short'
    audio = d / s['audio']; voc = d / 'vocals.mp3' if (d / 'vocals.mp3').exists() else (d / s['guide'] if s.get('guide') and (d / s['guide']).exists() else None)
    try:
        m = rms1(pcm(audio)); v = rms1(pcm(voc)) if voc else np.zeros_like(m)
        n = min(len(m), len(v)) if voc else len(m); m = m[:n]; v = v[:n] if voc else np.zeros(n)
        score = m / (m.max() + 1e-9) + 1.4 * (v / (v.max() + 1e-9)); L = int(PLEN); best, bt = -1, None
        for t in range(int(dur * 0.2), int(min(dur * 0.8, n - L))):
            sc = score[t:t + L].mean() - 0.35 * (t / dur)   # prefer the first big chorus over the last one
            if sc > best: best, bt = sc, t
        if bt is None: raise ValueError('no window')
        starts = [l.get('t') for l in (s.get('lines') or []) if isinstance(l, dict) and l.get('t') is not None]
        near = [t for t in starts if bt - 4 <= t <= bt + 3]
        t0 = (min(near, key=lambda t: abs(t - bt)) - 0.4) if near else bt
        return max(0.0, min(dur - PLEN, t0)), 'energy'
    except Exception as e:
        return dur * 0.35, 'fallback'
def cut(d, s, t0, out):
    voc = d / 'vocals.mp3'; ins = d / s['audio']; fo = PLEN - 1.5
    if voc.exists():
        args = ['-ss', '%.2f' % t0, '-t', '%.2f' % PLEN, '-i', str(ins), '-ss', '%.2f' % t0, '-t', '%.2f' % PLEN, '-i', str(voc),
                '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,afade=t=in:d=0.8,afade=t=out:st=%.2f:d=1.5[a]' % fo, '-map', '[a]']
    else:
        args = ['-ss', '%.2f' % t0, '-t', '%.2f' % PLEN, '-i', str(ins), '-af', 'afade=t=in:d=0.8,afade=t=out:st=%.2f:d=1.5' % fo]
    tmp = out.with_suffix('.tmp.mp3')
    subprocess.run(['ffmpeg', '-v', 'error', '-y'] + args + ['-ac', '2', '-ar', '44100', '-b:a', '96k', str(tmp)], check=True); tmp.replace(out)
lib = {'version': 1, 'cats': [], 'songs': {}}; counts = {}
for e in json.loads((SONGS / 'index.json').read_text()):
    sid = e['id']; key = sid.replace('user-', ''); d = SONGS / sid; s = json.loads((d / 'song.json').read_text())
    g, y, ballad = meta.get(key, ('pop', 2000, False)); cs = cats(g, y, ballad) + [c for c in extra.get(key, []) if c not in cats(g, y, ballad)]
    for c in cs + ['all']: counts[c] = counts.get(c, 0) + 1
    ev = (s.get('chart') or {}).get('ev') or []; dur = float(s.get('duration') or 1)
    npm = len([x for x in ev if x[4] <= 2]) / dur * 60 if ev else 0
    notes = s.get('notes') or []; mids = [n[2] if isinstance(n, list) else n.get('midi', 0) for n in notes] if notes else []
    mids = [m for m in mids if m]; rng = (np.percentile(mids, 95) - np.percentile(mids, 5)) if len(mids) > 8 else 7
    nps = len(mids) / dur if dur else 0
    vocal = float(rng) / 12 + nps * 0.8
    pv = d / 'preview.mp3'; info = None
    if pv.exists() and not FORCE and (d / 'preview.json').exists(): info = json.loads((d / 'preview.json').read_text())
    else:
        t0, how = hook(d, s, sid); cut(d, s, t0, pv); info = {'t0': round(t0, 2), 'len': PLEN, 'how': how}; (d / 'preview.json').write_text(json.dumps(info))
    lib['songs'][sid] = {'genre': g, 'year': y, 'cats': cs, 'npm': round(npm), 'vocal': round(vocal, 3), 'preview': info}
    print('%-45s %-7s %4d npm %4d vocal %.2f  hook %6.1fs / %5.0fs (%s)' % (sid, g, y, npm, vocal, info['t0'], dur, info['how']), flush=True)
def quint(key, out):   # library-relative 1-5 (quintiles), so the meters spread across the whole library
    ids = sorted(lib['songs'], key=lambda i: lib['songs'][i][key])
    for r, i in enumerate(ids): lib['songs'][i][out] = 1 + min(4, r * 5 // len(ids))
quint('npm', 'bars'); quint('vocal', 'stars')
lib['cats'] = [{'id': c, 'name': n, 'count': counts.get(c, 0)} for c, n in CAT_NAMES if c in ('all', 'fav') or counts.get(c)]
tmp = SONGS / 'library.json.tmp'; tmp.write_text(json.dumps(lib, separators=(',', ':'))); tmp.replace(SONGS / 'library.json')
print('cats:', [(c['name'], c['count']) for c in lib['cats']])
