// Headless screenshots of every screen on a PRIVATE server (never the live :8780). TEST-ONLY synthetic DualSense; no scoring input is faked
// for display (results screens show whatever the empty/bot run produced). Also measures canvas fps during Beat play.
import { createRequire } from 'module'; import { spawn } from 'child_process'; import path from 'path'; import fs from 'fs';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18434, HS = 18435, CODE = 'shot', sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = process.env.SHOTS || ROOT + '/.local/shots/v138'; fs.mkdirSync(OUT, { recursive: true }); const TAG = process.env.TAG || '';
const SONG = process.env.SONG || 'twinkle';
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: CODE, KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1000); const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const errs = []; const report = {};
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => {
    const btn = () => ({ pressed: false, value: 0, touched: false });
    window.__pad = { id: '"TEST synthetic DualSense" (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn), vibrationActuator: { playEffect: () => Promise.resolve('complete') } };
    window.__padOn = false; navigator.getGamepads = () => [window.__padOn ? window.__pad : null, null, null, null];
    window.__tap = (i, ms) => { const b = window.__pad.buttons[i]; b.pressed = true; b.value = 1; window.__pad.timestamp = performance.now(); setTimeout(() => { b.pressed = false; b.value = 0; }, ms || 70); };
    window.__plug = () => { window.__padOn = true; const e = new Event('gamepadconnected'); e.gamepad = window.__pad; window.dispatchEvent(e); };
  });
  const tv = await ctx.newPage(); tv.on('pageerror', e => errs.push(e.message));
  const ready = () => tv.waitForFunction(() => window.KaraokeTVRec && KaraokeTVDebug.songs().length > 100, null, { timeout: 30000 });
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await ready();
  await tv.evaluate(() => { localStorage.setItem('karaoke.engine', 'webaudio'); }); await tv.reload(); await ready(); await sleep(800);
  await tv.evaluate(() => window.__plug()); await sleep(300);
  const shot = async n => { await tv.screenshot({ path: OUT + '/' + n + TAG + '.png' }); console.log('shot ' + n); };
  const songs = await tv.evaluate(() => KaraokeTVDebug.songs().map(s => s.id)); const si = Math.max(0, songs.indexOf(SONG));
  await tv.evaluate(i => KaraokeTVDebug.select(i), si); await tv.evaluate(() => KaraokeTVDebug.play('beat-normal')); await sleep(600);
  await shot('01-home');
  await tv.evaluate(() => { KaraokeTVSearch.open(); KaraokeTVSearch.apply('hotel'); }); await sleep(500); await shot('02-search');
  await tv.evaluate(() => { KaraokeTVSearch.apply(''); document.activeElement && document.activeElement.blur(); KaraokeTVDebug.key('Back'); }); await sleep(300);
  await tv.evaluate(i => KaraokeTVDebug.select(i), si); await tv.evaluate(() => KaraokeTVDebug.toast('Saved ✓ on the server', 4000)); await sleep(300); await shot('03-toast');
  await tv.evaluate(() => KaraokeTVDebug.play('rec')); await sleep(200); await tv.evaluate(() => window.__tap(0)); await sleep(500); await shot('04-record-panel');
  await tv.evaluate(() => window.__tap(1)); await sleep(400);
  const game = async (play, name, ms, fps) => {
    await tv.evaluate(p => KaraokeTVDebug.play(p), play); await sleep(200); await tv.evaluate(() => KaraokeTVDebug.start()); await sleep(ms);
    if (fps) report[name + '_fps'] = await tv.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); (function f() { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else r(Math.round(n / ((performance.now() - t0) / 1000))); })(); }));
    await shot(name);
  };
  // TEST-ONLY bot hits the upcoming notes so the judgement / combo visuals are visible in the Beat screenshot
  await tv.evaluate(() => { window.__bot = true; (function tick() { if (!window.__bot) return; const d = KaraokeTVDebug.beat(); if (d && d.upcoming) { d.upcoming.forEach(u => { if (Math.abs(u.t - d.h) < 0.02 && !window['__h' + u.t + u.lane]) { window['__h' + u.t + u.lane] = 1; KaraokeTVDebug.beatPress(u.lane, d.h); } }); } requestAnimationFrame(tick); })(); });
  await game('beat-normal', '05-beat', 9000, true);
  await tv.evaluate(() => KaraokeTVDebug.key(13)); await sleep(600); await shot('06-pause');
  await tv.evaluate(() => KaraokeTVDebug.finish()); await sleep(1500); await shot('07-results-beat');
  await tv.evaluate(() => { window.__bot = false; KaraokeTVDebug.quit(); }); await sleep(800);
  await game('duet-normal', '08-duet', 9000, true); await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(800);
  await game('sing', '09-sing', 9000, true);
  await tv.evaluate(() => KaraokeTVDebug.finish()); await sleep(1500); await shot('10-results-sing');
  await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(800);
  await game('jam', '11-jam', 4000, false); await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(800);
  const ph = await ctx.newPage(); ph.setViewportSize({ width: 430, height: 932 }); await ph.goto(`http://127.0.0.1:${H}/phone/?code=${CODE}`).catch(() => {}); await sleep(1500);
  await ph.screenshot({ path: OUT + '/12-phone' + TAG + '.png' }); console.log('shot 12-phone');
} catch (e) { console.log('ERR ' + e.message); }
console.log(JSON.stringify(report)); console.log('pageerrors: ' + (errs.join(' | ') || 'none'));
await browser.close(); server.kill();
