#!/usr/bin/env python3
"""Word-level re-timing of song lyrics by CTC forced alignment (wav2vec2, torchaudio) against the song's vocal stem.

  .venv-ingest/bin/python tools/align-words.py [--dry] [--report out.json] [ids...]     (default: every songs/*/ with lines)

The vocal stem is songs/<id>/vocals.mp3 decoded like the player decodes it (librosa trims the mp3 encoder delay), so the
word times land on the TV's audio clock. Each existing line (LRCLIB + whisper, already roughly placed) is aligned inside a
window around its current time; each word's start is then snapped to the nearest vocal onset (backtracked) within 80 ms,
and its end set from the last aligned character (so the highlight sweeps each word at its own speed). Lines whose
alignment is weak keep their old timing, shifted by the median correction of their aligned neighbours.
Old timings are backed up to .local/lyr-backup/<id>.json once.
"""
import sys, json, re, os, shutil
from pathlib import Path
import numpy as np, torch, torchaudio, librosa
ROOT = Path(__file__).resolve().parents[1]
SR, FR = 16000, 0.02          # wav2vec2: 320-sample frames at 16 kHz
SNAP = float(os.environ.get('ALIGN_SNAP', '0.08'))   # onset snap radius (s)
B = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
LAB = B.get_labels(); IDX = {c: i for i, c in enumerate(LAB)}
_model = None
def model():
    global _model
    if _model is None: torch.set_num_threads(max(1, (os.cpu_count() or 4) - 2)); _model = B.get_model().eval()
    return _model

def emissions(y):
    """log-probs [T, C] for the whole song; 20 s chunks with 2 s context each side (self-attention cost is quadratic)."""
    m = model(); C, X = 20 * SR, 2 * SR; out = []
    with torch.inference_mode():
        for s in range(0, len(y), C):
            a, b = max(0, s - X), min(len(y), s + C + X)
            e, _ = m(torch.from_numpy(y[a:b]).float()[None]); e = torch.log_softmax(e[0], -1)
            f0 = int(round((s - a) / 320)); n = int(round(min(C, len(y) - s) / 320)); out.append(e[f0:f0 + n])
    return torch.cat(out)

def toks(text):
    t = re.sub(r"[^A-Z']", '', text.upper().replace('-', ''))
    return [IDX[c] for c in t if c in IDX]

def onsets(y):
    env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=160)
    on = librosa.onset.onset_detect(onset_envelope=env, sr=SR, hop_length=160, backtrack=True, units='time', delta=0.04)
    return np.asarray(on)

def align_line(E, words, w0, w1):
    """CTC-align the words of one line inside frames [w0, w1). Returns per word (t0, t1, prob) or None for no-letter words."""
    seqs = [toks(w['text']) for w in words]; flat = [c for s in seqs for c in s]
    if not flat or w1 - w0 < len(flat) * 2 + 4: return None, 0.0
    em = E[w0:w1][None]; tg = torch.tensor([flat], dtype=torch.int32)
    try: ali, sc = torchaudio.functional.forced_align(em, tg, blank=0)
    except Exception: return None, 0.0
    spans = torchaudio.functional.merge_tokens(ali[0], sc[0].exp())
    if len(spans) != len(flat): return None, 0.0
    res, k = [], 0
    for s in seqs:
        if not s: res.append(None); continue
        sp = spans[k:k + len(s)]; k += len(s)
        res.append(((w0 + sp[0].start) * FR, (w0 + sp[-1].end) * FR, float(np.mean([x.score for x in sp]))))
    probs = [r[2] for r in res if r]
    return res, float(np.mean(probs)) if probs else 0.0

