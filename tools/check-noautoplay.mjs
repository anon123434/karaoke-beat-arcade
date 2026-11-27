// v13.11: nothing plays or loads audio on first load, nor when highlighting/scrolling songs (no preview, no decode, no audio prefetch).
// Audio is fetched only when a song is started. PRIVATE server.
import { createRequire } from 'module'; import { spawn } from 'child_process';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = process.env.ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, ''), H = +(process.env.PORT || 18670); const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'qaauto', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' }); await sleep(1500);
const b = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const pg = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
let ok = true; const check = (n, c) => { console.log(c ? 'PASS' : 'FAIL', n); if (!c) ok = false; };
const aud = []; pg.on('request', r => { if (/\.(mp3|wav)(\?|$)/.test(r.url())) aud.push(r.url().split('/').slice(-2).join('/')); });
await pg.goto(`http://127.0.0.1:${H}/tv/` + (process.env.Q || '')); await pg.waitForFunction(() => document.querySelectorAll('#songList > .song-card').length > 100);
await sleep(4000);
const s0 = await pg.evaluate(() => KaraokeTVSelect.state()); check('no preview playing 4 s after load', !s0.preview && !s0.want);
check('no audio file requested on first load', aud.length === 0);
for (let i = 0; i < 12; i++) { await pg.keyboard.press('ArrowDown'); await sleep(250); } await sleep(2500);
const s1 = await pg.evaluate(() => KaraokeTVSelect.state()); check('no preview while scrolling/dwelling on songs', !s1.preview && !s1.want);
check('no audio file requested while scrolling/dwelling', aud.length === 0);
await pg.evaluate(() => KaraokeTVDebug.start()); await pg.waitForFunction(() => { const s = KaraokeTVDebug.state(); return s.screen === 'game' && s.t > 0.2; }, null, { timeout: 30000 }).catch(() => {});
check('audio loads when a song is started', aud.some(x => /instrumental/.test(x)));
console.log(ok ? 'ALL PASS' : 'FAILED'); server.kill(); await b.close(); process.exit(ok ? 0 : 1);
