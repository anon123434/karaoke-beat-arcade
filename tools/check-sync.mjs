// Headless check of output-device auto-sync, the tap test and the pause nudge. TEST-ONLY: a synthetic sound-device list
// (window.__testSound, never present on the TV), a synthetic DualSense, and a bot that presses "when the sound is heard".
import { createRequire } from 'module'; import { spawn } from 'child_process'; import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18144, HS = 18507, sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: 'sync', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1000);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const INIT = () => {
  window.__dev = 'BLUETOOTH'; let cb = null;
  window.__testSound = { getActivatedDeviceList: () => [{ id: 1, name: 'TEST synthetic speaker', device: window.__dev, direction: 'OUT', isConnected: true, isActivated: true }],
    addDeviceStateChangeListener: f => { cb = f; return 1; } };
  window.__switchDev = d => { window.__dev = d; cb && cb({ device: d, isConnected: true, isActivated: true }); };
  const btn = () => ({ pressed: false, value: 0 });
  window.__pad = { id: 'TEST synthetic DualSense', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn), vibrationActuator: { playEffect: () => Promise.resolve() } };
  navigator.getGamepads = () => [window.__pad, null, null, null];
  window.__tap = i => { const b = window.__pad.buttons[i]; b.pressed = true; b.value = 1; window.__pad.timestamp = performance.now(); setTimeout(() => { b.pressed = false; b.value = 0; }, 50); };
};
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); await ctx.addInitScript(INIT);
  const tv = await ctx.newPage(); const errs = []; tv.on('pageerror', e => errs.push(e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeSync, null, { timeout: 15000 });
  await tv.evaluate(() => { localStorage.clear(); localStorage.setItem('karaoke.engine', 'webaudio'); }); await tv.reload(); await tv.waitForFunction(() => window.KaraokeSync); await sleep(1200);
  const s1 = await tv.evaluate(() => ({ ...KaraokeSync.get(), toast: document.getElementById('homeToast').textContent }));
  check('Bluetooth output detected at start, offsets applied', s1.out.type === 'bluetooth' && s1.avMs === 200 && s1.outLat === 320 && s1.judgeMs === 330, JSON.stringify({ out: s1.out.type, av: s1.avMs, outLat: s1.outLat, judge: s1.judgeMs }));
  check('toast says Bluetooth detected', /Bluetooth audio detected/.test(s1.toast), s1.toast);
  await tv.evaluate(() => window.__switchDev('BUILTIN_SPEAKER')); await sleep(700);
  const s2 = await tv.evaluate(() => KaraokeSync.get());
  check('device change to TV speaker re-syncs', s2.out.type === 'speaker' && s2.avMs === 0 && s2.outLat === 120, JSON.stringify({ out: s2.out.type, av: s2.avMs, outLat: s2.outLat }));
  await tv.evaluate(() => window.__switchDev('BLUETOOTH')); await sleep(700);
  // Beat Easy with a bot that presses when the sound is HEARD through Bluetooth (320 ms after the clock) + 10 ms pad lag
  const songs = await tv.evaluate(() => KaraokeTVDebug.songs().map(s => s.id));
  await tv.evaluate(() => { KaraokeTVDebug.play('beat-easy'); localStorage.setItem('karaoke.beatOffsetMs', '0'); });
  await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, songs.indexOf('twinkle')); await sleep(300);
  await tv.evaluate(() => { const done = new Set(); window.__botOn = true; (function tick() { if (!window.__botOn) return; const d = KaraokeTVDebug.beat(); if (d) d.upcoming.forEach(p => { const k = p.t + ':' + p.lane; if (!done.has(k) && p.t - d.h <= 0.008) { done.add(k); window.__tap(KaraokeBeat.LANES[p.lane].btn[0]); } }); requestAnimationFrame(tick); })(); });
  await tv.waitForFunction(() => KaraokeTVDebug.state().screen === 'results', null, { timeout: 60000 });
  const r = await tv.evaluate(() => ({ score: +document.getElementById('finalScore').getAttribute('data-v'), meta: document.getElementById('resMeta').textContent }));
  check('Bluetooth (330 ms round trip): presses on the heard beat score, no early auto-misses', r.score >= 90, JSON.stringify(r));
  await tv.evaluate(() => { window.__botOn = false; KaraokeTVDebug.quit(); }); await sleep(500);
  // tap test: synthetic presses 260 ms after each click (audio) and 60 ms after each drawn flash (video) -> picture lead 200 ms
  await tv.evaluate(() => KaraokeSync.start()); await sleep(100);
  await tv.evaluate(() => { const seen = {}; window.__tt = true; (function tick() { if (!window.__tt) return; const S = KaraokeSync.state(); if (S && (S.phase === 'audio' || S.phase === 'video')) { const ref = S.phase === 'audio' ? S.events : S.drawn, lag = S.phase === 'audio' ? 260 : 60; for (let k = 0; k < S.N; k++) { const key = S.phase + k; if (ref[k] != null && !seen[key] && performance.now() >= ref[k] + lag) { seen[key] = 1; window.__tap(0); } } } requestAnimationFrame(tick); })(); });
  await tv.waitForFunction(() => KaraokeSync.state() && KaraokeSync.state().phase === 'done', null, { timeout: 40000 });
  const s3 = await tv.evaluate(() => ({ ...KaraokeSync.get(), msg: document.getElementById('syncMsg').textContent }));
  const P = s3.sync.byDev.bluetooth || {};
  check('tap test measures sound vs picture and stores it for the Bluetooth device', Math.abs(P.tapA - 260) <= 25 && Math.abs(P.tapV - 60) <= 25 && Math.abs(s3.avMs - 200) <= 35, JSON.stringify({ tapA: P.tapA, tapV: P.tapV, av: s3.avMs, judge: s3.judgeMs }));
  await tv.evaluate(() => { window.__tt = false; }); await tv.keyboard.press('Enter'); await sleep(300);
  // pause-menu nudge: start a song, pause, go to the sync item, press right twice
  await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, songs.indexOf('twinkle')); await sleep(1500);
  await tv.keyboard.press('Enter'); await sleep(600);
  const idx = await tv.evaluate(() => [...document.querySelectorAll('#pauseMenu .pm-item')].findIndex(e => e.dataset.act === 'sync'));
  for (let i = 0; i < idx; i++) { await tv.keyboard.press('ArrowDown'); await sleep(60); }
  await tv.keyboard.press('ArrowRight'); await sleep(60); await tv.keyboard.press('ArrowRight'); await sleep(200);
  const s4 = await tv.evaluate(() => ({ ...KaraokeSync.get(), label: document.getElementById('pmSync').textContent }));
  check('pause menu ▶ nudges +20 ms for this device', (s4.sync.byDev.bluetooth || {}).nudge === 20 && Math.abs(s4.avMs - s3.avMs - 20) <= 1, JSON.stringify({ nudge: (s4.sync.byDev.bluetooth || {}).nudge, label: s4.label }));
  check('offsets up to 400 ms clamp cleanly', await tv.evaluate(() => { const s = JSON.parse(JSON.stringify(KaraokeSync.get().sync)); s.byDev.bluetooth = { tapA: 700, tapV: 50, src: 'pad' }; KaraokeSync.set(s); return KaraokeSync.get().avMs === 450; }));
  check('no page errors', !errs.length, errs.join(' | '));
} catch (e) { fail++; console.log('FAIL exception — ' + e.message); }
await browser.close(); server.kill();
console.log(fail ? fail + ' FAILED' : 'ALL PASS'); process.exit(fail ? 1 : 0);
