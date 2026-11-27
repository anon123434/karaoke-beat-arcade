// [synthetic test signals] — generated sine tones, not presented as real singing.
const test = require('node:test'); const assert = require('node:assert');
const AT = require('../shared/autotune.js'); const Y = require('../shared/yin.js');
const sr = 24000;
function tone(f, n, ph = 0) { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin(2 * Math.PI * f * (i + ph) / sr); return x; }
function runShift(f, ratio, n = 256 * 94) {
  const s = new AT.Shifter(sr, 20); let out = [];
  for (let o = 0; o < n; o += 256) out.push(s.process(tone(f, 256, o), ratio));
  const y = new Float32Array(n); out.forEach((b, i) => y.set(b, i * 256));
  return Y.detect(y.slice(n - 2048), sr, { minRms: 0.001 }).freq;
}
test('[synthetic] shifter: +1 semitone moves 220 Hz to ~233 Hz', () => {
  const f = runShift(220, Math.pow(2, 1 / 12)); assert.ok(Math.abs(1200 * Math.log2(f / 233.08)) < 25, 'got ' + f);
});
test('[synthetic] shifter: -2 semitones', () => {
  const f = runShift(330, Math.pow(2, -2 / 12)); assert.ok(Math.abs(1200 * Math.log2(f / 293.66)) < 25, 'got ' + f);
});
test('[synthetic] shifter idle passes the pitch through, added delay ~12 ms', () => {
  const s = new AT.Shifter(sr, 20); assert.ok(s.latencyMs() < 13, s.latencyMs());
  const f = runShift(440, 1); assert.ok(Math.abs(1200 * Math.log2(f / 440)) < 10, 'got ' + f);
});
test('correction pulls to the reference note in the singer octave, else nearest semitone', () => {
  const A3 = 220, sharp = A3 * Math.pow(2, 0.4 / 12);
  assert.ok(Math.abs(AT.correction(sharp, 57) + 0.4) < 1e-9);          // ref A3
  assert.ok(Math.abs(AT.correction(sharp, 69) + 0.4) < 1e-9);          // ref A4 folded to the singer's octave
  assert.ok(Math.abs(AT.correction(sharp, 60) - (-0.4)) < 1e-9);       // 2.6 st from ref C4 -> nearest semitone
  assert.ok(Math.abs(AT.correction(A3 * Math.pow(2, 1.6 / 12), 59) - 0.4) < 1e-9); // toward ref B3 (+0.4)
  assert.strictEqual(AT.correction(0, 57), 0);
});
test('refAt finds the sounding note', () => {
  const notes = [{ t: 1, d: 0.5, midi: 60 }, { t: 2, d: 0.5, midi: 62 }]; const h = { i: 0 };
  assert.strictEqual(AT.refAt(notes, 0.5, h), null); assert.strictEqual(AT.refAt(notes, 1.2, h), 60);
  assert.strictEqual(AT.refAt(notes, 1.7, h), null); assert.strictEqual(AT.refAt(notes, 2.1, h), 62);
  assert.strictEqual(AT.refAt(notes, 1.1, h), 60);   // seeking backwards resets
});
test('[synthetic] AutoTune strength 1 corrects a 40-cent-flat tone toward the reference', () => {
  const t = new AT.AutoTune(sr), f0 = 220 * Math.pow(2, -0.4 / 12), notes = [{ t: 0, d: 10, midi: 57 }];
  const blocks = []; for (let o = 0; o < sr; o += 256) blocks.push(t.process(tone(f0, 256, o), f0, 1, notes, o / sr));
  const y = new Float32Array(blocks.length * 256); blocks.forEach((b, i) => y.set(b, i * 256));
  const f = Y.detect(y.slice(y.length - 2048), sr, { minRms: 0.001 }).freq;
  assert.ok(Math.abs(1200 * Math.log2(f / 220)) < 12, 'got ' + f);
});
