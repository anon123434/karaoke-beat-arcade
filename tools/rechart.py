#!/usr/bin/env python3
"""v13.6 re-chart (server side, no Demucs): chart v3 events -> chart v4.
  1. dynamic beat grid: the tracker's beats are re-fitted to the real strong kick/snare attacks (sliding +-3 beat window), so tempo drift and
     a wrong phase are removed.  Reports BPM/phase fit before and after.
  2. quantise: every drum / bass / pad event snaps to the nearest 1/16 slot (or 1/3-beat triplet slot in beats where the drums really play
     triplets) when within a tight tolerance; off-grid hits (swing, pushes) stay on their real attack time.
  3. accents: kick/snare strength relative to the local average -> level 1 (Easy) = on-beat accents, 2 (Normal) = solid hits, 3 (Hard) = all
     but ghost notes, 4 = ghost (never charted).
  4. features: drops / breaks / section changes -> R1 accent moments; instrumental solos (no vocals, strong dominant lead) -> lead melody from the
     pitch contour (D-pad contour lanes, L1 holds, easy/remote get a lane-3 pulse on the lead), listed in chart.feat.
Original v3 chart is kept in .local/chart-v3/<id>.json (the re-run always starts from it).
Usage: .venv-ingest/bin/python tools/rechart.py [--no-solo] [--dry] [ids...]"""
import json, sys, shutil
from pathlib import Path
import numpy as np, librosa

ROOT = Path(__file__).resolve().parents[1]; BK = ROOT / '.local/chart-v3'; SR = 22050

# ---------------- beat grid ----------------
def slots(b, tri=None):
    """16th slots of a beat array: list of (t, beat index, pos 0..3)."""
    out = []
    for k in range(len(b) - 1):
        L = b[k + 1] - b[k]
        for j in range(4): out.append((b[k] + L * j / 4, k, j))
    return out

def fit_stats(b, ts, tol=0.02):
    """share of onsets within tol of a 16th slot + median |dev| (ms)."""
    s = np.array([x[0] for x in slots(b)]); ts = np.array(ts); ts = ts[(ts > s[0]) & (ts < s[-1])]
    if not len(ts): return 0.0, None
    i = np.clip(np.searchsorted(s, ts), 1, len(s) - 1); d = np.minimum(np.abs(ts - s[i - 1]), np.abs(ts - s[i]))
    return float((d <= tol).mean()), float(np.median(d) * 1000)

def refit(b, ts, iters=3):
    """dynamic grid: nudge each beat by the median deviation of the strong onsets around it (+-3 beats), smoothed."""
    b = np.array(b, dtype=float); ts = np.array(sorted(ts))
    if len(b) < 16 or len(ts) < 30: return b
    for _ in range(iters):
        S = slots(b); st = np.array([x[0] for x in S]); sk = np.array([x[1] for x in S])
        i = np.clip(np.searchsorted(st, ts), 1, len(st) - 1)
        j = np.where(np.abs(ts - st[i - 1]) < np.abs(ts - st[i]), i - 1, i); dev = ts - st[j]; kk = sk[j]; ok = np.abs(dev) < min(0.05, 0.3 * np.median(np.diff(b)) / 4 * 2)
        adj = np.zeros(len(b)); have = np.zeros(len(b), bool)
        for k in range(len(b)):
            m = ok & (kk >= k - 3) & (kk <= k + 3)
            if m.sum() >= 4: adj[k] = np.median(dev[m]); have[k] = True
        if not have.any(): break
        idx = np.arange(len(b)); adj = np.interp(idx, idx[have], adj[have])          # fill gaps
        adj = np.convolve(np.pad(adj, 2, mode='edge'), np.ones(5) / 5, mode='valid')
        b = b + 0.8 * adj
        b = np.maximum.accumulate(b + np.arange(len(b)) * 1e-6)
    return b

def triplet_beats(b, drum_ts):
    """beat indices where the drums play 1/3-beat triplets (>=2 onsets closer to a triplet slot than a 16th slot, within 15 ms)."""
    ts = np.array(sorted(drum_ts)); res = set()
    for k in range(len(b) - 1):
        L = b[k + 1] - b[k]; m = ts[(ts >= b[k] - 0.01) & (ts < b[k + 1] - 0.01)]; n = 0
        for t in m:
            f = (t - b[k]) / L; d4 = abs(f * 4 - round(f * 4)) * L / 4; d3 = abs(f * 3 - round(f * 3)) * L / 3
            if d3 < 0.015 and d4 > 0.025 and round(f * 3) % 3 != 0: n += 1
        if n >= 2: res.add(k)
    return res

