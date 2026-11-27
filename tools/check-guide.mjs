// Headless: guide vocals play in sync with the instrumental, levels cycle with the remote key and persist.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const WebSocket = createRequire(import.meta.url)('ws');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18083, sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: 18446, KARAOKE_CODE: 'g', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(600);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  let p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${H}/tv/`); await sleep(2500);
  const idx = await p.evaluate(() => KaraokeTVDebug.songs().findIndex(s => s.id === 'twinkle'));
  await p.evaluate(i => KaraokeTVDebug.select(i), idx); await sleep(200);
  check('default level Low', (await p.evaluate(() => KaraokeTVDebug.guide())).level === 'low');
  check('home Guide button shows Low', /Low/.test(await p.evaluate(() => document.getElementById('guideBtnVal').textContent)));
  await p.evaluate(() => KaraokeTVDebug.start()); await sleep(4000);
  let g = await p.evaluate(() => KaraokeTVDebug.guide());
  check('guide playing at 25%', g.playing && Math.abs(g.vol - 0.25) < 1e-6, JSON.stringify(g));
  check('guide in sync (<80 ms)', Math.abs(g.drift) < 0.08, 'drift ' + (g.drift * 1000).toFixed(0) + ' ms');
  await p.keyboard.press('g'); await sleep(300); g = await p.evaluate(() => KaraokeTVDebug.guide());
  check('remote key -> Medium', g.level === 'medium' && Math.abs(g.vol - 0.5) < 1e-6);
  await p.keyboard.press('g'); await p.keyboard.press('g'); await sleep(300); g = await p.evaluate(() => KaraokeTVDebug.guide());
  check('Off pauses the stem', g.level === 'off' && !g.playing, JSON.stringify(g));
  // phone sets Full
  const ph = new WebSocket(`ws://127.0.0.1:${H}/ws?role=phone&s=g`); const got = [];
  ph.on('message', d => got.push(JSON.parse(d)));
  await new Promise(r => ph.on('open', r)); ph.send(JSON.stringify({ type: 'guide', level: 'full' })); await sleep(800);
  g = await p.evaluate(() => KaraokeTVDebug.guide());
  check('phone -> Full', g.level === 'full' && g.playing && g.vol === 1, JSON.stringify(g));
  check('phone gets TV guide state', got.some(m => m.type === 'guide' && m.level === 'full'));
  ph.close();
  await p.reload(); await sleep(2000);
  check('level remembered on the TV', (await p.evaluate(() => KaraokeTVDebug.guide())).level === 'full');
  check('no page errors', errs.length === 0, errs.join(' | '));
} finally { await browser.close(); server.kill(); }
process.exit(fail ? 1 : 0);
