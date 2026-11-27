#!/usr/bin/env python3
"""
Song ingest for KaraokeTV (personal use with songs you own). Everything runs locally except the LRCLIB lyrics lookup.

  python tools/ingest.py <audio file> [--id user-xyz] [--title T --artist A]

Steps:
 1. Demucs htdemucs (CPU) two-stem split -> vocals.wav / no_vocals.wav
 2. faster-whisper (small.en) on the vocal stem, word timestamps -> transcript (also used for ID + word timing)
 3. LRCLIB search (lyric snippet and/or title/artist), prefer entry whose duration matches -> title, artist, synced lyrics
    fallback: whisper words grouped into lines
 4. Line-level LRC -> word timing: aligned to whisper words where possible, else spread by word length
 5. Reference melody: librosa pYIN on the vocal stem -> tuning-corrected monophonic notes (median-filtered, blips < 80 ms
    dropped, same-pitch fragments merged) -> melody.json in the scorer format + melody.mid
 6. Instrumental -> instrumental.mp3 (what the TV plays); song.json / lyrics.lrc; songs/index.json refreshed
"""
import argparse, difflib, json, math, re, subprocess, sys, time, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / '.local/ingest'
UA = 'KaraokeTV/0.1 (personal home karaoke; contact: local)'


def log(*a):
    print('[ingest]', *a, flush=True)


def duration_of(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                         capture_output=True, text=True).stdout.strip()
    return float(out)


# ---------- 1. separation ----------
def separate(src):
    out = WORK / 'demucs/htdemucs' / src.stem
    kept = WORK / 'stems' / src.stem  # compacted FLAC stems from an earlier run (ingest-batch cleanup)
    if (kept / 'vocals.flac').exists() and (kept / 'instrumental.flac').exists():
        return kept / 'vocals.flac', kept / 'instrumental.flac'
    if not (out / 'vocals.wav').exists():
        log('demucs htdemucs on', src.name)
        subprocess.run([sys.executable, '-m', 'demucs', '-n', 'htdemucs', '--two-stems', 'vocals', '-d', 'cpu',
                        '-o', str(WORK / 'demucs'), str(src)], check=True)
    return out / 'vocals.wav', out / 'no_vocals.wav'


# ---------- 2. transcription ----------
def transcribe(vocals, cache):
    if cache.exists():
        return json.loads(cache.read_text())
    from faster_whisper import WhisperModel
    log('faster-whisper small.en on vocal stem')
    model = WhisperModel('small.en', device='cpu', compute_type='int8')
    segs, _ = model.transcribe(str(vocals), word_timestamps=True, vad_filter=False, beam_size=5,
                               condition_on_previous_text=False)
    words = []
    for s in segs:
        for w in (s.words or []):
            words.append({'t': round(w.start, 3), 'end': round(w.end, 3), 'w': w.word.strip(), 'p': round(w.probability, 3)})
    cache.write_text(json.dumps(words))
    return words


# ---------- 3. LRCLIB ----------
def http_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def norm(s):
    return re.sub(r"[^a-z0-9' ]+", ' ', s.lower()).split()


def lrclib_candidates(words, title=None, artist=None):
    queries = []
    if title:
        queries.append({'track_name': title, **({'artist_name': artist} if artist else {})})
        if artist:  # featured artists / spelling variants: also try the main artist and the title alone
            main_artist = re.split(r'\s+(?:feat\.?|ft\.?|featuring|&|and|with)\s+', artist, flags=re.I)[0]
            if main_artist != artist:
                queries.append({'track_name': title, 'artist_name': main_artist})
            queries.append({'track_name': title})
    # LRCLIB's search does not index lyric text, only title/artist/album. Titles are usually sung in the
    # chorus, so query track_name with the most repeated phrases of the transcript.
    if not title:
        from collections import Counter
        toks = norm(' '.join(w['w'] for w in words))
        cnt = Counter()
        for n in (2, 3, 4, 5):
            for i in range(len(toks) - n + 1):
                cnt[' '.join(toks[i:i + n])] += 1
        ranked = sorted((g for g, c in cnt.items() if c >= 3), key=lambda g: -(cnt[g] * (len(g.split()) ** 1.5)))
        picked = []
        for g in ranked:
            if not any(g in p or p in g for p in picked):
                picked.append(g)
            if len(picked) >= 8:
                break
        log('title guesses from repeated phrases:', picked)
        queries += [{'track_name': g} for g in picked]
    seen, out = set(), []
    for q in queries:
        try:
            res = http_json('https://lrclib.net/api/search?' + urllib.parse.urlencode(q))
        except Exception as e:
            log('lrclib query failed:', e)
            continue
        for r in res:
            if r['id'] not in seen:
                seen.add(r['id'])
                out.append(r)
        time.sleep(0.3)
    return out


