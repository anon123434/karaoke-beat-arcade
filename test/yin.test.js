// Pitch detector tests. All signals here are SYNTHETIC test signals (labelled), not real input.
const test = require('node:test');
const assert = require('node:assert');
const Yin = require('../shared/yin');
const SR = 44100, N = 2048;

function synth(f, { harmonics = [1], vibratoCents = 0, noise = 0, amp = 0.3, sr = SR, n = N, seed = 1 } = {}) {
  const out = new Float32Array(n); let ph = 0, s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 1073741824 - 1; };
  for (let i = 0; i < n; i++) {
    const fi = f * Math.pow(2, vibratoCents * Math.sin(2 * Math.PI * 5.5 * i / sr) / 1200);
    ph += 2 * Math.PI * fi / sr;
    let v = 0; harmonics.forEach((a, k) => { v += a * Math.sin((k + 1) * ph); });
    out[i] = amp * v + noise * rnd();
  }
  return out;
}
const cents = (a, b) => Math.abs(1200 * Math.log2(a / b));

test('[synthetic] pure sines across the singing range are within 5 cents', () => {
  for (const f of [82.41, 110, 196, 261.63, 329.63, 440, 659.25, 880]) {
    const r = Yin.detect(synth(f), SR);
    assert.ok(r.freq > 0, 'voiced at ' + f);
    assert.ok(cents(r.freq, f) < 5, `f=${f} got ${r.freq.toFixed(2)}`);
  }
});

test('[synthetic] voice-like tone (weak fundamental, strong 2nd/3rd harmonics, vibrato, noise) is not an octave error', () => {
  for (const f of [130.81, 196, 293.66]) {
    const sig = synth(f, { harmonics: [0.35, 1, 0.7, 0.4, 0.25, 0.15], vibratoCents: 30, noise: 0.03 });
    const r = Yin.detect(sig, SR);
    assert.ok(r.freq > 0);
    assert.ok(cents(r.freq, f) < 40, `f=${f} got ${r.freq.toFixed(2)}`);
  }
});

test('[synthetic] silence and near-silence are unvoiced', () => {
  assert.strictEqual(Yin.detect(new Float32Array(N), SR).freq, 0);
  assert.strictEqual(Yin.detect(synth(220, { amp: 0.001 }), SR).freq, 0);
});

test('[synthetic] white noise is rejected as unvoiced', () => {
  let voiced = 0;
  for (let seed = 1; seed <= 20; seed++) if (Yin.detect(synth(1, { amp: 0, noise: 0.3, seed }), SR).freq > 0) voiced++;
  assert.ok(voiced <= 2, 'noise frames detected as pitched: ' + voiced);
});

test('[synthetic] works at the iPhone 48 kHz rate', () => {
  const r = Yin.detect(synth(246.94, { sr: 48000, harmonics: [0.5, 1, 0.5] }), 48000);
  assert.ok(cents(r.freq, 246.94) < 10);
});

test('Tracker: median smoothing removes a one-frame octave jump; noise floor never gates sustained singing', () => {
  const t = new Yin.Tracker({ gateRatio: 2.5 });
  const out = [220, 220, 440, 220, 220].map(f => t.push({ freq: f, rms: 0.1 }));
  assert.strictEqual(out[2], 220);
  for (let i = 0; i < 2000; i++) t.push({ freq: 220, rms: 0.1 }); // ~45 s of continuous singing
  assert.strictEqual(t.push({ freq: 220, rms: 0.1 }), 220);
  // quiet background (unvoiced) frames set the floor; quiet hum below floor*ratio is gated
  for (let i = 0; i < 50; i++) t.push({ freq: 0, rms: 0.05 });
  assert.strictEqual(t.push({ freq: 300, rms: 0.06 }), 0);
});

test('[synthetic] phone pipeline config: 2x-decimated 24 kHz, 1024 window still covers 82–880 Hz within 10 cents', () => {
  for (const f of [82.41, 130.81, 261.63, 523.25, 880]) {
    const r = Yin.detect(synth(f, { sr: 24000, n: 1024, harmonics: [0.6, 1, 0.4] }), 24000);
    assert.ok(Math.abs(1200 * Math.log2(r.freq / f)) < 10, f + ' -> ' + r.freq);
  }
});
