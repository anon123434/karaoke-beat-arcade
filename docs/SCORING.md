# KaraokeTV scoring and pitch pipeline

## Phone (iPhone Safari, `phone/phone.js` + `shared/yin.js`)
- `getUserMedia` with echo cancellation, noise suppression and AGC **off** (they distort pitch).
- High-pass 65 Hz → low-pass 1.4 kHz → ScriptProcessor hop **512** samples (~10.7 ms at 48 kHz).
- 2× decimation to ~24 kHz, **YIN** (de Cheveigné & Kawahara 2002) on a 1024-sample (~42 ms) window:
  CMNDF threshold 0.15, search range 70–1100 Hz, parabolic interpolation, aperiodicity reject > 0.35.
- Gating: absolute RMS floor 0.004, plus an adaptive noise floor learned only from *unvoiced* frames
  (voice must be 2.5× louder). Sustained singing never gates itself.
- Median-of-3 smoothing removes single-frame octave jumps without delaying note onsets.
- ~94 pitch frames/s go over `wss://` with the phone's latency estimate = median RTT/2 + analysis delay (~32 ms).

## Timeline sync (`tv/app.js`)
Frame song-time = `audioClock − (phoneLatency + tvLeg + outputLatency)`.
- `phoneLatency`, `tvLeg`: measured continuously by ping/pong RTTs.
- `outputLatency` (TV speaker/audio pipeline + air): default 120 ms; **measured** by *Sync my mic*:
  the TV plays 7 beeps at 880 Hz at irregular known times, the phone hears them, and
  `KaraokeScoring.calibrate()` takes the median onset offset (needs ≥3 beeps, IQR ≤120 ms). Saved on the TV.
- The pitch lane, lyric wipe and scoring all run on that "heard" timeline.

## Formula (`shared/scoring.js`, reproducible, unit-tested)
```
cents(f, midi) = octave-folded |1200·log2(f / hz(midi))|  ∈ [0, 600]   (singing an octave away is fine)
credit(e)      = 1 if e ≤ 35¢;  1 − (e−35)/215 if 35 < e < 250;  0 if e ≥ 250¢ or unvoiced
note window    = [t+δ, t+d+δ] split into 50 ms bins; bin credit = best frame credit in the bin (0 if none)
N(δ)           = mean(bin credit) · (1 − 0.5·|δ|/150 ms),  δ ∈ {−150 … +150 ms, 25 ms steps}
noteScore      = max_δ N(δ)                (timing accuracy: early/late costs up to 50%)
rating         = Perfect ≥ 0.85, Great ≥ 0.65, Good ≥ 0.40, else Miss
final score    = round(100 · Σ noteScore_i·d_i / Σ d_i)       (0–100, duration-weighted)
```
Live score on the TV = points banked so far on the same 0–100 scale.

## Reference results (synthetic test signals, `npm test` / `npm run check:browser`)
| Input (synthetic) | Score |
|---|---|
| Exact melody | 100 |
| Exact melody one octave down | 100 |
| 30 cents sharp throughout | 100 |
| One semitone flat throughout | 60–80 |
| 100 ms late / 400 ms late | 60–99 / much lower |
| 30% dropouts + ±30¢ jitter | > 80 |
| Monotone (one note) | < 35 |
| Three semitones off | ≤ 25 (E2E: 2) |
| Silence | 0 |
| Instrumental track alone into the mic (bleed worst case) | 20 |