def pick_lyrics(cands, words, dur):
    heard = norm(' '.join(w['w'] for w in words))
    best, best_score = None, -1
    for c in cands:
        plain = c.get('plainLyrics') or re.sub(r'\[[^\]]*\]', '', c.get('syncedLyrics') or '')
        if not plain:
            continue
        sim = difflib.SequenceMatcher(None, heard[:400], norm(plain)[:400], autojunk=False).ratio()
        ddiff = abs((c.get('duration') or 0) - dur)
        score = sim - min(ddiff, 30) / 60 + (0.15 if c.get('syncedLyrics') else 0)
        c['_sim'], c['_ddiff'] = round(sim, 3), round(ddiff, 1)
        if score > best_score:
            best, best_score = c, score
    return best


def parse_lrc(text):
    lines = []
    for raw in text.splitlines():
        m = re.match(r'\[(\d+):(\d+(?:\.\d+)?)\](.*)', raw.strip())
        if not m:
            continue
        t = int(m.group(1)) * 60 + float(m.group(2))
        body = m.group(3).strip()
        if body:
            lines.append({'t': round(t, 3), 'text': body})
        elif lines:
            lines.append({'t': round(t, 3), 'text': ''})  # blank = end marker
    return lines


# ---------- 4. word timing ----------
def words_for_lines(lrc_lines, wwords, dur):
    out = []
    real = [l for l in lrc_lines if l['text']]
    for idx, l in enumerate(lrc_lines):
        if not l['text']:
            continue
        nxt = next((x['t'] for x in lrc_lines[idx + 1:]), dur)
        toks = l['text'].split()
        window = [w for w in wwords if l['t'] - 0.6 <= w['t'] < nxt - 0.1]
        # align line tokens to whisper words by normalised text
        a = [re.sub(r"[^a-z0-9']", '', t.lower()) for t in toks]
        b = [re.sub(r"[^a-z0-9']", '', w['w'].lower()) for w in window]
        times = [None] * len(toks)
        sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
        for blk in sm.get_matching_blocks():
            for k in range(blk.size):
                times[blk.a + k] = (window[blk.b + k]['t'], window[blk.b + k]['end'])
        # line end: last matched word end, else capped by next line
        matched_end = max([e for (_, e) in [x for x in times if x]] or [0])
        end = min(nxt, max(matched_end, l['t'] + 0.4 * len(toks)) if matched_end else min(nxt, l['t'] + 0.45 * len(toks) + 0.5))
        start = l['t']
        if times[0] is None:
            times[0] = (start, None)
        # fill gaps by interpolating on character length between anchors
        anchors = [(i, x[0]) for i, x in enumerate(times) if x] + [(len(toks), end)]
        res = []
        prev_i, prev_t = 0, max(start - 0.3, min(times[0][0], start + 1.0))
        ai = 0
        for i in range(len(toks)):
            if times[i]:
                res.append(times[i][0]); prev_i, prev_t = i, times[i][0]; continue
            j, tj = next((ai_, at) for ai_, at in anchors if ai_ > i)
            span = sum(len(toks[k]) + 1 for k in range(prev_i, j))
            pos = sum(len(toks[k]) + 1 for k in range(prev_i, i))
            res.append(prev_t + (tj - prev_t) * pos / max(1, span))
        res = sorted(max(start - 0.3, x) for x in res)
        ws = []
        for i, tok in enumerate(toks):
            t0 = res[i]
            t1 = res[i + 1] if i + 1 < len(toks) else end
            ws.append({'t': round(t0, 3), 'd': round(max(0.12, min(t1 - t0, 2.0)), 3), 'text': tok})
        out.append({'t': ws[0]['t'], 'end': round(max(end, ws[-1]['t'] + ws[-1]['d']), 3), 'words': ws})
    return out


