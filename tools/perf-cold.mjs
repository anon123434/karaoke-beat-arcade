// Cold first-open vs second-open perf (long frames > 50 ms) for each TV screen. PRIVATE server only. CPU throttle THR (default 4).
// RUNS=<n> fresh contexts (empty cache each). Output: .local/perf-cold-<TAG>/report.json
import { createRequire } from 'module'; import { spawn } from 'child_process'; import fs from 'fs';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = process.env.ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, ''), H = +(process.env.PORT || 18620), THR = +(process.env.THR || 4), TAG = process.env.TAG || 'x', RUNS = +(process.env.RUNS || 3);
const OUT = ROOT + '/.local/perf-cold-' + TAG; fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'qaperf', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1500);
const b = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'] });
const all = [];
async function oneRun(run) {
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } }); const tv = await ctx.newPage(); const errs = [];
  tv.on('pageerror', e => errs.push(e.message));
  await tv.addInitScript(() => {
    try { localStorage.setItem('karaoke.engine', 'webaudio'); localStorage.setItem('karaoke.play', 'sing'); } catch (e) {}
    window.__fr = []; window.__lt = []; { const A = window.AudioContext; window.AudioContext = class extends A { constructor(o) { super({ ...(o || {}), sampleRate: 44100 }); } }; }
    let last = performance.now(); (function tick(n) { window.__fr.push([n, n - last]); last = n; requestAnimationFrame(tick); })(last);
    try { new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push([e.startTime, e.duration]))).observe({ entryTypes: ['longtask'] }); } catch (e) {}
  });
  const cdp = await ctx.newCDPSession(tv); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THR });
  const R = {};
  // window(): run fn, then watch WIN ms; report frame gaps > 50 ms inside [t0, t0+WIN]
  const win = async (name, fn, WIN = 2500) => {
    const t0 = await tv.evaluate(() => performance.now()); await fn(); await sleep(WIN);
    const r = await tv.evaluate(([t0, WIN]) => { const g = window.__fr.filter(x => x[0] >= t0 && x[0] <= t0 + WIN).map(x => x[1]); const lt = window.__lt.filter(x => x[0] >= t0 && x[0] <= t0 + WIN).map(x => x[1]);
      return { n: g.length, over50: g.filter(x => x > 50).length, max: Math.round(Math.max(0, ...g)), worst3: g.slice().sort((a, b) => b - a).slice(0, 3).map(Math.round), lt: lt.length, ltMax: Math.round(Math.max(0, ...lt)) }; }, [t0, WIN]);
    R[name] = r; return r;
  };
  const key = k => tv.keyboard.press(k);
  const t00 = Date.now(); await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`);
  await tv.waitForFunction(() => document.querySelectorAll('#songList > .song-card').length > 100, null, { timeout: 90000 }); R.cold_to_list_ms = Date.now() - t00;
  // boot window: from navigation start to +4 s after list ready
  await sleep(3500);
  R['boot'] = await tv.evaluate(() => { const g = window.__fr.map(x => x[1]); return { n: g.length, over50: g.filter(x => x > 50).length, max: Math.round(Math.max(0, ...g)), worst3: g.slice().sort((a, b) => b - a).slice(0, 3).map(Math.round) }; });
  R.fcp = await tv.evaluate(() => Math.round((performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || -1));
  await sleep(1500);
  for (const n of [1, 2]) await win('scroll' + n, async () => { for (let i = 0; i < 8; i++) { await key('ArrowDown'); await sleep(110); } }, 1200);
  for (const n of [1, 2]) await win('cat' + n, async () => { await tv.evaluate(() => KaraokeTVSelect.setCat(1)); await sleep(50); await tv.evaluate(() => KaraokeTVSelect.setCat(0)); }, 1500);
  for (const n of [1, 2]) { await win('search' + n, async () => { await tv.evaluate(() => KaraokeTVSearch.open()); }, 1500); await tv.keyboard.type('lo', { delay: 30 }); await sleep(500); await win('searchClose' + n, async () => { await tv.evaluate(() => KaraokeTVSearch.close()); }, 1200); await tv.evaluate(() => KaraokeTVSearch.apply('')); await sleep(300); }
  // song focus (first time a song becomes the highlighted one -> art, preview, preload)
  const ids = await tv.evaluate(() => KaraokeTVDebug.songs().map(s => s.id));
  for (const n of [1, 2]) await win('focus' + n, async () => { await tv.evaluate(i => KaraokeTVDebug.select(i), 3 + n * 7); }, 3000);
  // dwell on a song that is not decoded yet (browse -> pump decodes it) and an immediate start of an undecoded song
  for (const n of [1, 2]) await win('dwell' + n, async () => { await tv.evaluate(i => KaraokeTVDebug.select(i), 50 + n * 5); }, 6000);
  for (const n of [1, 2]) {
    await win('coldstart' + n, async () => { await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, 70 + n * 5); }, 7000);
    R['coldstart' + n].startMs = await tv.evaluate(() => (KaraokeTVDebug.engine().lastStart || {}).ms); R['coldstart' + n].audioT = await tv.evaluate(() => KaraokeTVDebug.state().t);
    await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(1200);
  }
  // song start: sing, then pause menu, then quit
  for (const n of [1, 2]) {
    await tv.evaluate(i => KaraokeTVDebug.select(i), 3 + n * 7); await sleep(2500);
    await win('songstart' + n, async () => { await tv.evaluate(() => KaraokeTVDebug.start()); }, 4000);
    await win('pause' + n, async () => { await key('Escape'); }, 1200); await key('Escape'); await sleep(500);
    await win('results' + n, async () => { await tv.evaluate(() => KaraokeTVDebug.finish()); }, 3500);
    for (let i = 0; i < 6 && (await tv.evaluate(() => KaraokeTVDebug.state().screen)) !== 'home'; i++) { await key('Escape'); await sleep(700); }
    await sleep(800);
  }
  // beat-mode song start
  await tv.evaluate(() => { localStorage.setItem('karaoke.play', 'beat'); });
  for (const n of [1, 2]) {
    await tv.evaluate(i => KaraokeTVDebug.select(i), 40 + n); await sleep(2500);
    await win('beatstart' + n, async () => { await tv.evaluate(() => KaraokeTVDebug.start()); }, 4000);
    await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(1500);
  }
  R.heap_mb = await tv.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1e6));
  R.errs = errs.slice(0, 5); await ctx.close(); return R;
}
try { for (let r = 0; r < RUNS; r++) { const R = await oneRun(r); all.push(R); console.log('run', r, 'done'); } } catch (e) { console.log('harness exception', e.message); }
server.kill();
await b.close();
// summarise: median over runs of over50 and max per window
const med = a => { a = a.slice().sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
const names = Object.keys(all[0] || {}).filter(k => all[0][k] && typeof all[0][k] === 'object' && 'over50' in all[0][k]);
const S = {}; for (const n of names) S[n] = { over50_med: med(all.map(r => r[n].over50)), max_med: med(all.map(r => r[n].max)), max_worst: Math.max(...all.map(r => r[n].max)), ltMax_med: med(all.map(r => r[n].ltMax || 0)) };
S._cold_to_list_ms = med(all.map(r => r.cold_to_list_ms)); S._fcp = med(all.map(r => r.fcp)); S._heap_mb = med(all.map(r => r.heap_mb));
fs.writeFileSync(OUT + '/report.json', JSON.stringify({ runs: all, summary: S }, null, 1));
console.log('name              over50  max_med  max_worst  longtask_max'); for (const n of names) console.log(n.padEnd(16), String(S[n].over50_med).padStart(5), String(S[n].max_med).padStart(8), String(S[n].max_worst).padStart(9), String(S[n].ltMax_med).padStart(10));
console.log('cold_to_list_ms', S._cold_to_list_ms, 'fcp', S._fcp, 'heap', S._heap_mb);