def process(sid, dry=False):
    p = ROOT / 'songs' / sid / 'song.json'; S = json.loads(p.read_text()); L = S.get('lines') or []
    voc = ROOT / 'songs' / sid / 'vocals.mp3'
    if not L or not voc.exists(): return None
    bk = ROOT / '.local/lyr-backup' / (sid + '.json'); bk.parent.mkdir(parents=True, exist_ok=True)
    if not bk.exists(): bk.write_text(json.dumps({'lines': L}))
    L = json.loads(bk.read_text())['lines']          # always re-align from the ORIGINAL timing (idempotent)
    y, _ = librosa.load(str(voc), sr=SR, mono=True); E = emissions(y); T = E.shape[0]; ON = onsets(y)
    rms = librosa.feature.rms(y=y, frame_length=640, hop_length=160)[0]; db = 20 * np.log10(rms + 1e-6); ACT = db > np.percentile(db, 60) - 8   # 10 ms vocal-activity frames
    def sung_until(t0, t1, lim):   # extend a word's end while the voice keeps sounding (held notes), never past lim
        k = int(t1 * 100); kl = int(lim * 100)
        while k < kl and k < len(ACT) and ACT[k]: k += 1
        return max(t1, min(k / 100, lim))
    out, shifts, oks, old_on, new_on, corr = [], [], 0, [], [], []
    # pass 1 (coarse): where does each line really start? wide window, keep the per-line median correction
    c1 = []
    for i, l in enumerate(L):
        prev_end = L[i - 1]['end'] if i else 0.0; nxt = L[i + 1]['t'] if i + 1 < len(L) else l['end'] + 2
        a = max(l['t'] - 1.0, prev_end - 0.3, 0); b = min(max(l['end'] + 1.0, l['t'] + 1.5), nxt + 0.6)
        res, prob = align_line(E, l['words'], int(a / FR), min(T, int(b / FR)))
        if res and prob >= 0.12:
            d = [r[0] - w['t'] for w, r in zip(l['words'], res) if r]
            if d: c1.append((i, float(np.median(d))))
    G = float(np.median([c for _, c in c1])) if c1 else 0.0
    MAD = float(np.median([abs(c - G) for _, c in c1])) if c1 else 9.0
    def local(i):   # robust local correction: median of the 9 nearest pass-1 lines, outliers (> 0.35 s from the song median) ignored
        near = [c for j, c in sorted(c1, key=lambda x: abs(x[0] - i))[:9] if abs(c - G) <= 0.35]
        return float(np.median(near)) if near else G
    def near_on(t): 
        if not len(ON): return 9
        i = np.searchsorted(ON, t); c = [abs(ON[j] - t) for j in (i - 1, i) if 0 <= j < len(ON)]; return min(c)
    for i, l in enumerate(L):
        prev_end = L[i - 1]['end'] if i else 0.0; nxt = L[i + 1]['t'] if i + 1 < len(L) else l['end'] + 2
        g = local(i); a = max(l['t'] + g - 0.45, 0); b = l['end'] + g + 0.6
        res, prob = align_line(E, l['words'], int(a / FR), min(T, int(b / FR)))
        ok = res is not None and prob >= 0.12 and sum(1 for r in res if r) >= max(1, 0.6 * len(res))
        if ok:   # reject a line that lands far from its neighbours' correction (backing vocals / a repeat)
            dl = float(np.median([r[0] - w['t'] for w, r in zip(l['words'], res) if r]))
            if abs(dl - g) > 0.3: ok = False
        nl = {'t': l['t'], 'end': l['end'], 'words': [dict(w) for w in l['words']], 'ali': round(prob, 3) if res else 0}
        if ok:
            oks += 1; ws = nl['words']
            for w, r in zip(ws, res):
                if not r: continue
                t0, t1 = r[0], r[1]
                if len(ON):   # snap the start to the vocal onset (backtracked) within 80 ms
                    j = np.searchsorted(ON, t0); cand = [ON[q] for q in (j - 2, j - 1, j) if 0 <= q < len(ON) and -SNAP <= ON[q] - t0 <= 0.02]   # CTC character starts run a little late: snap only back to the onset
                    if cand: t0 = max(cand)
                old_on.append(near_on(w['t'])); new_on.append(near_on(t0)); shifts.append(t0 - w['t'])
                w['t'] = round(t0, 3); w['d'] = round(max(0.08, t1 - t0), 3)
            # words without letters (numbers): between neighbours
            for q, (w, r) in enumerate(zip(ws, res)):
                if r: continue
                pt = ws[q - 1]['t'] + ws[q - 1]['d'] if q else ws[q + 1]['t'] - 0.3 if q + 1 < len(ws) else w['t']
                w['t'] = round(pt, 3); w['d'] = 0.25
            for q in range(len(ws)):   # held notes: the highlight keeps sweeping while the word is still sung
                lim = ws[q + 1]['t'] - 0.03 if q + 1 < len(ws) else ws[q]['t'] + 3.0
                ws[q]['d'] = round(sung_until(ws[q]['t'], ws[q]['t'] + ws[q]['d'], lim) - ws[q]['t'], 3)
            for q in range(len(ws) - 1):   # monotonic, no overlap
                if ws[q + 1]['t'] < ws[q]['t'] + 0.04: ws[q + 1]['t'] = round(ws[q]['t'] + 0.04, 3)
                ws[q]['d'] = round(max(0.06, min(ws[q]['d'], ws[q + 1]['t'] - ws[q]['t'], 4.0)), 3)
            nl['t'] = ws[0]['t']; nl['end'] = round(max(ws[-1]['t'] + ws[-1]['d'], nl['t'] + 0.2), 3)
            corr.append((i, float(np.median([w2['t'] - w1['t'] for w1, w2 in zip(l['words'], ws)]))))
        out.append(nl)
    # weak lines: shift by the median correction of the nearest aligned lines
    cmap = dict(corr)
    for i, nl in enumerate(out):
        if i in cmap or not corr: continue
        dt = local(i)
        if abs(dt) > 1.0: dt = 0.0
        for w in nl['words']: w['t'] = round(w['t'] + dt, 3)
        nl['t'] = nl['words'][0]['t']; nl['end'] = round(nl['end'] + dt, 3)
    for i in range(1, len(out)):   # keep lines ordered
        if out[i]['t'] < out[i - 1]['t'] + 0.05:
            d = out[i - 1]['t'] + 0.05 - out[i]['t']
            for w in out[i]['words']: w['t'] = round(w['t'] + d, 3)
            out[i]['t'] = out[i]['words'][0]['t']
    for nl in out: nl.pop('ali', None)
    # trust policy: full word re-timing only where most lines aligned; otherwise only a consistent whole-song shift; else unchanged
    frac = oks / max(1, len(L))
    if frac >= 0.5: mode = 'word-aligned'
    elif len(c1) >= 8 and MAD <= 0.3 and abs(G) >= 0.08:
        mode = 'song-shift'; out = json.loads(json.dumps(L))
        for nl in out:
            for w in nl['words']: w['t'] = round(w['t'] + G, 3)
            nl['t'] = nl['words'][0]['t']; nl['end'] = round(nl['end'] + G, 3)
    else: mode = 'unchanged'; out = json.loads(json.dumps(L))
    rep = {'id': sid, 'mode': mode, 'song_correction_ms': round(G * 1000), 'line_spread_ms': round(MAD * 1000), 'lines': len(L), 'aligned_lines': oks, 'aligned_frac': round(oks / max(1, len(L)), 3), 'words': len(shifts),
           'shift_median_ms': round(float(np.median(np.abs(shifts))) * 1000) if shifts else None,
           'shift_p90_ms': round(float(np.percentile(np.abs(shifts), 90)) * 1000) if shifts else None,
           'onset_dist_old_median_ms': round(float(np.median(old_on)) * 1000) if old_on else None,
           'onset_dist_new_median_ms': round(float(np.median(new_on)) * 1000) if new_on else None,
           'onset_dist_old_p90_ms': round(float(np.percentile(old_on, 90)) * 1000) if old_on else None,
           'onset_dist_new_p90_ms': round(float(np.percentile(new_on, 90)) * 1000) if new_on else None}
    if not dry:
        S['lines'] = out; S.setdefault('ingest', {})['word_align'] = {'method': 'wav2vec2-base-960h CTC forced alignment on vocals.mp3 + onset snap (80 ms)', **{k: v for k, v in rep.items() if k != 'id'}}
        tmp = p.with_suffix('.json.tmp'); tmp.write_text(json.dumps(S, separators=(',', ':'))); tmp.replace(p)
    return rep

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]; dry = '--dry' in sys.argv
    repf = None
    if '--report' in sys.argv: repf = sys.argv[sys.argv.index('--report') + 1]; args = [a for a in args if a != repf]
    ids = args or sorted(d.name for d in (ROOT / 'songs').iterdir() if (d / 'song.json').exists() and (d / 'vocals.mp3').exists())
    reps = []
    for sid in ids:
        try: r = process(sid, dry)
        except Exception as e: r = {'id': sid, 'error': str(e)[:200]}
        if r: reps.append(r); print(json.dumps(r), flush=True)
    if repf: Path(repf).write_text(json.dumps(reps, indent=1))
