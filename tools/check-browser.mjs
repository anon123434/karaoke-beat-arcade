// End-to-end headless check (Chromium via Playwright already installed for CleanFrame).
// Everything sung here is SYNTHETIC test input, clearly labelled; it validates the pipeline, not a human voice.
//  1. TV UI renders (home/QR), screenshot
//  2. Real phone page (iPhone viewport, HTTPS) with Chromium's fake mic fed a synthetic voice WAV ->
//     on-page YIN -> wss -> server -> TV: TV must receive voiced frames at the right pitch.
//  3. Fake WS phone "sings" the reference melody (synthetic) -> TV final score must be high;
//     sings 3 semitones off -> score must be low. Screenshots of game + results.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const pw = createRequire(import.meta.url)('playwright');
const WebSocket = require('ws');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '.local/qa'); fs.mkdirSync(OUT, { recursive: true });
const song = JSON.parse(fs.readFileSync(path.join(ROOT, 'songs/twinkle/song.json')));
const H = 18080, HS = 18443, CODE = 'e2ecode';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); };

// synthetic voice WAV: voice-like A3 (220 Hz) with vibrato, 6 s
const voiceWav = path.join(OUT, 'synthetic-voice-220.wav');
{ const SR = 48000, n = SR * 6, b = Buffer.alloc(44 + n * 2); let ph = 0;
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { ph += 2 * Math.PI * 220 * Math.pow(2, 20 * Math.sin(2 * Math.PI * 5 * i / SR) / 1200) / SR;
    const v = 0.4 * Math.sin(ph) + 0.6 * Math.sin(2 * ph) + 0.3 * Math.sin(3 * ph) + 0.15 * Math.sin(4 * ph);
    b.writeInt16LE(Math.round(v * 0.45 * 32767), 44 + i * 2); }
  fs.writeFileSync(voiceWav, b); }