class Quant:
    def __init__(self, b, tri, tol):
        self.b = b; self.tri = tri; self.tol = tol
    def snap(self, t):
        """-> (t', slot level 0 beat / 1 8th / 2 16th or triplet / 3 off-grid)"""
        b = self.b
        if t < b[0] or t >= b[-1]: return t, 3
        k = int(np.searchsorted(b, t, side='right')) - 1; k = min(k, len(b) - 2); L = b[k + 1] - b[k]; f = (t - b[k]) / L
        if k in self.tri: n, step = 3, L / 3
        else: n, step = 4, L / 4
        q = int(round(f * n)); c = b[k] + q * step; tol = min(self.tol, 0.3 * step)
        if abs(t - c) > tol: return t, 3
        if n == 4: lvl = 0 if q % 4 == 0 else 1 if q % 4 == 2 else 2
        else: lvl = 0 if q % 3 == 0 else 2
        return float(c), lvl

# ---------------- main ----------------
def local_mean(ts, vs, win=4.0):
    ts = np.array(ts); vs = np.array(vs); out = np.zeros(len(ts))
    for i, t in enumerate(ts):
        m = (ts >= t - win) & (ts <= t + win); out[i] = vs[m].mean() if m.any() else vs[i]
    return out

def bar_energy(y, b):
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]; ft = librosa.times_like(rms, sr=SR, hop_length=512)
    nb = (len(b) - 1) // 4; E = np.zeros(nb)
    for i in range(nb):
        m = (ft >= b[i * 4]) & (ft < b[min(len(b) - 1, i * 4 + 4)]); E[i] = rms[m].mean() if m.any() else 0
    return E, rms, ft

def vocal_mask(lines, dur):
    m = np.zeros(int(dur * 10) + 10, bool)
    for ln in lines or []:
        a, e = ln.get('t', 0), ln.get('end', ln.get('t', 0) + 2); m[int(a * 10): int(e * 10) + 1] = True
    return m

def find_solos(y, b, E, meta):
    """instrumental stretches (no sung line) of >= 6 s with strong energy and a clearly dominant lead (pyin voiced share)."""
    dur = len(y) / SR; vm = vocal_mask(meta.get('lines'), dur); res = []
    nb = len(E)
    if nb < 8: return res
    thr = np.percentile(E[E > 0], 40)
    i = 0
    while i < nb:
        t0 = b[i * 4]
        def sung(bar): a, e = int(b[bar * 4] * 10), int(b[min(len(b) - 1, bar * 4 + 4)] * 10); return vm[a:e + 1].mean() if e > a else 0
        if sung(i) < 0.1 and E[i] >= thr:
            j = i
            while j + 1 < nb and sung(j + 1) < 0.1 and E[j + 1] >= thr * 0.8: j += 1
            if b[(j + 1) * 4] - t0 >= 6.0: res.append((t0, float(b[min(len(b) - 1, (j + 1) * 4)]), i, j))
            i = j + 1
        else: i += 1
    return res

def lead_notes(y, t0, t1):
    a, e = int(t0 * SR), int(min(len(y), t1 * SR)); seg = librosa.effects.harmonic(y[a:e], margin=3.0)
    f0, vf, vp = librosa.pyin(seg, fmin=165, fmax=1400, sr=SR, frame_length=2048, hop_length=512, fill_na=np.nan)
    share = float(vf.mean()) if len(vf) else 0
    if share < 0.5: return [], share
    midi = np.where(vf, librosa.hz_to_midi(np.where(np.isnan(f0), 440, f0)), np.nan); ft = librosa.times_like(f0, sr=SR, hop_length=512) + t0
    notes = []; cur = None
    for i, m in enumerate(midi):
        if np.isnan(m):
            if cur and ft[i] - cur['last'] > 0.07: notes.append(cur); cur = None
            continue
        if cur and abs(m - np.median(cur['ms'])) < 0.8 and ft[i] - cur['last'] < 0.09: cur['ms'].append(m); cur['last'] = ft[i]
        else:
            if cur: notes.append(cur)
            cur = {'t': float(ft[i]), 'ms': [m], 'last': float(ft[i])}
    if cur: notes.append(cur)
    out = []
    for n in notes:
        d = n['last'] - n['t'] + 0.023
        if d >= 0.09 and len(n['ms']) >= 3: out.append({'t': n['t'], 'd': d, 'midi': float(np.median(n['ms']))})
    return out, share

