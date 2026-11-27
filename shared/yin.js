/*
 * YIN fundamental-frequency estimator (de Cheveigné & Kawahara, 2002).
 * Shared by the iPhone mic page (real input) and the Node unit tests.
 * UMD: window.KaraokeYin in browsers, module.exports in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KaraokeYin = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULTS = {
    threshold: 0.15,   // CMNDF absolute threshold (lower = stricter)
    fmin: 70,          // Hz, lowest singing pitch we look for (~C#2)
    fmax: 1100,        // Hz, highest (~C#6)
    minRms: 0.01,      // absolute silence gate on the analysis window
    maxAperiodicity: 0.35 // reject frames whose best dip is still this high (noise)
  };

  function rms(buf) {
    var s = 0;
    for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return Math.sqrt(s / buf.length);
  }

  /**
   * @param {Float32Array|number[]} buf  mono samples, length N
   * @param {number} sampleRate
   * @param {object} [opts]
   * @returns {{freq:number, clarity:number, rms:number}} freq = 0 when unvoiced
   */
  function detect(buf, sampleRate, opts) {
    var o = {};
    for (var k in DEFAULTS) o[k] = (opts && opts[k] != null) ? opts[k] : DEFAULTS[k];
    var level = rms(buf);
    if (level < o.minRms) return { freq: 0, clarity: 0, rms: level };

    var tauMin = Math.max(2, Math.floor(sampleRate / o.fmax));
    var tauMax = Math.min(Math.floor(sampleRate / o.fmin), Math.floor(buf.length / 2));
    var W = buf.length - tauMax;           // integration window
    var d = new Float32Array(tauMax + 1);
    // Step 2: difference function
    for (var tau = 1; tau <= tauMax; tau++) {
      var sum = 0;
      for (var j = 0; j < W; j++) {
        var delta = buf[j] - buf[j + tau];
        sum += delta * delta;
      }
      d[tau] = sum;
    }
    // Step 3: cumulative mean normalised difference
    var cmnd = new Float32Array(tauMax + 1);
    cmnd[0] = 1;
    var running = 0;
    for (tau = 1; tau <= tauMax; tau++) {
      running += d[tau];
      cmnd[tau] = running > 0 ? d[tau] * tau / running : 1;
    }
    // Step 4: absolute threshold, take first dip below threshold, walk to its local minimum
    var best = -1;
    for (tau = tauMin; tau <= tauMax; tau++) {
      if (cmnd[tau] < o.threshold) {
        while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best === -1) {
      // no dip under threshold: take global minimum, but only accept if fairly periodic
      var minVal = Infinity;
      for (tau = tauMin; tau <= tauMax; tau++) if (cmnd[tau] < minVal) { minVal = cmnd[tau]; best = tau; }
      if (minVal > o.maxAperiodicity) return { freq: 0, clarity: 1 - minVal, rms: level };
    }
    // Step 5: parabolic interpolation
    var betterTau = best;
    if (best > tauMin && best < tauMax) {
      var s0 = cmnd[best - 1], s1 = cmnd[best], s2 = cmnd[best + 1];
      var denom = 2 * (2 * s1 - s2 - s0);
      if (denom !== 0) betterTau = best + (s2 - s0) / denom;
    }
    var freq = sampleRate / betterTau;
    if (freq < o.fmin || freq > o.fmax) return { freq: 0, clarity: 0, rms: level };
    return { freq: freq, clarity: Math.max(0, Math.min(1, 1 - cmnd[best])), rms: level };
  }

  /** Small streaming helper: median-of-3 smoothing + adaptive noise-floor gate. */
  function Tracker(opts) {
    this.hist = [];
    this.noiseFloor = 0.005;
    this.gateRatio = (opts && opts.gateRatio) || 3; // voice must be 3x louder than floor
  }
  Tracker.prototype.push = function (r) {
    // Noise floor learns only from unvoiced frames (room noise, breaths, chordal music
    // YIN rejects), falling fast and rising slowly, so sustained singing never gates itself.
    if (!(r.freq > 0)) {
      var a = r.rms < this.noiseFloor ? 0.2 : 0.03;
      this.noiseFloor = Math.max(0.0005, this.noiseFloor * (1 - a) + r.rms * a);
    }
    var f = (r.rms > this.noiseFloor * this.gateRatio) ? r.freq : 0;
    this.hist.push(f);
    if (this.hist.length > 3) this.hist.shift();
    if (f === 0) return 0;
    var voiced = this.hist.filter(function (x) { return x > 0; });
    if (voiced.length < 3) return f; // don't delay note onsets
    voiced.sort(function (x, y) { return x - y; });
    return voiced[1]; // median of 3 removes single-frame octave jumps
  };

  return { detect: detect, rms: rms, Tracker: Tracker, DEFAULTS: DEFAULTS };
});
