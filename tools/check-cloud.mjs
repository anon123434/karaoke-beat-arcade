// v13.10 headless check: TV joins the hosted room relay (the Worker in ../worker) through the server bridge.
// Needs a deployed Worker and .local/cloud-relay.json {origin, base, inv}; run with KBA_ORIGIN=https://your-worker.example.
// Phones join via <origin>/kba/j/<room>. All "singers" except the browser phone are SIMULATED (synthetic
// pitch frames from the song notes, labelled [synthetic]); the browser phone uses Chromium's fake mic (a test beep).
// Uses a throwaway room code per run, private ports, temp FAV_FILE. Never touches :8780 or the production room.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
const pw = createRequire(import.meta.url)('playwright');
const WebSocket = createRequire(import.meta.url)('ws');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = process.env.OUT || path.join(ROOT, '.local/qa/cloud'); fs.mkdirSync(OUT, { recursive: true });
const song = JSON.parse(fs.readFileSync(path.join(ROOT, 'songs/twinkle/song.json')));
const ORIGIN = (process.env.KBA_ORIGIN || '').replace(/\/+$/, ''), A = 'abcdefghijkmnpqrstuvwxyz23456789';
if (!/^https?:\/\//.test(ORIGIN)) { console.log('set KBA_ORIGIN=https://your-worker-host'); process.exit(2); }
const HOSTNAME = new URL(ORIGIN).host;
const ROOM = 'q' + [...crypto.randomBytes(5)].map(b => A[b % A.length]).join('');
const H = 18530, HS = 18531, HB = 18540, HBS = 18541, sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-cloud-'));
const env = (o) => ({ ...process.env, KARAOKE_HOST: '127.0.0.1', KARAOKE_CODE: 'cloudqa', FAV_FILE: path.join(tmp, 'fav.json'), KTV_TEST: '1', KTV_CLOUD_GRACE_MS: '3000', ...o });
const srvA = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: env({ HTTP_PORT: H, HTTPS_PORT: HS, KTV_CLOUD_ROOM: ROOM }), stdio: ['ignore', fs.openSync(path.join(OUT, 'serverA.log'), 'w'), 'inherit'] });
let srvB = null;
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const getJ = async (port, p, method) => (await fetch(`http://127.0.0.1:${port}${p}`, { method: method || 'GET' })).json();
const pct = (a, q) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };

