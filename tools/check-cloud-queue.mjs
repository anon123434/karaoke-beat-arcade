// v13.12 check: the phone song queue through the hosted relay path (phone -> Worker Room DO -> Mac bridge server/cloud.js -> TV page).
// Run it against a LOCAL `wrangler dev --local --local-protocol https` Worker that has RELAY_TOKEN set (never the production room):
//   ORIGIN=https://127.0.0.1:8811 RELAY=<RELAY_TOKEN from .dev.vars> node tools/check-cloud-queue.mjs
// The TV is a headless page on a private server (port PORT, default 18720); phones are "QA ..." websocket clients; TEST-ONLY.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
const req = createRequire(import.meta.url);
let pw; try { pw = req(process.env.PW || 'playwright-core'); } catch (e) { pw = createRequire(import.meta.url)('playwright'); }
const WebSocket = req('ws');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ORIGIN = process.env.ORIGIN, RELAY = process.env.RELAY;
if (!ORIGIN || !RELAY) { console.log('set ORIGIN and RELAY (local wrangler dev only)'); process.exit(2); }
const H = +(process.env.PORT || 18720), HS = H + 1, sleep = ms => new Promise(r => setTimeout(r, ms));
const A = 'abcdefghijkmnpqrstuvwxyz23456789', ROOM = 'q' + [...crypto.randomBytes(5)].map(b => A[b % A.length]).join('');
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktv-cq-'));
fs.writeFileSync(path.join(tmp, 'cloud.json'), JSON.stringify({ inv: RELAY, origin: ORIGIN, base: '/kba' }));
const srv = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_HOST: '127.0.0.1', KARAOKE_CODE: 'cloudqa', FAV_FILE: path.join(tmp, 'fav.json'), KTV_TEST: '1', KTV_CLOUD_CFG: path.join(tmp, 'cloud.json'), KTV_CLOUD_ROOM: ROOM, KTV_CLOUD_GRACE_MS: '3000', NODE_TLS_REJECT_UNAUTHORIZED: '0' }, stdio: 'ignore' });
await sleep(1500);
const b = await pw.chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const tv = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage(); const errs = []; tv.on('pageerror', e => errs.push(e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/`); await tv.waitForFunction(() => document.querySelectorAll('#songList > .song-card').length > 100, null, { timeout: 60000 });
  const tvq = () => tv.evaluate(() => window.KTVQueue.state());
  await sleep(3500);
  const hostO = ORIGIN.replace(/^https?:\/\//, '');
  const r = await fetch(`${ORIGIN}/kba/j/${ROOM}`, { redirect: 'manual' }); const ck = (r.headers.get('set-cookie') || '').split(';')[0];
  check('cloud join link', r.status === 302 && /^ktv_ph=/.test(ck), 'status ' + r.status);
  const idx = await (await fetch(`${ORIGIN}/kba/phone/songs-index.json`, { headers: { cookie: ck } })).json().catch(() => null);
  check('phone can fetch the song index through the Worker', idx && idx.songs && idx.songs.length > 100, idx && idx.songs ? idx.songs.length + ' songs' : 'no index');
  const ids = (idx ? idx.songs : []).map(s => s[0]).filter(x => x !== 'twinkle');
  async function phone(name) {
    const st = { msgs: [], slot: 0 };
    const ws = new WebSocket(`wss://${hostO}/kba/ws?role=phone&s=${ROOM}&cid=${crypto.randomBytes(6).toString('hex')}&name=${encodeURIComponent(name)}`, { headers: { cookie: ck }, rejectUnauthorized: false }); st.ws = ws;
    ws.on('message', d => { const m = JSON.parse(d); st.msgs.push(m); if (m.type === 'hello') st.slot = m.slot; });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    st.send = o => ws.send(JSON.stringify(o));
    st.wait = async (f, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = st.msgs.find(f); if (m) return m; await sleep(60); } return null; };
    return st;
  }
  const P = await phone('QA Cloud');
  check('phone gets a slot', (await P.wait(m => m.type === 'hello')) && P.slot > 0, 'slot ' + P.slot);
  check('TV sends the queue on join (q-get over the bridge)', !!(await P.wait(m => m.type === 'queue')));
  // keep the TV "not idle" so queue adds stay adds (a key press resets the 8 s idle timer)
  await tv.keyboard.press('ArrowDown');
  P.send({ type: 'q-add', id: ids[0] }); const r1 = await P.wait(m => m.type === 'qres' && m.id === ids[0]);
  check('q-add reaches the TV and is answered through the relay', r1 && r1.ok, r1 && r1.act);
  const q1 = await tvq(); check('TV queue holds the song', q1.q && q1.q.length === 1, JSON.stringify((q1.q || []).map(x => x.t)));
  const qm = await P.wait(m => m.type === 'queue' && m.q && m.q.length === 1); check('queue broadcast reaches the phone', !!qm);
  await sleep(900); P.send({ type: 'q-add', id: ids[1] }); const r2 = await P.wait(m => m.type === 'qres' && m.id === ids[1]); check('second add', r2 && r2.ok, r2 && r2.act);
  await sleep(900); P.send({ type: 'q-add', id: ids[2] }); const r3 = await P.wait(m => m.type === 'qres' && m.id === ids[2]); check('third add', r3 && r3.ok, r3 && r3.act);
  await sleep(900); P.send({ type: 'q-add', id: ids[3] }); const r4 = await P.wait(m => m.type === 'qres' && m.id === ids[3]); check('fourth is refused (3 per phone)', r4 && !r4.ok && r4.act === 'full', r4 && r4.act);
  await sleep(2600); P.send({ type: 'q-del', qid: ((await tvq()).q[0] || {}).qid }); await sleep(700);
  const q2 = await tvq(); check('q-del removes your own item', q2.q.length === 2, q2.q.length + ' left');
  // flood: the Worker bucket (burst 3, 1 per 2 s) answers 'rate' itself without bothering the TV
  const F = await phone('QA Flood'); await F.wait(m => m.type === 'hello'); await sleep(2500);
  for (let i = 0; i < 8; i++) F.send({ type: 'q-add', id: ids[4 + i] });
  await sleep(1500); const rates = F.msgs.filter(m => m.type === 'qres' && m.act === 'rate').length;
  check('flood is rate limited at the relay', rates >= 3, rates + ' rate answers of 8');
  F.send({ type: 'q-add', id: '../../etc/passwd' }); F.send({ type: 'q-add', id: { a: 1 } }); F.send({ type: 'q-del', qid: 'x'.repeat(500) }); await sleep(800);
  check('bad ids are dropped, TV still fine', (await tv.evaluate(() => !!window.KTVQueue)) && errs.length === 0, errs.join('|'));
  P.ws.close(); F.ws.close();
} catch (e) { fail++; console.log('FAIL exception — ' + e.message); }
await b.close(); srv.kill(); console.log(fail ? 'FAILED ' + fail : 'ALL PASS'); process.exit(fail ? 1 : 0);
