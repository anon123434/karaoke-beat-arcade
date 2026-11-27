// Headless multiplayer check with 2 SIMULATED phones (synthetic pitch, clearly labelled):
// "Sam" sings the melody accurately, "Ana" sings 3 semitones flat. Party + Battle (trade lines).
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const WebSocket = createRequire(import.meta.url)('ws');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, '.local/qa'); fs.mkdirSync(OUT, { recursive: true });
const song = JSON.parse(fs.readFileSync(path.join(ROOT, 'songs/twinkle/song.json')));
const H = 18094, HS = 18457, CODE = 'colors', sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: CODE, KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(700);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
function phone(cid, name, transpose) {
  const ws = new WebSocket(`wss://127.0.0.1:${HS}/ws?role=phone&s=${CODE}&cid=${cid}&name=${name}`, { rejectUnauthorized: false });
  const st = { ws, anchor: null, msgs: [], slot: 0 };
  ws.on('message', d => { const m = JSON.parse(d); st.msgs.push(m); if (m.type === 'hello') st.slot = m.slot; if (m.type === 'clock') st.anchor = { t: m.t, at: Date.now() }; });
  let seq = 0;
  st.timer = setInterval(() => {
    if (ws.readyState !== 1) return;
    let f = 0;
    if (st.anchor) {
      const heard = st.anchor.t + (Date.now() - st.anchor.at) / 1000 - 0.12; // default 120 ms TV output latency
      const n = song.notes.find(x => heard >= x.t && heard < x.t + x.d);
      f = n ? 440 * Math.pow(2, (n.midi + transpose - 69) / 12) : 0;
    }
    ws.send(JSON.stringify({ type: 'pitch', f, c: 0.9, rms: 0.1, seq: seq++ }));
  }, 23);
  return new Promise(r => ws.on('open', () => { ws.send(JSON.stringify({ type: 'status', mic: 'live', lat: 0 })); r(st); }));
}
try {
  const p = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${H}/tv/`); await sleep(2000);
  const A = await phone('a', 'QA Roxanne', 0), B = await phone('b', 'QA Ana', -3);
  await sleep(800);
  const phoneColor = x => x.msgs.filter(m => m.type === 'hello').pop().color;
  async function sample(label, who) {
    await p.evaluate(() => { KaraokeTVDebug.mode('party'); KaraokeTVDebug.select(0); KaraokeTVDebug.start(); });
    await p.waitForFunction(() => KaraokeTVDebug.state().screen === 'game' && KaraokeTVDebug.state().t > 4, null, { timeout: 60000 });
    const hud = await p.evaluate(() => { const c = e => e && getComputedStyle(e).getPropertyValue('--c').trim(); const o = {}; for (const s of [1, 2, 3, 4]) { o['sb' + s] = c(document.getElementById('sb' + s)); o['pc' + s] = c(document.getElementById('pc' + s)); } return o; });
    const norm = v => v && v.toLowerCase();
    for (const [name, x] of who) { const pc = norm(phoneColor(x)); check(label + ': ' + name + ' scoreboard colour = phone colour', norm(hud['sb' + x.slot]) === pc, hud['sb' + x.slot] + ' vs ' + pc); check(label + ': ' + name + ' player card colour = phone colour', norm(hud['pc' + x.slot]) === pc, hud['pc' + x.slot] + ' vs ' + pc); }
    await p.evaluate(() => KaraokeTVDebug.finish()); await p.waitForFunction(() => KaraokeTVDebug.state().screen === 'results', null, { timeout: 30000 }); await sleep(1200);
    const rs = await p.evaluate(() => [...document.querySelectorAll('#mrRows .mr-row')].map(r => ({ p: (r.querySelector('.mr-p') || {}).textContent, c: getComputedStyle(r).getPropertyValue('--c').trim().toLowerCase() })));
    for (const [name, x] of who) { const row = rs.find(r => r.p === 'P' + x.slot); check(label + ': ' + name + ' results colour = phone colour', row && row.c === norm(phoneColor(x)), JSON.stringify(rs)); }
    await p.keyboard.press('Escape'); await sleep(500);
  }
  check('slots 1,2 and colours pink/cyan', A.slot === 1 && B.slot === 2 && phoneColor(A).toLowerCase() === '#ff3fa4' && phoneColor(B).toLowerCase() === '#3ff2ff', phoneColor(A) + phoneColor(B));
  await sample('two players', [['Roxanne', A], ['Ana', B]]);
  // Roxanne leaves, a third joins, Roxanne rejoins
  clearInterval(A.timer); A.ws.close(); await sleep(800);
  const C = await phone('c', 'QA Cleo', 0); await sleep(500); const A2 = await phone('a', 'QA Roxanne', 0); await sleep(800);
  await sample('after leave/rejoin', [['Ana', B], ['Cleo', C], ['Roxanne', A2]]);
  check('no page errors', errs.length === 0, errs.join(' | '));
  [A2, B, C].forEach(x => { clearInterval(x.timer); x.ws.close(); });
} catch (e) { check('multi run', false, e.stack); }
finally { await browser.close(); server.kill(); }
process.exit(fail ? 1 : 0);
