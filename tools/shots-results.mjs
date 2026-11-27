// v13.9 headless screenshots of the results screens on a PRIVATE server. Rows are TEST DATA (labelled in the corner of the image),
// rendered through the real results code via KaraokeTVDebug.resultsPreview. No pitch input is involved.
import { createRequire } from 'module'; import { spawn } from 'child_process'; import path from 'path'; import fs from 'fs';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), OUT = process.env.SHOTS || path.join(ROOT, '.local/shots/v139');
const H = 18484, sleep = ms => new Promise(r => setTimeout(r, ms)); fs.mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'rs', KARAOKE_HOST: '127.0.0.1', FAV_FILE: '/tmp/ktv-fav-shots.json' }, stdio: 'ignore' });
await sleep(1000); const browser = await pw.chromium.launch();
const errs = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await ctx.newPage(); tv.on('pageerror', e => errs.push(e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVDebug && KaraokeTVDebug.songs().length > 100, null, { timeout: 30000 }); await sleep(600);
  const label = () => tv.evaluate(() => { let d = document.getElementById('__testlbl'); if (!d) { d = document.createElement('div'); d.id = '__testlbl'; d.textContent = 'TEST DATA — layout preview'; d.style.cssText = 'position:fixed;right:8px;bottom:4px;z-index:999;font:14px sans-serif;color:#fff8;'; document.body.appendChild(d); } });
  const rows = [
    { slot: 1, name: 'Sam', color: '#3ff2ff', av: 'img/av0.webp', score: 92, pitch: 94, rhythm: null, combo: 48 },
    { slot: 2, name: 'Mia', color: '#ff3fa4', av: 'img/av1.webp', score: 85, pitch: 88, rhythm: null, combo: 31 },
    { slot: 3, name: 'Beat Bot', color: '#59ffa8', av: 'img/av2.webp', score: 77, pitch: null, rhythm: 81, combo: 64 },
    { slot: 4, name: 'Jay', color: '#ffd75e', av: 'img/av3.webp', score: 61, pitch: 66, rhythm: null, combo: 12 } ];
  await tv.evaluate(r => KaraokeTVDebug.resultsPreview('multi', { rows: r, sub: 'MULTIPLAYER \u2022 BEAT MATCH', winner: true }), rows); await label(); await sleep(2200);
  await tv.screenshot({ path: path.join(OUT, 'results-B-winner.png') });
  await tv.keyboard.press('Enter'); await sleep(2200);
  const st = await tv.evaluate(() => KaraokeTVDebug.results()); console.log('after OK on winner:', JSON.stringify(st));
  await tv.screenshot({ path: path.join(OUT, 'results-A-table.png') });
  await tv.evaluate(() => KaraokeTVDebug.resultsPreview('solo', { score: 87, combo: 112, pitch: null, rhythm: 89, msg: 'GREAT PERFORMANCE!', sub: 'SOLO MODE \u2022 BEAT \u2022 NORMAL' })); await sleep(2400);
  await tv.screenshot({ path: path.join(OUT, 'results-C-solo.png') });
  await tv.keyboard.press('ArrowLeft'); console.log('solo focus after ◀:', JSON.stringify(await tv.evaluate(() => KaraokeTVDebug.results())));
} catch (e) { errs.push('exception ' + e.message); }
console.log('pageerrors:', errs.length ? errs.join(' | ') : 'none');
await browser.close(); server.kill();
