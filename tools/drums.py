"""Drum transcription from a Demucs drums stem (band-split onsets, no grid snapping).
kick  = low band 40-120 Hz energy jump that dominates the mid band
snare = 150 Hz-5 kHz broadband (noise) burst: 1-5 kHz jump + 150-400 Hz body, not a kick
hat   = > 7 kHz short burst without a kick/snare
crash = bright burst whose > 7 kHz energy sustains (> 0.5 s)
Times are the steepest energy rise (the audible attack) at 5.8 ms resolution, refined to ~1 ms on the waveform."""
import numpy as np, librosa
from scipy.signal import butter, sosfiltfilt, find_peaks

SR, HOP, NFFT = 22050, 128, 1024
KREL, KE, KL, SMH = 0.12, 0.03, 0.6, 1.3

def _band(P, f, lo, hi): return P[(f >= lo) & (f < hi)].sum(0) + 1e-10

def _flux(E, smooth=2):
    L = np.log(E); d = np.zeros_like(L); d[1:] = L[1:] - L[:-1]
    d = np.maximum(d, 0)
    if smooth > 1: d = np.convolve(d, np.ones(smooth) / smooth, mode='same')
    return d

def _peaks(x, min_gap_s, rel):
    ref = np.percentile(x[x > 0], 99) if np.any(x > 0) else 1
    p, _ = find_peaks(x, height=ref * rel, distance=max(1, int(min_gap_s * SR / HOP)))
    return p

def _refine(yb, t, win=0.03, smooth=0.002):
    """steepest rise of the band-passed amplitude envelope near t (sample-level)."""
    a = int(max(0, (t - win) * SR)); b = int(min(len(yb), (t + win) * SR))
    if b - a < 32: return t
    env = np.abs(yb[a:b]); k = max(2, int(smooth * SR))
    env = np.convolve(env, np.ones(k) / k, mode='same')
    d = np.diff(env); return (a + int(np.argmax(d))) / SR

def transcribe(y):
    """y: mono drums stem at SR. Returns dict of lists of (t, strength 0..1)."""
    S = np.abs(librosa.stft(y, n_fft=NFFT, hop_length=HOP)) ** 2; f = librosa.fft_frequencies(sr=SR, n_fft=NFFT)
    lo, body, mid, hi = _band(S, f, 40, 120), _band(S, f, 150, 400), _band(S, f, 1000, 5000), _band(S, f, 7000, 11000)
    rms = librosa.feature.rms(y=y, frame_length=NFFT, hop_length=HOP)[0]; quiet = np.percentile(rms, 99) * 0.04
    fl, fb, fm, fh = _flux(lo), _flux(body), _flux(mid), _flux(hi)
    lvl = lambda E, i: float(np.log(E[min(len(E) - 1, i + 3)] / E[max(0, i - 3)]))   # dB-ish rise over ~35 ms
    t_of = lambda i: float(librosa.frames_to_time(i, sr=SR, hop_length=HOP))
    sos_k = butter(4, [40, 120], 'bandpass', fs=SR, output='sos'); yk = sosfiltfilt(sos_k, y)
    yc = sosfiltfilt(butter(4, 300, 'highpass', fs=SR, output='sos'), y)
    sos_s = butter(4, [1000, 5000], 'bandpass', fs=SR, output='sos'); ys = sosfiltfilt(sos_s, y)
    loE = np.percentile(lo, 99); midE = np.percentile(mid, 99); hiE = np.percentile(hi, 99)
    out = {'kick': [], 'snare': [], 'hat': [], 'crash': []}
    K = []
    for i in _peaks(fl, 0.09, KREL):
        if rms[i] < quiet: continue
        e = lo[min(len(lo) - 1, i + 4)] / loE
        if e < KE or lvl(lo, i) < KL: continue
        K.append(i); out['kick'].append((_refine(yc, t_of(i), 0.025), float(min(1.0, e ** 0.5))))   # audible attack = the beater click (> 300 Hz) of the stem
    Karr = np.array(K)
    for i in _peaks(fm + 0.5 * fb, 0.09, 0.22):
        if rms[i] < quiet: continue
        e = mid[min(len(mid) - 1, i + 3)] / midE
        if e < 0.05 or lvl(mid, i) < 0.9: continue
        hh = hi[min(len(hi) - 1, i + 2)] / hiE
        if e < SMH * hh: continue                      # open hat / cymbal: the > 7 kHz band dominates, not a snare
        near_k = len(Karr) and np.min(np.abs(Karr - i)) <= 3
        # a kick's click also lights the mids: on a kick only count it if the noise burst is strong on its own
        if near_k and (e < 0.35 or lvl(mid, i) < 1.6): continue
        out['snare'].append((_refine(ys, t_of(i)), float(min(1.0, e ** 0.5))))
    Sarr = np.array([int(librosa.time_to_frames(t, sr=SR, hop_length=HOP)) for t, _ in out['snare']])
    for i in _peaks(fh, 0.07, 0.25):
        if rms[i] < quiet: continue
        e = hi[min(len(hi) - 1, i + 2)] / hiE
        if e < 0.04: continue
        if (len(Karr) and np.min(np.abs(Karr - i)) <= 2) or (len(Sarr) and np.min(np.abs(Sarr - i)) <= 2):
            sustain = hi[i:i + int(0.5 * SR / HOP)] / hiE
            if len(sustain) > 20 and e > 0.5 and np.median(sustain) > 0.3: out['crash'].append((t_of(i), float(min(1.0, e ** 0.5))))
            continue
        sustain = hi[i:i + int(0.5 * SR / HOP)] / hiE
        (out['crash'] if (e > 0.5 and len(sustain) > 20 and np.median(sustain) > 0.3) else out['hat']).append((t_of(i), float(min(1.0, e ** 0.5))))
    return out

