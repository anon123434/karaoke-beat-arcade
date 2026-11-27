// v13.9 headless check on a PRIVATE server (never the live :8780) with a throwaway favorites file:
// Song Select category rail, favorites saved on the server, △ difficulty, hover preview (Web Audio, cancelled on move, no game state).
import { createRequire } from 'module'; import { spawn } from 'child_process'; import path from 'path'; import fs from 'fs'; import os from 'os';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18474, sleep = ms => new Promise(r => setTimeout(r, ms)), FAV = path.join(os.tmpdir(), 'ktv-fav-test-' + process.pid + '.json');
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'sel', KARAOKE_HOST: '127.0.0.1', FAV_FILE: FAV }, stdio: 'ignore' });
await sleep(1000); const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => {   // TEST-ONLY synthetic controller
    const btn = () => ({ pressed: false, value: 0, touched: false });
    window.__pad = { id: '"TEST synthetic DualSense" (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn),
      vibrationActuator: { playEffect: () => Promise.resolve('complete') } };
    window.__padOn = false; navigator.getGamepads = () => [window.__padOn ? window.__pad : null, null, null, null];
    window.__tap = (i, ms) => { const b = window.__pad.buttons[i]; b.pressed = true; b.value = 1; window.__pad.timestamp = performance.now(); setTimeout(() => { b.pressed = false; b.value = 0; }, ms || 70); };
    window.__plug = () => { window.__padOn = true; const e = new Event('gamepadconnected'); e.gamepad = window.__pad; window.dispatchEvent(e); };
  });
  await ctx.addInitScript(() => { localStorage.setItem('karaoke.engine', 'webaudio'); localStorage.setItem('karaoke.certOk', '1'); });
  const tv = await ctx.newPage(); const errs = []; tv.on('pageerror', e => errs.push(e.message));
  await tv.addInitScript(() => { try { localStorage.setItem("karaoke.preview", "on"); } catch (e) {} });   // v13.11: preview is opt-in; this check covers the opt-in path
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVDebug && KaraokeTVDebug.songs().length > 100 && KaraokeTVSelect.state().cats.length > 5, null, { timeout: 30000 }); await sleep(500);
  await tv.evaluate(() => window.__plug && __plug());
  const tap = async i => { await tv.evaluate(i => window.__tap(i), i); await sleep(220); };
  const st = () => tv.evaluate(() => KaraokeTVSelect.state());
  let s = await st(); check('library.json categories loaded', s.cats[0] === 'all' && s.cats[1] === 'fav' && s.cats.indexOf('90s-rnb') > 0, s.cats.join(','));
  check('rail shows counts', await tv.evaluate(() => /All Songs\s*\d{3}/.test(document.getElementById('catRail').textContent)));
  check('art cards on rows + preview card', await tv.evaluate(() => { const i = document.querySelector('#songList .art-img'); return i && /art\.webp$/.test(i.src) && /art\.webp$/.test(document.getElementById('pvArt').src); }));
  // hover preview (v13.11: nothing previews until the first key press, so wiggle the D-pad once first)
  await tv.keyboard.press("ArrowDown"); await tv.keyboard.press("ArrowUp");
  await tv.waitForFunction(() => KaraokeTVSelect.state().preview, null, { timeout: 8000 }).catch(() => {});
  s = await st(); check('hover preview plays after a short pause on a song', s.preview === s.selected, JSON.stringify({ p: s.preview, sel: s.selected }));
  await tv.keyboard.press('ArrowDown'); s = await st(); check('moving cancels the preview at once', !s.preview, String(s.preview));
  await tv.keyboard.press('ArrowDown'); await sleep(200); s = await st(); check('no preview before ~400 ms', !s.preview);
  await tv.waitForFunction(() => KaraokeTVSelect.state().preview, null, { timeout: 8000 }).catch(() => {}); s = await st(); check('preview for the new song', s.preview === s.selected);
  check('preview does not touch the game engine (idle guard sees the list)', await tv.evaluate(() => KaraokeTVDebug.state ? KaraokeTVDebug.state().screen === 'home' : document.getElementById('home').classList.contains('active')));
  // category: R1 twice -> 90s R&B (all, fav, 90s-rnb)
  await tap(5); await tap(5); s = await st();
  const vis = s.vis || []; check('R1 → 90s R&B filters the list', s.cat === '90s-rnb' && vis.length > 5 && vis.length < 40, s.cat + ' ' + vis.length);
  check('only matching rows visible', await tv.evaluate(() => [...document.querySelectorAll('#songList .song-card')].filter(c => !c.classList.contains('nomatch')).length) === vis.length);
  await tap(4); await sleep(200); s = await st(); check('L1 back to Favorites (empty)', s.cat === 'fav' && s.vis.length === 0);
  await tap(4); await sleep(200); s = await st(); check('L1 back to All Songs', s.cat === 'all');
  // favorite with □
  const before = s.selected; await tap(2); await sleep(500);
  const saved = JSON.parse(fs.readFileSync(FAV, 'utf8')); check('□ favorites the song, saved on the server', (saved.ids || []).indexOf(before) >= 0, JSON.stringify(saved));
  await tap(5); await sleep(200); s = await st(); check('Favorites category lists it', s.cat === 'fav' && s.vis.length === 1);
  await tv.keyboard.press('ArrowLeft'); await sleep(200); s = await st(); check('remote ◀ enters the category rail without changing category', s.cat === 'fav'); await tv.keyboard.press('ArrowUp'); await sleep(200); s = await st(); check('remote ▲ on the rail = previous category', s.cat === 'all');
  // △ difficulty
  await tv.evaluate(() => KaraokeTVDebug.play('beat-easy')); const d0 = await tv.evaluate(() => localStorage.getItem('karaoke.play'));
  await tap(3); const d1 = await tv.evaluate(() => localStorage.getItem('karaoke.play'));
  check('△ cycles difficulty', d0 === 'beat-easy' && d1 === 'beat-normal', d0 + ' → ' + d1);
  // search still works with R3 and combines with category
  await tap(11); await sleep(200); check('R3 opens search', await tv.evaluate(() => document.getElementById('searchBar').classList.contains('active')));
  await tv.keyboard.press('Escape').catch(() => {});
  await tv.reload(); await tv.waitForFunction(() => window.KaraokeTVSelect && KaraokeTVSelect.state().favs.length === 1, null, { timeout: 20000 }).catch(() => {});
  check('favorites persist after reload (from the server)', (await st()).favs[0] === before);
  // starting a song stops the preview
  await tv.waitForFunction(() => KaraokeTVSelect.state().preview, null, { timeout: 8000 }).catch(() => {});
  await tv.evaluate(() => { KaraokeTVDebug.play('beat-normal'); KaraokeTVDebug.start(); }); await sleep(300);
  s = await st(); check('starting a song stops the preview', !s.preview);
  if (process.env.SHOT) { await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(1500); await tv.evaluate(() => { KaraokeTVSelect.setCat(0); KaraokeTVDebug.select(2); }); await sleep(2500); await tv.screenshot({ path: process.env.SHOT }); }
  check('no page errors', !errs.length, errs.join(' | '));
} catch (e) { fail++; console.log('FAIL exception — ' + e.message); }
await browser.close(); server.kill(); try { fs.unlinkSync(FAV); } catch (e) {} console.log(fail ? fail + ' FAILED' : 'ALL PASSED'); process.exit(fail ? 1 : 0);
