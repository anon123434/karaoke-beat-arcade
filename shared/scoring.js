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

  // ---------- combo rule (v13.16: timing only; the score, ratings and counts still come from scoreNote, untouched) ----
  // A note keeps the combo alive when the singer is VOICED during the note's timing window, whatever the pitch: at its best
  // timing (+-90 ms: late / early / sliding in) at least ~35% of the note's duration holds voiced frames (short unvoiced gaps
  // < 150 ms between voiced frames are bridged, so a consonant or a breath inside a note does not break it; notes < 150 ms
  // get a slightly wider window), and at least 20% of the note's own span must be voiced (a shifted window can't borrow a
  // neighbour's singing to cover a skipped note). The streak breaks only when the singer is silent / mostly absent through the note or only
  // sings outside its time window. Rests and gaps between notes never break it. A wrong-pitch note therefore keeps the streak
  // but still scores (and is rated) Miss / Good exactly as before. Set COMBO.timingOnly = false for the v13.15 pitch rule.
  var COMBO = { timingOnly: true, minCore: 0.2, tolCents: 150, minCov: 0.35, minVoiced: 0.30, shiftMax: 0.09, shiftStep: 0.03, minConf: 0.55, frameCap: 0.02, bridgeMax: 0.15, vibWin: 0.045, shortNote: 0.15 };

  function signedCents(freq, midi) {
    var raw = 1200 * Math.log(freq / midiToHz(midi)) / Math.LN2;
    return ((raw % 1200) + 1800) % 1200 - 600;
  }

  /** frames sorted by t, [{t, f, c?}]. Returns {hit, cov, voiced, reason} (reason: '' | 'silent' | 'off'). */
  function comboEval(note, frames) {
    var span = COMBO.shiftMax + COMBO.vibWin + 0.03, a = lowerBound(frames, note.t - span), end = note.t + note.d + span;
    var ts = [], es = [], any = [];
    for (var i = a; i < frames.length && frames[i].t <= end; i++) {
      var fr = frames[i];
      if (!(fr.f > 0) || (fr.c != null && fr.c < COMBO.minConf)) continue;
      ts.push(fr.t); es.push(signedCents(fr.f, note.midi));
    }
    var n = ts.length, med = new Array(n), eff = new Array(n), k;
    for (k = 0; k < n; k++) {   // median of 3 (single-frame glitches), then the lenient of "now" and the short-window mean (vibrato centre)
      var x0 = es[Math.max(0, k - 1)], x1 = es[k], x2 = es[Math.min(n - 1, k + 1)];
      med[k] = Math.max(Math.min(x0, x1), Math.min(Math.max(x0, x1), x2));
    }
    for (k = 0; k < n; k++) {
      var sum = 0, cnt = 0;
      for (var j = k; j >= 0 && ts[k] - ts[j] <= COMBO.vibWin; j--) { sum += med[j]; cnt++; }
      for (j = k + 1; j < n && ts[j] - ts[k] <= COMBO.vibWin; j++) { sum += med[j]; cnt++; }
      eff[k] = Math.min(Math.abs(med[k]), Math.abs(sum / cnt));
    }
    var best = { cov: 0, voiced: 0 }, any0 = 0, cpad = note.d < COMBO.shortNote ? (COMBO.shortNote - note.d) / 2 : 0;
    for (k = 0; k < n; k++) if (ts[k] >= note.t && ts[k] <= note.t + note.d) any0 += Math.min(COMBO.frameCap, (ts[k + 1] || ts[k] + COMBO.frameCap) - ts[k]);
    for (var sh = -COMBO.shiftMax; sh <= COMBO.shiftMax + 1e-9; sh += COMBO.shiftStep) {
      var pad = note.d < COMBO.shortNote ? (COMBO.shortNote - note.d) / 2 : 0,   // very short notes (< 150 ms, often a syllable the singer glides through): look a little wider
          t0 = note.t + sh - pad, t1 = note.t + sh + note.d + pad, vo = 0, br = 0;
      for (k = 0; k < n; k++) {
        if (ts[k] < t0 || ts[k] > t1 || (!COMBO.timingOnly && eff[k] > COMBO.tolCents)) continue;
        var nxt = k + 1 < n ? ts[k + 1] : ts[k] + COMBO.frameCap, dt = Math.min(nxt, t1) - ts[k], own = Math.min(dt, COMBO.frameCap);
        vo += own;
        if (dt > own && dt < COMBO.bridgeMax && k + 1 < n && (COMBO.timingOnly || eff[k + 1] <= COMBO.tolCents)) br += dt - own;
      }
      var cov = (vo + br) / note.d, vv = vo / note.d;
      if (vv >= COMBO.minVoiced && cov > best.cov) best = { cov: cov, voiced: vv };
      else if (!best.cov && vv > best.voiced) best.voiced = vv;
    }
    var core = 0;   // voiced time inside the note's OWN span (a shifted window must not borrow a whole neighbour's singing to cover a skipped note)
    if (COMBO.minCore > 0) for (k = 0; k < n; k++) if (ts[k] >= note.t - cpad && ts[k] <= note.t + note.d + cpad) core += Math.min(COMBO.frameCap, (ts[k + 1] || ts[k] + COMBO.frameCap) - ts[k]);
    var hit = best.cov >= COMBO.minCov && (COMBO.minCore <= 0 || core / note.d >= COMBO.minCore);
    return { hit: hit, cov: Math.min(1, best.cov), voiced: best.voiced, reason: hit ? '' : any0 < 0.25 * note.d ? 'silent' : 'off' }   // 'off' = voiced only outside the note's window (or, with timingOnly false, wrong pitch);
  }

  /**
   * Render-only pitch smoothing for the TV pitch trace (never feeds the scorer): ignores low-confidence frames, folds octave jumps
   * (to the previous point, or the note's octave), median of 3, then a one-euro filter (fast moves pass, jitter / vibrato ripple is damped).
   * push(t, f, c, refMidi) -> null (nothing to draw this frame) or {t, m, join}; join = connect to the previous drawn point
   * (gaps < 150 ms are bridged unless the pitch jumped > 4 semitones across a gap). Adds about one frame (median) + ~30 ms (filter).
   */
  var SMOOTH = { minConf: 0.6, gap: 0.15, jump: 4, minCutoff: 5, beta: 0.4, dCutoff: 8 };
  function PitchSmoother(opts) { this.o = {}; for (var k in SMOOTH) this.o[k] = opts && opts[k] != null ? opts[k] : SMOOTH[k]; this.reset(); }
  PitchSmoother.prototype.reset = function () { this.hist = []; this.lastT = -9; this.x = null; this.dx = 0; this.lastDrawT = -9; this.lastM = null; };
  function alpha(cut, dt) { var tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
  PitchSmoother.prototype.push = function (t, f, c, ref) {
    var o = this.o;
    if (!(f > 0) || (c != null && c < o.minConf)) return null;
    var m = hzToMidi(f), gap = t - this.lastT;
    if (gap > o.gap) { this.hist = []; this.x = null; }
    var anchor = this.x != null ? this.x : ref;
    if (anchor == null) anchor = m;
    var v = m; while (v - anchor > 6) v -= 12; while (anchor - v > 6) v += 12;
    if (ref != null && Math.abs(v - ref) > 8) { v = m; while (v - ref > 6) v -= 12; while (ref - v > 6) v += 12; }
    this.hist.push(v); if (this.hist.length > 3) this.hist.shift();
    var h = this.hist, mv = h.length < 3 ? v : Math.max(Math.min(h[0], h[1]), Math.min(Math.max(h[0], h[1]), h[2]));
    var join = this.lastM != null && t - this.lastDrawT <= o.gap;
    if (this.x == null) { this.x = mv; this.dx = 0; }
    else {
      var dt = Math.max(0.004, Math.min(0.2, t - this.lastT)), raw = (mv - this.x) / dt;
      this.dx += alpha(o.dCutoff, dt) * (raw - this.dx);
      this.x += alpha(o.minCutoff + o.beta * Math.abs(this.dx), dt) * (mv - this.x);
    }
    if (join && t - this.lastDrawT > 0.03 && Math.abs(this.x - this.lastM) > o.jump) join = false;
    this.lastT = t;
    var out = { t: t, m: this.x, join: join, pm: this.lastM, pt: this.lastDrawT };
    this.lastDrawT = t; this.lastM = this.x;
    return out;
  };

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
    this.combo = 0; this.maxCombo = 0; this.breaks = 0; this.breakSilent = 0; this.saves = 0;
  }
  LiveScorer.prototype.addFrame = function (t, f, c) {
    // keep sorted (frames normally arrive in order); c = optional pitch confidence (0-1) from the phone
    var fr = c > 0 || c === 0 ? { t: t, f: f, c: c } : { t: t, f: f };
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
      var ce = comboEval(n, this.frames), keep = ce.hit || r.rating !== 'Miss', saved = keep && r.rating === 'Miss';
      if (!keep) { this.combo = 0; this.breaks++; if (ce.reason === 'silent') this.breakSilent++; } else { this.combo++; this.maxCombo = Math.max(this.maxCombo, this.combo); if (saved) this.saves++; }
      out.push({ index: this.next, note: n, score: r.score, rating: r.rating, saved: saved, cov: ce.cov });
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
    return { score: finalScore(this.notes, this.results), counts: this.counts, maxCombo: this.maxCombo, breaks: this.breaks, saves: this.saves, notes: this.results };
  };

  return {
    CONFIG: CONFIG, midiToHz: midiToHz, hzToMidi: hzToMidi, centsOff: centsOff,
    frameCredit: frameCredit, rate: rate, scoreNote: scoreNote, scoreSong: scoreSong,
    LiveScorer: LiveScorer, comboEval: comboEval, COMBO: COMBO, PitchSmoother: PitchSmoother, SMOOTH: SMOOTH
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