def lines_from_whisper(wwords):
    lines, cur = [], []
    for w in wwords:
        if cur and (w['t'] - cur[-1]['end'] > 0.8 or len(cur) >= 8):
            lines.append(cur); cur = []
        cur.append(w)
    if cur:
        lines.append(cur)
    return [{'t': l[0]['t'], 'end': l[-1]['end'],
             'words': [{'t': w['t'], 'd': round(max(0.12, w['end'] - w['t']), 3), 'text': w['w']} for w in l]} for l in lines]


# ---------- 4b. lyric sync: global offset + per-line/word snapping ----------
def tok(t):
    return re.sub(r"[^a-z0-9']", '', t.lower())


def xcorr_offset(lrc_lines, vocals, dur):
    """Global offset (s) by cross-correlating vocal-stem activity with LRC line activity (20 Hz)."""
    import numpy as np, librosa
    y, sr = librosa.load(str(vocals), sr=11025, mono=True)
    hop = sr // 20
    rms = librosa.feature.rms(y=y, frame_length=hop * 2, hop_length=hop)[0]
    db = 20 * np.log10(rms + 1e-6)
    act = (db > np.percentile(db, 45)).astype(float)
    n = len(act)
    lrc = np.zeros(n)
    real = [l for l in lrc_lines if l['text']]
    for i, l in enumerate(real):
        nxt = real[i + 1]['t'] if i + 1 < len(real) else dur
        end = min(nxt, l['t'] + 0.38 * len(l['text'].split()) + 0.6)
        a, b = int(l['t'] * 20), int(end * 20)
        lrc[max(0, a):max(0, min(n, b))] = 1
    a0, l0 = act - act.mean(), lrc - lrc.mean()
    lags = range(-20 * 20, 20 * 20 + 1)
    sc = []
    for L in lags:  # lrc shifted by L frames
        if L >= 0:
            v = float(np.dot(a0[L:], l0[:n - L]))
        else:
            v = float(np.dot(a0[:n + L], l0[-L:]))
        sc.append(v)
    sc = np.array(sc)
    k = int(np.argmax(sc))
    # confidence: peak vs best value outside +-1 s of the peak
    mask = np.ones(len(sc), bool); mask[max(0, k - 20):k + 21] = False
    second = float(sc[mask].max()) if mask.any() else 0.0
    conf = float((sc[k] - second) / (abs(sc[k]) + 1e-9))
    return lags[k] / 20.0, round(conf, 3)


def vocal_onsets(vocals):
    """Vocal phrase onsets (s): rising edges of vocal-stem activity after >= 0.24 s of quiet (50 Hz frames)."""
    import numpy as np, librosa
    y, sr = librosa.load(str(vocals), sr=11025, mono=True)
    hop = sr // 50
    db = 20 * np.log10(librosa.feature.rms(y=y, frame_length=hop * 4, hop_length=hop)[0] + 1e-6)
    act = db > np.percentile(db, 50)
    on, quiet = [], 0
    for i, x in enumerate(act):
        if x and quiet >= 12:
            on.append(i / 50)
        quiet = 0 if x else quiet + 1
    return np.array(on)


