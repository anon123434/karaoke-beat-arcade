// [SYNTHETIC worst-case check] What would the phone mic score if it heard ONLY the TV speakers (singer silent)?
// Mixes instrumental + guide vocals at each guide level, runs the same YIN the phone uses, scores against the melody.
const { execFileSync } = require('child_process');
const path = require('path');
const Yin = require('../shared/yin'); const S = require('../shared/scoring');
const ROOT = path.resolve(__dirname, '..'), SR = 24000;
const pcm = f => { const b = execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ['twinkle', 'amazing-grace'];
const levels = { off: 0, low: 0.25, medium: 0.5, full: 1 };
for (const id of ids) {
  const d = path.join(ROOT, 'songs', id), song = require(path.join(d, 'song.json'));
  const inst = pcm(path.join(d, song.audio)), vox = pcm(path.join(d, song.guide));
  const row = [];
  for (const [name, g] of Object.entries(levels)) {
    const frames = [], buf = new Float32Array(1024);
    for (let s = 0; s + 1024 < Math.min(inst.length, vox.length); s += 512) {
      for (let k = 0; k < 1024; k++) buf[k] = inst[s + k] + g * vox[s + k];
      const r = Yin.detect(buf, SR, { minFreq: 70, maxFreq: 1100 });
      frames.push({ t: (s + 512) / SR, f: r.freq > 0 ? r.freq : 0 });
    }
    row.push(name + ' ' + S.scoreSong(song.notes, frames).score);
  }
  console.log(id.padEnd(36), row.join(' | '));
}
