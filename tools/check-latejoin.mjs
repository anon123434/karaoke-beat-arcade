// v13.13: join QR on screen + mid-song late join. PRIVATE server, 4 SIMULATED phones named "QA ..." (synthetic pitch). Screenshots -> .local/shots/late/
import { createRequire } from 'module'; import { spawn } from 'child_process'; import fs from 'fs'; import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const WebSocket = createRequire(import.meta.url)('ws');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '.local/shots/late'); fs.mkdirSync(OUT, { recursive: true });
const song = JSON.parse(fs.readFileSync(path.join(ROOT, 'songs/twinkle/song.json')));
const H = 18731, HS = 18732, CODE = 'late1', sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: CODE, KARAOKE_HOST: '127.0.0.1', KTV_CLOUD_CFG: '/nonexistent' }, stdio: 'ignore' });
await sleep(900);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
function phone(cid, name, transpose = 0) {
  const ws = new WebSocket(`wss://127.0.0.1:${HS}/ws?role=phone&s=${CODE}&cid=${cid}&name=${encodeURIComponent(name)}`, { rejectUnauthorized: false });
  const st = { ws, anchor: null, msgs: [], slot: 0, live: false, mic(on) { st.live = on; ws.send(JSON.stringify({ type: 'status', mic: on ? 'live' : 'off', lat: 0 })); } };
  ws.on('message', d => { const m = JSON.parse(d); st.msgs.push(m); if (m.type === 'hello') st.slot = m.slot; if (m.type === 'clock') st.anchor = { t: m.t, at: Date.now() }; });
  let seq = 0;
  st.timer = setInterval(() => {
    if (ws.readyState !== 1 || !st.live) return;
    let f = 0;
    if (st.anchor) { const heard = st.anchor.t + (Date.now() - st.anchor.at) / 1000 - 0.12; const n = song.notes.find(x => heard >= x.t && heard < x.t + x.d); f = n ? 440 * Math.pow(2, (n.midi + transpose - 69) / 12) : 0; }
    ws.send(JSON.stringify({ type: 'pitch', f, c: 0.9, rms: 0.1, seq: seq++ }));
  }, 23);
  return new Promise(r => ws.on('open', () => r(st)));
}
const overlap = (a, b) => a.x < b.r && a.r > b.x && a.y < b.b && a.b > b.y;
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${H}/tv/`); await sleep(2200);
  const all = [];
  async function round(modeName, firstN) {
    const ph = [];
    for (let i = 0; i < firstN; i++) { const x = await phone('a' + modeName + i, 'QA ' + 'ABCD'[i], [0, -1, 2, -4][i]); x.mic(true); ph.push(x); }
    await sleep(800);
    await p.evaluate(m => { KaraokeTVDebug.mode(m); KaraokeTVDebug.select(0); KaraokeTVDebug.start(); }, modeName);
    const t0 = Date.now(); const res = { shots: [], q: [] };
    const waitT = async tt => { while (true) { await sleep(150); const s = await p.evaluate(() => KaraokeTVDebug.state()); if (s.screen === 'game' && s.t >= tt) return s; if (Date.now() - t0 > 60000) throw new Error('timeout waiting t=' + tt); } };
    await waitT(3);
    res.q0 = await p.evaluate(() => KaraokeTVDebug.joinQr()); await p.screenshot({ path: path.join(OUT, `${modeName}-1-start-${firstN}p.png`) });
    // 3rd phone joins mid-song: first connects with mic off ("tap Start mic" message), then taps Start mic
    const plan = firstN === 1 ? [[6, 'B'], [12, 'C'], [18, 'D']] : [[7, 'C'], [14, 'D']];
    const lates = [];
    for (const [tt, nm] of plan) {
      await waitT(tt);
      const x = await phone('l' + modeName + nm, 'QA ' + nm, 0); lates.push(x); ph.push(x);
      await sleep(500); x.waitMsgs = x.msgs.filter(m => m.late).map(m => m.late);
      const before = await p.evaluate(() => KaraokeTVDebug.late()); x.mic(true);
      await sleep(900);
      const after = await p.evaluate(() => KaraokeTVDebug.late());
      res.q.push({ nm, before, after, qr: await p.evaluate(() => KaraokeTVDebug.joinQr()), state: await p.evaluate(() => KaraokeTVDebug.state()), paused: await p.evaluate(() => KaraokeTVDebug.paused()) });
      await sleep(700); await p.screenshot({ path: path.join(OUT, `${modeName}-2-after-${nm}-joined.png`) });
    }
    while (true) { await sleep(250); const s = await p.evaluate(() => KaraokeTVDebug.state()); if (s.screen === 'results') break; if (Date.now() - t0 > 80000) throw new Error('never ended'); }
    res.round = await p.evaluate(() => KaraokeTVDebug.round()); await sleep(1500);
    res.rows = await p.evaluate(() => [...document.querySelectorAll('#mrRows .mr-row')].map(r => ({ name: r.querySelector('.mr-name')?.textContent, late: r.querySelector('.mr-late')?.textContent || '', score: +r.querySelector('.mr-score')?.getAttribute('data-v') })));
    await p.screenshot({ path: path.join(OUT, `${modeName}-3-results-win.png`) }); await sleep(7600); await p.screenshot({ path: path.join(OUT, `${modeName}-4-results-table.png`) });
    await p.keyboard.press('Escape'); await sleep(500);
    ph.forEach(x => { clearInterval(x.timer); x.ws.close(); }); await sleep(600);
    return { ph, lates, res };
  }
  for (const [mode, n] of [['party', 1], ['battle-alt', 2]]) {
    const { lates, res } = await round(mode, n); const tag = mode + ' ' + (n + lates.length) + 'p: ';
    check(tag + 'QR on screen at start with label + svg', res.q0.on && res.q0.vis && res.q0.hasSvg && /Scan to join/.test(res.q0.label), JSON.stringify(res.q0.rect) + ' ' + res.q0.label);
    check(tag + 'QR does not cover lyrics or lane', !overlap(res.q0.rect, res.q0.lyrics) && !overlap(res.q0.rect, res.q0.lane), JSON.stringify({ q: res.q0.rect, l: res.q0.lyrics, ln: res.q0.lane }));
    res.q.forEach((q, i) => {
      const want = n + i + 1;
      check(tag + `late ${q.nm}: in the round (${want} singers, ${want} cards)`, q.after && q.after.slots.length === want && q.after.cards === want && q.after.multi, JSON.stringify({ s: q.after && q.after.slots, c: q.after && q.after.cards }));
      check(tag + `late ${q.nm}: song kept playing (not paused)`, !q.paused && q.state.screen === 'game');
      check(tag + `late ${q.nm}: QR ${want >= 4 ? 'hidden at 4 players' : 'still shown'}`, want >= 4 ? !q.qr.on : (q.qr.on && !overlap(q.qr.rect, q.qr.lyrics) && !overlap(q.qr.rect, q.qr.lane) && !overlap(q.qr.rect, q.qr.cards)), JSON.stringify(q.qr.rect) + ' cards ' + JSON.stringify(q.qr.cards));
      check(tag + `late ${q.nm}: marked late`, q.after && q.after.late[q.after.slots[q.after.slots.length - 1]] && q.after.cls.includes(want === 4 ? 'pn4' : want === 3 ? 'pn3' : 'multi'));
    });
    lates.forEach(x => {
      check(tag + `phone ${x.slot}: told "tap Start mic" while still mic-off`, (x.waitMsgs || []).includes('wait'), JSON.stringify(x.waitMsgs));
      check(tag + `phone ${x.slot}: told "you're in" (late:in)`, x.msgs.some(m => m.type === 'state' && m.late === 'in' && m.song), '');
      const fb = x.msgs.filter(m => m.type === 'feedback'); check(tag + `phone ${x.slot}: gets its own feedback from join on`, fb.length > 0 && fb.every(m => m.to === x.slot), 'n=' + fb.length);
    });
    const byName = Object.fromEntries(res.rows.map(r => [r.name, r]));
    check(tag + 'results show every singer', res.rows.length === n + lates.length, JSON.stringify(res.rows));
    lates.forEach(x => { const r = res.rows.find(r => r.late); });
    check(tag + 'late joiners flagged in results, early ones not', res.rows.filter(r => r.late).length === lates.length && res.rows.filter(r => !r.late).length === n, JSON.stringify(res.rows.map(r => [r.name, !!r.late])));
    check(tag + 'late joiners who sing right score high (a percent of the notes since joining, not of the whole song)', res.rows.filter(r => r.late).every(r => r.score >= 85), JSON.stringify(res.rows.map(r => [r.name, r.score])));
    const first = res.round; check(tag + 'late joiners have fewer notes than the song', first.notes.slice(n).every(k => k > 0 && k < song.notes.length) || mode === 'battle-alt', JSON.stringify(first.notes));
    if (mode === 'battle-alt') check(tag + 'trade-lines notes still add up to the song (nothing double-scored)', first.notes.reduce((a, b) => a + b, 0) === song.notes.length, JSON.stringify(first.notes));
    res.rowsOut = res.rows;
  }
  // setting off: no QR; pause-menu item toggles it
  { const x = await phone('s1', 'QA S'); x.mic(true); await sleep(500);
    await p.evaluate(() => { localStorage.setItem('karaoke.joinQr', '0'); KaraokeTVDebug.mode('party'); KaraokeTVDebug.select(0); KaraokeTVDebug.start(); }); await sleep(3500);
    let q = await p.evaluate(() => KaraokeTVDebug.joinQr()); check('setting OFF: no QR during play', !q.on && !q.setting, JSON.stringify(q));
    await p.keyboard.press('Enter'); await sleep(900); await p.screenshot({ path: path.join(OUT, 'pause-menu-joinqr.png') });
    await p.evaluate(() => { const it = document.querySelector('#pauseMenu .pm-item[data-act="joinqr"]'); it && it.click(); });
    // click goes through the pointer module; fall back to keyboard if needed
    q = await p.evaluate(() => KaraokeTVDebug.joinQr());
    if (q.setting === false) { for (let i = 0; i < 3; i++) { await p.keyboard.press('ArrowDown'); await sleep(120); } await p.keyboard.press('Enter'); await sleep(400); q = await p.evaluate(() => KaraokeTVDebug.joinQr()); }
    check('pause menu toggles the setting back ON', q.setting === true, JSON.stringify(q.setting));
    await p.keyboard.press('Escape'); await sleep(600); q = await p.evaluate(() => KaraokeTVDebug.joinQr()); check('setting ON again: QR back during play', q.on, JSON.stringify(q.on));
    await p.evaluate(() => KaraokeTVDebug.key && 0); clearInterval(x.timer); x.ws.close(); await p.evaluate(() => { localStorage.removeItem('karaoke.joinQr'); });
  }
  check('no page errors', errs.length === 0, errs.join(' | '));
} catch (e) { check('latejoin run', false, e.stack); }
finally { await browser.close(); server.kill(); }
console.log(fail ? 'FAILURES: ' + fail : 'ALL PASS'); process.exit(fail ? 1 : 0);
