/*
 * KaraokeTV scoring engine — independent of where the song comes from.
 * Input: a reference note list [{t, d, midi}] (seconds) and pitch frames
 * [{t, f}] on the same song timeline (f in Hz, 0 = unvoiced/silent).
 *
 * FORMULA (documented in docs/SCORING.md):
 *   cents(f, midi)  = octave-folded |1200*log2(f / hz(midi))|, in [0, 600]
 *   credit(e)       = 1                     if e <= 35 cents
 *                   = 1 - (e - 35) / 215    if 35 < e < 250
 *                   = 0                     if e >= 250 (or unvoiced)
 *   For a note, split [t+δ, t+d+δ] into 50 ms bins; bin credit = best frame credit in bin (0 if none).
 *   N(δ) = mean(bin credit) * (1 - 0.5 * |δ| / 0.15)   for δ in {-150..+150 ms, 25 ms steps}
 *   noteScore = max over δ of N(δ)   (timing accuracy: late/early singing costs up to 50%)
 *   rating: Perfect >= 0.85, Great >= 0.65, Good >= 0.40, else Miss
 *   final score = round(100 * Σ noteScore_i * d_i / Σ d_i)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KaraokeScoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONFIG = {
    perfectCents: 35,
    zeroCents: 250,
    binSec: 0.05,
    maxShiftSec: 0.15,
    shiftStepSec: 0.025,
    shiftPenalty: 0.5,
    ratings: [['Perfect', 0.85], ['Great', 0.65], ['Good', 0.40]]
  };

  function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function hzToMidi(f) { return 69 + 12 * Math.log(f / 440) / Math.LN2; }

  /** Octave-folded cents distance: singing an octave (or two) away is not penalised. */
  function centsOff(freq, midi) {
    if (!(freq > 0)) return Infinity;
    var raw = 1200 * Math.log(freq / midiToHz(midi)) / Math.LN2;
    var folded = ((raw % 1200) + 1800) % 1200 - 600;
    return Math.abs(folded);
  }

  function frameCredit(cents) {
    if (cents <= CONFIG.perfectCents) return 1;
    if (cents >= CONFIG.zeroCents) return 0;
    return 1 - (cents - CONFIG.perfectCents) / (CONFIG.zeroCents - CONFIG.perfectCents);
  }

  function rate(score) {
    for (var i = 0; i < CONFIG.ratings.length; i++) if (score >= CONFIG.ratings[i][1]) return CONFIG.ratings[i][0];
    return 'Miss';
  }

  /** frames must be sorted by t. Returns {score, shift, rating}. */
  function scoreNote(note, frames) {
    var best = { score: 0, shift: 0 };
    var nb = Math.max(1, Math.round(note.d / CONFIG.binSec));
    var binLen = note.d / nb;
    var lo = lowerBound(frames, note.t - CONFIG.maxShiftSec);
    for (var shift = -CONFIG.maxShiftSec; shift <= CONFIG.maxShiftSec + 1e-9; shift += CONFIG.shiftStepSec) {
      var start = note.t + shift, end = start + note.d;
      var bins = new Float32Array(nb);
      for (var i = lo; i < frames.length && frames[i].t < end; i++) {
        var fr = frames[i];
        if (fr.t < start) continue;
        var b = Math.min(nb - 1, Math.floor((fr.t - start) / binLen));
        var c = frameCredit(centsOff(fr.f, note.midi));
        if (c > bins[b]) bins[b] = c;
      }
      var sum = 0;
      for (var k = 0; k < nb; k++) sum += bins[k];
      var s = (sum / nb) * (1 - CONFIG.shiftPenalty * Math.abs(shift) / CONFIG.maxShiftSec);
      if (s > best.score + 1e-9) best = { score: s, shift: shift };
    }
    best.rating = rate(best.score);
    return best;
  }

  function lowerBound(arr, t) {
    var a = 0, b = arr.length;
    while (a < b) { var m = (a + b) >> 1; if (arr[m].t < t) a = m + 1; else b = m; }
    return a;
  }

  function finalScore(notes, results) {
    var num = 0, den = 0;
    for (var i = 0; i < notes.length; i++) { den += notes[i].d; num += (results[i] ? results[i].score : 0) * notes[i].d; }
    return den ? Math.round(100 * num / den) : 0;
  }

  /** Whole-song batch scoring (used by tests and the results screen). */
  function scoreSong(notes, frames) {
    frames = frames.slice().sort(function (a, b) { return a.t - b.t; });
    var results = notes.map(function (n) { return scoreNote(n, frames); });
    var counts = { Perfect: 0, Great: 0, Good: 0, Miss: 0 };
    results.forEach(function (r) { counts[r.rating]++; });
    return { score: finalScore(notes, results), notes: results, counts: counts };
  }

  /**
   * Live scorer: feed frames as they arrive (song-timeline t), call update(now)
   * every animation frame; it finalises notes once their timing window has passed.
   */
  function LiveScorer(notes) {
    this.notes = notes;
    this.frames = [];
    this.results = new Array(notes.length);
    this.next = 0;
    this.totalDur = notes.reduce(function (s, n) { return s + n.d; }, 0);
    this.earned = 0;
    this.counts = { Perfect: 0, Great: 0, Good: 0, Miss: 0 };
    this.combo = 0; this.maxCombo = 0;
  }
  LiveScorer.prototype.addFrame = function (t, f) {
    // keep sorted (frames normally arrive in order)
    var fr = { t: t, f: f };
    var arr = this.frames;
    if (!arr.length || arr[arr.length - 1].t <= t) arr.push(fr);
    else arr.splice(lowerBound(arr, t), 0, fr);
  };
  /** returns array of newly finalised {index, note, score, rating} */
  LiveScorer.prototype.update = function (now) {
    var out = [];
    while (this.next < this.notes.length) {
      var n = this.notes[this.next];
      if (now < n.t + n.d + CONFIG.maxShiftSec + 0.05) break;
      var r = scoreNote(n, this.frames);
      this.results[this.next] = r;
      this.earned += r.score * n.d;
      this.counts[r.rating]++;
      if (r.rating === 'Miss') this.combo = 0; else { this.combo++; this.maxCombo = Math.max(this.maxCombo, this.combo); }
      out.push({ index: this.next, note: n, score: r.score, rating: r.rating });
      this.next++;
    }
    return out;
  };
  /** v13.13 late join (Battle · trade lines): swap the not-yet-finalised tail of this scorer's note list. Notes already finalised (this.next) must stay as the prefix. */
  LiveScorer.prototype.replaceNotes = function (notes) {
    var keep = Math.min(this.next, notes.length);
    this.notes = notes; this.results = this.results.slice(0, keep); this.results.length = notes.length;
    this.totalDur = notes.reduce(function (s, n) { return s + n.d; }, 0);
  };
  /** Points banked so far, on the 0–100 scale of the whole song. */
  LiveScorer.prototype.liveScore = function () { return this.totalDur ? Math.round(100 * this.earned / this.totalDur) : 0; };
  LiveScorer.prototype.finish = function () {
    this.update(Infinity);
    return { score: finalScore(this.notes, this.results), counts: this.counts, maxCombo: this.maxCombo, notes: this.results };
  };

  return {
    CONFIG: CONFIG, midiToHz: midiToHz, hzToMidi: hzToMidi, centsOff: centsOff,
    frameCredit: frameCredit, rate: rate, scoreNote: scoreNote, scoreSong: scoreSong,
    LiveScorer: LiveScorer
  };
});

