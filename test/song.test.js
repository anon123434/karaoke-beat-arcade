// Generated test-song artifacts are consistent with each other.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const D = path.join(__dirname, '../songs/twinkle');
const song = require(path.join(D, 'song.json'));
const melody = require(path.join(D, 'melody.json'));

test('song.json, melody.json, LRC and MIDI agree; WAV is valid and matches duration', () => {
  assert.deepStrictEqual(song.notes, melody);
  assert.strictEqual(melody.length, 42);
  const lrc = fs.readFileSync(path.join(D, 'lyrics.lrc'), 'utf8');
  assert.match(lrc, /\[00:02\.40\]<00:02\.40>Twin<00:03\.00>kle /);
  const wav = fs.readFileSync(path.join(D, 'instrumental.wav'));
  assert.strictEqual(wav.toString('ascii', 0, 4), 'RIFF'); assert.strictEqual(wav.readUInt32LE(24), 44100);
  assert.ok(Math.abs(wav.readUInt32LE(40) / 2 / 44100 - song.duration) < 0.01);
  // parse MIDI note-ons
  const mid = fs.readFileSync(path.join(D, 'melody.mid'));
  assert.strictEqual(mid.toString('ascii', 0, 4), 'MThd');
  const ppq = mid.readUInt16BE(12); let i = 22, tick = 0, ons = [], tempo = 0;
  const vlq = () => { let v = 0, b; do { b = mid[i++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  while (i < mid.length) {
    tick += vlq(); const st = mid[i++];
    if (st === 0xff) { const type = mid[i++], len = vlq(); if (type === 0x51) tempo = mid.readUIntBE(i, 3); i += len; if (type === 0x2f) break; }
    else if ((st & 0xf0) === 0x90) { ons.push({ tick, midi: mid[i] }); i += 2; } else i += 2;
  }
  assert.strictEqual(tempo, 600000);
  assert.deepStrictEqual(ons.map(o => o.midi), melody.map(n => n.midi));
  ons.forEach((o, k) => assert.ok(Math.abs(o.tick / ppq * 0.6 - melody[k].t) < 0.002));
});

test('[synthetic check] instrumental has no lead melody: per-note YIN on the WAV rarely matches the target note', () => {
  const Yin = require('../shared/yin'); const S = require('../shared/scoring');
  const wav = fs.readFileSync(path.join(D, 'instrumental.wav'));
  const pcm = new Float32Array((wav.length - 44) / 2); for (let k = 0; k < pcm.length; k++) pcm[k] = wav.readInt16LE(44 + k * 2) / 32768;
  const frames = [];
  for (let s = 0; s + 2048 < pcm.length; s += 1024) { const r = Yin.detect(pcm.subarray(s, s + 2048), 44100); frames.push({ t: (s + 1024) / 44100, f: r.freq }); }
  const bleed = S.scoreSong(song.notes, frames).score;
  // If the TV audio reached the phone mic directly, how much would it score on its own?
  console.log('    instrumental-only score (mic bleed worst case):', bleed);
  assert.ok(bleed < 50, 'instrumental alone scores ' + bleed);
});
