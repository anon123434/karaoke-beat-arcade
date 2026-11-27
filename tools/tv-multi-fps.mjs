// Real-TV perf check: 2 SIMULATED phones (synthetic pitch along the melody, one accurate, one 3 st flat) join the
// live server, the TV plays a song in the given mode, and we read the TV's own FPS telemetry from .local/perf.log.
import { createRequire } from 'module';
import fs from 'fs'; import path from 'path';
const WebSocket = createRequire(import.meta.url)('ws');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CODE = fs.readFileSync(path.join(ROOT, '.local/pairing-code'), 'utf8').trim();
const [mode = 'party', songIdx = '0', secs = '30'] = process.argv.slice(2);
const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'songs/index.json')));
const song = JSON.parse(fs.readFileSync(path.join(ROOT, 'songs', index[+songIdx].id, 'song.json')));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function phone(cid, name, tr) {
  const ws = new WebSocket(`wss://127.0.0.1:8743/ws?role=phone&s=${CODE}&cid=${cid}&name=${name}`, { rejectUnauthorized: false });
  let anchor = null, seq = 0;
  ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'clock') anchor = { t: m.t, at: Date.now() }; });
  const timer = setInterval(() => {
    if (ws.readyState !== 1) return;
    let f = 0;
    if (anchor) { const h = anchor.t + (Date.now() - anchor.at) / 1000 - 0.12; const n = song.notes.find(x => h >= x.t && h < x.t + x.d); f = n ? 440 * Math.pow(2, (n.midi + tr - 69) / 12) : 0; }
    ws.send(JSON.stringify({ type: 'pitch', f, c: 0.9, rms: 0.1, seq: seq++ }));
  }, 11); // ~90 frames/s like the real phone
  return new Promise(r => ws.on('open', () => { ws.send(JSON.stringify({ type: 'status', mic: 'live', lat: 30 })); r({ ws, timer }); }));
}
const dev = q => fetch('http://127.0.0.1:8780/api/dev?' + q);
const A = await phone('simA', 'SimSam', 0), B = await phone('simB', 'SimAna', -3);
await sleep(800);
fs.writeFileSync(path.join(ROOT, '.local/perf.log'), '');
await dev('action=mode&value=' + mode);
await dev('action=start&song=' + songIdx);
await sleep(+secs * 1000);
const g = fs.readFileSync(path.join(ROOT, '.local/perf.log'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x => x.screen === 'game' && x.src === 'tv').slice(1);
const f = g.map(x => x.fps);
console.log(mode.padEnd(12), 'song', index[+songIdx].id, '| avg', (f.reduce((a, b) => a + b, 0) / Math.max(1, f.length)).toFixed(1), 'min', Math.min(...f), '| p95 frame', Math.max(...g.map(x => x.p95FrameMs)), 'ms | work max', Math.max(...g.map(x => x.maxWorkMs)), 'ms |', f.map(Math.round).join(' '));
await dev('action=home');
[A, B].forEach(x => { clearInterval(x.timer); x.ws.close(); });
await sleep(300); process.exit(0);
