// v13.11.1 pointer support: real mouse events (hover, click, wheel) on the song-select, loading, pause and results screens. PRIVATE server.
import { createRequire } from 'module'; import { spawn } from 'child_process';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = process.env.ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, ''), H = +(process.env.PORT || 18760); const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'qaptr', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' }); await sleep(1500);
const b = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } }); const tv = await ctx.newPage();
let ok = true; const check = (n, c, d) => { console.log(c ? 'PASS' : 'FAIL', n, c ? '' : (d || '')); if (!c) ok = false; }; const errs = []; tv.on('pageerror', e => errs.push(e.message));
await tv.addInitScript(() => { localStorage.setItem('karaoke.engine', 'webaudio'); localStorage.setItem('karaoke.busyStallMs', '3000'); const A = window.AudioContext; window.AudioContext = class extends A { constructor(o) { super({ ...(o || {}), sampleRate: 44100 }); } }; });
await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVDebug && KaraokeTVDebug.songs().length > 100, null, { timeout: 60000 }); await tv.evaluate(() => KaraokeTVDebug.play('beat-normal')); await sleep(800);
const st = () => tv.evaluate(() => ({ sel: KaraokeTVSearch.state().selected, cat: KaraokeTVSelect.state().cat, scr: KaraokeTVDebug.state().screen, ov: KaraokeTVSearch.state().overlay, play: localStorage.getItem('karaoke.play'), busy: document.getElementById('busy').classList.contains('show'), row: (document.querySelector('#homeRow .focused') || {}).id }));
const box = async sel => { const r = await tv.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, sel); return r; };
const card = i => `#songList .song-card:nth-child(${i + 1})`;
// hover
let p = await box(card(3)); await tv.mouse.move(p.x - 30, p.y - 30); await tv.mouse.move(p.x, p.y, { steps: 4 }); await sleep(250); let s = await st(); check('hover over a song card highlights it', s.sel === 3, JSON.stringify(s));
p = await box(card(2)); await tv.mouse.move(p.x, p.y, { steps: 4 }); await sleep(200); s = await st(); check('hover moves the highlight to another card', s.sel === 2, JSON.stringify(s));
p = await box('#homeRow #guideBtn'); await tv.mouse.move(p.x, p.y, { steps: 4 }); await sleep(200); s = await st(); check('hover over a bottom-row button focuses it', s.row === 'guideBtn', JSON.stringify(s));
// categories
p = await box('.cat-rail .cr-i:nth-of-type(4)'); await tv.mouse.click(p.x, p.y); await sleep(300); s = await st(); const cats = await tv.evaluate(() => KaraokeTVSelect.state().cats); check('click on a category switches to it', s.cat === cats[2] , JSON.stringify(s));
p = await box('.cat-rail .cr-i:nth-of-type(2)'); await tv.mouse.click(p.x, p.y); await sleep(300); s = await st(); check('click on All Songs switches back', s.cat === 'all', JSON.stringify(s));
// mode tab
p = await box('#modeSwitch [data-k="duet"]'); await tv.mouse.click(p.x, p.y); await sleep(200); s = await st(); check('click on a mode tab changes the play style', /^duet/.test(s.play), s.play);
await tv.evaluate(() => KaraokeTVDebug.play('beat-normal'));
// search
p = await box('#homeRow #searchBtn'); await tv.mouse.click(p.x, p.y); await sleep(400); s = await st(); check('click on the Search button opens search', s.ov, JSON.stringify(s));
await tv.mouse.click(1850, 1040); await sleep(500); s = await st(); check('click outside the search panel closes it', !s.ov, JSON.stringify(s));
// wheel + tabs
await tv.evaluate(() => KaraokeTVDebug.select(0)); await sleep(150); p = await box(card(1)); await tv.mouse.move(p.x, p.y, { steps: 3 }); await tv.mouse.wheel(0, 120); await sleep(200); await tv.mouse.wheel(0, 120); await sleep(200); s = await st(); check('mouse wheel scrolls the list', s.sel >= 2, JSON.stringify(s));
await tv.evaluate(() => KaraokeTVDebug.select(10)); await sleep(150); p = await box('#ptrDown'); await tv.mouse.click(p.x, p.y); await sleep(200); s = await st(); check('list ▼ tab steps down', s.sel === 14, JSON.stringify(s));
p = await box('#ptrUp'); await tv.mouse.click(p.x, p.y); await sleep(200); s = await st(); check('list ▲ tab steps up', s.sel === 10, JSON.stringify(s));
// loading cancel (audio request hangs)
await tv.route(/instrumental\.mp3/, r => { /* hang */ }); p = await box(card(10)); await tv.mouse.move(p.x, p.y, { steps: 3 }); await sleep(200); await tv.mouse.click(p.x, p.y); await sleep(500); s = await st(); check('click on the highlighted card shows the loading overlay', s.busy, JSON.stringify(s));
p = await box('#busyCancel'); await tv.mouse.click(p.x, p.y); await sleep(500); s = await st(); check('Cancel on the loading overlay returns to the list', !s.busy && s.scr === 'home', JSON.stringify(s)); await tv.unroute(/instrumental\.mp3/);
// click to play, tap to pause, pause-menu click, quit
p = await box(card(10)); await tv.mouse.click(p.x, p.y); const pl = await tv.waitForFunction(() => { const x = KaraokeTVDebug.state(); return x.screen === 'game' && x.t > 0.3; }, null, { timeout: 60000 }).then(() => true).catch(() => false); check('click on a song starts it', pl);
await sleep(2500); await tv.mouse.click(960, 540); await sleep(400); check('click on the game screen pauses', await tv.evaluate(() => KaraokeTVDebug.paused()));
p = await box('#pauseMenu .pm-item[data-act="resume"]'); await tv.mouse.click(p.x, p.y); await sleep(500); check('click Resume resumes', !(await tv.evaluate(() => KaraokeTVDebug.paused())));
await tv.mouse.click(960, 540); await sleep(400); p = await box('#pauseMenu .pm-item[data-act="quit"]'); await tv.mouse.click(p.x, p.y); await sleep(700); s = await st(); check('click Quit returns to the song list', s.scr === 'home', JSON.stringify(s));
check('no page errors', !errs.length, errs.join('|'));
console.log(ok ? 'ALL PASS' : 'FAILED'); server.kill(); await b.close(); process.exit(ok ? 0 : 1);
