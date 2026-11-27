// Song-list scroll with dwells (what triggers preview + audio preload in <=v13.10). Counts frame gaps, decodes, audio bytes, preview sources. PRIVATE server.
import { createRequire } from 'module'; import { spawn } from 'child_process';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = process.env.ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, ''), H = +(process.env.PORT || 18700), THR = +(process.env.THR || 4), RUNS = +(process.env.RUNS || 3); const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'qascroll', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' }); await sleep(1500);
const b = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const out = [];
for (let r = 0; r < RUNS; r++) {
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } }); const pg = await ctx.newPage(); let bytes = 0, files = 0;
  pg.on('response', async x => { if (/\.(mp3|wav)(\?|$)/.test(x.url())) { files++; try { bytes += (await x.body()).length; } catch (e) {} } });
  await pg.addInitScript(() => {
    localStorage.setItem('karaoke.engine', 'webaudio'); const A = window.AudioContext; window.__dec = 0; window.__src = 0; window.__fr = []; window.__lt = [];
    window.AudioContext = class extends A { constructor(o) { super({ ...(o || {}), sampleRate: 44100 }); } decodeAudioData(...a) { window.__dec++; return super.decodeAudioData(...a); } createBufferSource() { window.__src++; return super.createBufferSource(); } };
    let last = performance.now(); (function t(n) { window.__fr.push([n, n - last]); last = n; requestAnimationFrame(t); })(last);
    try { new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(e.duration))).observe({ entryTypes: ['longtask'] }); } catch (e) {}
  });
  const cdp = await ctx.newCDPSession(pg); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THR });
  await pg.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await pg.waitForFunction(() => document.querySelectorAll('#songList > .song-card').length > 100); await sleep(4000);
  const t0 = await pg.evaluate(() => performance.now()); await pg.keyboard.press('ArrowDown');
  for (let k = 0; k < 8; k++) { for (let i = 0; i < 6; i++) { await pg.keyboard.press('ArrowDown'); await sleep(120); } await sleep(1300); }
  const m = await pg.evaluate(t0 => { const g = window.__fr.filter(x => x[0] >= t0).map(x => x[1]); return { frames: g.length, over50: g.filter(x => x > 50).length, maxGap: Math.round(Math.max(...g)), longtasks: window.__lt.length, ltMax: Math.round(Math.max(0, ...window.__lt)), decodes: window.__dec, previewSources: window.__src }; }, t0);
  out.push({ ...m, audioFiles: files, audioMB: +(bytes / 1e6).toFixed(1) }); await ctx.close();
}
console.log(JSON.stringify(out)); server.kill(); await b.close();