const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: CODE, KARAOKE_HOST: '127.0.0.1' }, stdio: 'inherit' });
await sleep(600);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-audio-capture=' + voiceWav] });
try {
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await tvCtx.newPage();
  const errors = []; tv.on('pageerror', e => errors.push(e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/`);
  await tv.waitForSelector('#qr svg', { timeout: 5000 });
  check('TV home renders with pairing QR', true);
  await tv.waitForFunction(() => document.querySelectorAll('.song-card').length >= 2);
  await tv.screenshot({ path: path.join(OUT, 'tv-home.png') });
  check('home lists the built-in songs', true, await tv.evaluate(() => [...document.querySelectorAll('.song-card .title')].map(e => e.textContent).join(' | ')));

  // ---- 2. real phone page + fake mic (synthetic voice) ----
  const phoneCtx = await browser.newContext({ ...pw.devices['iPhone 13'], ignoreHTTPSErrors: true, permissions: ['microphone'] });
  const ph = await phoneCtx.newPage();
  await ph.goto(`https://127.0.0.1:${HS}/phone/?s=${CODE}`);
  await ph.waitForFunction(() => document.getElementById('pConn').textContent === 'Connected', null, { timeout: 5000 });
  check('phone page connects over wss with pairing code', true);
  await tv.waitForFunction(() => /Phone connected/.test(document.getElementById('phoneStatus').textContent), null, { timeout: 5000 });
  check('TV shows phone connected', true);
  await ph.click('#mic');
  await tv.waitForFunction(() => /mic live/.test(document.getElementById('phoneStatus').textContent), null, { timeout: 5000 });
  check('mic permission granted -> TV shows "iPhone mic live"', true);
  await sleep(1500);
  const shown = await ph.textContent('#hz');
  const hz = parseFloat(shown);
  check('phone page YIN detects synthetic 220 Hz voice', Math.abs(1200 * Math.log2(hz / 220)) < 40, shown);
  await ph.screenshot({ path: path.join(OUT, 'phone.png') });
  // Start the song: real phone frames now flow to the TV for a few seconds
  await tv.keyboard.press('Enter');
  await sleep(4500);
  const st = await tv.evaluate(() => window.KaraokeTVDebug.state());
  check('TV receives real phone-page pitch frames during the song', st.frames > 50, st.frames + ' frames in ~4.5 s');
  // remote has no colour keys: BACK opens the pause menu, ▼▼▼ + OK = "Quit to songs"
  await tv.keyboard.press('Escape'); await sleep(200);
  check('BACK in game opens the pause menu', await tv.evaluate(() => window.KaraokeTVDebug.paused()));
  for (let k = 0; k < 8 && !(await tv.evaluate(() => { const f = document.querySelector('#pauseMenu .pm-item.focused'); return f && f.dataset.act === 'quit'; })); k++) await tv.keyboard.press('ArrowDown');
  await sleep(600); await tv.keyboard.press('Enter'); await sleep(300);
  check('pause menu → Quit returns to songs', (await tv.evaluate(() => window.KaraokeTVDebug.state())).screen === 'home');
  await phoneCtx.close();
  await sleep(500);

  // ---- 2b. calibration with a fake phone that hears beeps 200 ms late (synthetic) ----
  {
    const cal = JSON.parse(fs.readFileSync(path.join(ROOT, 'songs/calibration/calibration.json')));
    const ws = new WebSocket(`wss://127.0.0.1:${HS}/ws?role=phone&s=${CODE}`, { rejectUnauthorized: false });
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'status', mic: 'live', lat: 0 }));
    let anchor = null; ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'clock') anchor = { t: m.t, at: Date.now() }; });
    await tv.waitForFunction(() => /mic live/.test(document.getElementById('phoneStatus').textContent));
    await tv.evaluate(() => window.KaraokeTVDebug.select(window.KaraokeTVDebug.songs().length - 1));   // 40+ songs now: jump to the last one first
    for (let k = 0; k < 8 && !(await tv.evaluate(() => document.getElementById('calBtn').classList.contains('focused'))); k++) await tv.keyboard.press('ArrowDown');
    await tv.keyboard.press('Enter');
    const timer = setInterval(() => {
      if (!anchor) return;
      const heard = anchor.t + (Date.now() - anchor.at) / 1000 - 0.2;
      const on = cal.beeps.some(b => heard >= b && heard < b + cal.beepLen);
      ws.send(JSON.stringify({ type: 'pitch', f: on ? 880 : 0, c: 0.9, rms: 0.1 }));
    }, 11);
    await tv.waitForFunction(() => window.KaraokeTVDebug.cal().done, null, { timeout: 15000 });
    clearInterval(timer);
    const c = await tv.evaluate(() => window.KaraokeTVDebug.cal());
    await tv.screenshot({ path: path.join(OUT, 'tv-calibration.png') });
    check('[synthetic] calibration measures a 200 ms speaker delay', Math.abs(c.latency - 200) <= 40, c.latency + ' ms, "' + c.title + '"');
    await tv.keyboard.press('Enter'); // back home
    await tv.evaluate(() => window.KaraokeTVDebug.select(0));
    ws.close(); await sleep(300);
  }

  // ---- 3. fake WS phone sings (synthetic) ----
  async function fakeSing(label, transpose) {
    const ws = new WebSocket(`wss://127.0.0.1:${HS}/ws?role=phone&s=${CODE}`, { rejectUnauthorized: false });
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'status', mic: 'live', lat: 0 }));
    let anchor = null;
    ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'clock') anchor = { t: m.t, at: Date.now() }; });
    await tv.waitForFunction(() => /mic live/.test(document.getElementById('phoneStatus').textContent));
    await tv.keyboard.press('Enter');
    let seq = 0, shot = false;
    const timer = setInterval(() => {
      if (!anchor) return;
      const heard = anchor.t + (Date.now() - anchor.at) / 1000 - 0.2; // what the "singer" hears (same 200 ms delay as calibrated)
      const n = song.notes.find(x => heard >= x.t && heard < x.t + x.d);
      const f = n ? 440 * Math.pow(2, (n.midi + transpose - 69) / 12) : 0;
      ws.send(JSON.stringify({ type: 'pitch', f, c: 0.9, rms: 0.1, seq: seq++ }));
    }, 23);
    const t0 = Date.now();
    while (true) {
      await sleep(250);
      const s = await tv.evaluate(() => window.KaraokeTVDebug.state());
      if (!shot && s.t > 14.2 && transpose === 0) { shot = true; await tv.screenshot({ path: path.join(OUT, 'tv-game.png') }); }
      if (s.screen === 'results') break;
      if (Date.now() - t0 > 60000) throw new Error('song never ended');
    }
    clearInterval(timer);
    const score = +(await tv.getAttribute('#finalScore', 'data-v'));
    if (transpose === 0) await tv.screenshot({ path: path.join(OUT, 'tv-results.png') });
    ws.close();
    await tv.keyboard.press('Escape');
    await sleep(400);
    return score;
  }
  const good = await fakeSing('accurate', 0);
  check('[synthetic] accurate singing -> high final score', good >= 85, 'score ' + good);
  const bad = await fakeSing('off-key', 3);
  check('[synthetic] 3 semitones off -> low final score', bad <= 25, 'score ' + bad);
  check('no JS errors on TV page', errors.length === 0, errors.join('; '));
} catch (e) { check('e2e run', false, e.message); }
finally { await browser.close(); server.kill(); }
fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify(results, null, 1));
process.exit(results.every(r => r.ok) ? 0 : 1);
