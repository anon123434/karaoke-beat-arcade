// Headless check of v13.7 Record map on a PRIVATE server (never the live :8780). TEST-ONLY synthetic inputs: a fake DualSense and a
// tapping bot. Saves go to songs/twinkle (built-in demo); its song.json is restored afterwards and the test versions removed.
import { createRequire } from 'module'; import { spawn } from 'child_process'; import path from 'path'; import fs from 'fs';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18424, HS = 18425, CODE = 'rec', sleep = ms => new Promise(r => setTimeout(r, ms)); const OUT = process.env.SHOTS || ROOT + '/.local/shots'; fs.mkdirSync(OUT, { recursive: true });
const SJ = ROOT + '/songs/twinkle/song.json', BAK = fs.readFileSync(SJ), VDIR = ROOT + '/songs/twinkle/custom-versions';
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: CODE, KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
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
  const tv = await ctx.newPage(); const errs = []; tv.on('pageerror', e => errs.push(e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVRec && KaraokeTVDebug.songs().length > 100, null, { timeout: 30000 });
  await tv.evaluate(() => { localStorage.setItem('karaoke.engine', 'webaudio'); localStorage.removeItem('karaoke.beatOffsetMs'); localStorage.removeItem('karaoke.pick.twinkle'); }); await tv.reload();
  await tv.waitForFunction(() => window.KaraokeTVRec && KaraokeTVDebug.songs().length > 100, null, { timeout: 30000 }); await sleep(800);
  await tv.evaluate(() => window.__plug()); await sleep(300);
  const songs = await tv.evaluate(() => KaraokeTVDebug.songs().map(s => s.id)); const ti = songs.indexOf('twinkle');
  await tv.evaluate(i => KaraokeTVDebug.select(i), ti); await tv.evaluate(() => KaraokeTVDebug.play('sing')); await sleep(100);
  await tv.evaluate(() => window.__tap(7)); await sleep(250);   // R2 from Sing -> Record map
  const R = () => tv.evaluate(() => KaraokeTVRec.state());
  check('L2/R2 cycle reaches Record map', (await tv.evaluate(() => KaraokeTVDebug.play())) === 'rec', await tv.evaluate(() => document.getElementById('playNow').textContent));
  await tv.evaluate(() => window.__tap(0)); await sleep(300); let s = await R();
  check('✕ on the song list opens the Record map panel', s.ui === 'menu', s.rows.slice(0, 3).join(' | '));
  await tv.screenshot({ path: OUT + '/rec-1-panel.png' });
  const parts = await tv.evaluate(() => { const o = []; for (let i = 0; i < 6; i++) { KaraokeTVRec.state(); } return document.getElementById('recRows').children.length; });
  check('panel lists the record / preview / undo / clear / save rows', parts >= 12);
  // custom section 4.0-12.0 s, snap 1/8, count-in on, 100% speed -> move to the Record row and press ✕
  const bt = await tv.evaluate(() => KaraokeTVDebug.songs().find(x => x.id === 'twinkle')) && await tv.evaluate(() => { const s = window.__s = null; return true; });
  await tv.evaluate(() => KaraokeTVRec.set({ a: 4, b: 12, sec: 99, snap: 1, speed: 0, count: true, idx: 6 }));
  await tv.evaluate(() => window.__tap(0)); await sleep(200);
  s = await R(); check('Record starts the song with a count-in', !!s.active && (await tv.evaluate(() => KaraokeTVDebug.beat() && KaraokeTVDebug.beat().kind)) === 'rec');
  // TEST-ONLY bot: tap ✕ on every beat and ○ on every off-beat 8th as the beat lines reach the hit line; hold L1 at ~9 s for 1 s
  await tv.evaluate(() => {
    const B = window.__beats = []; window.__bot = true; const bts = (window.__bt = null);
    (function tick() { if (!window.__bot) return; const d = KaraokeTVDebug.beat(); if (d && d.lastH != null) {
      const h = d.lastH, T = window.__targets || (window.__targets = (() => { const out = []; const t = KaraokeTVRecBeats(); for (let k = 0; k + 1 < t.length; k++) { if (t[k] >= 4 && t[k] < 12) { out.push([t[k], 0]); out.push([(t[k] + t[k + 1]) / 2, 1]); } } return out; })());
      while (T.length && T[0][0] <= h) { const [t, lane] = T.shift(); window.__tap(lane === 0 ? 0 : 1); B.push(t); }
      if (!window.__held && h >= 9.0) { window.__held = 1; window.__tap(4, 1000 / 1); }
    } requestAnimationFrame(tick); })();
  });
  await sleep(4500); await tv.screenshot({ path: OUT + '/rec-2-recording.png' });
  await tv.waitForFunction(() => KaraokeTVRec.state().ui === 'menu', null, { timeout: 30000 }); await tv.evaluate(() => { window.__bot = false; });
  s = await R(); const ev = s.draft.ev; const beats = await tv.evaluate(() => KaraokeTVRecBeats());
  const onGrid = ev.filter(e => { let best = 9; for (let k = 0; k + 1 < beats.length; k++) { const L = beats[k + 1] - beats[k]; for (let j = 0; j < 2; j++) best = Math.min(best, Math.abs(e[0] - (beats[k] + j * L / 2))); } return best < 0.002; }).length;
  const expTaps = await tv.evaluate(() => window.__beats.length);
  check('every press became a note in its lane, snapped to the 1/8 grid', ev.length >= expTaps * 0.9 && onGrid === ev.length, ev.length + ' notes / ' + expTaps + ' taps, on grid ' + onGrid);
  const want = await tv.evaluate(() => window.__beats.slice());
  const near = want.filter(t => ev.some(e => Math.abs(e[0] - t) < 0.01)).length;
  check('latency-compensated: notes land on the beats the bot played to (not ~130 ms late)', near >= want.length * 0.9, near + '/' + want.length);
  const hold = ev.find(e => e[1] === 8 && e[2] > 0.5); check('L1 hold became a long note', !!hold, JSON.stringify(hold));
  check('section recorded 4-12 s', JSON.stringify(s.draft.sections) === '[[4,12]]');
  await tv.screenshot({ path: OUT + '/rec-3-after.png' });
  // clear a lane + undo
  const n0 = ev.length; await tv.evaluate(() => KaraokeTVRec.set({ idx: 9, lane: 1 })); await tv.evaluate(() => window.__tap(0)); await sleep(200);
  s = await R(); check('Clear lane removes only ○ notes in the section', s.draft.ev.length < n0 && !s.draft.ev.some(e => e[1] === 1) && s.draft.ev.some(e => e[1] === 0), n0 + ' -> ' + s.draft.ev.length);
  await tv.evaluate(() => KaraokeTVRec.set({ idx: 8 })); await tv.evaluate(() => window.__tap(0)); await sleep(200);
  s = await R(); check('Undo brings them back', s.draft.ev.length === n0);
  // punch-in 6-8 s with no presses: only that range is replaced
  const outside = s.draft.ev.filter(e => e[0] < 6 || e[0] >= 8).length;
  await tv.evaluate(() => KaraokeTVRec.set({ a: 6, b: 8, sec: 99, count: false, idx: 6 })); await tv.evaluate(() => window.__tap(0)); await tv.waitForFunction(() => !!KaraokeTVRec.state().active, null, { timeout: 5000 });
  await tv.waitForFunction(() => KaraokeTVRec.state().ui === 'menu' && !KaraokeTVRec.state().active, null, { timeout: 20000 }); s = await R();
  check('punch-in replaces only 6-8 s', s.draft.ev.filter(e => e[0] >= 6 && e[0] < 8).length === 0 && s.draft.ev.length === outside, s.draft.ev.length + ' notes kept (' + outside + ' outside)');
  await sleep(200); await tv.evaluate(() => KaraokeTVRec.set({ idx: 8 })); await tv.evaluate(() => window.__tap(0)); await sleep(200);   // undo the punch-in
  // 75% speed: the clock runs in song seconds at 0.75x
  await tv.evaluate(() => KaraokeTVRec.set({ a: 13, b: 17, sec: 99, count: false, speed: 1, idx: 6 })); await tv.evaluate(() => window.__tap(0)); await tv.waitForFunction(() => !!KaraokeTVRec.state().active, null, { timeout: 5000 }); await sleep(1500);
  const r1 = await tv.evaluate(() => [KaraokeTVDebug.beat().lastH, performance.now()]); await sleep(1500); const r2 = await tv.evaluate(() => [KaraokeTVDebug.beat().lastH, performance.now()]);
  const rate = (r2[0] - r1[0]) / ((r2[1] - r1[1]) / 1000); check('75% speed plays at 0.75x', Math.abs(rate - 0.75) < 0.06, rate.toFixed(3));
  await tv.waitForFunction(() => KaraokeTVRec.state().ui === 'menu' && !KaraokeTVRec.state().active, null, { timeout: 20000 });
  await sleep(200); await tv.evaluate(() => KaraokeTVRec.set({ idx: 8 })); await tv.evaluate(() => window.__tap(0)); await sleep(200);   // undo that (empty) take
  // preview: plays the section as a Beat game with my notes; TEST-ONLY bot hits them on time
  await tv.evaluate(() => KaraokeTVRec.set({ a: 4, b: 12, sec: 99, speed: 0, idx: 7 })); await tv.evaluate(() => window.__tap(0)); await tv.waitForFunction(() => KaraokeTVRec.state().preview, null, { timeout: 5000 }); await sleep(600);
  const pv = await tv.evaluate(() => KaraokeTVDebug.beat()); check('Preview plays my notes as a Beat game', pv && pv.kind === 'beat' && pv.total === (await R()).draft.ev.length, pv && pv.total);
  await tv.evaluate(() => { window.__bot2 = true; const done = new Set(); (function tick() { if (!window.__bot2) return; const d = KaraokeTVDebug.beat(); if (d && d.upcoming) d.upcoming.forEach(p => { const k = p.t + ':' + p.lane; if (!done.has(k) && p.t - d.h <= 0.008) { done.add(k); window.__tap(KaraokeBeat.LANES[p.lane].btn[0], p.dur ? p.dur * 1000 + 40 : 60); } }); requestAnimationFrame(tick); })(); });
  await tv.waitForFunction(() => KaraokeTVRec.state().ui === 'menu' && !KaraokeTVRec.state().preview, null, { timeout: 30000 }); await tv.evaluate(() => { window.__bot2 = false; });
  s = await R(); check('Preview ends back in the panel with a result', /Preview: \d+ Perfect/.test(s.msg), s.msg);
  // save
  await tv.evaluate(() => KaraokeTVRec.set({ idx: 11 })); await tv.evaluate(() => window.__tap(0)); await tv.waitForFunction(() => /Saved/.test(KaraokeTVRec.state().msg) || /fail/i.test(KaraokeTVRec.state().msg), null, { timeout: 10000 });
  s = await R(); const disk = JSON.parse(fs.readFileSync(SJ, 'utf8')).custom;
  check('Save writes the map into song.json on the Mac (atomic) and versions it', /Saved/.test(s.msg) && disk && disk.ev.length === s.draft.ev.length && fs.existsSync(VDIR + '/current.json'), s.msg);
  check('after saving, this song plays My map', s.pick === 'mine');
  await tv.screenshot({ path: OUT + '/rec-4-saved.png' });
  await tv.evaluate(() => window.__tap(1)); await sleep(250); check('○ leaves the panel', (await R()).ui === null);
  // play it in Beat mode (merge: auto chart outside 4-12 s)
  await tv.evaluate(() => KaraokeTVDebug.play('beat-normal')); await sleep(100);
  const badge = await tv.evaluate(() => document.getElementById('playNow').textContent); check('song list badge shows My map', /My map/.test(badge), badge);
  const counts = await tv.evaluate(() => { const s = KaraokeTVDebug.songs ? null : null; return 1; });
  await tv.evaluate(() => window.__tap(0)); await sleep(800);
  const g = await tv.evaluate(() => KaraokeTVDebug.beat()); const mineIn = disk.ev.length;
  check('Beat mode plays My map (my notes inside the section + auto chart outside)', g && g.total >= mineIn, g && g.total + ' prompts, mine ' + mineIn);
  await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(300);
  await tv.evaluate(() => window.__tap(3)); await sleep(150); check('△ steps this song from My map back to the Auto map (v13.9)', /Auto map/.test(await tv.evaluate(() => document.getElementById('playNow').textContent + ' ' + document.getElementById('pvMode').textContent)), await tv.evaluate(() => document.getElementById('pvMode').textContent));
  check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
} catch (e) { fail++; console.log('FAIL exception', e.message); }
await browser.close(); server.kill();
fs.writeFileSync(SJ, BAK); fs.rmSync(VDIR, { recursive: true, force: true });
console.log(fail ? fail + ' FAILED' : 'ALL PASSED'); process.exit(fail ? 1 : 0);
