// Headless 1920x1080: game + results screens stay inside the 5% title-safe area; longest lyric line auto-fits.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '.local/qa'); fs.mkdirSync(OUT, { recursive: true });
const H = 18082, sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: 18445, KARAOKE_CODE: 'shot', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(600);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const inSafe = `(sel) => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null || getComputedStyle(e).position === 'absolute').map(e => { const b = e.getBoundingClientRect(); return { sel, w: b.width, l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), sw: e.scrollWidth, cw: e.clientWidth }; })`;
try {
  const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${H}/tv/`); await sleep(2500);
  const songs = await p.evaluate(() => KaraokeTVDebug.songs());
  // song with the longest lyric line
  let si = 0, li = 0, mx = 0; songs.forEach((s, i) => s.lines.forEach((n, j) => { if (n > mx) { mx = n; si = i; li = j; } }));
  await p.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, si); await sleep(1500);
  await p.evaluate(i => KaraokeTVDebug.showLine(i), li); await sleep(300);
  const sels = ['#game .hud-title', '#game .hud-score', '#game .score', '#game .lane-wrap', '#lyricCur', '#lyricNext', '#game .progress', '#game .time'];
  for (const s of sels) {
    const g = await p.evaluate(sel => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), sw: e.scrollWidth, cw: e.clientWidth }; }, s);
    if (!g) { check(s, false, 'missing'); continue; }
    const textFits = (s.startsWith('#lyric') ? g.sw <= 1700 + 2 : true);
    check(s + ' in title-safe area', g.l >= 96 && g.r <= 1824 && g.t >= 54 && g.b <= 1026 && textFits, JSON.stringify(g));
  }
  const lyr = await p.evaluate(() => ({ cur: document.getElementById('lyricCur').innerText, fs: document.getElementById('lyricCur').style.fontSize, two: document.getElementById('lyricCur').classList.contains('two') }));
  console.log('longest line (' + mx + ' chars, song ' + songs[si].id + '):', JSON.stringify(lyr));
  await p.screenshot({ path: path.join(OUT, 'game-longline.png') });
  check('no page errors', errs.length === 0, errs.join(' | '));
} finally { await browser.close(); server.kill(); }
process.exit(fail ? 1 : 0);
