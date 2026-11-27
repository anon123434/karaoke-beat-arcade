// Headless render-cost check for the Beat highway on a PRIVATE server: dense song, Hard, TEST-ONLY synthetic pad + hit bot,
// CPU throttled (CDP) to approximate a TV. Prints rAF fps, p95 frame ms and avg JS work per frame. ROOT env = checkout to test.
import { createRequire } from 'module'; import { spawn } from 'child_process'; import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = process.env.ROOT || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = +(process.env.PORT || 18444), SONG = process.env.SONG || 'twinkle', THR = +(process.env.THROTTLE || 4), sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'perf', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1000); const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => { const btn = () => ({ pressed: false, value: 0 }); window.__pad = { id: 'TEST synthetic DualSense', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn), vibrationActuator: { playEffect: () => Promise.resolve() } }; navigator.getGamepads = () => [window.__pad, null, null, null]; });
  const tv = await ctx.newPage(); const cdp = await ctx.newCDPSession(tv);
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVDebug && KaraokeTVDebug.songs().length > 100, null, { timeout: 30000 });
  await tv.evaluate(() => localStorage.setItem('karaoke.engine', 'webaudio')); await tv.reload(); await tv.waitForFunction(() => window.KaraokeTVDebug && KaraokeTVDebug.songs().length > 100, null, { timeout: 30000 }); await sleep(800);
  const i = await tv.evaluate(id => KaraokeTVDebug.songs().map(s => s.id).indexOf(id), SONG); await tv.evaluate(i => KaraokeTVDebug.select(i), i);
  await tv.evaluate(() => { KaraokeTVDebug.play('beat-hard'); KaraokeTVDebug.start(); }); await sleep(4000);
  await tv.evaluate(() => { const S = {}; (function tick() { const d = KaraokeTVDebug.beat(); if (d && d.upcoming) d.upcoming.forEach(u => { const k = u.t + ':' + u.lane; if (Math.abs(u.t - d.h) < 0.02 && !S[k]) { S[k] = 1; KaraokeTVDebug.beatPress(u.lane, d.h); } }); requestAnimationFrame(tick); })(); });
  await tv.evaluate(() => { const s = KaraokeTVDebug.songs(); }); await tv.evaluate(() => { window.__w = []; const o = window.KaraokePerfWork; window.KaraokePerfWork = ms => { window.__w.push(ms); o && o(ms); }; });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THR }); await sleep(1000);
  const r = await tv.evaluate(() => new Promise(res => { const gaps = []; let prev = performance.now(); const t0 = prev; window.__w = []; (function f(now) { gaps.push(now - prev); prev = now; if (now - t0 < 8000) requestAnimationFrame(f); else { gaps.sort((a, b) => a - b); const w = window.__w; res({ fps: +(gaps.length / ((now - t0) / 1000)).toFixed(1), p95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1), work: w.length ? +(w.reduce((a, b) => a + b, 0) / w.length).toFixed(2) : null, combo: KaraokeTVDebug.beat().combo }); } })(prev); }));
  console.log(JSON.stringify({ root: ROOT, throttle: THR, ...r }));
} catch (e) { console.log('ERR ' + e.message); }
await browser.close(); server.kill();
