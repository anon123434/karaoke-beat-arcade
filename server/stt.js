'use strict';
// Phone voice search fallback: audio recorded on the phone -> faster-whisper (tools/stt-worker.py) on this Mac. One worker, kept warm, serial queue.
const { spawn } = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const ROOT = path.resolve(__dirname, '..'), PY = path.join(ROOT, '.venv-ingest/bin/python');
let proc = null, buf = '', ready = null, queue = [], busy = null, idleT = null;
function start() {
  if (proc) return ready;
  proc = spawn(PY, [path.join(ROOT, 'tools/stt-worker.py')], { stdio: ['pipe', 'pipe', 'ignore'], cwd: ROOT });
  ready = new Promise(res => { proc._ready = res; });
  proc.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.ready) { proc._ready(true); continue; }
      const job = busy; busy = null; if (job) job.res(m); pump();
    }
  });
  proc.on('exit', () => { proc = null; ready = null; buf = ''; if (busy) { busy.res({ error: 'stt worker exited' }); busy = null; } pump(); });
  return ready;
}
function pump() {
  if (busy || !queue.length) return;
  if (!proc) { if (!queue.length) return; start(); }
  busy = queue.shift();
  ready.then(() => { if (proc && busy) proc.stdin.write(busy.file + '\n'); });
  clearTimeout(idleT); idleT = setTimeout(() => { if (proc && !busy && !queue.length) proc.kill(); }, 10 * 60 * 1000);
}
function transcribe(bytes, ext) {
  const file = path.join(os.tmpdir(), 'karaoketv-stt-' + process.pid + '-' + Date.now() + '.' + (ext || 'webm'));
  fs.writeFileSync(file, bytes);
  return new Promise(res => {
    const to = setTimeout(() => res({ error: 'timeout' }), 60000);
    queue.push({ file, res: r => { clearTimeout(to); fs.unlink(file, () => {}); res(r); } }); pump();
  });
}
module.exports = { transcribe, warm: () => { start(); } };
