// v13.9 screenshots: 4 SIMULATED phones (synthetic TEST pitch, labelled on the image) on a PRIVATE server -> multiplayer game HUD,
// winner reveal and results table from the real scorer. Never the live :8780.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const WebSocket = createRequire(import.meta.url)('ws');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '.local/shots/v139'); fs.mkdirSync(OUT, { recursive: true });
const song = JSON.parse(fs.readFileSync(path.join(ROOT, 'songs/twinkle/song.json')));
const H = 18494, HS = 18495, CODE = 'multi4', sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: CODE, KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(700);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
function phone(cid, name, transpose) {
  const ws = new WebSocket(`wss://127.0.0.1:${HS}/ws?role=phone&s=${CODE}&cid=${cid}&name=${name}`, { rejectUnauthorized: false });
  const st = { ws, anchor: null, msgs: [], slot: 0 };
  ws.on('message', d => { const m = JSON.parse(d); st.msgs.push(m); if (m.type === 'hello') st.slot = m.slot; if (m.type === 'clock') st.anchor = { t: m.t, at: Date.now() }; });
  let seq = 0;
  st.timer = setInterval(() => {
    if (ws.readyState !== 1) return;
    let f = 0;
    if (st.anchor) {
      const heard = st.anchor.t + (Date.now() - st.anchor.at) / 1000 - 0.12; // default 120 ms TV output latency
      const n = song.notes.find(x => heard >= x.t && heard < x.t + x.d);
      f = n ? 440 * Math.pow(2, (n.midi + transpose - 69) / 12) : 0;
    }
    ws.send(JSON.stringify({ type: 'pitch', f, c: 0.9, rms: 0.1, seq: seq++ }));
  }, 23);
  return new Promise(r => ws.on('open', () => { ws.send(JSON.stringify({ type: 'status', mic: 'live', lat: 0 })); r(st); }));
}
try {
  const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${H}/tv/`); await sleep(2000);
  const P = [await phone('a', 'Sam', 0), await phone('b', 'Mia', -1), await phone('c', 'Jay', 2), await phone('d', 'Ana', -4)];
  await sleep(900);
  const label = () => p.evaluate(() => { let d = document.getElementById('__testlbl'); if (!d) { d = document.createElement('div'); d.id = '__testlbl'; d.textContent = 'TEST: 4 simulated phones (synthetic pitch)'; d.style.cssText = 'position:fixed;right:8px;bottom:2px;z-index:999;font:14px sans-serif;color:#fff8;'; document.body.appendChild(d); } });
  const mode = process.env.MODE || 'battle-alt';
  await p.evaluate(m => { KaraokeTVDebug.mode(m); KaraokeTVDebug.select(0); KaraokeTVDebug.start(); }, mode); await label();
  let shot = false, win = false; const t0 = Date.now();
  while (true) {
    await sleep(200);
    const s = await p.evaluate(() => KaraokeTVDebug.state());
    if (!shot && s.t > 14) { shot = true; await p.screenshot({ path: path.join(OUT, 'multi4-game.png') }); }
    if (s.screen === 'results') break;
    if (Date.now() - t0 > 70000) throw new Error('song never ended');
  }
  await sleep(2200); await p.screenshot({ path: path.join(OUT, 'multi4-results-B-winner.png') });
  console.log('round', JSON.stringify(await p.evaluate(() => KaraokeTVDebug.round())), JSON.stringify(await p.evaluate(() => KaraokeTVDebug.results())));
  await p.keyboard.press('Enter'); await sleep(2000); await p.screenshot({ path: path.join(OUT, 'multi4-results-A-table.png') });
  console.log('pageerrors:', errs.length ? errs.join(' | ') : 'none');
  P.forEach(x => { clearInterval(x.timer); x.ws.close(); });
} catch (e) { console.log('ERR', e.stack); }
finally { await browser.close(); server.kill(); }