def rechart(sid, solo=True, dry=False):
    sj = ROOT / 'songs' / sid / 'song.json'; meta = json.loads(sj.read_text()); ch = meta.get('chart')
    if not ch: return None
    BK.mkdir(parents=True, exist_ok=True); bk = BK / (sid + '.json')
    if not bk.exists(): bk.write_text(json.dumps({'chart': ch, 'beats_t': (meta.get('beats') or {}).get('t'), 'beats_t0': (meta.get('beats') or {}).get('t0')}))
    old = json.loads(bk.read_text()); ch = old['chart']; bt0 = old['beats_t0'] or old['beats_t']
    ev = [list(e) for e in ch['ev']]; rep = {'id': sid}
    if not bt0 or len(bt0) < 16: return None
    b0 = np.array(old['beats_t'] or bt0, dtype=float)                       # v3 (already kick-phased) grid
    drums = ch.get('drums') is not False
    strong = [e[0] for e in ev if e[1] <= 1 and e[3] >= 0.35]
    fit0 = fit_stats(b0, strong)
    b = refit(b0, strong) if drums else b0
    fit1 = fit_stats(b, strong); rep.update(bpm=round(60 / float(np.median(np.diff(b))), 2), fit20_before=round(fit0[0], 3), fit20_after=round(fit1[0], 3), dev_ms_before=None if fit0[1] is None else round(fit0[1], 1), dev_ms_after=None if fit1[1] is None else round(fit1[1], 1),
                                       tempo_cv=round(float(np.std(np.diff(b)) / np.mean(np.diff(b))), 4), shift_ms=round(float(np.median(b[:len(b0)] - b0[:len(b)]) * 1000), 1) if len(b) >= len(b0) else 0)
    tri = triplet_beats(b, [e[0] for e in ev if e[1] <= 2]) if drums else set()
    tol = 0.035 if fit1[0] >= 0.6 else 0.02 if fit1[0] >= 0.4 else 0.012; rep['snap_tol_ms'] = int(tol * 1000); rep['triplet_beats'] = len(tri)
    Q = Quant(b, tri, tol)
    y, _ = librosa.load(str(ROOT / 'songs' / sid / 'instrumental.mp3'), sr=SR, mono=True)
    E, rms, ft = bar_energy(y, b); P = lambda t: 0
    out = []; moved = []
    for e in ev:
        if e[1] in (4, 5, 6, 7, 8, 9) and False: pass
        t2, lvl = Q.snap(e[0]); moved.append(abs(t2 - e[0]) * 1000 if lvl < 3 else None)
        e2 = [round(t2, 3), e[1], e[2], e[3], e[4], e[5]]; e2.append(lvl); out.append(e2)       # [6] = grid level
    rep['snapped_pct'] = round(100 * float(np.mean([m is not None for m in moved])), 1); mv = [m for m in moved if m is not None]; rep['snap_mean_ms'] = round(float(np.mean(mv)), 1) if mv else 0
    # ---- accents: kick/snare strength relative to the local average ----
    for lane in (0, 1):
        idx = [i for i, e in enumerate(out) if e[1] == lane]
        if not idx: continue
        v = [out[i][3] for i in idx]; lm = local_mean([out[i][0] for i in idx], v)
        for i, m in zip(idx, lm):
            e = out[i]; rel = e[3] / max(m, 0.05); g = e[6]
            if g == 0 and ((rel >= 0.95 and e[3] >= 0.45) or rel >= 1.25): lv = 1
            elif g <= 1 and ((rel >= 0.8 and e[3] >= 0.3) or rel >= 1.15): lv = 2
            elif rel >= 0.5 and e[3] >= 0.22: lv = 3
            else: lv = 4
            e[4] = lv
    for e in out:
        if len(e) == 7: e.append(0)
    # ---- features: drops / breaks / section changes -> R1 accents ----
    feats = []; acc = []
    if len(E) > 8:
        med = float(np.median(E[E > 0])); sm = np.convolve(E, np.ones(4) / 4, mode='same')
        for i in range(2, len(E)):
            prev = E[max(0, i - 3):i].mean()
            if prev <= 0: continue
            if E[i] >= 1.45 * prev and E[i] >= 0.9 * med: acc.append((float(b[i * 4]), 1, 'drop'))
            elif i >= 4 and E[i - 1] <= 0.5 * E[max(0, i - 6):i - 1].mean() and E[i] >= 0.8 * E[max(0, i - 6):i - 1].mean(): acc.append((float(b[i * 4]), 1, 'return'))
        for i in range(4, len(E), 4):                                        # 4-bar blocks: a clear energy step is a section change
            a = E[max(0, i - 4):i].mean(); c = E[i:i + 4].mean()
            if a > 0 and c > 0 and (c / a >= 1.25 or c / a <= 0.75): acc.append((float(b[i * 4]), 2, 'section'))
    last = {}
    for t, lv, kind in sorted(acc):
        if any(abs(t - x[0]) < 3.0 for x in feats): continue
        feats.append((t, lv, kind))
        out.append([round(t, 3), 9, 0, 1.0, lv, 0, 0, 2.0])
    out = [e for e in out if not (e[1] == 9 and e[7] != 2.0 and any(abs(e[0] - f[0]) < 2.0 for f in feats))]    # the stem-based accents near a feature moment are redundant
    rep['accents'] = len(feats)
    # ---- solos ----
    solos = []
    if solo and drums:
        for (a, c, i0, i1) in find_solos(y, b, E, meta):
            notes, share = lead_notes(y, a, c)
            if share < 0.5 or len(notes) < 12: continue
            solos.append((a, c, share, notes))
    chart_feat = []
    for (a, c, share, notes) in solos:
        out = [e for e in out if not (a <= e[0] < c and e[1] in (4, 5, 6, 7, 8))]       # the lead replaces the bass/pad lanes here
        prev = None; lastq = -9; lastbeatn = -9
        for n in notes:
            t2, lvl = Q.snap(n['t'])
            if lvl == 3: t2 = round(n['t'] * 1000) / 1000
            if t2 - lastq < 0.11: continue
            m = n['midi']
            if prev is None: lane = 6
            else:
                dm = m - prev; lane = 6 if abs(dm) < 0.6 else 7 if abs(dm) >= 6.5 else 4 if dm > 0 else 5
            prev = m; lastq = t2
            level = 2 if (lvl <= 1 and n['d'] >= 0.2) else 3
            out.append([round(t2, 3), lane, 0, 0.9, level, int(round(m)), lvl, 1.5])
            if n['d'] >= 0.7 and lvl <= 1: out.append([round(t2, 3), 8, round(min(n['d'], 3.0), 2), 0.9, 3, int(round(m)), lvl, 1.5])
            if lvl == 0 and t2 - lastbeatn >= 0.3:                                    # easy / remote: a △ pulse on the lead's on-beat notes
                out.append([round(t2, 3), 3, 0, 0.9, 1, 0, 0, 1.5]); lastbeatn = t2
        chart_feat.append([round(a, 2), round(c, 2), 'solo', round(share, 2)])
    rep['solos'] = len(chart_feat); rep['solo_s'] = round(sum(c[1] - c[0] for c in chart_feat), 1)
    for (t, lv, kind) in feats: chart_feat.append([round(t, 2), round(t, 2), kind, lv])
    out.sort(key=lambda e: (e[0], e[1]))
    nch = {'v': 4, 'lag_ms': ch.get('lag_ms'), 'grid': {'bpm': rep['bpm'], 'fit20': rep['fit20_after'], 'dev_ms': rep['dev_ms_after'], 'tri_beats': len(tri), 'tol_ms': rep['snap_tol_ms']},
           'src': 'rechart-v4 from ' + str(ch.get('src')), 'drums': ch.get('drums'), 'feat': sorted(chart_feat), 'cols': 'ev=[t,lane,dur,strength,level,midi,gridLevel,flag(0 stem,1.5 solo lead,2 feature)]', 'ev': out}
    d = (meta.get('duration') or 1) / 60
    rep['per_min_lvl'] = [round(sum(1 for e in out if e[4] <= k and e[1] <= 3 and e[1] != 2) / d) for k in (1, 2, 3)]
    if dry: return rep
    meta['chart'] = nch; bm = meta.setdefault('beats', {})
    if 't' in bm and 't0' not in bm: bm['t0'] = bm['t']
    bm['t'] = [round(float(x), 3) for x in b]; bm['bpm'] = rep['bpm']; bm.pop('s', None) if False else None
    tmp = sj.with_suffix('.json.tmp'); tmp.write_text(json.dumps(meta)); tmp.replace(sj)
    return rep

if __name__ == '__main__':
    a = sys.argv[1:]; solo = '--no-solo' not in a; dry = '--dry' in a
    ids = [x for x in a if not x.startswith('--')] or [e['id'] for e in json.loads((ROOT / 'songs/index.json').read_text())]
    for sid in ids:
        try:
            r = rechart(sid, solo, dry); print(json.dumps(r) if r else 'skip ' + sid, flush=True)
        except Exception as ex:
            import traceback; print('FAIL', sid, repr(ex), flush=True); traceback.print_exc()
