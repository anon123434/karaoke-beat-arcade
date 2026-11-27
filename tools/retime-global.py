#!/usr/bin/env python3
"""Whole-song re-timing of lyrics for songs whose LRC was timed to a different cut (offset that DRIFTS, not a constant shift).

  .venv-ingest/bin/python tools/retime-global.py [--dry] [--no-notes] id [id ...]

One CTC forced alignment (wav2vec2, same model as align-words.py) of ALL the lyric words against the whole vocal stem,
so every line lands where it is really sung no matter how far the LRC times are off. Per-line scores are reported; a line
whose words align with low confidence is flagged. Word starts are snapped back to vocal onsets (<= 80 ms), word ends
extend over held notes. The song's notes (pitch lane) are re-labelled with the new line/syllable. Previous timing is
backed up once to .local/lyr-backup-retime/<id>.json (song.json lines + notes) so it can be restored.
"""
import sys, json, os, importlib.util, shutil
from pathlib import Path
import numpy as np, torch, torchaudio, librosa
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('aw', ROOT / 'tools/align-words.py'); aw = importlib.util.module_from_spec(spec); spec.loader.exec_module(aw)
SR, FR = aw.SR, aw.FR
LOWPRIO = True   # keep the Mac server responsive while someone is singing: 2 torch threads, run under nice
aw.torch.set_num_threads(2)
_orig_model = aw.model
def _m():
    m = _orig_model(); aw.torch.set_num_threads(2); return m
aw.model = _m