def reference(y, lo_hz, hi_hz, min_gap=0.09, rel=0.2, smooth=0.004):
    """Independent check: attacks of the sample-level band-passed envelope (time domain, not STFT)."""
    sos = butter(4, [lo_hz, hi_hz], 'bandpass', fs=SR, output='sos'); yb = sosfiltfilt(sos, y)
    k = int(smooth * SR); env = np.convolve(np.abs(yb), np.ones(k) / k, mode='same')
    d = np.diff(env, prepend=env[0]); d = np.maximum(d, 0); d = np.convolve(d, np.ones(k) / k, mode='same')
    ref = np.percentile(d[d > 0], 99.5)
    p, _ = find_peaks(d, height=ref * rel, distance=int(min_gap * SR))
    return p / SR

def stem_lag(stem_sum, instrumental):
    """Seconds the Demucs stems run LATE vs the instrumental as the player decodes it (mp3 encoder-delay padding:
    Demucs's decoder keeps it, the browser/librosa trim it). Onset-envelope cross-correlation, +-150 ms, sub-frame."""
    h = 64
    e1 = librosa.onset.onset_strength(y=stem_sum, sr=SR, hop_length=h); e2 = librosa.onset.onset_strength(y=instrumental, sr=SR, hop_length=h)
    n = min(len(e1), len(e2)); a = e1[:n] - e1[:n].mean(); b = e2[:n] - e2[:n].mean()
    L = int(0.15 * SR / h); best, bi = None, 0
    cs = []
    for k in range(-L, L + 1):
        c = float(np.dot(a[max(0, k):n + min(0, k)], b[max(0, -k):n - max(0, k)])); cs.append(c)
    cs = np.array(cs); i = int(np.argmax(cs))
    off = 0.0
    if 0 < i < len(cs) - 1:
        y0, y1, y2 = cs[i - 1], cs[i], cs[i + 1]; den = y0 - 2 * y1 + y2
        off = 0.5 * (y0 - y2) / den if den else 0.0
    return (i - L + off) * h / SR
