/* Low-latency auto-tune for the voice-monitor stream (runs on the phone, before sending).
 * Pitch shifting: two-tap crossfaded delay line (W = 20 ms window, ~10 ms average added delay). Each tap's
 * delay sweeps at rate (1 - ratio), giving a pitch ratio; when a tap wraps, its weight is 0 (sin² crossfade).
 * Target: the song's reference note at the singer's heard time (folded to the singer's octave); when there is
 * no reference note or the singer is > 2.5 semitones away from it, the nearest semitone.
 * Scoring never sees this: the TV scores the raw YIN pitch, computed before correction. */
(function (root) {
  'use strict';
  function Shifter(sr, winMs) {
    this.sr = sr; this.W = Math.round((winMs || 20) / 1000 * sr);
    this.buf = new Float32Array(8192); this.mask = 8191; this.w = 0; this.phase = 0.5; this.ratio = 1;
  }
  Shifter.prototype.latencyMs = function () { return (this.W * 0.5 + 2) / this.sr * 1000; };
  Shifter.prototype.read = function (d) {
    var p = this.w - d, i = Math.floor(p), f = p - i, b = this.buf, m = this.mask;
    return b[i & m] * (1 - f) + b[(i + 1) & m] * f;
  };
  /** Process a block in place-safe manner: returns a new Float32Array. ratio = output/input frequency. */
  Shifter.prototype.process = function (x, ratio) {
    var y = new Float32Array(x.length), W = this.W, r0 = this.ratio, n = x.length;
    for (var k = 0; k < n; k++) {
      var r = r0 + (ratio - r0) * (k + 1) / n;          // ramp the ratio across the block (no zipper noise)
      this.buf[this.w & this.mask] = x[k];
      if (Math.abs(r - 1) < 1e-3) {                     // idle: steer to a single tap (phase 0.5) -> no comb colouring
        var dp = 0.5 - this.phase; this.phase += Math.max(-0.002 / W * 8, Math.min(0.002 / W * 8, dp));
      } else { this.phase += (1 - r) / W; this.phase -= Math.floor(this.phase); }
      var ph = this.phase, pb = ph + 0.5; if (pb >= 1) pb -= 1;
      var sa = Math.sin(Math.PI * ph), wA = sa * sa;     // wA + wB = 1; a tap is silent exactly when it wraps
      y[k] = wA * this.read(ph * W + 2) + (1 - wA) * this.read(pb * W + 2);
      this.w++;
    }
    this.ratio = ratio;
    return y;
  };

  function midiOf(f) { return 69 + 12 * Math.log2(f / 440); }
  /** Reference note (MIDI) sounding at time t (seconds) in notes[{t,d,midi}], or null. */
  function refAt(notes, t, hint) {
    if (!notes || !notes.length) return null;
    var i = hint && hint.i || 0;
    if (i >= notes.length || notes[i].t > t) i = 0;
    while (i < notes.length && notes[i].t + notes[i].d < t) i++;
    if (hint) hint.i = i;
    return i < notes.length && notes[i].t <= t ? notes[i].midi : null;
  }
  /** Semitone correction (target - detected) for a detected pitch f (Hz). */
  function correction(f, ref) {
    if (!(f > 0)) return 0;
    var m = midiOf(f);
    if (ref != null) {
      var folded = ref + 12 * Math.round((m - ref) / 12);  // reference note in the singer's octave
      if (Math.abs(folded - m) <= 2.5) return folded - m;
    }
    return Math.round(m) - m;                              // fallback: nearest semitone
  }
  /** Stateful tuner: per hop, smooths the ratio. strength 0..1 (1 = hard tune / fast retune). */
  function AutoTune(sr) { this.shifter = new Shifter(sr, 20); this.ratio = 1; this.hint = { i: 0 }; this.lastCorr = 0; }
  AutoTune.prototype.process = function (x, f, strength, notes, heardT) {
    var corr = f > 0 && strength > 0 ? correction(f, refAt(notes, heardT, this.hint)) * strength : 0;
    this.lastCorr = corr;
    var target = Math.pow(2, corr / 12), k = 0.25 + 0.6 * strength;
    this.ratio += (target - this.ratio) * k;
    return this.shifter.process(x, this.ratio);
  };
  var api = { Shifter: Shifter, AutoTune: AutoTune, correction: correction, refAt: refAt, midiOf: midiOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.KaraokeAutoTune = api;
})(this);
