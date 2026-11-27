// Headless screenshots + checks of the v13.5 streak visuals (chain line, multiplier meter, milestone, max-tier edge glow, break shards).
// TEST-ONLY: a synthetic "DualSense" + timing bot presses on time so the streak builds; this is not scoring input on the TV. Private server.
import { createRequire } from 'module'; import { spawn } from 'child_process'; import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18174, HS = 18607, sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: 'streak', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1000);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const FAKE_PAD = () => {   // TEST-ONLY synthetic DualSense (standard mapping) + timing bot
  const btn = () => ({ pressed: false, value: 0, touched: false });
  window.__pad = { id: '"TEST synthetic DualSense Wireless Controller" (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn),
    vibrationActuator: { playEffect: () => { window.__rumbles = (window.__rumbles || 0) + 1; return Promise.resolve('complete'); } } };
  window.__padOn = false;
  navigator.getGamepads = () => [window.__padOn ? window.__pad : null, null, null, null];
  window.__tap = (i, holdMs) => { const b = window.__pad.buttons[i]; b.pressed = true; b.value = 1; window.__pad.timestamp = performance.now(); setTimeout(() => { b.pressed = false; b.value = 0; window.__pad.timestamp = performance.now(); }, holdMs || 60); };
  window.__plug = () => { window.__padOn = true; const e = new Event('gamepadconnected'); e.gamepad = window.__pad; window.dispatchEvent(e); };
  window.__bot = (via, lateMs) => {
    const done = new Set(); window.__botOn = true;
    (function tick() {
      if (!window.__botOn) return;
      const d = KaraokeTVDebug.beat(); if (d) d.upcoming.forEach(p => {
        const k = p.t.toFixed(3) + ':' + p.lane, j = (lateMs || 0) / 1000, L = KaraokeBeat.LANES[p.lane];
        if (!done.has(k) && p.t + j - d.h <= 0.008) {
          done.add(k);
          if (via === 'pad') window.__tap(L.btn[0], p.dur ? p.dur * 1000 + 40 : 60);
          else { const e = new KeyboardEvent('keydown', { bubbles: true }); Object.defineProperty(e, 'keyCode', { get: () => L.key }); document.dispatchEvent(e); }
        }
      });
      requestAnimationFrame(tick);
    })();
  };
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); await ctx.addInitScript(FAKE_PAD);
  const tv = await ctx.newPage(); const errs = []; tv.on('pageerror', e => errs.push(e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVDebug, null, { timeout: 15000 });
  await tv.evaluate(() => { localStorage.setItem('karaoke.engine', 'webaudio'); localStorage.setItem('karaoke.beatOffsetMs', '0'); }); await tv.reload();
  await tv.waitForFunction(() => window.KaraokeTVDebug, null, { timeout: 15000 }); await sleep(1200);
  const songs = await tv.evaluate(() => KaraokeTVDebug.songs().map(s => s.id));
  for (const [mode, id, file] of [['beat-normal', process.argv[2] || 'twinkle', '.local/shots/streak-beat.png'], ['duet-normal', process.argv[3] || 'amazing-grace', '.local/shots/streak-duet.png']]) {
    await tv.evaluate(() => { window.__plug(); });
    await tv.evaluate(([m, i]) => { KaraokeTVDebug.play(m); KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, [mode, songs.indexOf(id)]);
    await tv.evaluate(() => window.__bot('pad', 0));
    await tv.waitForFunction(() => { const b = KaraokeTVDebug.beat(); return b && b.combo >= 34; }, null, { timeout: 120000 });
    // wait for a moment with a long visible chain (several recent hits on screen)
    await tv.waitForFunction(() => { const b = KaraokeTVDebug.beat(); return b && b.combo >= 50; }, null, { timeout: 120000 }); await sleep(250);   // 50+ streak, mid-chorus: chain + milestone + x4 meter all on screen
    await sleep(40);
    const st = await tv.evaluate(() => ({ combo: KaraokeTVDebug.beat().combo, edge: document.querySelector('.bt-edge').className, fps: 0 }));
    await tv.screenshot({ path: file });
    const fps = await tv.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); (function f() { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n / 2); })(); }));
    check(mode + ': streak reaches x4 (combo ' + st.combo + '), edge glow on', st.combo >= 30 && /on/.test(st.edge), st.edge);
    check(mode + ': frame rate with full streak fx (headless)', fps >= 50, fps + ' fps');
    // break: stop the bot -> a miss resets the tier and the edge glow
    await tv.evaluate(() => { window.__botOn = false; });
    await tv.waitForFunction(() => KaraokeTVDebug.beat().combo === 0, null, { timeout: 20000 });
    await sleep(60); if (mode === 'beat-normal') await tv.screenshot({ path: '.local/shots/streak-break.png' });
    const br = await tv.evaluate(() => document.querySelector('.bt-edge').className);
    check(mode + ': a miss breaks the streak (x1, edge glow off)', !/on/.test(br), br);
    await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(500);
  }
  check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
} catch (e) { fail++; console.log('FAIL run — ' + e.message); }
await browser.close(); server.kill();
console.log(fail ? fail + ' FAILED' : 'ALL PASS'); process.exit(fail ? 1 : 0);
