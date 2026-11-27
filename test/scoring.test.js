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

// ---- v13.15 combo rule + trace smoother (SYNTHETIC frames) ----
const cf = (note, fn, hop = 0.0107) => { const o = []; for (let t = note.t - 0.3; t < note.t + note.d + 0.3; t += hop) o.push({ t, f: fn(t), c: 0.95 }); return o; };
const N = { t: 1, d: 0.6, midi: 60 };

test('comboEval: vibrato and a breath inside the note keep the combo', () => {
  const f = cf(N, t => (t >= N.t && t <= N.t + N.d && !(t > 1.28 && t < 1.38)) ? hz(60 + 0.45 * Math.sin(t * 2 * Math.PI * 5.5)) : 0);
  assert.ok(S.comboEval(N, f).hit);
});
test('comboEval: sliding into the note from below keeps the combo', () => {
  const f = cf(N, t => (t >= N.t && t <= N.t + N.d) ? hz(60 - Math.max(0, 1 - (t - N.t) / 0.12) * 2) : 0);
  assert.ok(S.comboEval(N, f).hit);
});
test('comboEval: silent through the note breaks', () => {
  const r = S.comboEval(N, cf(N, () => 0));
  assert.ok(!r.hit); assert.strictEqual(r.reason, 'silent');
});
test('comboEval (timing rule): a wrong pitch sung on time keeps the streak, but still scores a Miss', () => {
  const f = cf(N, () => hz(63));
  assert.ok(S.comboEval(N, f).hit);
  assert.strictEqual(S.scoreNote(N, f.map(x => ({ t: x.t, f: x.f }))).rating, 'Miss');   // scoring untouched
});
test('comboEval: voiced only 20% of the note, or only outside its time window, breaks', () => {
  assert.ok(!S.comboEval(N, cf(N, t => (t >= N.t - 0.3 && t < N.t - 0.12) ? hz(60) : 0)).hit);          // sung entirely before the window
  assert.ok(!S.comboEval(N, cf(N, t => (t >= N.t && t < N.t + 0.1) ? hz(60) : 0)).hit);                  // 17% of the note
  assert.ok(S.comboEval(N, cf(N, t => (t >= N.t + 0.05 && t < N.t + 0.5) ? hz(66) : 0)).hit);            // late/early still counts, any pitch
});
test('comboEval: a skipped note between two sung notes breaks (neighbours cannot cover it)', () => {
  const a = { t: 0, d: 0.5, midi: 60 }, b = { t: 0.5, d: 0.3, midi: 62 }, c = { t: 0.8, d: 0.5, midi: 64 };
  const fr = []; for (let t = 0; t < 1.5; t += 0.0107) fr.push({ t, f: (t < 0.5 || (t >= 0.8 && t < 1.3)) ? hz(60) : 0, c: 0.95 });
  assert.ok(!S.comboEval(b, fr).hit);
});
test('comboEval: an octave-up singer still matches', () => {
  assert.ok(S.comboEval(N, cf(N, t => (t >= N.t && t <= N.t + N.d) ? hz(72) : 0)).hit);
});
test('LiveScorer: rests / gaps never break a combo', () => {
  const notes = [{ t: 0, d: 0.5, midi: 60 }, { t: 3, d: 0.5, midi: 62 }];
  const sc = new S.LiveScorer(notes);
  for (let t = 0; t < 4; t += 0.0107) { const n = notes.find(x => t >= x.t && t < x.t + x.d); sc.addFrame(t, n ? hz(n.midi) : 0, 0.95); sc.update(t); }
  assert.strictEqual(sc.combo, 2); assert.strictEqual(sc.breaks, 0);
});

test('PitchSmoother: bridges a short unvoiced gap, breaks on a long one', () => {
  const sm = new S.PitchSmoother(); const out = [];
  for (let t = 0; t < 1.5; t += 0.0107) { const gap = (t > 0.5 && t < 0.6) || (t > 1.0 && t < 1.4); out.push(sm.push(t, gap ? 0 : hz(60), 0.95, 60)); }
  const pts = out.filter(Boolean), joined = pts.filter(p => p.join).length;
  assert.ok(joined > pts.length * 0.9, 'short gap bridged: ' + joined + '/' + pts.length);
  assert.ok(pts.filter(p => !p.join).length >= 2, 'long gap starts a new line');
});
test('PitchSmoother: octave glitches snap to the reference octave', () => {
  const sm = new S.PitchSmoother(); let worst = 0;
  for (let t = 0; t < 1; t += 0.0107) { const o = sm.push(t, hz(((t * 100) | 0) % 7 === 3 ? 72 : 60), 0.95, 60); if (o) worst = Math.max(worst, Math.abs(o.m - 60)); }
  assert.ok(worst < 1.5, 'worst ' + worst);
});
test('PitchSmoother: low-confidence frames are ignored; added latency stays small', () => {
  const sm = new S.PitchSmoother(); const hit = [];
  for (let t = 0; t < 1; t += 0.0107) { const o = sm.push(t, hz(t < 0.5 ? 60 : 63), t > 0.2 && t < 0.25 ? 0.2 : 0.95, 60); if (o) hit.push([t, o.m]); }
  const t90 = hit.find(([t, m]) => t >= 0.5 && m >= 62.7)[0] - 0.5;
  assert.ok(t90 <= 0.06, 'step 90% in ' + Math.round(t90 * 1000) + ' ms');
});
