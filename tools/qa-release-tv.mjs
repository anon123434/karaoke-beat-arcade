// Release QA: TV UI perf + search stress on a PRIVATE server (never the live :8780). TEST-ONLY synthetic keys. ROOT=<checkout>
import { createRequire } from 'module'; import { spawn } from 'child_process'; import fs from 'fs';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = process.env.ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, ''), H = +(process.env.PORT || 18610), THR = +(process.env.THR || 6), TAG = process.env.TAG || 'x';
const OUT = ROOT + '/.local/qa-tv-' + TAG; fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms)); const R = { tag: TAG, thr: THR, bugs: [], m: {} }; const bug = (s, x, d) => { R.bugs.push([s, x, d]); console.log('BUG', s, x, d || ''); };
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'qatv', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1200);
const b = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info'] });
try {
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } }); const tv = await ctx.newPage(); const errs = [];
  tv.on('pageerror', e => errs.push(e.message)); tv.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_|404/.test(m.text())) errs.push(m.text()); });
  const cdp = await ctx.newCDPSession(tv); await cdp.send('Emulation.setCPUThrottlingRate', { rate: THR });
  const frames = ms => tv.evaluate(ms => new Promise(res => { const f = []; let last = performance.now(); const t0 = last; (function tick(n) { f.push(n - last); last = n; if (n - t0 < ms) requestAnimationFrame(tick); else { f.shift(); const s = f.slice().sort((a, b) => a - b); res({ fps: +(f.length / (ms / 1000)).toFixed(1), p95: +s[Math.floor(s.length * .95)].toFixed(1), max: +s[s.length - 1].toFixed(1), over33: f.filter(x => x > 34).length }); } })(performance.now()); }), ms);
  const during = async (ms, fn) => { const p = frames(ms); await fn(); return p; };
  let t = Date.now(); await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`);
  await tv.waitForFunction(() => document.querySelectorAll('#songList > .song-card').length > 100, null, { timeout: 60000 }); R.m.cold_to_list_ms = Date.now() - t;
  R.m.fcp_ms = await tv.evaluate(() => Math.round((performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || -1));
  await sleep(1500);
  R.m.home_idle = await frames(4000);
  const press = async (k, n, gap) => { for (let i = 0; i < n; i++) { await tv.keyboard.press(k); await sleep(gap); } };
  R.m.home_scroll = await during(4000, () => press('ArrowDown', 25, 140));
  // D-pad input -> paint latency
  const lat = []; for (let i = 0; i < 10; i++) { lat.push(await tv.evaluate(() => new Promise(res => { const t0 = performance.now(); document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 40, which: 40, key: 'ArrowDown', bubbles: true })); requestAnimationFrame(() => requestAnimationFrame(() => res(Math.round(performance.now() - t0)))); }))); await sleep(300); }
  lat.sort((a, b) => a - b); R.m.dpad_paint_ms = { p50: lat[5], max: lat[9] };
  // preview delay
  await tv.keyboard.press('ArrowDown'); t = Date.now(); let pv = -1; for (let i = 0; i < 80; i++) { if (await tv.evaluate(() => KaraokeTVSelect.state().preview)) { pv = Date.now() - t; break; } await sleep(100); } R.m.preview_ms = pv;
  // a song, then back to the list
  t = Date.now(); await tv.evaluate(() => KaraokeTVDebug.start()); let st = -1; for (let i = 0; i < 200; i++) { const s = await tv.evaluate(() => KaraokeTVDebug.state()); if (s.screen === 'game' && s.t > 0.05) { st = Date.now() - t; break; } await sleep(100); } R.m.start_to_audio_ms = st;
  R.m.game = await frames(5000); await tv.screenshot({ path: OUT + '/game.png' });
  await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(1500);
  R.m.home_idle_after_song = await frames(4000);
  R.m.home_scroll_after_song = await during(4000, () => press('ArrowUp', 25, 140));
  // ---- search stress (50x): open, IME-like viewport shrink, type, close by ▼ / Back / Done; plus blur-then-Back
  await tv.evaluate(() => KaraokeTVDebug.select(0)); await sleep(300);
  let stuck = 0, rescaled = 0, dirty = 0; const e0 = errs.length; t = Date.now();
  for (let i = 0; i < 50; i++) {
    if (i % 2) { await tv.evaluate(() => KaraokeTVDebug.select(0)); await sleep(40); await tv.evaluate(() => KaraokeTVDebug.key(404)); } else await tv.evaluate(() => KaraokeTVSearch.open());
    await tv.setViewportSize({ width: 1920, height: 560 }); await sleep(30);
    await tv.keyboard.type(['hotel', 'a', 'boyz', 'x', 'love'][i % 5], { delay: 15 });
    const f = await tv.evaluate(() => ({ ...KaraokeTVFit.state(), o: KaraokeTVSearch.state().overlay })); if (!f.o) bug('B', 'search did not open', 'iter ' + i); else if (f.t !== 'none' || f.rw !== 1920) rescaled++;
    const how = i % 5;
    if (how === 0) await tv.keyboard.press('ArrowDown');
    else if (how === 1) await tv.keyboard.press('Escape');
    else if (how === 2) await tv.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 65376, which: 65376, bubbles: true })));
    else if (how === 3) { await tv.evaluate(() => document.getElementById('searchInput').blur()); await tv.keyboard.press('Escape'); }   // IME closed (blur), then Back
    else { await tv.evaluate(() => document.getElementById('searchInput').blur()); await tv.keyboard.press('ArrowDown'); }               // IME closed (blur), then ▼
    await tv.setViewportSize({ width: 1920, height: 1080 }); await sleep(60);
    const s = await tv.evaluate(() => KaraokeTVSearch.state());
    if (s.overlay || s.focus) { stuck++; if (stuck < 4) console.log('stuck after mode', how, JSON.stringify({ o: s.overlay, f: s.focus, q: s.q })); await tv.evaluate(() => KaraokeTVSearch.close()); }
    if (s.q) { await tv.keyboard.press('Escape'); await sleep(50); }
  }
  R.m.search50_ms = Date.now() - t; R.m.search_stuck = stuck; R.m.search_rescaled = rescaled;
  const fin = await tv.evaluate(() => ({ s: KaraokeTVSearch.state(), f: KaraokeTVFit.state() }));
  if (stuck) bug('A', 'search overlay stays open over the list after the TV keyboard closes (blur) and Back/▼ is pressed', stuck + '/50');
  if (rescaled) bug('A', 'stage rescaled while the IME shrank the viewport', rescaled + '/50');
  if (fin.s.shown < 100 || fin.s.q) bug('B', 'list not restored after search stress', JSON.stringify({ shown: fin.s.shown, q: fin.s.q }));
  if (errs.length > e0) bug('A', 'JS errors during search stress', errs.slice(e0, e0 + 3).join(' | '));
  R.m.home_idle_after_search = await frames(3000);
  // Back at every screen
  await tv.keyboard.press('Escape'); await sleep(300); const sc1 = await tv.evaluate(() => KaraokeTVDebug.state().screen);
  await tv.evaluate(() => KaraokeTVDebug.start()); await sleep(2500); await tv.keyboard.press('Escape'); await sleep(500); const pz = await tv.evaluate(() => KaraokeTVDebug.paused());
  await tv.keyboard.press('Escape'); await sleep(500); const pz2 = await tv.evaluate(() => KaraokeTVDebug.paused());
  await tv.evaluate(() => KaraokeTVDebug.finish()); await sleep(3000); const sc2 = await tv.evaluate(() => KaraokeTVDebug.state().screen);
  for (let i = 0; i < 5 && (await tv.evaluate(() => KaraokeTVDebug.state().screen)) !== 'home'; i++) { await tv.keyboard.press('Escape'); await sleep(700); }
  const sc3 = await tv.evaluate(() => KaraokeTVDebug.state().screen);
  R.back = { homeBack: sc1, pauseOnBack: pz, resumeOn2ndBack: !pz2, afterFinish: sc2, resultsBackTo: sc3 };
  if (sc3 !== 'home') bug('A', 'Back does not leave results', sc3);
  // memory over repeated songs
  const heap = []; for (let k = 0; k < 6; k++) { await tv.evaluate(i => KaraokeTVDebug.select(i), 2 + k * 9); await sleep(800); await tv.evaluate(() => KaraokeTVDebug.start()); await sleep(3000); await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(600); await cdp.send('HeapProfiler.collectGarbage'); heap.push(Math.round(await tv.evaluate(() => performance.memory.usedJSHeapSize) / 1e6)); }
  R.m.heap_mb = heap; R.m.dom_nodes = await tv.evaluate(() => document.getElementsByTagName('*').length);
  await tv.screenshot({ path: OUT + '/home-end.png' });
  R.errs = errs.slice(0, 10);
} catch (e) { bug('A', 'harness exception', e.message.slice(0, 300)); }
fs.writeFileSync(OUT + '/report.json', JSON.stringify(R, null, 1)); console.log(JSON.stringify(R, null, 1));
await b.close(); server.kill(); process.exit(0);