/*
 * Latency calibration (pure function, unit-tested). Frames are on the TV audio timeline with
 * network + analysis latency already removed, but NOT the TV speaker delay. For each known beep,
 * the first frame within 100 cents of the beep pitch (or its octave) marks the heard onset.
 * outputLatency = median(onset - beepTime) over beeps found; needs >= 3 beeps and a tight spread.
 */
(function (root) {
  var S = (typeof module === 'object' && module.exports) ? module.exports : root.KaraokeScoring;
  S.calibrate = function (frames, beeps, freq) {
    var midi = S.hzToMidi(freq), offsets = [];
    beeps.forEach(function (b) {
      for (var i = 0; i < frames.length; i++) {
        var f = frames[i];
        if (f.t < b - 0.05 || f.t > b + 0.7 || !(f.f > 0)) continue;
        if (S.centsOff(f.f, midi) <= 100) { offsets.push(f.t - b); break; }
      }
    });
    if (offsets.length < 3) return { ok: false, found: offsets.length, reason: 'Heard ' + offsets.length + ' of ' + beeps.length + ' beeps' };
    offsets.sort(function (a, b) { return a - b; });
    var med = offsets[Math.floor(offsets.length / 2)];
    var spread = offsets[offsets.length - 1 - Math.floor(offsets.length / 4)] - offsets[Math.floor(offsets.length / 4)];
    if (spread > 0.12) return { ok: false, found: offsets.length, reason: 'Timing too inconsistent (' + Math.round(spread * 1000) + ' ms spread)' };
    return { ok: true, found: offsets.length, latencyMs: Math.max(0, Math.min(600, Math.round(med * 1000))), spreadMs: Math.round(spread * 1000) };
  };
})(typeof self !== 'undefined' ? self : this);