def align_lyrics(lrc_lines, wwords, vocals, dur):
    """LRC lines -> line/word timings snapped to the real audio. Returns (lines, report).
    1) global offset: grid search that best lines up LRC line starts with vocal onsets in the stem
       (plus a coarse activity cross-correlation, reported for comparison)
    2) each line start snaps to the nearest vocal onset within 0.35 s
    3) words inside a line: faster-whisper word times (windowed match of the LRC text, bias-corrected because
       whisper's word starts on sung vocals run early), gaps interpolated by character length"""
    import numpy as np
    real = [dict(l) for l in lrc_lines if l['text']]
    xc_off, xc_conf = xcorr_offset(lrc_lines, vocals, dur)
    on = vocal_onsets(vocals)
    starts = np.array([l['t'] for l in real])
    grid = np.arange(-4.0, 4.0001, 0.02)
    def fit(o):
        if not len(on):
            return 0.0
        d = np.min(np.abs(on[None, :] - (starts + o)[:, None]), axis=1)
        return float(np.mean(np.exp(-(d / 0.12) ** 2)))
    sc = np.array([fit(o) for o in grid])
    k = int(np.argmax(sc)); on_off = float(grid[k])
    on_gain = float(sc[k] - np.median(sc))
    off = on_off if on_gain > 0.05 else 0.0
    W = [w for w in wwords if tok(w['w'])]
    # pass 1: snapped line starts + windowed whisper matches
    info = []
    for li, l in enumerate(real):
        toks = l['text'].split()
        exp0 = l['t'] + off
        nxt = (real[li + 1]['t'] + off) if li + 1 < len(real) else dur
        near = on[np.abs(on - exp0) <= 0.35] if len(on) else []
        snapped = float(near[np.argmin(np.abs(near - exp0))]) if len(near) else exp0
        win = [w for w in W if exp0 - 1.5 <= w['t'] < max(nxt, exp0 + 0.5 * len(toks)) + 1.0]
        la, lb = [tok(t) for t in toks], [tok(w['w']) for w in win]
        times = [None] * len(toks)
        for blk in difflib.SequenceMatcher(None, la, lb, autojunk=False).get_matching_blocks():
            if blk.size >= 2 or (blk.size == 1 and len(la[blk.a]) >= 3):
                for q in range(blk.size):
                    times[blk.a + q] = (win[blk.b + q]['t'], win[blk.b + q]['end'])
        info.append({'toks': toks, 'start': snapped, 'snapped': len(near) > 0, 'times': times, 'nxt': nxt})
    firsts = [i['times'][0][0] - i['start'] for i in info if i['times'][0] and i['snapped']]
    bias = float(np.median(firsts)) if len(firsts) >= 3 else 0.0
    bias = max(-1.0, min(1.0, bias))
    out, anchored, matched, total = [], 0, 0, 0
    for li, i in enumerate(info):
        toks, start = i['toks'], i['start']
        nxt_start = info[li + 1]['start'] if li + 1 < len(info) else dur
        times = [None if t is None else (t[0] - bias, t[1] - bias) for t in i['times']]
        total += len(toks); matched += sum(1 for t in times if t)
        if any(times):
            anchored += 1
        anchors = [(0, start)]
        for q in range(1, len(toks)):
            if times[q] and anchors[-1][1] + 0.05 < times[q][0] < nxt_start:
                anchors.append((q, times[q][0]))
        end_m = max([t[1] for t in times if t] or [0])
        end = max(end_m, start + 0.3 * len(toks)) if end_m else start + 0.42 * len(toks) + 0.3
        end = min(end, max(nxt_start - 0.05, anchors[-1][1] + 0.25))
        end = max(end, anchors[-1][1] + 0.25)
        anchors.append((len(toks), end))
        ws = []
        for q in range(len(toks)):
            a_ = max(x for x in anchors if x[0] <= q)
            b_ = min((x for x in anchors if x[0] > q), key=lambda x: x[0])
            if a_[0] == q:
                ws.append(a_[1])
            else:
                span_c = sum(len(toks[z]) + 1 for z in range(a_[0], b_[0]))
                pos_c = sum(len(toks[z]) + 1 for z in range(a_[0], q))
                ws.append(a_[1] + (b_[1] - a_[1]) * pos_c / max(1, span_c))
        for q in range(1, len(ws)):
            ws[q] = max(ws[q], ws[q - 1] + 0.05)
        words = []
        for q, t0 in enumerate(ws):
            t1 = ws[q + 1] if q + 1 < len(ws) else max(end, t0 + 0.2)
            words.append({'t': round(max(0.0, t0), 3), 'd': round(max(0.12, min(t1 - t0, 2.0)), 3), 'text': toks[q]})
        out.append({'t': words[0]['t'], 'end': round(max(end, words[-1]['t'] + words[-1]['d']), 3), 'words': words})
    for q in range(1, len(out)):
        if out[q]['t'] < out[q - 1]['t']:
            out[q]['t'] = out[q]['words'][0]['t'] = round(out[q - 1]['t'] + 0.05, 3)
    snapped_frac = sum(1 for i in info if i['snapped']) / max(1, len(info))
    anchored_frac = anchored / max(1, len(info))
    mfrac = matched / max(1, total)
    conf = 'high' if snapped_frac >= 0.6 and mfrac >= 0.5 else 'medium' if snapped_frac >= 0.4 and mfrac >= 0.3 else 'low'
    rep = {'global_offset_s': round(off, 2), 'onset_fit_gain': round(on_gain, 3), 'xcorr_offset_s': xc_off,
           'xcorr_confidence': xc_conf, 'whisper_word_bias_s': round(bias, 2), 'lines_snapped_to_onset': round(snapped_frac, 3),
           'matched_words': round(mfrac, 3), 'anchored_lines': round(anchored_frac, 3), 'confidence': conf}
    return out, rep


