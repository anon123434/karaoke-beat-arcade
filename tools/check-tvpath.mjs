// Headless check of the TV code path (?tizenlike=1): old <audio> player by default (no guide element), silent engine
// check via /api/dev, switch to Web Audio via /api/dev without reinstall, user song plays past 5 s on both paths.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const WebSocket = createRequire(import.meta.url)('ws');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18104, HS = 18467, CODE = 'tvpath', sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: CODE, KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1000);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const dev = q => fetch(`http://127.0.0.1:${H}/api/dev?${q}`).then(r => r.json());
const perfLog = path.join(ROOT, '.local/perf.log');
const lastPerf = (screen, since) => fs.readFileSync(perfLog, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return {}; } }).filter(j => j.screen === screen && j.src === 'browser' && (j.at || '') >= since).pop();
try {
  const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; tv.on('pageerror', e => errs.push(e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVDebug, null, { timeout: 15000 }); await sleep(1500);
  check('TV path starts on the old <audio> player', (await tv.evaluate(() => KaraokeTVDebug.engine())).mode === 'element');
  const songs = await tv.evaluate(() => KaraokeTVDebug.songs().map(s => s.id)), idx = songs.indexOf('twinkle');
  await tv.evaluate(i => KaraokeTVDebug.select(i), idx); await sleep(300);
  check('guide shows "next update" on the old player', /next update/.test(await tv.evaluate(() => document.getElementById('guideBtnVal').textContent)));
  const playFor = async (label) => {
    await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, idx); await sleep(6500);
    const st = await tv.evaluate(() => KaraokeTVDebug.state()), g = await tv.evaluate(() => KaraokeTVDebug.guide());
    check(label + ': user song plays past 5 s', st.t > 5, 't=' + st.t.toFixed(2));
    await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(400);
    return g;
  };
  let g = await playFor('old player');
  check('old player: guide element never used', !g.playing && !g.src, JSON.stringify(g));
  // engine check refuses during a song
  await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, idx); await sleep(800);
  let since = new Date().toISOString(); await dev('action=enginecheck&song=' + idx); await sleep(800);
  check('engine check refuses during a song', (lastPerf('enginecheck', since) || {}).skipped === 'not on home');
  await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(400);
  since = new Date().toISOString(); await dev('action=enginecheck&song=' + idx); await sleep(9000);
  const ec = lastPerf('enginecheck', since) || {};
  check('silent engine check passes', ec.ok === true, JSON.stringify(ec));
  check('engine check leaves the old player intact', (await tv.evaluate(() => KaraokeTVDebug.engine())).mode === 'element');
  // race: a song starts while the silent check is running -> the check must not mute or pause it
  await dev('action=enginecheck&song=' + idx); await sleep(150);
  await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, idx); await sleep(9000);
  const rs = await tv.evaluate(() => ({ t: KaraokeTVDebug.state().t, vol: document.getElementById('audio').volume, paused: document.getElementById('audio').paused }));
  check('song started during an engine check keeps playing at full volume', rs.t > 7 && rs.vol === 1 && !rs.paused, JSON.stringify(rs));
  await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(400);
  // switch without reinstall
  await dev('action=engine&value=webaudio'); await sleep(500);
  await tv.waitForFunction(() => window.KaraokeTVDebug, null, { timeout: 15000 }); await sleep(1500);
  check('switched to Web Audio after reload', (await tv.evaluate(() => KaraokeTVDebug.engine())).mode === 'webaudio');
  // preloading while browsing: focused song decoded in the background, starts are instant
  await tv.evaluate(i => KaraokeTVDebug.select(i), idx); await sleep(3000);
  let ci = await tv.evaluate(() => KaraokeTVDebug.engineCache());
  check('v13.11: highlighting a song decodes nothing (audio only after the song is picked)', ci.buffers === 0 && !ci.ready, JSON.stringify(ci));
  g = await playFor('Web Audio');
  const ss = await tv.evaluate(() => KaraokeTVDebug.engineCache().lastStart);
  check('song picked from the list starts (decode on pick)', ss && ss.ms > 0 && ss.ms < 20000, JSON.stringify(ss));
  for (let k = 0; k < 6; k++) { await tv.evaluate(i => KaraokeTVDebug.select(i), k + 2); await sleep(150); }  // scroll quickly
  await sleep(4000);
  ci = await tv.evaluate(() => KaraokeTVDebug.engineCache());
  check('scrolling keeps memory bounded (only the focused song cached)', ci.buffers <= 2 && ci.mb < 200, JSON.stringify(ci));
  const cold = songs.indexOf('twinkle');
  await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, cold); await sleep(4000);
  const cs = await tv.evaluate(() => ({ st: KaraokeTVDebug.state(), ls: KaraokeTVDebug.engineCache().lastStart }));
  check('un-preloaded song still starts (waits for decode)', cs.st.t > 1 && cs.ls && cs.ls.preloaded === false, JSON.stringify(cs.ls));
  await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(300);
  check('Web Audio: guide sample-locked', g.engine === 'webaudio' && g.locked, JSON.stringify(g));
  await dev('action=engine&value=element'); await sleep(500);
  await tv.waitForFunction(() => window.KaraokeTVDebug, null, { timeout: 15000 }); await sleep(1000);
  check('can switch back to the old player', (await tv.evaluate(() => KaraokeTVDebug.engine())).mode === 'element');
  // voice monitoring while music uses the old player
  const ws = new WebSocket(`wss://127.0.0.1:${HS}/ws?role=phone&s=${CODE}&cid=x&name=x`, { rejectUnauthorized: false });
  let master = false; ws.on('message', d => { const m = JSON.parse(d); if (m.type === 'voice') master = m.master; });
  await new Promise(r => ws.on('open', r)); ws.send(JSON.stringify({ type: 'voice', on: true, vol: 0.8 }));
  await tv.evaluate(() => window.toggleVoiceMaster()); await sleep(300);
  let sent = 0; const t0 = performance.now();
  const tm = setInterval(() => { if (!master) return; const due = Math.floor((performance.now() - t0) / (256 / 24)); while (sent < due) { const b = Buffer.alloc(520); b.writeUInt8(1, 0); ws.send(b); sent++; } }, 4); // [synthetic] silent PCM
  await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, idx); await sleep(3000);
  const v = Object.values((await tv.evaluate(() => KaraokeTVDebug.voice())).voices)[0] || {};
  check('[synthetic] voice through TV stays off (removed in v13.8.1): no phone audio is played', !(v.bufMs > 0), JSON.stringify(v));
  check('song still plays with voices on', (await tv.evaluate(() => KaraokeTVDebug.state())).t > 2);
  clearInterval(tm); ws.close();
  check('no page errors', errs.length === 0, errs.join(' | '));
} finally { await browser.close(); server.kill(); }
console.log(fail ? fail + ' FAILED' : 'all passed'); process.exit(fail ? 1 : 0);