// phone: kind 'cloud' (cloud, QR cookie) or 'local' (wss to the private server)
async function phone(kind, cid, name, transpose, port) {
  let url, headers = {};
  if (kind === 'cloud') {
    const r = await fetch(`${ORIGIN}/kba/j/${ROOM}`, { redirect: 'manual' });
    const ck = (r.headers.get('set-cookie') || '').split(';')[0];
    if (r.status !== 302 || !/^ktv_ph=/.test(ck)) throw new Error('join link failed ' + r.status);
    headers.cookie = ck; url = `wss://${HOSTNAME}/kba/ws?role=phone&s=${ROOM}&cid=${cid}&name=${encodeURIComponent(name)}`;
  } else url = `wss://127.0.0.1:${port}/ws?role=phone&s=cloudqa&cid=${cid}&name=${encodeURIComponent(name)}`;
  const st = { kind, cid, name, transpose, anchor: null, msgs: [], slot: 0, sent: new Map(), seq: 0, rtt: [] };
  function open() {
    const ws = new WebSocket(url, { headers, rejectUnauthorized: false }); st.ws = ws;
    ws.on('message', d => { const m = JSON.parse(d); st.msgs.push(m); if (st.msgs.length > 4000) st.msgs.splice(0, 2000);
      if (m.type === 'hello') st.slot = m.slot; if (m.type === 'clock') {   // the singer hears the TV speaker, not the relayed clock: keep the least-delayed clock mapping
        const base = m.t * 1000 - Date.now(); st.bases = m.t < (st.lastT || 0) - 1 ? [base] : (st.bases || []).concat([base]).slice(-12); st.lastT = m.t;
        st.anchor = { t: Math.max(...st.bases) / 1000, at: 0 - (st.lat || 0) }; }
      if (m.type === 'pong') st.rtt.push(Date.now() - m.id); });
    return new Promise((r, j) => { ws.on('open', async () => {
      for (let i = 0; i < 5; i++) { ws.send(JSON.stringify({ type: 'ping', id: Date.now() })); await sleep(120); }
      await sleep(300);
      const lat = Math.round(pct(st.rtt, 0.5) / 2);   // like phone.js: half the RTT to the relay it is connected to
      ws.send(JSON.stringify({ type: 'status', mic: 'live', lat })); st.lat = lat; r(st); }); ws.on('error', j); });
  }
  st.reopen = async () => { try { st.ws.close(); } catch (e) {} await sleep(400); st.rtt = []; return open(); };
  st.timer = setInterval(() => {
    if (!st.ws || st.ws.readyState !== 1) return;
    let f = 0;
    if (st.anchor) {
      const heard = st.anchor.t + (Date.now() - st.anchor.at) / 1000 - 0.12;
      const n = song.notes.find(x => heard >= x.t && heard < x.t + x.d);
      f = n ? 440 * Math.pow(2, (n.midi + st.transpose - 69) / 12) : 0;
    }
    const seq = st.seq++; st.sent.set(seq, Date.now()); if (st.sent.size > 6000) st.sent.delete(seq - 6000);
    st.ws.send(JSON.stringify({ type: 'pitch', f, c: 0.9, rms: 0.1, seq }));   // [synthetic] pitch frame
  }, 23);
  return open();
}
const INIT = () => {   // record TV-side arrival of pitch frames (same machine clock as the simulated phones)
  const W = window.WebSocket; window.__arr = [];
  function P(u, p) { const w = p ? new W(u, p) : new W(u); w.addEventListener('message', ev => { if (typeof ev.data === 'string' && ev.data.indexOf('"pitch"') > 0) { try { const m = JSON.parse(ev.data); if (m.type === 'pitch') { __arr.push([m.p, m.seq, Date.now(), m.lat, m.via || 'local']); if (__arr.length > 30000) __arr.splice(0, 10000); } } catch (e) {} } }); return w; }
  P.prototype = W.prototype; P.CONNECTING = 0; P.OPEN = 1; P.CLOSING = 2; P.CLOSED = 3; window.WebSocket = P;
};
async function latency(p, phones, ms) {
  await p.evaluate(() => { window.__arr = []; }); await sleep(ms);
  const arr = await p.evaluate(() => window.__arr), res = {};
  for (const ph of phones) {
    const d = [], est = [];
    for (const [slot, seq, at, lat] of arr) if (slot === ph.slot && ph.sent.has(seq)) { d.push(at - ph.sent.get(seq)); est.push(lat); }
    res[ph.name] = { kind: ph.kind, n: d.length, min: Math.min(...d), p50: pct(d, 0.5), p75: pct(d, 0.75), p90: pct(d, 0.9), p95: pct(d, 0.95), max: Math.max(...d), compensated: pct(est, 0.5) };
  }
  return res;
}
async function round(p, modeName, during) {
  await p.evaluate(m => { KaraokeTVDebug.mode(m); KaraokeTVDebug.select(0); KaraokeTVDebug.start(); }, modeName);
  const t0 = Date.now(); let didDuring = false, shot = false;
  while (true) {
    await sleep(250);
    const s = await p.evaluate(() => KaraokeTVDebug.state());
    if (!shot && s.t > 12) { shot = true; await p.screenshot({ path: path.join(OUT, `cloud-game-${modeName}.jpg`), type: 'jpeg', quality: 85 }); }
    if (during && !didDuring && s.t > 8) { didDuring = true; await during(); }
    if (s.screen === 'results') break;
    if (Date.now() - t0 > 90000) throw new Error('song never ended');
  }
  const r = await p.evaluate(() => KaraokeTVDebug.round());
  await p.screenshot({ path: path.join(OUT, `cloud-results-${modeName}.jpg`), type: 'jpeg', quality: 85 });
  await p.keyboard.press('Escape'); await sleep(500);
  return r;
}
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const all = [];
const summary = { room: ROOM };
try {
  for (let i = 0; i < 30 && !(await getJ(H, '/api/cloud').catch(() => ({}))).up; i++) await sleep(300);
  const tvc = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); await tvc.addInitScript(INIT);
  const p = await tvc.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(`http://127.0.0.1:${H}/tv/`); await sleep(2500);
  const ses = await getJ(H, '/api/session');
  check('bridge up; session QR is the cloud join link', ses.cloud === true && ses.phoneUrl === `${ORIGIN}/kba/j/${ROOM}`, ses.phoneUrl);
  check('no local IP / cert in the cloud session', !/127\.0\.0\.1|192\.168\./.test(ses.phoneUrl + ses.qrSvg) && !ses.caUrl);
  let h = await p.evaluate(() => ({ url: document.getElementById('qrUrl').textContent, ...KaraokeTVDebug.home() }));
  check('TV shows cloud link under the QR, no cert QR', h.url === `${HOSTNAME}/kba/j/${ROOM}` && !h.caVisible, JSON.stringify({ url: h.url, ca: h.caVisible }));
  await p.screenshot({ path: path.join(OUT, 'cloud-tv-qr.jpg'), type: 'jpeg', quality: 88 });
  await p.screenshot({ path: path.join(OUT, 'cloud-tv-qr-panel.png'), clip: { x: 1180, y: 120, width: 740, height: 560 } });

  // 3 simulated cloud phones + 1 local phone (latency baseline)
  const sam = await phone('cloud', 'n1', 'Sam', 0), ana = await phone('cloud', 'a1', 'Ana', -3), kai = await phone('cloud', 'k1', 'Kai', 0);
  all.push(sam, ana, kai);
  await sleep(1200);
  h = await p.evaluate(() => KaraokeTVDebug.home());
  check('TV lists 3 cloud phones', /Sam/.test(h.players) && /Ana/.test(h.players) && /Kai/.test(h.players), h.players);
  check('cloud phones get slots 1-3', [sam.slot, ana.slot, kai.slot].sort().join() === '1,2,3', [sam.slot, ana.slot, kai.slot].join());
  const loc = await phone('local', 'L1', 'Lou', 0, HS); all.push(loc);
  await sleep(800);
  check('local phone (old link) still joins, gets slot 4', loc.slot === 4, String(loc.slot));
  // latency: pitch frames on the home screen (TV ignores them for scoring there)
  const lat1 = await latency(p, [sam, ana, kai, loc], 8000); summary.latency = lat1;
  console.log('LATENCY phone->TV one-way ms', JSON.stringify(lat1));
  check('cloud phone->TV p50 one-way < 120 ms', lat1.Sam.p50 < 120 && lat1.Ana.p50 < 120 && lat1.Kai.p50 < 120);
  check('TV latency compensation (lat field) within 40 ms of measured cloud one-way', Math.abs(lat1.Sam.compensated - lat1.Sam.p50) < 40, `lat ${lat1.Sam.compensated} vs measured ${lat1.Sam.p50}`);
  clearInterval(loc.timer); loc.ws.close(); await sleep(600);

  // real hosted phone page (browser) joins via the QR link
  const phc = await browser.newContext({ ...pw.devices['iPhone 13'], permissions: ['microphone'] });
  const pp = await phc.newPage(); const perrs = []; pp.on('pageerror', e => perrs.push(e.message));
  await pp.goto(`${ORIGIN}/kba/j/${ROOM}`); await sleep(1500);
  check('join link -> hosted phone page on cloud', pp.url().startsWith(`${ORIGIN}/kba/phone/?s=${ROOM}`), pp.url());
  await pp.fill('#kjName', 'Mia'); await pp.click('#kjGo'); await sleep(1500);
  try { await pp.click('#mic', { timeout: 3000 }); } catch (e) {}
  await sleep(2500);
  await pp.screenshot({ path: path.join(OUT, 'cloud-phone-joined.png') });
  h = await p.evaluate(() => KaraokeTVDebug.home());
  check('browser phone (fake test mic) listed on TV as 4th singer', /Mia/.test(h.players), h.players);
  await p.screenshot({ path: path.join(OUT, 'cloud-tv-4players.jpg'), type: 'jpeg', quality: 88 });

  // full song, party, 4 singers via Cloudflare
  const party = await round(p, 'party');
  summary.party = party;
  const sc = s => party.scores[party.slots ? party.slots.indexOf(s) : s - 1];
  console.log('party round', JSON.stringify(party));
  check('[synthetic] full song via cloud: accurate Sam >= 85', sc(sam.slot) >= 85, String(sc(sam.slot)));
  check('[synthetic] accurate Kai >= 85', sc(kai.slot) >= 85, String(sc(kai.slot)));
  check('[synthetic] off-key Ana <= 25', sc(ana.slot) <= 25, String(sc(ana.slot)));
  check('phones got their own feedback via the relay', sam.msgs.some(m => m.type === 'feedback') && sam.msgs.filter(m => m.type === 'feedback').every(m => m.to === sam.slot));
  check('phones got results state via the relay', ana.msgs.some(m => m.type === 'state' && m.state === 'results'));
  await pp.screenshot({ path: path.join(OUT, 'cloud-phone-results.png') });
  summary.jitterOn = await p.evaluate(() => KaraokeTVDebug.jitter(true)); console.log('TV de-jitter stats (on)', JSON.stringify(summary.jitterOn));
  // A/B: same song with the TV de-jitter off
  await p.evaluate(() => localStorage.setItem('karaoke.dejitter', '0')); await p.reload(); await sleep(3000);
  const off = await round(p, 'party'); summary.partyDejitterOff = off; console.log('party round, de-jitter OFF', JSON.stringify(off));
  await p.evaluate(() => localStorage.removeItem('karaoke.dejitter')); await p.reload(); await sleep(3000);

  // reconnect: drop the bridge mid-song + one phone reconnects with the same cid
  const st0 = await getJ(H, '/api/cloud');
  const rec = await round(p, 'party', async () => { await getJ(H, '/api/cloud/kick', 'POST'); await sleep(1500); await kai.reopen(); });
  const st1 = await getJ(H, '/api/cloud');
  summary.reconnect = { rec, before: st0, after: st1 };
  console.log('reconnect round', JSON.stringify(rec), JSON.stringify(st1));
  const sc2 = s => rec.scores[rec.slots ? rec.slots.indexOf(s) : s - 1];
  check('bridge reconnected after drop', st1.connects === st0.connects + 1 && st1.up, `${st0.connects}->${st1.connects}`);
  check('Kai rejoined with same slot', kai.slot === 3, String(kai.slot));
  check('[synthetic] Sam still scores >= 80 across the drop', sc2(sam.slot) >= 80, String(sc2(sam.slot)));
  check('TV QR stayed on cloud across a short drop', (await p.textContent('#qrUrl')).includes(HOSTNAME));

  // fallback: Worker unreachable -> TV switches to local QR after the grace period, back when reachable
  await getJ(H, '/api/cloud/block', 'POST'); await sleep(4500);
  let s2 = await getJ(H, '/api/session'); h = await p.evaluate(() => ({ url: document.getElementById('qrUrl').textContent, qr: document.getElementById('qr').innerHTML.length, ...KaraokeTVDebug.home() }));
  check('Worker unreachable -> TV switches to the local-IP QR', s2.cloud === false && /127\.0\.0\.1:18531/.test(s2.phoneUrl) && h.url === '' && Math.abs(h.qr - s2.qrSvg.length) < 40, s2.phoneUrl);
  await p.screenshot({ path: path.join(OUT, 'cloud-fallback-local-qr.jpg'), type: 'jpeg', quality: 85 });
  const loc2 = await phone('local', 'L2', 'Lou', 0, HS); all.push(loc2); await sleep(800);
  check('local phone joins while in fallback', loc2.slot >= 1 && /Lou/.test((await p.evaluate(() => KaraokeTVDebug.home())).players), String(loc2.slot));
  clearInterval(loc2.timer); loc2.ws.close();
  await getJ(H, '/api/cloud/unblock', 'POST');
  for (let i = 0; i < 20 && !(await getJ(H, '/api/session')).cloud; i++) await sleep(300);
  await sleep(1500);
  h = await p.evaluate(() => ({ url: document.getElementById('qrUrl').textContent, ...KaraokeTVDebug.home() }));
  check('Worker back -> cloud QR again, cloud phones re-listed', h.url.includes(HOSTNAME) && /Sam/.test(h.players) && /Kai/.test(h.players), h.players);
  check('no TV page errors', errs.length === 0, errs.join(' | '));
  check('no phone page errors', perrs.length === 0, perrs.join(' | '));
  await phc.close();

  // fallback at startup: server whose Worker origin is unreachable, local phones, full song (local baseline score)
  srvB = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: env({ HTTP_PORT: HB, HTTPS_PORT: HBS, KTV_CLOUD_ROOM: 'qzzzz2', KTV_CLOUD_ORIGIN: 'https://127.0.0.1:9' }), stdio: ['ignore', fs.openSync(path.join(OUT, 'serverB.log'), 'w'), 'inherit'] });
  await sleep(900);
  const pb = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await pb.addInitScript(INIT);
  await pb.goto(`http://127.0.0.1:${HB}/tv/`); await sleep(4500);
  const sb = await getJ(HB, '/api/session');
  check('startup fallback: unreachable Worker -> local QR', sb.cloud === false && /127\.0\.0\.1:18541/.test(sb.phoneUrl));
  const ln = await phone('local', 'bn', 'Sam', 0, HBS), la = await phone('local', 'ba', 'Ana', -3, HBS); all.push(ln, la);
  await sleep(800);
  const latL = await latency(pb, [ln, la], 5000); summary.latencyLocalOnly = latL; console.log('LATENCY local-only', JSON.stringify(latL));
  const lr = await round(pb, 'party'); summary.localRound = lr; console.log('local round', JSON.stringify(lr));
  check('[synthetic] local fallback full song: Sam >= 85', lr.scores[0] >= 85, String(lr.scores[0]));
} catch (e) { check('cloud run', false, e.stack); }
finally {
  all.forEach(x => { clearInterval(x.timer); try { x.ws.close(); } catch (e) {} });
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  await browser.close(); srvA.kill(); if (srvB) srvB.kill();
}
console.log(fail ? `FAILED ${fail}` : 'ALL PASS');
process.exit(fail ? 1 : 0);
