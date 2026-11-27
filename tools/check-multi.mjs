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
const H = 18084, HS = 18447, CODE = 'multi', sleep = ms => new Promise(r => setTimeout(r, ms));
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
  let h = await p.evaluate(() => KaraokeTVDebug.home());
  check('cert QR shown before any phone joined', h.caVisible, JSON.stringify(h));
  const A = await phone('a', 'Sam', 0), B = await phone('b', 'Ana', -3);
  await sleep(800);
  h = await p.evaluate(() => KaraokeTVDebug.home());
  check('TV lists both players', /Sam/.test(h.players) && /Ana/.test(h.players), h.players);
  check('cert QR hidden after an HTTPS phone joined (remembered)', !h.caVisible && h.certOk);
  check('players get slots 1 and 2', A.slot === 1 && B.slot === 2);
  await p.keyboard.press('b'); await sleep(200);
  check('BLUE shows phone setup again', (await p.evaluate(() => KaraokeTVDebug.home())).caVisible);
  await p.keyboard.press('b');
  await p.screenshot({ path: path.join(OUT, 'multi-home.png') });
  async function round(modeName, shotAt) {
    await p.evaluate(m => { KaraokeTVDebug.mode(m); KaraokeTVDebug.select(0); KaraokeTVDebug.start(); }, modeName);
    let shot = false; const t0 = Date.now();
    while (true) {
      await sleep(250);
      const s = await p.evaluate(() => KaraokeTVDebug.state());
      if (!shot && s.t > shotAt) { shot = true; await p.screenshot({ path: path.join(OUT, 'multi-game-' + modeName + '.png') }); }
      if (s.screen === 'results') break;
      if (Date.now() - t0 > 70000) throw new Error('song never ended');
    }
    const r = await p.evaluate(() => KaraokeTVDebug.round());
    await p.screenshot({ path: path.join(OUT, 'multi-results-' + modeName + '.png') });
    const title = await p.textContent('#mrTitle');
    await p.keyboard.press('Escape'); await sleep(400);
    return { r, title };
  }
  const party = await round('party', 12);
  check('[synthetic] party: both scored, accurate Sam high', party.r.scores[0] >= 85, JSON.stringify(party.r));
  check('[synthetic] party: off-key Ana low', party.r.scores[1] <= 25);
  const battle = await round('battle-alt', 14);
  check('battle-alt splits the notes between 2 players', battle.r.notes[0] > 0 && battle.r.notes[1] > 0 && battle.r.notes[0] + battle.r.notes[1] === song.notes.length, JSON.stringify(battle.r.notes));
  check('[synthetic] battle: Sam wins', /Sam/.test(battle.title) && battle.r.scores[0] > battle.r.scores[1], battle.title + ' ' + JSON.stringify(battle.r.scores));
  check('phone gets its own feedback only', A.msgs.filter(m => m.type === 'feedback').every(m => m.to === 1) && B.msgs.filter(m => m.type === 'feedback').every(m => m.to === 2));
  check('phones get winner on results', B.msgs.some(m => m.type === 'state' && m.state === 'results' && m.winner === 1));

  // v13.12.1: a third live mic must get a lane + HUD in Party and both Battle modes (was silently sliced to 2).
  const C = await phone('c', 'Jay', 2);
  await sleep(800);
  h = await p.evaluate(() => KaraokeTVDebug.home());
  check('TV lists three players', /Sam/.test(h.players) && /Ana/.test(h.players) && /Jay/.test(h.players), h.players);
  check('third player is slot 3', C.slot === 3, String(C.slot));
  async function round3(modeName) {
    await p.evaluate(m => { KaraokeTVDebug.mode(m); KaraokeTVDebug.select(0); KaraokeTVDebug.start(); }, modeName);
    const t0 = Date.now();
    let hud = null;
    while (true) {
      await sleep(250);
      const st = await p.evaluate(() => {
        const r = KaraokeTVDebug.round();
        return { screen: KaraokeTVDebug.state().screen, t: KaraokeTVDebug.state().t, slots: r && r.slots, notes: r && r.notes,
          cards: document.querySelectorAll('#pCards .pc').length, sbs: document.querySelectorAll('#scoreboard .sb').length,
          gameClass: document.getElementById('game').className };
      });
      if (!hud && st.t > 1) hud = st;
      if (st.screen === 'results') break;
      if (Date.now() - t0 > 70000) throw new Error('3p ' + modeName + ' never ended');
    }
    const r = await p.evaluate(() => KaraokeTVDebug.round());
    const title = await p.textContent('#mrTitle');
    const rows = await p.evaluate(() => document.querySelectorAll('#mrRows .mr-row, #results .mr-row').length);
    await p.keyboard.press('Escape'); await sleep(400);
    return { r, title, hud, rows };
  }
  const party3 = await round3('party');
  check('party 3p: all three slots in the round', party3.r && party3.r.slots && party3.r.slots.join(',') === '1,2,3', JSON.stringify(party3.r && party3.r.slots));
  check('party 3p: three HUDs (player cards or scoreboard)', party3.hud && (party3.hud.cards === 3 || party3.hud.sbs === 3), JSON.stringify(party3.hud));
  check('party 3p: all three scored', party3.r && party3.r.scores && party3.r.scores.length === 3, JSON.stringify(party3.r && party3.r.scores));
  const battle3 = await round3('battle-alt');
  check('battle-alt 3p: all three slots (not sliced to 2)', battle3.r && battle3.r.slots && battle3.r.slots.join(',') === '1,2,3', JSON.stringify(battle3.r && battle3.r.slots));
  check('battle-alt 3p: three HUDs', battle3.hud && (battle3.hud.cards === 3 || battle3.hud.sbs === 3), JSON.stringify(battle3.hud));
  check('battle-alt 3p: notes rotate among all three', battle3.r && battle3.r.notes && battle3.r.notes.length === 3 && battle3.r.notes.every(n => n > 0) && battle3.r.notes[0] + battle3.r.notes[1] + battle3.r.notes[2] === song.notes.length, JSON.stringify(battle3.r && battle3.r.notes));
  const same3 = await round3('battle-same');
  check('battle-same 3p: all three slots', same3.r && same3.r.slots && same3.r.slots.join(',') === '1,2,3', JSON.stringify(same3.r && same3.r.slots));
  check('battle-same 3p: three HUDs', same3.hud && (same3.hud.cards === 3 || same3.hud.sbs === 3), JSON.stringify(same3.hud));
  check('no page errors', errs.length === 0, errs.join(' | '));
  [A, B, C].forEach(x => { clearInterval(x.timer); x.ws.close(); });
} catch (e) { check('multi run', false, e.stack); }
finally { await browser.close(); server.kill(); }
process.exit(fail ? 1 : 0);
