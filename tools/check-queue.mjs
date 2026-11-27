// v13.12 check: phone Songs tab (search, browse, Play now / Add to queue) + TV queue (toast, strip, countdown, host controls).
// PRIVATE server on test ports (never :8780 / the production room); phones are headless browsers named "QA ..."; TEST-ONLY.
// Usage: node tools/check-queue.mjs   (SHOTS=<dir> for phone/TV screenshots; PW=<playwright path>)
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path';
const req = createRequire(import.meta.url);
let pw; try { pw = req(process.env.PW || 'playwright-core'); } catch (e) { pw = createRequire(import.meta.url)('playwright'); }
const WebSocket = req('ws');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOTS = process.env.SHOTS || path.join(ROOT, '.local/qa/queue'); fs.mkdirSync(SHOTS, { recursive: true });
const H = +(process.env.PORT || 18700), HS = H + 1, CODE = 'qaqueue';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-queue-'));
const srv = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_HOST: '127.0.0.1', KARAOKE_CODE: CODE, FAV_FILE: path.join(tmp, 'fav.json'), KTV_TEST: '1' }, stdio: 'ignore' });
await sleep(1300);
const b = await pw.chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
try {
  const tvc = await b.newContext({ viewport: { width: 1920, height: 1080 } }); const tv = await tvc.newPage(); const errs = [];
  tv.on('pageerror', e => errs.push('tv: ' + e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/`);
  await tv.waitForFunction(() => document.querySelectorAll('#songList > .song-card').length > 100, null, { timeout: 60000 });
  const scr = () => tv.evaluate(() => document.getElementById('stage').className.replace('on-', ''));
  const tvq = () => tv.evaluate(() => window.KTVQueue.state());
  const curSong = () => tv.evaluate(() => KaraokeTVSelect.state().selected);

  async function phone(name, w = 390) {
    const pc = await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: w, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await pc.addInitScript(n => { try { localStorage.setItem('karaoke.name', n); } catch (e) {} }, name);
    const ph = await pc.newPage(); ph.on('pageerror', e => errs.push(name + ': ' + e.message));
    await ph.goto(`https://127.0.0.1:${HS}/phone/?s=${CODE}`);
    await ph.waitForFunction(() => /connected/i.test((document.getElementById('pConn') || {}).textContent || ''), null, { timeout: 15000 });
    return ph;
  }
  const tab = ph => ph.evaluate(() => document.querySelector('[data-t=songs]').click());
  const rows = ph => ph.evaluate(() => [...document.querySelectorAll('#sList .srow b')].map(x => x.textContent));
  const typeQ = async (ph, q) => { await ph.fill('#sIn', q); await sleep(120); };
  const sheetBtns = ph => ph.evaluate(() => [...document.querySelectorAll('#sSheet button')].map(x => x.textContent.trim() + (x.disabled ? ' (disabled)' : '')));
  const pick = async (ph, title) => { await ph.evaluate(t => { const r = [...document.querySelectorAll('#sList .srow')].find(x => x.querySelector('b').textContent === t); r.click(); }, title); await sleep(150); };
  const toastTxt = ph => ph.evaluate(() => document.getElementById('sToast').textContent);

  const A = await phone('QA Ann'), B = await phone('QA Bob');
  await sleep(500);
  // ---------- phone UI: instant search over all songs, categories
  await tab(A); await A.waitForFunction(() => document.querySelectorAll('#sList .srow').length > 50, null, { timeout: 8000 });
  const idxSize = await A.evaluate(() => fetch('songs-index.json').then(r => r.text()).then(t => t.length));
  check('index is small and audio-free', idxSize < 12000, idxSize + ' bytes');
  const allN = await A.evaluate(() => (document.getElementById('sCount').textContent));
  check('Songs tab lists all songs', /109 songs/.test(allN), allN);
  const t0 = Date.now(); await typeQ(A, 'hotel'); let r = await rows(A);
  check('search by title', r.some(x => /Hotel California/i.test(x)), r.slice(0, 3).join(' | '));
  await typeQ(A, 'toto'); r = await rows(A); check('search by artist', r.includes('Africa'), r.slice(0, 3).join(' | '));
  await typeQ(A, 'tpain'); r = await rows(A); check('forgiving search (tpain)', r.length > 0, r.slice(0, 2).join(' | '));
  const tq = await A.evaluate(() => { const i = document.getElementById('sIn'); const t = performance.now(); i.value = 'boyz to'; i.dispatchEvent(new Event('input')); return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => res(Math.round(performance.now() - t))))); });
  check('typing renders within 2 frames-ish', tq < 120, tq + ' ms');
  await typeQ(A, 'qqqjjj'); check('no-match message', await A.evaluate(() => getComputedStyle(document.getElementById('sEmpty')).display !== 'none'));
  await typeQ(A, '');
  const cats = await A.evaluate(() => [...document.querySelectorAll('#sCats button')].map(x => x.textContent));
  await A.evaluate(() => [...document.querySelectorAll('#sCats button')].find(x => /Rock/.test(x.textContent)).click()); await sleep(100);
  const rockN = await A.evaluate(() => document.getElementById('sCount').textContent); check('browse by category', /11 songs/.test(rockN) && cats.length > 8, rockN + ' · ' + cats.length + ' chips');
  await A.evaluate(() => document.querySelector('#sCats button').click());
  await A.screenshot({ path: SHOTS + '/phone-songs-browse.png' });
  await typeQ(A, 'love'); await A.screenshot({ path: SHOTS + '/phone-songs-search.png' });

  // ---------- TV idle -> Play now
  await tv.waitForTimeout(500);
  console.log('waiting for the TV to be idle (8 s of no remote input)...'); await tv.waitForFunction(() => KTVQueue.state().idle, null, { timeout: 20000 });
  await sleep(1500);
  check('phone shows TV free', await A.evaluate(() => /free/.test(document.getElementById('tvState').textContent)), await A.evaluate(() => document.getElementById('tvState').textContent));
  await tv.evaluate(() => localStorage.setItem('karaoke.play', 'beat-normal'));   // the TV is set to drums: a phone-queued song must still be SUNG
  await typeQ(A, 'africa'); await pick(A, 'Africa');
  let bt = await sheetBtns(A); check('idle: sheet offers Play now + Add to queue', bt.some(x => /Play now/.test(x)) && bt.some(x => /Add to queue/.test(x)), bt.join(' / '));
  await A.screenshot({ path: SHOTS + '/phone-sheet-idle.png' });
  await A.evaluate(() => document.querySelector('#sSheet [data-a=play]').click());
  await tv.waitForFunction(() => document.getElementById('qCd').classList.contains('on'), null, { timeout: 4000 });
  await tv.screenshot({ path: SHOTS + '/tv-countdown.png' });
  check('TV shows "Up next" countdown', /Africa/.test(await tv.evaluate(() => document.getElementById('qCd').textContent)) && /QA Ann/.test(await tv.evaluate(() => document.getElementById('qCd').textContent)));
  check('phone confirms', /Starting/.test(await toastTxt(A)), await toastTxt(A));
  await tv.waitForFunction(() => document.getElementById('stage').className === 'on-game', null, { timeout: 12000 });
  check('song started on the TV after the countdown', (await scr()) === 'game'); await sleep(1500);
  const playing = await curSong(); check('TV is playing Africa', /africa/.test(String(playing)), String(playing));
  await tv.screenshot({ path: SHOTS + '/tv-game.png' });
  check('phone told "You\'re up"', /You.re up/.test(await toastTxt(A)), await toastTxt(A));

  // ---------- busy: never interrupted
  await tab(B); await B.waitForFunction(() => document.querySelectorAll('#sList .srow').length > 50);
  await sleep(600); check('phone shows TV busy', await B.evaluate(() => /busy/.test(document.getElementById('tvState').textContent)), await B.evaluate(() => document.getElementById('tvState').textContent));
  await typeQ(B, 'hotel california'); await pick(B, 'Hotel California');
  bt = await sheetBtns(B); check('busy: only Add to queue', !bt.some(x => /Play now/.test(x)) && bt.some(x => /Add to queue/.test(x)), bt.join(' / '));
  await B.screenshot({ path: SHOTS + '/phone-sheet-busy.png' });
  await B.evaluate(() => document.querySelector('#sSheet [data-a=queue]').click()); await sleep(700);
  let st = await tvq(); check('queued on the TV', st.q.length === 1 && /Hotel/.test(st.q[0].t) && st.q[0].n === 'QA Bob', JSON.stringify(st.q.map(x => x.t + ' / ' + x.n)));
  check('song in progress NOT interrupted', (await scr()) === 'game' && /africa/.test(String(await curSong())));
  check('phone confirms queued', /Added/.test(await toastTxt(B)), await toastTxt(B));
  await tv.screenshot({ path: SHOTS + '/tv-game-toast.png' });
  check('TV toast', /Hotel California/.test(await tv.evaluate(() => document.getElementById('qToast').textContent)));
  // ---------- per-phone cap 3 + rate limit
  await typeQ(B, 'love'); const titles = (await rows(B)).filter(t => !/Hotel/.test(t)).slice(0, 4);
  const res = []; for (const t of titles) { await pick(B, t); await B.evaluate(() => { const x = document.querySelector('#sSheet [data-a=queue]'); if (x && !x.disabled) x.click(); else document.querySelector('#sShade').click(); }); await sleep(2300); res.push(await toastTxt(B)); }
  st = await tvq(); check('max 3 queued per phone', st.q.filter(x => x.s === 2).length === 3, st.q.filter(x => x.s === 2).length + ' queued · ' + res.join(' | '));
  await typeQ(B, ''); await B.screenshot({ path: SHOTS + '/phone-queue.png' });
  // raw spam from a third socket (cloud-like rate limit): 12 adds in a burst
  const raw = await new Promise(res => { const w = new WebSocket(`wss://127.0.0.1:${HS}/ws?role=phone&s=${CODE}&cid=qa-raw&name=QA%20Raw`, { rejectUnauthorized: false }); const got = []; w.on('message', d => { const m = JSON.parse(d); if (m.type === 'qres') got.push(m.act); });
    w.on('open', async () => { await sleep(300); for (let i = 0; i < 12; i++) w.send(JSON.stringify({ type: 'q-add', id: 'twinkle', mode: 'queue' })); await sleep(1200); w.close(); res(got); }); });
  check('rate limit per phone', raw.filter(x => x === 'rate').length >= 8, raw.join(','));
  await sleep(6500);   // let this phone slot's rate bucket refill
  const nonsense = await new Promise(res => { const w = new WebSocket(`wss://127.0.0.1:${HS}/ws?role=phone&s=${CODE}&cid=qa-raw2&name=QA%20Raw2`, { rejectUnauthorized: false }); const got = []; w.on('message', d => { const m = JSON.parse(d); if (m.type === 'qres') got.push(m.act); });
    w.on('open', async () => { await sleep(300); w.send(JSON.stringify({ type: 'q-add', id: '../../etc/passwd' })); w.send(JSON.stringify({ type: 'q-add', id: 'no-such-song' })); await sleep(900); w.close(); res(got); }); });
  check('bad / unknown song ids rejected', !nonsense.includes('queued') && !nonsense.includes('play'), nonsense.join(',') || '(dropped)');
  await sleep(2500);

  // ---------- host controls on the TV (YELLOW): only when on the list, so end the song first
  await tv.evaluate(() => { KaraokeTVDebug.quit(); KaraokeTVDebug.key(405); }); await sleep(400);
  check('back on the song list', (await scr()) === 'home');
  check('TV Play setting restored after the queued song', await tv.evaluate(() => localStorage.getItem('karaoke.play') === 'beat-normal' && /Beat/i.test(document.getElementById('playBtnVal').textContent)), await tv.evaluate(() => document.getElementById('playBtnVal').textContent));
  check('YELLOW opens the queue', await tv.evaluate(() => document.getElementById('qOv').classList.contains('on')));
  await tv.screenshot({ path: SHOTS + '/tv-queue-manager.png' });
  const before = (await tvq()).q.map(x => x.t);
  await tv.evaluate(() => { KaraokeTVDebug.key(39); KaraokeTVDebug.key(13); }); await sleep(400);    // action 1 = Skip -> first item to the end
  const afterSkip = (await tvq()).q.map(x => x.t); check('host Skip moves the item to the end', afterSkip[afterSkip.length - 1] === before[0] && afterSkip[0] === before[1], before[0] + ' -> end');
  await tv.evaluate(() => { KaraokeTVDebug.key(39); KaraokeTVDebug.key(13); }); await sleep(400);    // action 2 = Remove
  const afterRm = (await tvq()).q.map(x => x.t); check('host Remove deletes the item', afterRm.length === afterSkip.length - 1 && afterRm[0] !== afterSkip[0], afterRm.length + ' left');
  await sleep(300); check('phones see the change', await B.evaluate(() => document.querySelectorAll('#upNext .qr').length) === afterRm.length);
  await tv.evaluate(() => KaraokeTVDebug.key(10009)); await sleep(300);
  check('Back closes the queue', !(await tv.evaluate(() => document.getElementById('qOv').classList.contains('on'))));
  // phone removes its own item
  const mineBefore = (await tvq()).q.filter(x => x.s === 2).length;
  await B.evaluate(() => document.querySelector('#upNext button[data-del]').click()); await sleep(600);
  check('phone can remove its own item', (await tvq()).q.filter(x => x.s === 2).length === mineBefore - 1);

  // ---------- auto-advance: idle on the list -> countdown -> next song; any key cancels the countdown
  await tv.waitForFunction(() => document.getElementById('qCd').classList.contains('on'), null, { timeout: 25000 });
  await tv.evaluate(() => KaraokeTVDebug.key(37)); await sleep(1500);
  await tv.screenshot({ path: SHOTS + '/tv-hold.png' });
  st = await tvq(); check('any button cancels the countdown (queue on hold)', !st.cd && st.q.length > 0 && st.hold > 20000 && (await scr()) === 'home', 'hold ' + Math.round(st.hold / 1000) + ' s');
  await tv.evaluate(() => KaraokeTVDebug.key(405)); await sleep(200);
  await tv.evaluate(() => KaraokeTVDebug.key(13)); await sleep(300);   // action 0 = Play now on the first item
  await tv.waitForFunction(() => document.getElementById('stage').className === 'on-game', null, { timeout: 12000 }).catch(() => {});
  check('host Play now starts the next queued song', (await scr()) === 'game', String(await curSong()));
  await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(500);
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  const logs = []; // nothing else
} finally { await b.close(); srv.kill(); }
console.log(fail ? 'FAILED ' + fail : 'ALL PASS');
process.exit(fail ? 1 : 0);
