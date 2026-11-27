// Server relay test with a FAKE phone client (synthetic pitch values, labelled) and a fake TV client.
const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
process.env.HTTP_PORT = '18080'; process.env.HTTPS_PORT = '18443'; process.env.KARAOKE_CODE = 'testcode'; process.env.KARAOKE_HOST = '127.0.0.1';
const { start } = require('../server/index.js');
const WebSocket = require('ws');

const open = (url, opts) => new Promise((res, rej) => { const w = new WebSocket(url, opts); const q = []; w.queue = q; w.on('message', d => q.push(JSON.parse(d))); w.on('open', () => res(w)); w.on('error', rej); });
const waitFor = (w, pred, ms = 2000) => new Promise((res, rej) => {
  const t0 = Date.now(); (function poll() { const i = w.queue.findIndex(pred); if (i >= 0) return res(w.queue.splice(i, 1)[0]); if (Date.now() - t0 > ms) return rej(new Error('timeout')); setTimeout(poll, 10); })();
});

test('pairing, status, pitch relay, clock relay, CA download, bad code rejected', async () => {
  const srv = start();
  await new Promise(r => setTimeout(r, 200));
  try {
    const session = await (await fetch('http://127.0.0.1:18080/api/session')).json();
    assert.strictEqual(session.phoneUrl, 'https://127.0.0.1:18443/phone/?s=testcode');
    assert.match(session.qrSvg, /<svg/);
    const ca = await fetch('http://127.0.0.1:18080/ca');
    assert.match(await ca.text(), /BEGIN CERTIFICATE/);
    assert.ok(!(await (await fetch('http://127.0.0.1:18080/ca')).text()).includes('PRIVATE KEY'));

    const tv = await open('ws://127.0.0.1:18080/ws?role=tv');
    await waitFor(tv, m => m.type === 'phone' && m.connected === false);

    // phone page over HTTPS (mkcert cert; test skips CA verification)
    const page = await new Promise((res, rej) => https.get('https://127.0.0.1:18443/phone/?s=testcode', { rejectUnauthorized: false }, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(b)); }).on('error', rej));
    assert.match(page, /NOW! Karaoke Beat Arcade/);

    const bad = new WebSocket('wss://127.0.0.1:18443/ws?role=phone&s=wrong', { rejectUnauthorized: false });
    const code = await new Promise(r => bad.on('close', c => r(c)));
    assert.strictEqual(code, 4001);

    const phone = await open('wss://127.0.0.1:18443/ws?role=phone&s=testcode', { rejectUnauthorized: false });
    await waitFor(phone, m => m.type === 'hello' && m.tv === true);
    await waitFor(tv, m => m.type === 'phone' && m.connected === true);

    phone.send(JSON.stringify({ type: 'ping', id: 1 }));
    await waitFor(phone, m => m.type === 'pong' && m.id === 1);

    phone.send(JSON.stringify({ type: 'status', mic: 'live', lat: 42 }));
    const st = await waitFor(tv, m => m.type === 'phone' && m.mic === 'live');
    assert.strictEqual(st.lat, 42);

    // [synthetic] fake phone pitch frames
    phone.send(JSON.stringify({ type: 'pitch', f: 261.63, c: 0.95, rms: 0.1, seq: 7 }));
    const p = await waitFor(tv, m => m.type === 'pitch');
    assert.deepStrictEqual([p.f, p.lat, p.seq], [261.63, 42, 7]);

    tv.send(JSON.stringify({ type: 'clock', t: 3.2, score: 10, lyric: 'Twinkle twinkle' }));
    const c = await waitFor(phone, m => m.type === 'clock');
    assert.strictEqual(c.lyric, 'Twinkle twinkle');

    // a second phone joins as player 2 (multiplayer); the same client id reconnecting keeps its slot
    const phone2 = await open('wss://127.0.0.1:18443/ws?role=phone&s=testcode&cid=two&name=Ana', { rejectUnauthorized: false });
    const h2 = await waitFor(phone2, m => m.type === 'hello');
    assert.strictEqual(h2.slot, 2); assert.strictEqual(h2.name, 'Ana');
    const pl = await waitFor(tv, m => m.type === 'phone' && m.players && m.players.length === 2);
    assert.strictEqual(pl.certOk, true);
    phone2.send(JSON.stringify({ type: 'pitch', f: 330, c: 0.9, rms: 0.1, seq: 1 }));
    const f2 = await waitFor(tv, m => m.type === 'pitch' && m.p === 2);
    assert.strictEqual(f2.f, 330);
    phone.close(); phone2.close(); tv.close();
    const st2 = await (await fetch('http://127.0.0.1:18080/api/stingray/status')).json();
    assert.strictEqual(typeof st2.configured, 'boolean');
  } finally { srv.close(); }
});
