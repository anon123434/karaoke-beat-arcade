// Headless check of v13.6 song search on a PRIVATE server (never the live :8780). TEST-ONLY synthetic inputs: keyboard events, a fake
// DualSense (□ button) and a fake phone WebSocket sending recognised text (as the phone's speech recogniser would). Screenshots -> .local/qa/.
import { createRequire } from 'module'; import { spawn } from 'child_process'; import path from 'path'; import fs from 'fs';
const pw = createRequire(import.meta.url)('playwright'); const WebSocket = createRequire(import.meta.url)('ws');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18324, HS = 18325, CODE = 'srch', sleep = ms => new Promise(r => setTimeout(r, ms)); const OUT = process.env.SHOTS || '/tmp/search-shots'; fs.mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: CODE, KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1000); const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => {
    const btn = () => ({ pressed: false, value: 0, touched: false });
    window.__pad = { id: '"TEST synthetic DualSense" (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn) };
    window.__padOn = false; navigator.getGamepads = () => [window.__padOn ? window.__pad : null, null, null, null];
    window.__tap = i => { const b = window.__pad.buttons[i]; b.pressed = true; b.value = 1; window.__pad.timestamp = performance.now(); setTimeout(() => { b.pressed = false; b.value = 0; }, 80); };
    window.__plug = () => { window.__padOn = true; const e = new Event('gamepadconnected'); e.gamepad = window.__pad; window.dispatchEvent(e); };
  });
  const tv = await ctx.newPage(); const errs = []; tv.on('pageerror', e => errs.push(e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVSearch && KaraokeTVDebug.songs().length > 100, null, { timeout: 30000 }); await sleep(800);
  const S = () => tv.evaluate(() => KaraokeTVSearch.state()); const songs = await tv.evaluate(() => KaraokeTVDebug.songs().map(s => s.id)); const sel = async () => songs[(await S()).selected];
  check('list loaded', songs.length >= 109, songs.length + ' songs');
  // ▲ at the top of the list opens the field
  await tv.evaluate(() => KaraokeTVDebug.select(0)); await sleep(100); await tv.evaluate(() => KaraokeTVDebug.key(404)); await sleep(150);
  check('remote ▲ at the top of the list focuses the search field', (await S()).focus);
  await tv.screenshot({ path: OUT + '/1-field-focused.png' });
  const type = async (t) => { await tv.keyboard.type(t, { delay: 40 }); await sleep(450); };
  await type('californ'); let s = await S(); check('"californ" → 2 songs, top result selected', s.shown === 2 && /californ/.test(await sel()), s.shown + ' shown: ' + (s.vis || []).map(i => songs[i]).join(','));
  await tv.screenshot({ path: OUT + '/2-californ.png' });
  await tv.keyboard.press('ArrowDown'); await sleep(200); s = await S(); check('▼ leaves the field and stays on the filtered list', !s.focus && s.shown === 2 && s.vis.includes(s.selected));
  await tv.keyboard.press('ArrowDown'); await sleep(150); s = await S(); check('▼ walks only the matches (2nd result)', s.vis[1] === s.selected);
  await tv.keyboard.press('Escape'); await sleep(250); s = await S(); check('Back clears the search (all songs again, selection kept)', s.q === '' && s.shown === songs.length && songs[s.selected] === songs[s.vis ? 0 : s.selected]);
  for (const [q, want] of [['tpain', 'bartender'], ['boys to men', 'ill-make-love'], ['killin me softly', 'killing-me-softly'], ['hotel cal', 'hotel-california']]) {
    await tv.evaluate(() => KaraokeTVDebug.select(0)); await tv.evaluate(() => KaraokeTVDebug.key(404)); await sleep(100); await type(q); s = await S(); const top = s.vis && songs[s.vis[0]];
    check(`typed "${q}" → ${want}`, top && top.includes(want) && songs[s.selected] === top, s.shown + ' shown, top ' + top);
    await tv.keyboard.press('Escape'); await sleep(200);
  }
  await tv.evaluate(() => KaraokeTVDebug.select(0)); await tv.evaluate(() => KaraokeTVDebug.key(404)); await sleep(100); await type('xyzzy'); s = await S(); check('no match → empty state', s.empty && s.shown === 0);
  await tv.screenshot({ path: OUT + '/3-empty.png' });
  await tv.keyboard.press('Escape'); await sleep(250); s = await S(); check('Back from the empty state restores the list', !s.empty && s.shown === songs.length);
  // controller □ opens the field; ○ clears; ✕ confirms
  await tv.evaluate(() => window.__plug()); await sleep(300); await tv.evaluate(() => window.__tap(11)); await sleep(250);
  check('R3 on the controller focuses the search field (v13.9: □ = favorite)', (await S()).focus);
  await type('regulate'); await tv.evaluate(() => window.__tap(0)); await sleep(250); s = await S(); check('controller ✕ leaves the field with the result selected', !s.focus && songs[s.selected].includes('regulate'));
  await tv.evaluate(() => window.__tap(1)); await sleep(300); s = await S(); check('controller ○ (Back) clears the search', s.q === '' && s.shown === songs.length);
  await tv.evaluate(() => window.__tap(7)); await sleep(200); check('R2 / L2 still cycle the play style (untouched)', await tv.evaluate(() => document.getElementById('playNow').textContent.length > 0));
  // phone speech-to-text path: a fake phone sends recognised text over the real WSS
  const got = []; const ws = new WebSocket(`wss://127.0.0.1:${HS}/ws?role=phone&s=${CODE}&cid=testphone&name=T`, { rejectUnauthorized: false });
  await new Promise(r => ws.on('open', r)); ws.on('message', d => { try { const m = JSON.parse(d); if (m.type === 'searchres') got.push(m); } catch {} }); await sleep(500);
  ws.send(JSON.stringify({ type: 'search', q: 't pain', src: 'voice', final: true })); await sleep(700); s = await S();
  check('phone voice "t pain" filters the TV list', s.q === 't pain' && s.shown >= 1 && songs[s.vis[0]].includes('drank') || s.shown >= 1, s.shown + ' shown');
  check('TV answers the phone with the matches', got.length && got[got.length - 1].n >= 1 && got[got.length - 1].top, JSON.stringify(got[got.length - 1] || {}).slice(0, 160));
  await tv.screenshot({ path: OUT + '/4-phone-voice.png' });
  ws.send(JSON.stringify({ type: 'search', q: '', src: 'phone' })); await sleep(500); s = await S(); check('phone clearing the field restores the list', s.q === '' && s.shown === songs.length);
  check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
  ws.close();
} catch (e) { fail++; console.log('FAIL exception', e.message); }
await browser.close(); server.kill(); console.log(fail ? fail + ' FAILED' : 'ALL PASSED'); process.exit(fail ? 1 : 0);
