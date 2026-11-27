#!/usr/bin/env node
/*
 * Generates the first test song from scratch — no downloads:
 *   "Twinkle, Twinkle, Little Star" (traditional melody, public domain),
 *   original piano karaoke arrangement synthesised here.
 * Outputs to songs/twinkle/:
 *   instrumental.wav  accompaniment only (bass + chords + count-in), NO lead melody
 *   melody.mid        reference melody (Standard MIDI File, format 0)
 *   melody.json       note list the scorer reads [{t,d,midi,syl,line}]
 *   lyrics.lrc        timed lyrics (enhanced LRC, word timestamps)
 *   song.json         everything the TV app needs (meta + notes + lyric lines)
 */
'use strict';
const fs = require('fs');
const path = require('path');


const SR = 44100;
const C = 60, D = 62, E = 64, F = 65, G = 67, A = 69, B = 71, C5 = 72, D5 = 74, D4 = 62, G4 = 67, B4 = 71, A4 = 69, E4 = 64;
const CH = { C: [48, [0, 4, 7]], F: [53, [0, 4, 7]], G: [43, [0, 4, 7, 10]], D: [50, [0, 4, 7, 10]], Am: [45, [0, 3, 7]] };

// Twinkle: explicit chords, 4/4, 100 BPM.
const phraseA1 = [[C, 'Twin-', 1], [C, 'kle', 1], [G, 'twin-', 1], [G, 'kle', 1], [A, 'lit-', 1], [A, 'tle', 1], [G, 'star,', 2]];
const phraseA2 = [[F, 'How', 1], [F, 'I', 1], [E, 'won-', 1], [E, 'der', 1], [D, 'what', 1], [D, 'you', 1], [C, 'are.', 2]];
const phraseB1 = [[G, 'Up', 1], [G, 'a-', 1], [F, 'bove', 1], [F, 'the', 1], [E, 'world', 1], [E, 'so', 1], [D, 'high,', 2]];
const phraseB2 = [[G, 'Like', 1], [G, 'a', 1], [F, 'dia-', 1], [F, 'mond', 1], [E, 'in', 1], [E, 'the', 1], [D, 'sky.', 2]];
const chordsA1 = ['C', 'C', 'F', 'C'], chordsA2 = ['F', 'C', 'G', 'C'], chordsB = ['C', 'F', 'C', 'G'];
const SONGS = {
  twinkle: {
    title: 'Twinkle, Twinkle, Little Star', artist: 'Traditional', key: 'C major', difficulty: 'Easy',
    bpm: 100, beatsPerBar: 4, countIn: 4, pickup: 0, chordBeats: 2,
    phrases: [phraseA1, phraseA2, phraseB1, phraseB2, phraseA1, phraseA2],
    chords: [chordsA1, chordsA2, chordsB, chordsB, chordsA1, chordsA2].flat()
  },
  // Amazing Grace: lyrics John Newton (1779), tune "New Britain" (1829) — public domain. Simplified to one note per syllable, G major, 3/4.
  'amazing-grace': {
    title: 'Amazing Grace', artist: 'Traditional (J. Newton, 1779)', key: 'G major', difficulty: 'Medium',
    bpm: 88, beatsPerBar: 3, countIn: 3, pickup: 1, chordBeats: 3,
    phrases: [
      [[D4, 'A-', 1], [G4, 'maz-', 2], [B4, 'ing', 1], [B4, 'grace,', 2], [A4, 'how', 1], [G4, 'sweet', 2], [E4, 'the', 1], [D4, 'sound', 3]],
      [[D4, 'That', 1], [G4, 'saved', 2], [B4, 'a', 1], [B4, 'wretch', 2], [A4, 'like', 1], [D5, 'me.', 3]],
      [[B4, 'I', 1], [D5, 'once', 2], [B4, 'was', 1], [D5, 'lost,', 2], [G4, 'but', 1], [E4, 'now', 2], [G4, 'am', 1], [D4, 'found,', 3]],
      [[D4, 'Was', 1], [G4, 'blind,', 2], [G4, 'but', 1], [B4, 'now', 2], [A4, 'I', 1], [G4, 'see.', 3]]
    ],
    // one chord per bar (bars start after the pickup)
    chords: ['G', 'G', 'C', 'G', 'G', 'D', 'D', 'G', 'G', 'C', 'G', 'G', 'D', 'G', 'G']
  }
};
CH.C3 = CH.C;