# ---------- 5. melody ----------
def melody(vocals, lines):
    import numpy as np, librosa, scipy.signal
    sr, hop = 22050, 256
    y, _ = librosa.load(str(vocals), sr=sr, mono=True)
    log('pYIN on vocal stem (%.0f s)' % (len(y) / sr))
    f0, voiced, prob = librosa.pyin(y, fmin=65, fmax=1050, sr=sr, frame_length=2048, hop_length=hop)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0][:len(f0)]
    gate = max(1e-4, float(np.percentile(rms[rms > 0], 30))) if np.any(rms > 0) else 1e-4
    ok = voiced & (rms > gate) & np.isfinite(f0)
    midi = np.full(len(f0), np.nan)
    midi[ok] = librosa.hz_to_midi(f0[ok])
    # global tuning offset (recordings are not always A=440)
    frac = midi[ok] - np.round(midi[ok])
    tune = float(np.angle(np.mean(np.exp(2j * np.pi * frac))) / (2 * np.pi)) if ok.any() else 0.0
    m = midi - tune
    # fix isolated octave jumps: compare with local median
    v = np.where(np.isnan(m), 0, m)
    med = scipy.signal.medfilt(v, 9)
    for i in np.where(ok)[0]:
        if med[i] > 0:
            while m[i] - med[i] > 9: m[i] -= 12
            while med[i] - m[i] > 9: m[i] += 12
    sm = scipy.signal.medfilt(np.where(np.isnan(m), 0, m), 5)
    times = librosa.frames_to_time(np.arange(len(f0)), sr=sr, hop_length=hop)
    dt = hop / sr
    # segment into notes with hysteresis: a new note starts only when the pitch leaves the current note by
    # > 0.7 st for >= 3 frames (~35 ms); unvoiced gaps up to ~95 ms inside a note are bridged (consonants)
    notes, cur, pend = [], None, []
    for i in range(len(sm)):
        x = float(sm[i]) if ok[i] and sm[i] > 0 else 0.0
        if x == 0.0:
            if cur and i - cur['last'] > 8:
                notes.append(cur); cur = None
            pend = []
            continue
        if cur is None:
            cur = {'start': i, 'last': i, 'vals': [x]}; continue
        centre = float(np.median(cur['vals'][-20:]))
        if abs(x - centre) <= 0.7:
            cur['vals'] += [p_[1] for p_ in pend] + [x]; cur['last'] = i; pend = []
        else:
            pend.append((i, x))
            if len(pend) >= 3 and abs(float(np.median([p_[1] for p_ in pend])) - centre) > 0.7:
                notes.append(cur)
                cur = {'start': pend[0][0], 'last': i, 'vals': [p_[1] for p_ in pend]}; pend = []
    if cur:
        notes.append(cur)
    out = []
    for n in notes:
        t, d = float(times[n['start']]), (n['last'] - n['start'] + 1) * dt
        out.append({'t': t, 'd': d, 'midi': int(round(float(np.median(n['vals']))))})
    # merge same-pitch fragments separated by < 120 ms
    merged = []
    for n in out:
        if merged and merged[-1]['midi'] == n['midi'] and n['t'] - (merged[-1]['t'] + merged[-1]['d']) < 0.12:
            merged[-1]['d'] = n['t'] + n['d'] - merged[-1]['t']
        else:
            merged.append(dict(n))
    # blips < 80 ms: absorbed by an adjacent (touching) note, otherwise dropped
    final = []
    for n in merged:
        if n['d'] < 0.08:
            if final and n['t'] - (final[-1]['t'] + final[-1]['d']) < 0.05:
                final[-1]['d'] = n['t'] + n['d'] - final[-1]['t']
            continue
        if final and final[-1]['midi'] == n['midi'] and n['t'] - (final[-1]['t'] + final[-1]['d']) < 0.12:
            final[-1]['d'] = n['t'] + n['d'] - final[-1]['t']
        else:
            final.append(n)
    # fold octave outliers (bleed / pYIN octave errors) into median +-12 st so the lane stays readable;
    # scoring is octave-folded anyway, so this never changes what counts as in tune
    if final:
        w = np.repeat([n['midi'] for n in final], [max(1, int(n['d'] * 20)) for n in final])
        medm = float(np.median(w))
        for n in final:
            while n['midi'] > medm + 12: n['midi'] -= 12
            while n['midi'] < medm - 12: n['midi'] += 12
    # keep notes that overlap a lyric line (drops stray ad-libs / bleed in instrumental sections)
    def line_of(n):
        for li, l in enumerate(lines):
            if n['t'] < l['end'] + 0.5 and n['t'] + n['d'] > l['t'] - 0.5:
                return li
        return None
    res = []
    for n in final:
        li = line_of(n)
        if li is None:
            continue
        syl = ''
        for w in lines[li]['words']:
            if w['t'] - 0.15 <= n['t'] < w['t'] + w['d']:
                syl = w['text']
        res.append({'t': round(n['t'], 3), 'd': round(min(n['d'], 4.0), 3), 'midi': n['midi'], 'syl': syl, 'line': li})
    stats = {'voiced_frames': int(ok.sum()), 'tuning_offset_cents': round(tune * 100, 1), 'raw_notes': len(out), 'voiced_seconds': round(float(ok.sum()) * dt, 1), 'note_seconds': round(sum(n['d'] for n in res), 1),
             'notes': len(res), 'range': [min(n['midi'] for n in res), max(n['midi'] for n in res)] if res else None}
    return res, stats


