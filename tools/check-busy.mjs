// v13.11 loading feedback: overlay within 100 ms of the press, repeat Enter ignored, clears on success, stalled start retries itself, friendly error + retry, Back cancels. PRIVATE server.
import { createRequire } from 'module'; import { spawn } from 'child_process';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = process.env.ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, ''), H = +(process.env.PORT || 18740); const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'qabusy', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' }); await sleep(1500);
const b = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let ok = true; const check = (n, c, d) => { console.log(c ? 'PASS' : 'FAIL', n, c ? '' : (d || '')); if (!c) ok = false; };
async function page(stall) {
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } }); const tv = await ctx.newPage(); const errs = []; tv.on('pageerror', e => errs.push(e.message));
  await tv.addInitScript(s => { localStorage.setItem('karaoke.engine', 'webaudio'); localStorage.setItem('karaoke.busyStallMs', String(s)); const A = window.AudioContext; window.AudioContext = class extends A { constructor(o) { super({ ...(o || {}), sampleRate: 44100 }); } }; }, stall);
  const cdp = await ctx.newCDPSession(tv); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVDebug && KaraokeTVDebug.songs().length > 100, null, { timeout: 60000 }); await tv.evaluate(() => KaraokeTVDebug.play('beat-normal')); await sleep(800); tv.errs = errs; return tv;
}
const busy = tv => tv.evaluate(() => { const e = document.getElementById('busy'); return { show: e.classList.contains('show'), err: e.classList.contains('err'), txt: document.getElementById('busyTxt').textContent, hint: document.getElementById('busyHint').textContent, bar: document.getElementById('busyBar').style.transform, screen: KaraokeTVDebug.state().screen, t: KaraokeTVDebug.state().t, paused: KaraokeTVDebug.paused() }; });
// 1. press OK on an undecoded song
let tv = await page(20000); await tv.evaluate(() => KaraokeTVDebug.select(12)); await sleep(300);
const t0 = Date.now(); await tv.keyboard.press('Enter'); const seen = await tv.waitForFunction(() => document.getElementById('busy').classList.contains('show'), null, { timeout: 2000 }).then(() => Date.now() - t0).catch(() => -1);
check('loading overlay visible within 100 ms of OK (4x CPU)', seen >= 0 && seen <= 100, String(seen));
const pressed = await tv.evaluate(() => !!document.querySelector('.pressed') || true); let s1 = await busy(tv); check('overlay says Loading <song>', /^Loading/.test(s1.txt), JSON.stringify(s1));
for (let i = 0; i < 5; i++) { await tv.keyboard.press('Enter'); await sleep(40); }
await tv.waitForFunction(() => { const s = KaraokeTVDebug.state(); return s.screen === 'game' && s.t > 0.3; }, null, { timeout: 60000 }).catch(() => {});
s1 = await busy(tv); check('repeat Enter while loading did not pause/cancel: song plays', s1.screen === 'game' && s1.t > 0.2 && !s1.paused, JSON.stringify(s1)); check('overlay cleared on success', !s1.show, JSON.stringify(s1));
await tv.close();
// 2. Back cancels
tv = await page(20000); await tv.evaluate(() => KaraokeTVDebug.select(14)); await sleep(300); await tv.keyboard.press('Enter'); await sleep(150); await tv.keyboard.press('Escape'); await sleep(600);
s1 = await busy(tv); check('Back during loading cancels and returns to the list', !s1.show && s1.screen === 'home', JSON.stringify(s1)); await tv.close();
// 3. a stalled fetch (first request hangs) recovers by itself
tv = await page(3000); let hang = 1; await tv.route(/instrumental\.mp3/, r => { if (hang-- > 0) return; r.continue(); });
await tv.evaluate(() => KaraokeTVDebug.select(16)); await sleep(300); await tv.keyboard.press('Enter');
const ok3 = await tv.waitForFunction(() => { const s = KaraokeTVDebug.state(); return s.screen === 'game' && s.t > 0.3; }, null, { timeout: 40000 }).then(() => true).catch(() => false); s1 = await busy(tv);
check('stalled start (hung request) auto-retries and plays', ok3 && !s1.show, JSON.stringify(s1)); await tv.close();
// 4. every request hangs -> friendly error, OK retries once the network is back
tv = await page(2500); let blocked = true, held = []; await tv.route(/instrumental\.mp3/, r => { if (blocked) held.push(r); else r.continue(); });
await tv.evaluate(() => KaraokeTVDebug.select(18)); await sleep(300); await tv.keyboard.press('Enter');
const err4 = await tv.waitForFunction(() => document.getElementById('busy').classList.contains('err'), null, { timeout: 60000 }).then(() => true).catch(() => false); s1 = await busy(tv);
check('friendly error with retry after repeated stalls', err4 && /Couldn/.test(s1.txt) && /OK = try again/.test(s1.hint), JSON.stringify(s1));
blocked = false; await tv.keyboard.press('Enter');
const ok4 = await tv.waitForFunction(() => { const s = KaraokeTVDebug.state(); return s.screen === 'game' && s.t > 0.3; }, null, { timeout: 40000 }).then(() => true).catch(() => false); s1 = await busy(tv);
check('OK on the error retries and plays', ok4 && !s1.show, JSON.stringify(s1)); check('no page errors', !tv.errs.length, tv.errs.join('|')); await tv.close();
console.log(ok ? 'ALL PASS' : 'FAILED'); server.kill(); await b.close(); process.exit(ok ? 0 : 1);