function build(id, def) {
const OUT = path.join(__dirname, '..', 'songs', id);
fs.mkdirSync(OUT, { recursive: true });
const BPM = def.bpm, BEAT = 60 / BPM;
const COUNT_IN_BEATS = def.countIn;
const LEAD_IN = COUNT_IN_BEATS * BEAT;
const phrases = def.phrases;
// ---- melody / lyrics timeline ----
const notes = [];
const lines = [];
let beat = 0;
phrases.forEach((ph, li) => {
  const words = [];
  ph.forEach(([midi, syl, beats]) => {
    const t = +(LEAD_IN + beat * BEAT).toFixed(3);
    // sung note lasts 90% of its slot so consecutive notes stay distinct
    const d = +(beats * BEAT * 0.9).toFixed(3);
    notes.push({ t, d, midi, syl, line: li });
    words.push({ t, d, text: syl });
    beat += beats;
  });
  lines.push({ t: words[0].t, end: +(LEAD_IN + beat * BEAT).toFixed(3), words });
});
const songEnd = LEAD_IN + beat * BEAT;
const duration = +(songEnd + 2.0).toFixed(3); // final chord ring-out

// ---- synth ----
const total = Math.ceil(duration * SR);
const buf = new Float32Array(total);
function piano(midi, start, len, vel) {
  const f0 = 440 * Math.pow(2, (midi - 69) / 12);
  const s0 = Math.floor(start * SR);
  const n = Math.min(total - s0, Math.floor((len + 1.2) * SR)); // let it ring after release
  const relAt = len * SR;
  const B = 0.0004; // slight inharmonicity
  for (let h = 1; h <= 10; h++) {
    const fh = f0 * h * Math.sqrt(1 + B * h * h);
    if (fh > SR / 2.2) break;
    const amp = vel * Math.pow(h, -1.4) * (h === 1 ? 1 : 0.8);
    const decay = 1.4 + h * 0.55 + f0 / 600;
    const w = 2 * Math.PI * fh / SR;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let env = Math.exp(-decay * t) * Math.min(1, i / (0.004 * SR));
      if (i > relAt) env *= Math.exp(-12 * (i - relAt) / SR);
      buf[s0 + i] += amp * env * Math.sin(w * i);
    }
  }
  // hammer noise
  for (let i = 0; i < 0.01 * SR && s0 + i < total; i++) buf[s0 + i] += vel * 0.02 * (((i * 1103515245 + 12345) % 2147483648) / 1073741824 - 1) * (1 - i / (0.01 * SR));
}
function click(start, accent) {
  const s0 = Math.floor(start * SR), f = accent ? 1800 : 1300;
  for (let i = 0; i < 0.05 * SR; i++) buf[s0 + i] += 0.25 * Math.exp(-90 * i / SR) * Math.sin(2 * Math.PI * f * i / SR);
}
for (let b = 0; b < COUNT_IN_BEATS; b++) click(b * BEAT, b === 0);
if (def.pickup) for (let b = 0; b < def.pickup; b++) click(LEAD_IN + b * BEAT, false); // keep time under the pickup

// Accompaniment (no lead melody): bass on each chord; 4/4 -> broken-chord eighths, 3/4 -> waltz "oom-pah-pah".
const chordStart = LEAD_IN + def.pickup * BEAT;
def.chords.forEach((name, ci) => {
  const [root, iv] = CH[name];
  const t = chordStart + ci * def.chordBeats * BEAT;
  if (t >= songEnd) return;
  piano(root - 12, t, def.chordBeats * BEAT, 0.32);
  const tones = iv.slice(0, 3).map(x => root + x);
  if (def.beatsPerBar === 3) { [1, 2].forEach(k => tones.forEach(m => piano(m, t + k * BEAT, BEAT * 0.8, 0.06))); }
  else { const pattern = [tones[0], tones[1], tones[2], tones[1]]; pattern.forEach((m, k) => piano(m, t + k * BEAT / 2, BEAT / 2, 0.11)); }
});
const finalChord = CH[def.chords[def.chords.length - 1]];
piano(finalChord[0] - 12, songEnd, 1.8, 0.3); finalChord[1].slice(0, 3).forEach(x => piano(finalChord[0] + x, songEnd, 1.8, 0.12)); // final chord

