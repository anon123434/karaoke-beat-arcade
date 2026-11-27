// TEST-ONLY: forces decodeAudioData failures to check the engine's retry + per-song fallback. No real audio judged.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18134, HS = 18497;   // private server instance: never a live :8780 (a second TV page would replace the real TV connection)
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: 'decode', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1000); let fails = 0; const check = (n, ok, d) => { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const b = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const tv = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); const errs = []; tv.on('pageerror', e => errs.push(e.message));
await tv.addInitScript(() => {
  window.__pauses = []; const op = HTMLMediaElement.prototype.pause; HTMLMediaElement.prototype.pause = function () { window.__pauses.push((this.id || this.tagName) + ' ' + (new Error().stack || '').split('\n').slice(2, 6).map(x => x.trim()).join(' < ')); return op.call(this); };
  window.__failDecodes = 0; const P = (window.AudioContext || window.webkitAudioContext).prototype, orig = P.decodeAudioData;
  P.decodeAudioData = function (buf, ok, bad) { if (window.__failDecodes > 0) { window.__failDecodes--; const e = new DOMException('Unable to decode audio data (TEST)', 'EncodingError'); /* like a slow TV decode */ const p = new Promise((res, rej) => setTimeout(() => { if (bad) bad(e); rej(e); }, 1500)); if (bad) p.catch(() => {}); return p; } return orig.call(this, buf, ok, bad); };
});
await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVDebug, null, { timeout: 15000 });
await tv.evaluate(() => { localStorage.setItem('karaoke.engine', 'webaudio'); localStorage.setItem('karaoke.play', 'sing'); }); await tv.reload(); await tv.waitForFunction(() => window.KaraokeTVDebug); await sleep(1500);
const ids = await tv.evaluate(() => KaraokeTVDebug.songs().map(s => s.id)); const ix = id => ids.indexOf(id);
// 1 failure: retry recovers, stays on Web Audio
await tv.evaluate(i => { window.__failDecodes = 1; KaraokeTVDebug.select(i); }, ix('amazing-grace')); await sleep(200);
await tv.evaluate(() => { document.getElementById('audio').volume = 0; KaraokeTVDebug.start(); }); await sleep(4000);
let e = await tv.evaluate(() => ({ mode: KaraokeTVDebug.engine().mode, t: KaraokeTVDebug.state().t, retry: KaraokeTVDebug.engineCache() }));
check('one decode failure → freed cache, retried, still Web Audio and playing', e.mode === 'webaudio' && e.t > 1.5, JSON.stringify({ mode: e.mode, t: e.t }));
await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(800);
// 2 failures: this song on the element player, back to Web Audio on the song list
await tv.evaluate(i => { window.__failDecodes = 99; KaraokeTVDebug.select(i); }, ix('twinkle')); await sleep(300);
await tv.evaluate(() => { KaraokeTVDebug.start(); }); await sleep(7000);
e = await tv.evaluate(() => ({ mode: KaraokeTVDebug.engine().mode, t: KaraokeTVDebug.state().t }));
check('repeated decode failure → this song plays on the element player', e.mode === 'element' && e.t > 1, JSON.stringify(e) + ' el: ' + (await tv.evaluate(() => { const a = document.getElementById('audio'); return JSON.stringify({ paused: a.paused, ct: a.currentTime, src: a.getAttribute('src'), rs: a.readyState, err: a.error && a.error.code, scr: KaraokeTVDebug.state().screen, eng: KaraokeTVDebug.engine().err, isAudioEl: a.tagName, n: document.querySelectorAll('audio').length }); })));
await tv.evaluate(() => { window.__failDecodes = 0; KaraokeTVDebug.quit(); }); await sleep(800);
e = await tv.evaluate(() => ({ mode: KaraokeTVDebug.engine().mode }));
check('back on the song list → Web Audio again', e.mode === 'webaudio', JSON.stringify(e));
await tv.evaluate(i => KaraokeTVDebug.select(i), ix('amazing-grace')); await sleep(2500);
await tv.evaluate(() => KaraokeTVDebug.start()); await sleep(3500);
e = await tv.evaluate(() => ({ mode: KaraokeTVDebug.engine().mode, t: KaraokeTVDebug.state().t, g: KaraokeTVDebug.guide().locked }));
check('next song plays on Web Audio with the guide locked', e.mode === 'webaudio' && e.t > 1.5 && e.g, JSON.stringify(e));
await tv.evaluate(() => KaraokeTVDebug.quit());
check('no page errors', !errs.length, errs.join(' | '));
console.log(fails ? fails + ' FAILED' : 'ALL PASS'); await b.close(); server.kill();