def write_midi(notes, path):
    ppq, tempo = 480, 500000  # 120 bpm: 1 beat = 0.5 s
    def vlq(n):
        b = [n & 0x7f]
        n >>= 7
        while n:
            b.insert(0, (n & 0x7f) | 0x80); n >>= 7
        return b
    ev = [(0, [0xff, 0x51, 3, tempo >> 16 & 255, tempo >> 8 & 255, tempo & 255])]
    tick = lambda s: int(round(s / 0.5 * ppq))
    for n in notes:
        ev.append((tick(n['t']), [0x90, n['midi'], 96]))
        ev.append((tick(n['t'] + n['d']), [0x80, n['midi'], 0]))
    ev.sort(key=lambda e: (e[0], 0 if e[1][0] == 0x80 else 1))
    trk, last = [], 0
    for t, b in ev:
        trk += vlq(t - last) + b; last = t
    trk += [0, 0xff, 0x2f, 0]
    path.write_bytes(b'MThd' + (6).to_bytes(4, 'big') + bytes([0, 0, 0, 1, ppq >> 8, ppq & 255]) +
                     b'MTrk' + len(trk).to_bytes(4, 'big') + bytes(trk))


def ts(s):
    m = int(s // 60)
    return '%02d:%05.2f' % (m, s - m * 60)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('audio'); ap.add_argument('--id'); ap.add_argument('--title'); ap.add_argument('--artist')
    a = ap.parse_args()
    src = Path(a.audio).expanduser().resolve()
    WORK.mkdir(parents=True, exist_ok=True)
    dur = duration_of(src)
    vocals, inst = separate(src)
    wwords = transcribe(vocals, WORK / (src.stem + '.whisper.json'))
    log('heard %d words: "%s ..."' % (len(wwords), ' '.join(w['w'] for w in wwords[:30])))
    cands = lrclib_candidates(wwords, a.title, a.artist)
    best = pick_lyrics(cands, wwords, dur)
    report = {'source': src.name, 'duration': round(dur, 2), 'heard_first_words': ' '.join(w['w'] for w in wwords[:40])}
    if best and best.get('_sim', 0) >= 0.35:
        title, artist = a.title or best['trackName'], a.artist or best['artistName']
        report.update({'lrclib_id': best['id'], 'lrclib_match': {'similarity': best['_sim'], 'duration_diff_s': best['_ddiff'],
                       'album': best.get('albumName')}, 'identified': True})
    else:
        title, artist = a.title or ('Unknown song (%s)' % src.stem), a.artist or 'Unknown'
        report['identified'] = bool(a.title)
        report['lrclib_best'] = best and {k: best.get(k) for k in ('trackName', 'artistName', 'duration', '_sim', '_ddiff')}
    synced = best.get('syncedLyrics') if best and best.get('_sim', 0) >= 0.35 else None
    if synced and best['_ddiff'] <= 6:
        lines, report['lyric_sync'] = align_lyrics(parse_lrc(synced), wwords, vocals, dur)
        report['lyrics_source'] = 'lrclib-synced, auto-aligned (global offset + whisper per-line/word snapping)'
        log('lyric sync:', json.dumps(report['lyric_sync']))
    else:
        lines = lines_from_whisper(wwords)
        report['lyrics_source'] = 'whisper word timestamps'
    notes, mstats = melody(vocals, lines)
    report['melody'] = mstats
    sid = a.id or ('user-' + re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')[:40])
    out = ROOT / 'songs' / sid
    out.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(inst), '-ac', '2', '-ar', '44100', '-b:a', '160k',
                    str(out / 'instrumental.mp3')], check=True)
    # guide vocals (original vocal stem, mono 96 kbps) - played quietly under the instrumental if enabled
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(vocals), '-ac', '1', '-ar', '44100', '-b:a', '96k',
                    str(out / 'vocals.mp3')], check=True)
    (out / 'melody.json').write_text(json.dumps(notes, indent=0))
    write_midi(notes, out / 'melody.mid')
    lrc = ['[ti:%s]' % title, '[ar:%s]' % artist] + [
        '[%s]' % ts(l['t']) + ' '.join('<%s>%s' % (ts(w['t']), w['text']) for w in l['words']) for l in lines]
    (out / 'lyrics.lrc').write_text('\n'.join(lrc) + '\n')
    lo, hi = (mstats['range'] or [60, 72])
    song = {'id': sid, 'title': title, 'artist': artist, 'difficulty': 'Real song', 'key': '',
            'arrangement': 'Personal copy: Demucs instrumental stem', 'license': 'Personal home use only (owner-supplied audio)',
            'leadIn': notes[0]['t'] if notes else (lines[0]['t'] if lines else 0), 'duration': round(dur, 3),
            'audio': 'instrumental.mp3', 'guide': 'vocals.mp3', 'midi': 'melody.mid', 'lrc': 'lyrics.lrc', 'notes': notes, 'lines': lines,
            'source': 'ingest', 'ingest': report}
    (out / 'song.json').write_text(json.dumps(song))
    (out / 'ingest-report.json').write_text(json.dumps(report, indent=1))
    subprocess.run(['node', str(ROOT / 'tools/build-index.js')], check=True)
    log('done:', sid, '|', title, '-', artist, '|', len(lines), 'lines,', len(notes), 'notes')
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
