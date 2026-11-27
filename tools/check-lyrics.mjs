// Headless: classic karaoke lyrics — merged phrases, every line fits the title-safe area, wipe follows word timing.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '.local/qa'); fs.mkdirSync(OUT, { recursive: true });
const H = 18114, HS = 18477, sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: 'lyr', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1000);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
try {
  const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${H}/tv/`); await p.waitForFunction(() => window.KaraokeTVDebug, null, { timeout: 15000 }); await sleep(1500);
  const songs = await p.evaluate(() => KaraokeTVDebug.songs());
  for (const s of songs) {
    const avg = s.lines.reduce((a, b) => a + b, 0) / s.lines.length;
    console.log(`INFO ${s.id}: ${s.raw} LRC lines -> ${s.lines.length} phrases, avg ${avg.toFixed(0)} chars`);
  }
  const target = songs.findIndex(s => s.id === 'twinkle');
  let worst = { size: 999 }, twoRows = 0, outside = [];
  for (let si = 0; si < songs.length; si++) {
    await p.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, si); await sleep(250);
    for (let li = 0; li < songs[si].lines.length; li++) {
      const r = await p.evaluate(i => { const x = KaraokeTVDebug.showLine(i, 0.5); const b = document.getElementById('lyricCur').getBoundingClientRect(); const rows = [...document.querySelectorAll('#lyricCur .lrow')].map(e => e.getBoundingClientRect()); return { ...x, l: Math.min(...rows.map(q => q.left)), r: Math.max(...rows.map(q => q.right)), b: b.bottom }; }, li);
      if (r.rows > 1) twoRows++;
      if (parseFloat(r.size) < parseFloat(worst.size || 999)) worst = { ...r, song: songs[si].id };
      if (r.l < 108 || r.r > 1812 || r.b > 1022) outside.push(songs[si].id + '#' + li + ' ' + JSON.stringify(r));
    }
    await p.evaluate(() => KaraokeTVDebug.quit()); await sleep(150);
  }
  check('every lyric line fits the title-safe area', outside.length === 0, outside.slice(0, 3).join(' | '));
  check('smallest current-line font is readable (>= 56 px)', parseFloat(worst.size) >= 56, JSON.stringify(worst));
  console.log('INFO two-row lines:', twoRows);
  // live: wipe moves with the real song clock (user song), screenshots mid-line
  await p.evaluate(i => { window.KaraokeDev.lyrics = true; KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, target);
  await p.waitForFunction(() => KaraokeTVDebug.state().t > 24.2, null, { timeout: 40000 });
  const x1 = await p.evaluate(() => getComputedStyle(document.querySelector('#lyricCur .lclip')).transform);
  await p.screenshot({ path: path.join(OUT, 'lyrics-wipe-1.png') });
  await sleep(1200);
  const x2 = await p.evaluate(() => getComputedStyle(document.querySelector('#lyricCur .lclip')).transform);
  await p.screenshot({ path: path.join(OUT, 'lyrics-wipe-2.png') });
  const tx = m => +(m.match(/matrix\(([^)]+)\)/) || [0, '0,0,0,0,0'])[1].split(',')[4];
  check('wipe advances with the song (user song, live clock)', tx(x2) > tx(x1), tx(x1).toFixed(0) + ' -> ' + tx(x2).toFixed(0) + ' px');
  const ln = await p.evaluate(() => ({ cur: document.getElementById('lyricCur').textContent.slice(0, 80), next: document.getElementById('lyricNext').textContent }));
  check('current + next line shown', ln.cur.length > 10 && ln.next.length > 3, JSON.stringify(ln));
  // wipe is compositor-only: no inline width/clip-path styles are animated
  check('wipe uses transforms only', await p.evaluate(() => { const c = document.querySelector('#lyricCur .lclip'); return !c.style.width && !c.style.clipPath && /translate3d/.test(c.style.transform); }));
  check('no page errors', errs.length === 0, errs.join(' | '));
} finally { await browser.close(); server.kill(); }
console.log(fail ? fail + ' FAILED' : 'all passed'); process.exit(fail ? 1 : 0);
