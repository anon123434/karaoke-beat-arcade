"""Drum transcription v2b: broadband onsets of the Demucs drums stem, each classified kick / snare / hat / crash.
Demucs often routes a kick's low body into the BASS stem, so the kick cue is a sharp low-band (40-120 Hz) rise in the
drum stem OR in the full instrumental at that instant (bass notes rise too, so a short decay is also required)."""
import numpy as np, librosa
from scipy.signal import find_peaks
SR, HOP, NFFT = 22050, 128, 1024
def _bands(y):
    S = np.abs(librosa.stft(y, n_fft=NFFT, hop_length=HOP)) ** 2; f = librosa.fft_frequencies(sr=SR, n_fft=NFFT)
    B = lambda lo, hi: S[(f >= lo) & (f < hi)].sum(0) + 1e-10
    return B(40, 120), B(150, 400), B(1000, 5000), B(7000, 11000), S
def _rise(E, i, pre=4, post=4):
    return float(np.log(E[min(len(E) - 1, i + post)].max() if np.ndim(E[min(len(E) - 1, i + post)]) else E[min(len(E) - 1, i + post)]) - np.log(E[max(0, i - pre)]))
def transcribe(y, yinst=None):
    lo, body, mid, hi, S = _bands(y)
    ilo = _bands(yinst)[0] if yinst is not None else lo
    n = min(len(lo), len(ilo)); lo, body, mid, hi, ilo = lo[:n], body[:n], mid[:n], hi[:n], ilo[:n]
    oenv = librosa.onset.onset_strength(S=librosa.power_to_db(S[:, :n]), sr=SR, hop_length=HOP)
    ref = np.percentile(oenv, 99.5)
    on, _ = find_peaks(oenv, height=ref * 0.12, distance=int(0.07 * SR / HOP))
    rms = np.sqrt(S[:, :n].sum(0)); quiet = np.percentile(rms, 99) * 0.03
    loR, iloR, midR, hiR = [np.percentile(x, 99) for x in (lo, ilo, mid, hi)]
    out = {'kick': [], 'snare': [], 'hat': [], 'crash': []}
    t_of = lambda i: float(i * HOP / SR)
    w = lambda E, i, a, b: E[max(0, i + a):min(len(E), i + b)].max()
    for i in on:
        if rms[i] < quiet: continue
        L, Bo, M, H = w(lo, i, 0, 5), w(body, i, 0, 5), w(mid, i, 0, 5), w(hi, i, 0, 5); tot = L + Bo + M + H
        sl, sb, sm, sh = L / tot, Bo / tot, M / tot, H / tot
        irise = float(np.log(w(ilo, i, 0, 5) / w(ilo, i, -6, -1)))
        st = float(min(1.0, (oenv[i] / ref) ** 0.7))
        kick = sl >= 0.08 or (sl + sb) >= 0.3 or (irise >= 0.6 and sh < 0.5)   # low end in the drum stem, or a sharp low hit in the mix
        snare = sm >= 0.3                                                        # 1-5 kHz noise burst dominates
        if kick: out['kick'].append((t_of(i), st))
        if snare: out['snare'].append((t_of(i), st))
        if not kick and not snare:
            sus = np.median(hi[i:i + int(0.5 * SR / HOP)]) / hiR if i + 10 < n else 0
            (out['crash'] if sh > 0.5 and sus > 0.3 and st > 0.5 else out['hat']).append((t_of(i), st))
    return out