// normalise + write 16-bit mono WAV
let peak = 0; for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(buf[i]));
const gain = 0.85 / peak;
const pcm = Buffer.alloc(44 + total * 2);
pcm.write('RIFF', 0); pcm.writeUInt32LE(36 + total * 2, 4); pcm.write('WAVE', 8);
pcm.write('fmt ', 12); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(SR, 24); pcm.writeUInt32LE(SR * 2, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34);
pcm.write('data', 36); pcm.writeUInt32LE(total * 2, 40);
for (let i = 0; i < total; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(buf[i] * gain * 32767))), 44 + i * 2);
fs.writeFileSync(path.join(OUT, 'instrumental.wav'), pcm);

// ---- MIDI (format 0, 480 ppq) ----
function vlq(n) { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; }
const PPQ = 480, tick = s => Math.round(s / BEAT * PPQ);
const ev = [];
ev.push([0, [0xff, 0x51, 3, ...[60000000 / BPM].map(x => [(x >> 16) & 255, (x >> 8) & 255, x & 255]).flat()]]);
const nm = Buffer.from(def.title.slice(0, 40)); ev.push([0, [0xff, 0x03, nm.length, ...nm]]);
notes.forEach(n => { ev.push([tick(n.t), [0x90, n.midi, 96]]); ev.push([tick(n.t + n.d), [0x80, n.midi, 0]]); });
ev.sort((a, b) => a[0] - b[0] || (a[1][0] === 0x80 ? -1 : 1));
const trk = []; let last = 0;
ev.forEach(([t, bytes]) => { trk.push(...vlq(t - last), ...bytes); last = t; });
trk.push(0, 0xff, 0x2f, 0);
const hdr = Buffer.from([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, PPQ >> 8, PPQ & 255]);
const th = Buffer.alloc(8); th.write('MTrk', 0); th.writeUInt32BE(trk.length, 4);
fs.writeFileSync(path.join(OUT, 'melody.mid'), Buffer.concat([hdr, th, Buffer.from(trk)]));

// ---- LRC (enhanced, word-level) ----
const ts = s => { const m = Math.floor(s / 60), r = s - m * 60; return String(m).padStart(2, '0') + ':' + r.toFixed(2).padStart(5, '0'); };
const lrc = ['[ti:' + def.title + ']', '[ar:' + def.artist + ']', '[by:KaraokeTV original arrangement]']
  .concat(lines.map(l => '[' + ts(l.t) + ']' + l.words.map(w => '<' + ts(w.t) + '>' + w.text.replace(/-$/, '') + (w.text.endsWith('-') ? '' : ' ')).join('').trim()));
fs.writeFileSync(path.join(OUT, 'lyrics.lrc'), lrc.join('\n') + '\n');

const melody = notes.map(({ t, d, midi, syl, line }) => ({ t, d, midi, syl, line }));
fs.writeFileSync(path.join(OUT, 'melody.json'), JSON.stringify(melody, null, 1));
const song = {
  id, title: def.title, artist: def.artist, key: def.key, difficulty: def.difficulty,
  arrangement: 'Original piano karaoke arrangement (KaraokeTV, synthesised locally)',
  license: 'Melody and lyrics public domain; arrangement and audio generated by tools/build-song.js',
  bpm: BPM, leadIn: LEAD_IN, duration, audio: 'instrumental.wav', midi: 'melody.mid', lrc: 'lyrics.lrc',
  notes: melody, lines
};
fs.writeFileSync(path.join(OUT, 'song.json'), JSON.stringify(song));
console.log(`${id}: ${notes.length} notes, ${lines.length} lines, ${duration}s, wav ${(pcm.length / 1e6).toFixed(1)} MB`);

return { id, title: def.title, artist: def.artist, duration, key: def.key, difficulty: def.difficulty };
}

Object.keys(SONGS).forEach(id => build(id, SONGS[id]));
require('child_process').execFileSync(process.execPath, [path.join(__dirname, 'build-index.js')], { stdio: 'inherit' });
