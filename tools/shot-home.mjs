// Headless 1920x1080 check of the TV home screen: layout stays inside the title-safe area, list scrolls, focus visible.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '.local/qa'); fs.mkdirSync(OUT, { recursive: true });
const H = 18081, sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: 18444, KARAOKE_CODE: 'shot', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(600);
const browser = await pw.chromium.launch();
let fail = 0;
const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
try {
  const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${H}/tv/`); await sleep(2500);
  const n = await p.evaluate(() => document.querySelectorAll('.song-card').length);
  const geom = async () => p.evaluate(() => {
    const r = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
    const vp = r(document.getElementById('songViewport'));
    const f = document.querySelector('.song-card.focused');
    return { vp, brand: r(document.querySelector('#home .brand')), qr: r(document.querySelector('#home .qr-panel')), cal: r(document.getElementById('calBtn')),
      focused: f ? r(f) : null, more: document.getElementById('moreBelow').textContent, count: document.getElementById('songCount').textContent };
  });
  const safe = b => b.l >= 96 && b.t >= 54 && b.r <= 1824 && b.b <= 1026;
  let g = await geom();
  check('songs listed', n >= 5, n + ' cards');
  for (const k of ['vp', 'brand', 'qr', 'cal']) check(k + ' inside title-safe area', safe(g[k]), JSON.stringify(g[k]));
  check('list starts below the title', g.vp.t >= g.brand.b + 10, `brand bottom ${g.brand.b}, list top ${g.vp.t}`);
  check('list left of QR panel', g.vp.r <= g.qr.l, `${g.vp.r} <= ${g.qr.l}`);
  check('more-below indicator', n * 116 > (g.vp.b - g.vp.t) ? /more/.test(g.more) : true, g.more);
  await p.screenshot({ path: path.join(OUT, 'home-top.png') });
  for (let i = 0; i < n; i++) {
    await p.keyboard.press('ArrowDown'); await sleep(300);
    g = await geom();
    if (g.focused) check('focused card ' + (i + 2) + ' fully visible', g.focused.t >= g.vp.t - 1 && g.focused.b <= g.vp.b + 1, g.count);
    if (i === Math.floor(n / 2)) await p.screenshot({ path: path.join(OUT, 'home-mid.png') });
  }
  g = await geom();
  check('cal button reachable', await p.evaluate(() => document.getElementById('calBtn').classList.contains('focused')));
  // settings row with arrows + OK only (no colour keys)
  const val = id => p.evaluate(i => document.getElementById(i).textContent, id);
  await p.keyboard.press('ArrowRight'); const g0 = await val('guideBtnVal'); await p.keyboard.press('Enter'); await sleep(100);
  check('Guide button cycles with OK', (await val('guideBtnVal')) !== g0, g0 + ' -> ' + await val('guideBtnVal'));
  await p.keyboard.press('ArrowRight'); const m0 = await val('modeBtnVal'); await p.keyboard.press('Enter'); await sleep(100);
  check('Mode button cycles with OK', (await val('modeBtnVal')) !== m0, m0 + ' -> ' + await val('modeBtnVal'));
  await p.keyboard.press('ArrowRight'); const ca0 = await p.evaluate(() => KaraokeTVDebug.home().caVisible); await p.keyboard.press('Enter'); await sleep(100);
  { const h = await p.evaluate(() => KaraokeTVDebug.home()); check('Add phone button toggles setup QR (always shown until a phone has joined)', h.certOk ? h.caVisible !== ca0 : h.caVisible, JSON.stringify(h)); }
  for (const id of ['calBtn', 'guideBtn', 'modeBtn', 'phoneBtn']) { const b = await p.evaluate(i => { const r = document.getElementById(i).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }, id); check(id + ' inside title-safe area', safe(b), JSON.stringify(b)); }
  await p.screenshot({ path: path.join(OUT, 'home-row.png') });
  await p.keyboard.press('Enter'); await p.keyboard.press('ArrowLeft'); await p.keyboard.press('Enter'); await p.keyboard.press('Enter'); await p.keyboard.press('ArrowLeft'); for (let i = 0; i < 3; i++) await p.keyboard.press('Enter'); // restore mode/guide defaults
  await p.screenshot({ path: path.join(OUT, 'home-bottom.png') });
  for (let i = 0; i <= n; i++) await p.keyboard.press('ArrowUp');
  await sleep(400); await p.screenshot({ path: path.join(OUT, 'home-top.png') });
  check('no page errors', errs.length === 0, errs.join(' | '));
} finally { await browser.close(); server.kill(); }
process.exit(fail ? 1 : 0);
