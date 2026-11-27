// Headless check: Web Audio engine (guide sample-locked), voice monitoring relay + jitter buffer with 2 SIMULATED
// phones streaming [synthetic] quiet sine PCM, and a real phone page (Chromium fake mic) streaming its mic.
// v13.8.1: 'Voice through TV' was removed by design (always off). This legacy test is retired; see tools/check-guide-voice.mjs.
console.log('SKIPPED (voice through TV removed in v13.8.1) — ALL PASS'); process.exit(0);
import { createRequire } from 'module';
import { spawn } from 'child_process';
import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const WebSocket = createRequire(import.meta.url)('ws');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18094, HS = 18457, CODE = 'voice', sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: CODE, KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(700);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--ignore-certificate-errors'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
function fakePhone(cid, freq) {   // [synthetic] PCM: quiet sine, real-time paced 256-sample packets @ 24 kHz
  const ws = new WebSocket(`wss://127.0.0.1:${HS}/ws?role=phone&s=${CODE}&cid=${cid}&name=${cid}`, { rejectUnauthorized: false });
  const st = { ws, master: null, sent: 0, slot: 0 }; let ph = 0, seq = 0, t0 = 0;
  ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'voice') { if (m.master && !st.master) { t0 = performance.now(); st.sent = 0; } st.master = m.master; } if (m.type === 'hello') st.slot = m.slot; });
  st.timer = setInterval(() => {
    if (ws.readyState !== 1 || !st.master) return;
    const due = Math.floor((performance.now() - t0) / (256 / 24));
    while (st.sent < due) {
      const b = Buffer.alloc(8 + 512); b.writeUInt8(1, 0); b.writeUInt16LE(seq++ & 65535, 2); b.writeUInt16LE(3, 4);
      for (let i = 0; i < 256; i++) { b.writeInt16LE(Math.round(1500 * Math.sin(ph)), 8 + 2 * i); ph += 2 * Math.PI * freq / 24000; }
      ws.send(b); st.sent++;
    }
  }, 4);
  return new Promise(r => ws.on('open', () => { ws.send(JSON.stringify({ type: 'status', mic: 'live', lat: 0 })); ws.send(JSON.stringify({ type: 'voice', on: true, vol: 0.8 })); r(st); }));
}
try {
  const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; tv.on('pageerror', e => errs.push(e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/`); await tv.waitForFunction(() => window.KaraokeTVDebug, null, { timeout: 15000 }); await sleep(1500);
  const eng = await tv.evaluate(() => KaraokeTVDebug.engine());
  check('TV audio engine is Web Audio', eng.mode === 'webaudio', JSON.stringify(eng));
  check('Voice on TV is Off by default', /Off/.test(await tv.evaluate(() => document.getElementById('voiceBtnVal').textContent)));
  // guide sample-locked
  const idx = await tv.evaluate(() => KaraokeTVDebug.songs().findIndex(s => s.id === 'twinkle'));
  if (idx >= 0) {
    await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.guide('low'); KaraokeTVDebug.start(); }, idx); await sleep(4500);
    const g = await tv.evaluate(() => KaraokeTVDebug.guide()), st = await tv.evaluate(() => KaraokeTVDebug.state());
    check('guide plays sample-locked with the backing track', g.engine === 'webaudio' && g.locked && g.playing, JSON.stringify(g));
    check('song clock advances on the Web Audio engine', st.t > 2 && st.t < 6, 't=' + st.t.toFixed(2));
    await tv.keyboard.press('Escape'); await sleep(200);
    check('pause stops the clock', await tv.evaluate(() => { const a = KaraokeTVDebug.state().t; return new Promise(r => setTimeout(() => r(Math.abs(KaraokeTVDebug.state().t - a) < 0.01), 400)); }));
    await tv.keyboard.press('Escape'); await sleep(600);
    check('resume continues from the same spot', await tv.evaluate(() => KaraokeTVDebug.state().t > 2.5 && !KaraokeTVDebug.paused()));
    await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(300);
  }
  const A = await fakePhone('va', 196), B = await fakePhone('vb', 262);
  await sleep(600);
  check('phones told voice is off', A.master === false && B.master === false);
  // home row: ▼ past last song -> row; move right to Voice; OK
  await tv.evaluate(() => window.toggleVoiceMaster()); await sleep(500);
  check('phones told voice is on', A.master === true && B.master === true);
  await sleep(4000);
  const vr = await tv.evaluate(() => KaraokeTVDebug.voice());
  for (const p of [A, B]) {
    const s = vr.voices[p.slot] || {};
    check(`[synthetic] player ${p.slot}: packets played`, s.rx > 300, JSON.stringify(s));
    check(`player ${p.slot}: jitter buffer stays small`, s.bufMs != null && s.bufMs <= 110 && s.under <= 3, `buffer ${s.bufMs} ms, underruns ${s.under}, drops ${s.drops}`);
    check(`player ${p.slot}: network leg measured`, s.netMs != null && s.netMs < 60, s.netMs + ' ms');
  }
  console.log('INFO engine output:', JSON.stringify(vr.engine), ' est mouth->speaker (excl. phone input & TV speaker hw):', JSON.stringify(Object.values(vr.voices).map(v => v.estMs)));
  // phone page (real code path, Chromium fake microphone)
  const ph = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  ph.on('pageerror', e => errs.push('phone: ' + e.message));
  await ph.goto(`https://127.0.0.1:${HS}/phone/?s=${CODE}`); await sleep(1500);
  await ph.click('#mic'); await sleep(500);
  await ph.click('#atOn'); await sleep(2500);
  const slot = await ph.evaluate(() => +document.getElementById('pBadge').textContent.replace(/\D/g, ''));
  const v3 = (await tv.evaluate(() => KaraokeTVDebug.voice())).voices[slot] || {};
  check('phone page streams its mic to the TV (auto-tune on)', v3.rx > 100, JSON.stringify(v3));
  check('phone shows live status', /Live on the TV/.test(await ph.evaluate(() => document.getElementById('vStatus').textContent)));
  await ph.screenshot({ path: path.join(ROOT, '.local/qa/phone-voice.png'), fullPage: true });
  await ph.click('#vOn'); await sleep(300);
  const rx1 = ((await tv.evaluate(() => KaraokeTVDebug.voice())).voices[slot] || {}).rx; await sleep(800);
  const rx2 = ((await tv.evaluate(() => KaraokeTVDebug.voice())).voices[slot] || {}).rx;
  check('phone "Hear my voice" off stops streaming', rx2 === rx1, rx1 + ' -> ' + rx2);
  await tv.evaluate(() => { localStorage.setItem('karaoke.voiceLevel', 'high'); window.toggleVoiceMaster(); }); await sleep(400);  // high -> off
  check('TV Voice Off stops phones', A.master === false);
  check('no page errors', errs.length === 0, errs.join(' | '));
  for (const p of [A, B]) { clearInterval(p.timer); p.ws.close(); }
} finally { await browser.close(); server.kill(); }
console.log(fail ? fail + ' FAILED' : 'all passed'); process.exit(fail ? 1 : 0);