def run(sid, dry, notes, drop=None, Lover=None):
    p = ROOT / 'songs' / sid / 'song.json'; S = json.loads(p.read_text()); L = S['lines']
    bk = ROOT / '.local/lyr-backup-retime' / (sid + '.json'); bk.parent.mkdir(parents=True, exist_ok=True)
    if not bk.exists(): bk.write_text(json.dumps({'lines': S['lines'], 'notes': S['notes']}))
    L = Lover if Lover is not None else json.loads(bk.read_text())['lines']
    y, _ = librosa.load(str(ROOT / 'songs' / sid / 'vocals.mp3'), sr=SR, mono=True)
    E = aw.emissions(y); T = E.shape[0]; ON = aw.onsets(y)
    rms = librosa.feature.rms(y=y, frame_length=640, hop_length=160)[0]; db = 20 * np.log10(rms + 1e-6); ACT = db > np.percentile(db, 60) - 8
    words = [(li, wi, w) for li, l in enumerate(L) for wi, w in enumerate(l['words'])]
    seqs = [aw.toks(w['text']) for _, _, w in words]; flat = [c for s in seqs for c in s]
    ali, sc = torchaudio.functional.forced_align(E[None], torch.tensor([flat], dtype=torch.int32), blank=0)
    spans = torchaudio.functional.merge_tokens(ali[0], sc[0].exp()); assert len(spans) == len(flat)
    k = 0; res = []
    for s in seqs:
        if not s: res.append(None); continue
        sp = spans[k:k + len(s)]; k += len(s)
        res.append((sp[0].start * FR, sp[-1].end * FR, float(np.mean([x.score for x in sp]))))
    out = [{'t': 0, 'end': 0, 'words': [dict(w) for w in l['words']]} for l in L]; ws_all = [[] for _ in L]
    for (li, wi, w), r in zip(words, res):
        nw = out[li]['words'][wi]
        if r:
            t0 = r[0]
            j = np.searchsorted(ON, t0); cand = [ON[q] for q in (j - 2, j - 1, j) if 0 <= q < len(ON) and -aw.SNAP <= ON[q] - t0 <= 0.02]
            if cand: t0 = max(cand)
            nw['t'] = round(float(t0), 3); nw['d'] = round(float(max(0.08, r[1] - t0)), 3)
        ws_all[li].append(r[2] if r else None)
    weak = []
    for li, l in enumerate(out):
        ws = l['words']
        for q, w in enumerate(ws):   # no-letter words: after the previous word
            if res[sum(len(x['words']) for x in out[:li]) + q] is None:
                w['t'] = round((ws[q - 1]['t'] + ws[q - 1]['d']) if q else (ws[q + 1]['t'] - 0.3 if q + 1 < len(ws) else w['t']), 3); w['d'] = 0.25
        for q in range(len(ws) - 2, -1, -1):   # CTC parks short words (I, a, the) in silence before a long gap: pull a word up against its successor when the stem is mostly silent in between
            gap = ws[q + 1]['t'] - ws[q]['t']
            if gap > 1.0:
                a_, b_ = int(ws[q]['t'] * 100), int(ws[q + 1]['t'] * 100); fr = float(np.mean(ACT[a_:b_])) if b_ > a_ else 1.0
                if fr < 0.35: ws[q]['t'] = round(ws[q + 1]['t'] - max(0.18, 0.06 * len(ws[q]['text'])), 3); ws[q]['d'] = 0.2
        for q in range(len(ws) - 1):
            if ws[q + 1]['t'] < ws[q]['t'] + 0.04: ws[q + 1]['t'] = round(ws[q]['t'] + 0.04, 3)
        for q in range(len(ws)):
            lim = ws[q + 1]['t'] - 0.03 if q + 1 < len(ws) else ws[q]['t'] + 3.0
            kk = int((ws[q]['t'] + ws[q]['d']) * 100); kl = int(lim * 100)
            while kk < kl and kk < len(ACT) and ACT[kk]: kk += 1
            ws[q]['d'] = round(max(0.06, min(max(ws[q]['d'], kk / 100 - ws[q]['t']), lim - ws[q]['t'], 4.0)), 3)
        l['t'] = ws[0]['t']; l['end'] = round(max(ws[-1]['t'] + ws[-1]['d'], l['t'] + 0.2), 3)
        sc_ = [x for x in ws_all[li] if x is not None]; m = float(np.mean(sc_)) if sc_ else 0
        if m < 0.2: weak.append((li, round(m, 2)))
    if drop is not None and Lover is None:   # lyric lines the audio does not contain (LRC from a longer cut): drop them, then align the rest again
        bad = [li for li in range(len(L)) if (lambda v: (float(np.mean(v)) if v else 0) < drop)([x for x in ws_all[li] if x is not None])]
        if bad:
            r2, o2 = run(sid, dry, notes, drop, [l for i, l in enumerate(L) if i not in set(bad)]); r2['dropped_lines'] = [[i, ' '.join(w['text'] for w in L[i]['words'])[:40]] for i in bad]; return r2, o2
    rep = {'id': sid, 'lines': len(L), 'weak_lines': weak, 'old_vs_new_line_start_s': [round(o['t'] - n['t'], 1) for o, n in zip(L, out)]}
    if not dry:
        S['lines'] = out
        S['ingest']['word_align'] = {'method': 'retime-global: single wav2vec2 CTC alignment of all lyrics over the whole vocal stem + onset snap', 'weak_lines': weak}
        if notes:   # pitch lane: re-extract with the NEW line windows (old windows dropped notes in newly-located vocal sections) and relabel line/syllable
            sys.path.insert(0, str(ROOT / 'tools')); import ingest
            nn, ms = ingest.melody(ROOT / 'songs' / sid / 'vocals.mp3', out)
            S['notes'] = nn; S['leadIn'] = nn[0]['t'] if nn else out[0]['t']; S['ingest']['melody'] = ms
            d = ROOT / 'songs' / sid
            (d / 'melody.json').write_text(json.dumps(nn, indent=0)); ingest.write_midi(nn, d / 'melody.mid')
            (d / 'lyrics.lrc').write_text('\n'.join(['[ti:%s]' % S['title'], '[ar:%s]' % S['artist']] + ['[%s]' % ingest.ts(l['t']) + ' '.join('<%s>%s' % (ingest.ts(w['t']), w['text']) for w in l['words']) for l in out]) + '\n')
            rep['notes'] = [len(S['notes'])]
        p.with_suffix('.json.tmp').write_text(json.dumps(S, separators=(',', ':'))); p.with_suffix('.json.tmp').replace(p)
    return rep, out

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    DROP = next((float(a.split('=')[1]) for a in sys.argv if a.startswith('--drop=')), None)
    for sid in args:
        rep, _ = run(sid, '--dry' in sys.argv, '--no-notes' not in sys.argv, DROP); print(json.dumps(rep))
