// Phone song queue relay (v13.12): fake TV + fake phones on a private server. Phones send only a song id; the relay validates, rate-limits per phone,
// and routes the TV's 'queue' (broadcast) and 'qres' (to one slot) back. Also the phone song index (no audio, small).
const test = require('node:test');
const assert = require('node:assert');
process.env.HTTP_PORT = '18082'; process.env.HTTPS_PORT = '18445'; process.env.KARAOKE_CODE = 'testcode'; process.env.KARAOKE_HOST = '127.0.0.1'; process.env.KTV_CLOUD = '0';
const { start } = require('../server/index.js');
const WebSocket = require('ws');
const PhoneIndex = require('../shared/phone-index.js');

const open = (url, opts) => new Promise((res, rej) => { const w = new WebSocket(url, opts); const q = []; w.queue = q; w.on('message', d => q.push(JSON.parse(d))); w.on('open', () => res(w)); w.on('error', rej); });
const waitFor = (w, pred, ms = 2000) => new Promise((res, rej) => {
  const t0 = Date.now(); (function poll() { const i = w.queue.findIndex(pred); if (i >= 0) return res(w.queue.splice(i, 1)[0]); if (Date.now() - t0 > ms) return rej(new Error('timeout')); setTimeout(poll, 20); })();
});
const quiet = (w, ms = 250) => new Promise(r => setTimeout(r, ms));

test('PhoneIndex.build: ids, titles, artists, categories, small', () => {
  const j = PhoneIndex.build([{ id: 'a-1', title: 'Song One', artist: 'Artist One' }, { id: '../bad', title: 'x', artist: 'y' }, { id: 'b', title: 'B', artist: 'C' }],
    { cats: [{ id: 'all' }, { id: 'fav' }, { id: 'rock', name: 'Rock' }], songs: { 'a-1': { cats: ['rock', 'nope'] } } });
  assert.deepStrictEqual(j.cats, [['rock', 'Rock']]); assert.strictEqual(j.songs.length, 2);
  assert.deepStrictEqual(j.songs[0], ['a-1', 'Song One', 'Artist One', [0]]); assert.deepStrictEqual(j.songs[1][3], []);
});

test('queue relay: q-add/q-del/q-get validated + rate-limited per phone; queue/qres routed back', async () => {
  const srv = start();
  await new Promise(r => setTimeout(r, 200));
  try {
    const idx = await (await fetch('http://127.0.0.1:18082/phone/songs-index.json')).json();
    assert.ok(idx.songs.length >= 2 && Array.isArray(idx.cats)); assert.ok(JSON.stringify(idx).length < 20000);
    const tv = await open('ws://127.0.0.1:18082/ws?role=tv');
    const ph = await open('wss://127.0.0.1:18445/ws?role=phone&s=testcode&cid=qa-a&name=QA%20Ann', { rejectUnauthorized: false });
    await waitFor(ph, m => m.type === 'hello');
    await waitFor(tv, m => m.type === 'q-get' && m.p === 1);   // a joining phone asks the TV to publish the queue

    ph.send(JSON.stringify({ type: 'q-add', id: 'twinkle', mode: 'play' }));
    const a = await waitFor(tv, m => m.type === 'q-add');
    assert.deepStrictEqual([a.p, a.id, a.mode], [1, 'twinkle', 'play']);
    ph.send(JSON.stringify({ type: 'q-add', id: '../../etc/passwd' })); ph.send(JSON.stringify({ type: 'q-add', id: { x: 1 } })); ph.send(JSON.stringify({ type: 'q-del', qid: 'x' }));
    await quiet(); assert.strictEqual(tv.queue.filter(m => m.type === 'q-add' || m.type === 'q-del').length, 0, 'invalid frames are dropped, not forwarded');
    ph.send(JSON.stringify({ type: 'q-del', qid: 7 }));
    const d = await waitFor(tv, m => m.type === 'q-del'); assert.deepStrictEqual([d.p, d.qid], [1, 7]);

    // burst: 3 pass (token bucket), the rest are refused to the phone with act 'rate'
    for (let i = 0; i < 10; i++) ph.send(JSON.stringify({ type: 'q-add', id: 'twinkle', mode: 'queue' }));
    await quiet(400);
    const fwd = tv.queue.filter(m => m.type === 'q-add').length, rate = ph.queue.filter(m => m.type === 'qres' && m.act === 'rate').length;
    assert.ok(fwd <= 3 && rate >= 6, 'forwarded ' + fwd + ', refused ' + rate);

    // TV -> phones: queue broadcast, qres to one slot only
    const ph2 = await open('wss://127.0.0.1:18445/ws?role=phone&s=testcode&cid=qa-b&name=QA%20Bob', { rejectUnauthorized: false });
    await waitFor(ph2, m => m.type === 'hello');
    tv.send(JSON.stringify({ type: 'queue', idle: false, q: [{ qid: 1, id: 'twinkle', t: 'Twinkle', n: 'QA Bob', s: 2 }] }));
    await waitFor(ph, m => m.type === 'queue' && m.q.length === 1); await waitFor(ph2, m => m.type === 'queue');
    tv.send(JSON.stringify({ type: 'qres', to: 2, ok: true, act: 'queued', pos: 1, id: 'twinkle' }));
    await waitFor(ph2, m => m.type === 'qres' && m.act === 'queued'); await quiet();
    assert.strictEqual(ph.queue.filter(m => m.type === 'qres' && m.act === 'queued').length, 0, 'qres goes only to the addressed phone');
    ph.close(); ph2.close(); tv.close();
  } finally { srv.close(); }
});
