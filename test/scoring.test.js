// Scoring formula tests. Pitch frames are SYNTHETIC (generated from the reference melody), labelled as such.
const test = require('node:test');
const assert = require('node:assert');
const S = require('../shared/scoring');
const song = require('../songs/twinkle/song.json');
const hz = S.midiToHz;

function frames(notes, fn, hop = 0.023) {
  const out = []; const end = notes[notes.length - 1].t + notes[notes.length - 1].d + 0.5;
  for (let t = 0; t < end; t += hop) {
    const n = notes.find(x => t >= x.t && t < x.t + x.d);
    out.push({ t, f: n ? fn(n, t) : 0 });
  }
  return out;
}

test('centsOff is octave-folded', () => {
  assert.ok(S.centsOff(hz(60), 60) < 1e-6);
  assert.ok(S.centsOff(hz(48), 60) < 1e-6);       // octave below
  assert.ok(S.centsOff(hz(72), 60) < 1e-6);       // octave above
  assert.ok(Math.abs(S.centsOff(hz(61), 60) - 100) < 1e-6);
  assert.ok(Math.abs(S.centsOff(hz(66), 60) - 600) < 1e-6); // tritone = worst case
  assert.strictEqual(S.centsOff(0, 60), Infinity);
});

test('frameCredit piecewise formula', () => {
  assert.strictEqual(S.frameCredit(0), 1);
  assert.strictEqual(S.frameCredit(35), 1);
  assert.ok(Math.abs(S.frameCredit(142.5) - 0.5) < 1e-9);
  assert.strictEqual(S.frameCredit(250), 0);
  assert.strictEqual(S.frameCredit(Infinity), 0);
});

test('[synthetic] perfect singing scores 100, all Perfect', () => {
  const r = S.scoreSong(song.notes, frames(song.notes, n => hz(n.midi)));
  assert.strictEqual(r.score, 100); assert.strictEqual(r.counts.Perfect, song.notes.length);
});

test('[synthetic] singing an octave lower (male voice) still scores 100', () => {
  assert.strictEqual(S.scoreSong(song.notes, frames(song.notes, n => hz(n.midi - 12))).score, 100);
});

test('[synthetic] silence scores 0, all Miss', () => {
  const r = S.scoreSong(song.notes, frames(song.notes, () => 0));
  assert.strictEqual(r.score, 0); assert.strictEqual(r.counts.Miss, song.notes.length);
});

test('[synthetic] one constant pitch (monotone) scores low', () => {
  const r = S.scoreSong(song.notes, frames(song.notes, () => hz(64)));
  assert.ok(r.score < 35, 'monotone score ' + r.score);
});

test('[synthetic] a semitone flat everywhere is mediocre; 30 cents off is still Perfect', () => {
  const flat = S.scoreSong(song.notes, frames(song.notes, n => hz(n.midi - 1))).score;
  assert.ok(flat >= 60 && flat <= 80, 'semitone flat ' + flat);
  assert.strictEqual(S.scoreSong(song.notes, frames(song.notes, n => hz(n.midi + 0.3))).score, 100);
});

test('[synthetic] timing: 100 ms late loses a bit, 400 ms late loses a lot', () => {
  const late = d => frames(song.notes, n => hz(n.midi)).map(f => ({ t: f.t + d, f: f.f }));
  const s100 = S.scoreSong(song.notes, late(0.1)).score, s400 = S.scoreSong(song.notes, late(0.4)).score;
  assert.ok(s100 >= 60 && s100 < 100, 'late 100ms ' + s100);
  assert.ok(s400 < s100 - 15, 'late 400ms ' + s400);
});

test('[synthetic] noisy input: 30% random dropouts + jitter still ranks above off-key singing', () => {
  let s = 7; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const noisy = S.scoreSong(song.notes, frames(song.notes, n => rnd() < 0.3 ? 0 : hz(n.midi + (rnd() - 0.5) * 0.6))).score;
  const offKey = S.scoreSong(song.notes, frames(song.notes, n => hz(n.midi + 3))).score;
  assert.ok(noisy > 80, 'noisy ' + noisy); assert.ok(offKey < 20, 'off-key ' + offKey);
});

test('LiveScorer matches batch scoring and finalises notes progressively', () => {
  const fr = frames(song.notes, (n, t) => (n.line % 2 ? hz(n.midi) : hz(n.midi + 2)));
  const live = new S.LiveScorer(song.notes);
  let finalised = 0;
  fr.forEach(f => { live.addFrame(f.t, f.f); finalised += live.update(f.t - 0.3).length; });
  assert.ok(finalised > 0 && finalised < song.notes.length);
  const r = live.finish();
  assert.strictEqual(r.score, S.scoreSong(song.notes, fr).score);
  assert.ok(live.liveScore() === r.score);
});

test('ratings thresholds', () => {
  assert.strictEqual(S.rate(0.9), 'Perfect'); assert.strictEqual(S.rate(0.7), 'Great');
  assert.strictEqual(S.rate(0.5), 'Good'); assert.strictEqual(S.rate(0.1), 'Miss');
});

test('[synthetic] calibrate: recovers a 180 ms speaker delay, rejects missing/noisy beeps', () => {
  const cal = require('../songs/calibration/calibration.json');
  const mk = (delay, jitter = 0, drop = 0) => {
    const fr = []; let s = 5; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    for (let t = 0; t < cal.duration; t += 0.0107) {
      const on = cal.beeps.some((b, k) => k >= drop && t >= b + delay + (k % 2 ? jitter : -jitter) && t < b + delay + cal.beepLen);
      fr.push({ t, f: on ? 880 * (1 + (rnd() - 0.5) * 0.01) : (rnd() < 0.05 ? 300 : 0) });
    }
    return fr;
  };
  const r = S.calibrate(mk(0.18), cal.beeps, cal.freq);
  assert.ok(r.ok && Math.abs(r.latencyMs - 180) <= 12, JSON.stringify(r));
  assert.strictEqual(S.calibrate(mk(0.18, 0, 5), cal.beeps, cal.freq).ok, false);   // only 2 beeps heard
  assert.strictEqual(S.calibrate(mk(0.18, 0.1), cal.beeps, cal.freq).ok, false);    // ±100 ms jitter
  assert.strictEqual(S.calibrate([], cal.beeps, cal.freq).ok, false);
});
