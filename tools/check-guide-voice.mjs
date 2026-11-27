// v13.8.1 headless check on a PRIVATE server (never the live :8780): Voice-through-TV removed + forced off; guide vocals default Full and
// audible from the first frame of a song (also when the song was already preloaded on the list = the reported bug). No mic input faked.
import { createRequire } from 'module'; import { spawn } from 'child_process'; import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18464, sleep = ms => new Promise(r => setTimeout(r, ms)), SONG = 'twinkle';
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'gv', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1000); const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  // simulate an existing TV install: Voice was ON at High and guide was Low (old default) before the update
  await ctx.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('karaoke.voiceLevel', 'high'); localStorage.setItem('karaoke.voiceOffMigrated', '1'); localStorage.setItem('karaoke.guideLevel', 'low'); localStorage.setItem('karaoke.engine', 'webaudio'); } });
  const tv = await ctx.newPage(); const errs = []; tv.on('pageerror', e => errs.push(e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVDebug && KaraokeTVDebug.songs().length > 100, null, { timeout: 30000 }); await sleep(800);
  check('no Voice button on the home screen', await tv.evaluate(() => !document.getElementById('voiceBtn') && ![...document.querySelectorAll('#homeRow .hbtn')].some(b => /voice/i.test(b.textContent))));
  check('no Voice item in the pause menu', await tv.evaluate(() => ![...document.querySelectorAll('#pauseMenu .pm-item')].some(b => /voice/i.test(b.textContent))));
  check('saved Voice=High is forced off', await tv.evaluate(() => localStorage.getItem('karaoke.voiceLevel') === 'off' && KaraokeTVDebug.voice && JSON.stringify(KaraokeTVDebug.voice()).indexOf('"master":true') < 0), await tv.evaluate(() => JSON.stringify(KaraokeTVDebug.voice()).slice(0, 160)));
  check('guide vocals default to Full (old Low default reset once)', await tv.evaluate(() => KaraokeTVDebug.guide().level) === 'full');
  const i = await tv.evaluate(id => KaraokeTVDebug.songs().map(s => s.id).indexOf(id), SONG); await tv.evaluate(i => KaraokeTVDebug.select(i), i);
  await tv.waitForFunction(() => { const c = KaraokeTVDebug.engineCache(); return c && c.ready; }, null, { timeout: 60000 });   // preloaded on the list (bug case)
  await tv.evaluate(() => { KaraokeTVDebug.play('sing'); KaraokeTVDebug.start(); });
  await tv.waitForFunction(() => KaraokeTVDebug.guide().locked, null, { timeout: 30000 }).catch(() => {}); await sleep(800);
  let g = await tv.evaluate(() => Object.assign(KaraokeTVDebug.guide(), { gain: KaraokeTVDebug.guideGain() }));
  check('preloaded song: guide plays at Full from the start, no toggling', g.locked && g.playing && g.gain > 0.9, JSON.stringify(g));
  await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(800);
  await tv.reload(); await tv.waitForFunction(() => window.KaraokeTVDebug && KaraokeTVDebug.songs().length > 100, null, { timeout: 30000 }); await sleep(300);
  await tv.evaluate(i => KaraokeTVDebug.select(i), i); await tv.evaluate(() => { KaraokeTVDebug.play('beat-normal'); KaraokeTVDebug.start(); });   // cold start (not decoded yet)
  await tv.waitForFunction(() => KaraokeTVDebug.guide().locked, null, { timeout: 60000 }).catch(() => {}); await sleep(800);
  g = await tv.evaluate(() => Object.assign(KaraokeTVDebug.guide(), { gain: KaraokeTVDebug.guideGain() }));
  check('cold start (after app restart): guide plays at Full, setting kept', g.locked && g.playing && g.gain > 0.9 && g.level === 'full', JSON.stringify(g));
  check('voice still off after restart', await tv.evaluate(() => localStorage.getItem('karaoke.voiceLevel') === 'off'));
  check('no page errors', !errs.length, errs.join(' | '));
} catch (e) { fail++; console.log('FAIL exception — ' + e.message); }
await browser.close(); server.kill(); console.log(fail ? fail + ' FAILED' : 'ALL PASSED'); process.exit(fail ? 1 : 0);
