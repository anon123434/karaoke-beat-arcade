'use strict';
// v13.16: cloud bridge <-> world leaderboard (fake Worker over plain http/ws; no network)
const test = require('node:test'), assert = require('node:assert');
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { WebSocketServer } = require('ws');

function fakeWorker() {
  const hits = { top: 0, cookies: [] }, srv = http.createServer((req, res) => {
    if (req.url.startsWith('/kba/api/lb/top')) {
      hits.top++; hits.cookies.push(req.headers.cookie || '');
      if (req.headers.cookie !== 'ktv_inv=relaytoken_0123456789abcdef') { res.writeHead(401); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ kind: 'sing', n: 5, songs: { twinkle: [['QA A', 90, 1]] }, at: 1 }));
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server: srv, path: '/kba/ws' }); let sock = null; const got = [];
  wss.on('connection', ws => { sock = ws; ws.on('message', d => { try { got.push(JSON.parse(d)); } catch (e) {} }); });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, wss, hits, got, port: srv.address().port, sock: () => sock })));
}
const until = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

test('cloud bridge: web-hs goes to the TV, TV state reaches the room, top lists are cached and read with the relay credential', async () => {
  const fw = await fakeWorker(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktvlb-'));
  fs.writeFileSync(path.join(dir, 'cloud.json'), JSON.stringify({ origin: 'http://127.0.0.1:' + fw.port, base: '/kba', inv: 'relaytoken_0123456789abcdef' }));
  process.env.KTV_CLOUD_CFG = path.join(dir, 'cloud.json'); process.env.KTV_CLOUD_ROOM = 'tvqa22'; process.env.HTTP_PORT = '1';
  const { startCloud } = require('../server/cloud'), toTv = [];
  const c = startCloud({ root: dir, log: () => {}, onPhones: () => {}, onToTv: m => toTv.push(m), onState: () => {} });
  try {
    assert.ok(await c.ready(3000), 'bridge up');
    assert.ok(c.send({ type: 'state', state: 'results', score: 50, web: { song: 'twinkle', kind: 'sing', rows: [{ name: 'QA A', score: 50 }] } }));
    assert.ok(await until(() => fw.got.some(m => m.state === 'results' && m.web && m.web.rows.length === 1)), 'results reached the room');
    fw.sock().send(JSON.stringify({ type: 'web-hs', ok: true, song: 'twinkle', title: 'T', kind: 'bogus', results: [{ name: 'QA A', score: 50, pos: 3 }], top: [], extra: 'dropped' }));
    assert.ok(await until(() => toTv.some(m => m.type === 'web-hs')), 'web-hs forwarded to the TV');
    const hs = toTv.find(m => m.type === 'web-hs'); assert.equal(hs.kind, 'sing'); assert.equal(hs.results[0].pos, 3); assert.equal(hs.extra, undefined);
    const a = JSON.parse(await c.lbTop('sing')), b = JSON.parse(await c.lbTop('sing'));
    assert.equal(a.songs.twinkle[0][1], 90); assert.deepEqual(a, b); assert.equal(fw.hits.top, 1, 'second call served from the cache (no polling)');
    assert.equal(fw.hits.cookies[0], 'ktv_inv=relaytoken_0123456789abcdef');
    assert.match(c.lbUrl, /\/kba\/leaderboard$/);
  } finally { c.close(); fw.wss.close(); fw.srv.close(); }
});
