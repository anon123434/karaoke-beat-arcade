#!/usr/bin/env node
// Calibration track: 880 Hz beeps at irregular, known times (irregular so a beep can't be mistaken for its neighbour).
'use strict';
const fs = require('fs'), path = require('path');
const SR = 44100, BEEPS = [1.0, 1.9, 2.7, 3.8, 4.6, 5.7, 6.5], LEN = 0.14, DUR = 7.6;
const n = Math.ceil(DUR * SR), b = Buffer.alloc(44 + n * 2);
b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) {
  const t = i / SR; let v = 0;
  for (const s of BEEPS) if (t >= s && t < s + LEN) { const u = t - s; v = Math.sin(2 * Math.PI * 880 * u) * Math.min(1, u / 0.003, (LEN - u) / 0.01); }
  b.writeInt16LE(Math.round(v * 0.8 * 32767), 44 + i * 2);
}
const out = path.join(__dirname, '../songs/calibration');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'beeps.wav'), b);
fs.writeFileSync(path.join(out, 'calibration.json'), JSON.stringify({ freq: 880, beeps: BEEPS, beepLen: LEN, duration: DUR }));
console.log('calibration track written');
