// v13.9.2: search is a fixed overlay; the Tizen IME must not rescale the 1920x1080 stage (that shrink+crash was seen on the live TV).
// Private server only. Opens/closes search 50 times and simulates a viewport shrink while the "IME" (focus) is up.
import { createRequire } from 'module'; import { spawn } from 'child_process'; import path from 'path'; import fs from 'fs'; import os from 'os';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18514, sleep = ms => new Promise(r => setTimeout(r, ms));
const FAV = path.join(os.tmpdir(), 'ktv-fav-so-' + process.pid + '.json');
const OUT = path.join(ROOT, '.local/shots/v139'); fs.mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'so', KARAOKE_HOST: '127.0.0.1', FAV_FILE: FAV }, stdio: 'ignore' });
await sleep(1000);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await ctx.newPage(); const errs = []; tv.on('pageerror', e => errs.push(e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`);
  await tv.waitForFunction(() => window.KaraokeTVDebug && KaraokeTVDebug.songs().length > 100, null, { timeout: 30000 });
  await sleep(400);
  const fit = () => tv.evaluate(() => KaraokeTVFit.state());
  const st = () => tv.evaluate(() => KaraokeTVSearch.state());
  const before = await fit();
  check('stage starts at 1920x1080, no scale', before.tw === 1920 && before.th === 1080 && (!before.t || before.t === 'none') && Math.abs(before.k - 1) < 0.002, JSON.stringify(before));
  await tv.evaluate(() => KaraokeTVSearch.open());
  await tv.waitForFunction(() => KaraokeTVSearch.state().overlay && KaraokeTVSearch.state().focus, null, { timeout: 3000 });
  const open1 = await st();
  check('search opens as an overlay (not a layout-expanding bar)', open1.overlay && open1.focus, JSON.stringify(open1));
  const homeShift = await tv.evaluate(() => {
    const b = document.querySelector('.home-body').getBoundingClientRect();
    const rail = document.getElementById('catRail').getBoundingClientRect();
    return { bodyTop: Math.round(b.top), railH: Math.round(rail.height), bodyH: Math.round(b.height) };
  });
  await tv.screenshot({ path: path.join(OUT, 'search-overlay-logo.png') });
  // Simulate the Tizen IME shrinking the layout viewport
  await tv.setViewportSize({ width: 1920, height: 640 }); await sleep(200);
  const mid = await fit();
  const home2 = await tv.evaluate(() => {
    const b = document.querySelector('.home-body').getBoundingClientRect();
    const rail = document.getElementById('catRail').getBoundingClientRect();
    const stg = document.getElementById('stage');
    return { bodyTop: Math.round(b.top), railH: Math.round(rail.height), bodyH: Math.round(b.height), tw: stg.offsetWidth, th: stg.offsetHeight, t: stg.style.transform || 'none', k: KaraokeTVFit.state().k };
  });
  check('IME shrink is ignored: stage stays 1920x1080, transform unchanged', home2.tw === 1920 && home2.th === 1080 && (home2.t === 'none' || home2.t === before.t) && Math.abs(home2.k - 1) < 0.002, JSON.stringify({ mid, home2 }));
  check('underlying song-select layout did not reflow', home2.bodyTop === homeShift.bodyTop && home2.railH === homeShift.railH && home2.bodyH === homeShift.bodyH, JSON.stringify({ homeShift, home2 }));
  check('fit() counted the ignored resize', (await fit()).ignored >= 1, JSON.stringify(await fit()));

  let loops = 0;
  for (let i = 0; i < 50; i++) {
    await tv.evaluate(() => KaraokeTVSearch.close());
    await tv.evaluate(() => KaraokeTVSearch.open());
    loops++;
  }
  await sleep(100);
  const after = await Promise.all([fit(), st()]);
  check('50 open/close loops under a shrunk viewport: overlay still works', loops === 50 && after[1].overlay && after[1].focus, JSON.stringify({ loops, fit: after[0], st: after[1] }));
  check('after 50 loops the stage is still unscaled 1920x1080', after[0].tw === 1920 && after[0].th === 1080 && Math.abs(after[0].k - 1) < 0.002, JSON.stringify(after[0]));

  await tv.setViewportSize({ width: 1920, height: 1080 }); await sleep(150);
  await tv.evaluate(() => KaraokeTVSearch.close()); await sleep(150);
  const done = await fit();
  check('closing search + restoring the viewport leaves the stage at 1920x1080', done.tw === 1920 && done.th === 1080 && Math.abs(done.k - 1) < 0.002, JSON.stringify(done));
  check('no page errors in the IME/search loop', !errs.length, errs.join(' | '));
} catch (e) { fail++; console.log('FAIL exception — ' + e.message); }
await browser.close(); server.kill(); try { fs.unlinkSync(FAV); } catch (e) {}
console.log(fail ? fail + ' FAILED' : 'ALL PASSED'); process.exit(fail ? 1 : 0);
