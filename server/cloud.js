/*
 * Cloud room bridge (v13.10): the local server joins the hosted room relay (the Worker in ../worker,
 * Durable Object "Room", same protocol as server/index.js) as the room's TV, over outbound WSS.
 * Phones then scan <origin>/kba/j/<room> (real HTTPS, no certificate, no local IP); their mic pitch,
 * status, search and guide messages arrive here and are handed to the TV over the LAN socket. Songs never leave
 * the Mac/TV: only small JSON control/pitch frames cross Cloudflare.
 * If the Worker is unreachable (or the credential is missing/rejected) the server keeps the local-IP flow.
 * Config: .local/cloud-relay.json {origin, base, inv} (mode 600, git-ignored; `inv` is the Worker's RELAY_TOKEN). Never logged.
 * Without that file (or with KTV_CLOUD=0) the cloud bridge is off and only the local QR is used.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const ROOM_RE = /^[a-z2-9]{6}$/;
const ALPH = 'abcdefghijkmnpqrstuvwxyz23456789'.replace(/[^a-z2-9]/g, '');

function loadCfg(root) {
  if (process.env.KTV_CLOUD === '0') return null;
  const f = process.env.KTV_CLOUD_CFG || path.join(root, '.local/cloud-relay.json');
  let c; try { c = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
  if (!c || typeof c.inv !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(c.inv)) return null;
  const origin = String(process.env.KTV_CLOUD_ORIGIN || c.origin || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[a-z0-9.:-]+$/i.test(origin)) return null;
  const base = /^\/[a-z0-9-]+$/i.test(c.base || '') ? c.base : '/kba';
  return { origin, base, inv: c.inv };
}
function roomCode(root) {
  if (ROOM_RE.test(process.env.KTV_CLOUD_ROOM || '')) return process.env.KTV_CLOUD_ROOM;
  const f = path.join(root, '.local/cloud-room');
  try { const c = fs.readFileSync(f, 'utf8').trim(); if (ROOM_RE.test(c)) return c; } catch (e) {}
  let c = ''; const b = crypto.randomBytes(6); for (let i = 0; i < 6; i++) c += ALPH[b[i] % ALPH.length];
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c, { mode: 0o600 });
  return c;
}

// token bucket per key
function limiter(rate, burst) {
  const b = new Map();
  return key => {
    const now = Date.now(); let s = b.get(key);
    if (!s) { s = { tok: burst, at: now }; b.set(key, s); }
    s.tok = Math.min(burst, s.tok + (now - s.at) * rate / 1000); s.at = now;
    if (s.tok < 1) return false; s.tok -= 1; return true;
  };
}
const num = (v, lo, hi) => { v = +v; return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0; };
const COLORS = ['#ff3fa4', '#3ff2ff', '#ffd75e', '#59ffa8'];
const cleanName = (n, slot) => { n = String(n || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 16); return n || 'Player ' + slot; };

/**
 * start({ root, log, onPhones(list), onToTv(msg), onState(up) }) -> { up(), room, phoneUrl, send(msg), legMs(), stats(), close() }
 */
function startCloud(opts) {
  // test servers on private ports never touch the production room (it would replace the real TV's socket)
  if (!process.env.KTV_CLOUD_ROOM && process.env.HTTP_PORT && +process.env.HTTP_PORT !== 8780) { opts.log('cloud relay: off on private port without KTV_CLOUD_ROOM'); return null; }
  const cfg = loadCfg(opts.root);
  if (!cfg) { opts.log('cloud relay: off (no .local/cloud-relay.json or KTV_CLOUD=0) - local QR only'); return null; }
  const room = roomCode(opts.root);
  const phoneUrl = `${cfg.origin}${cfg.base}/j/${room}`;
  const wsUrl = `${cfg.origin.replace(/^http/, 'ws')}${cfg.base}/ws?role=tv&s=${room}`;
  const pitchOk = limiter(120, 120), ctlOk = limiter(8, 16), qOk = limiter(0.5, 3);
  let ws = null, up = false, closed = false, backoff = 1000, timer = null, pingT = null, downT = null, firstTry = null;
  let rtts = [], legMs = 0, blocked = false, lastPong = 0, joinLive = true, joinT = null, published = false;
  const stats = { connects: 0, drops: 0, pitchIn: 0, pitchDropped: 0, badMsgs: 0, lastErr: '' };
  let players = [];   // validated cloud player list

  function publishState() {
    const show = !!(up && joinLive);
    if (show === published) return;
    published = show;
    if (!show) { players = []; opts.onPhones(players); }
    opts.onState(show);
  }
  function setUp(v) {
    if (v) { clearTimeout(downT); downT = null; up = true; publishState(); return; }
    // brief blips keep the cloud QR (phones stay on the Durable Object and come back when we reconnect);
    // after 8 s down the TV switches to the local-IP QR
    if (up && !downT) downT = setTimeout(() => { downT = null; up = false; publishState(); }, +(process.env.KTV_CLOUD_GRACE_MS || 8000));
  }
  // v13.13.1: if <origin>/kba/j/<room> 404s (quota, stale room, etc.) don't keep showing a cloud QR phones can't use
  function checkJoin() {
    if (closed) return;
    let lib; try { lib = require(phoneUrl.startsWith('https') ? 'https' : 'http'); } catch (e) { return; }
    const req = lib.get(phoneUrl, { timeout: 5000, headers: { 'User-Agent': 'KaraokeTV-MacBridge/13.13.1' } }, res => {
      res.resume();
      const ok = res.statusCode === 302 || res.statusCode === 301 || res.statusCode === 200 || res.statusCode === 303;
      if (ok) {
        if (!joinLive) opts.log('cloud relay: join QR live again');
        joinLive = true; publishState();
      } else if (res.statusCode === 404 || res.statusCode >= 500) {
        if (joinLive) opts.log('cloud relay: join QR not live (HTTP ' + res.statusCode + ') - local QR until it recovers');
        joinLive = false; publishState();
      }
    });
    req.on('error', () => {});
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} });
  }
  function connect() {
    if (closed) return;
    let opened = false;
    ws = new WebSocket(blocked ? 'ws://127.0.0.1:9/blocked' : wsUrl, { headers: { Cookie: 'ktv_inv=' + cfg.inv, 'User-Agent': 'KaraokeTV-MacBridge/13.10' }, handshakeTimeout: 6000, maxPayload: 64 * 1024 });
    ws.on('open', () => {
      opened = true; stats.connects++; if (firstTry) { firstTry(); firstTry = null; } backoff = 1000; opts.log('cloud relay: connected room', room, '->', phoneUrl.replace(/^https?:\/\//, ''));
      lastPong = Date.now(); setUp(true); ping(); clearInterval(pingT); pingT = setInterval(ping, 2000);
      if (!joinT) { checkJoin(); joinT = setInterval(checkJoin, 15000); }
    });
    ws.on('unexpected-response', (req, res) => { stats.lastErr = 'http ' + res.statusCode; opts.log('cloud relay: rejected', res.statusCode, '(credential or room) - local QR stays'); });
    ws.on('error', e => { stats.lastErr = String(e.code || e.message || e).slice(0, 60); });
    ws.on('message', (data, bin) => { if (!bin) onMsg(data); });
    ws.on('close', () => {
      clearInterval(pingT); if (opened) stats.drops++;
      if (firstTry) { firstTry(); firstTry = null; }
      setUp(false);
      if (!closed) { clearTimeout(timer); timer = setTimeout(connect, backoff); backoff = Math.min(30000, backoff * 2); }
    });
  }
  function ping() {
    send({ type: 'ping', id: Date.now() });
    if (lastPong && Date.now() - lastPong > 10000 && ws && ws.readyState === 1) {
      stats.lastErr = 'ping timeout'; opts.log('cloud relay: no pong, reconnecting');
      try { ws.close(); } catch (e) {}
    }
  }
  function send(o) {
    if (!ws || ws.readyState !== 1) return false;
    if (ws.bufferedAmount > 256 * 1024) return false;   // congested: drop (clock/feedback are refreshed every 250 ms)
    try { ws.send(JSON.stringify(o)); return true; } catch (e) { return false; }
  }
  function onMsg(data) {
    if (data.length > 32 * 1024) { stats.badMsgs++; return; }
    let m; try { m = JSON.parse(data); } catch (e) { stats.badMsgs++; return; }
    if (!m || typeof m.type !== 'string') { stats.badMsgs++; return; }
    if (m.type === 'pong') {
      lastPong = Date.now();
      const rtt = Date.now() - (+m.id || 0); if (!(rtt >= 0 && rtt < 10000)) return;
      rtts.push(rtt); if (rtts.length > 9) rtts.shift();
      const s = rtts.slice().sort((a, b) => a - b); legMs = s[Math.floor(s.length / 2)] / 2;
      return;
    }
    const slotOk = p => Number.isInteger(p) && p >= 1 && p <= 4 && players.some(x => x.slot === p);
    if (m.type === 'phone') {
      players = (Array.isArray(m.players) ? m.players : []).slice(0, 4).filter(p => p && Number.isInteger(p.slot) && p.slot >= 1 && p.slot <= 4)
        .map(p => ({ slot: p.slot, name: cleanName(p.name, p.slot), color: COLORS[p.slot - 1], mic: String(p.mic || 'off').replace(/[^a-z-]/g, '').slice(0, 12) || 'off', lat: Math.round(num(p.lat, 0, 2000)), cloud: true }));
      return opts.onPhones(players);
    }
    if (m.type === 'pitch') {
      stats.pitchIn++;
      if (!slotOk(m.p) || !pitchOk('p' + m.p)) { stats.pitchDropped++; return; }
      // the phone's own estimate covers phone->Cloudflare; add the Cloudflare->Mac leg we measure ourselves
      return opts.onToTv({ type: 'pitch', p: m.p, f: num(m.f, 0, 4000), c: num(m.c, 0, 1), rms: num(m.rms, 0, 10), lat: Math.round(num(m.lat, 0, 2000) + legMs), seq: Number.isInteger(m.seq) ? m.seq : 0, via: 'cloud' });
    }
    if (m.type === 'search') { if (!slotOk(m.p) || !ctlOk('s' + m.p)) return; return opts.onToTv({ type: 'search', q: String(m.q || '').slice(0, 60), src: m.src === 'voice' ? 'voice' : 'phone', final: !!m.final, p: m.p }); }
    if (m.type === 'guide') { if (!slotOk(m.p) || !ctlOk('g' + m.p)) return; return opts.onToTv({ type: 'guide', level: String(m.level || '').replace(/[^a-z]/g, '').slice(0, 12), from: 'phone', p: m.p }); }
    if (m.type === 'vdelay') { if (!slotOk(m.p) || !ctlOk('v' + m.p)) return; return opts.onToTv({ type: 'vdelay', p: m.p, ms: Math.round(num(m.ms, -2000, 2000)) }); }
    if (m.type === 'q-add' || m.type === 'q-del' || m.type === 'q-get') {   // v13.12 phone song queue (relay already vetted the slot; re-validate)
      if (!slotOk(m.p)) return;
      if (m.type === 'q-get') return opts.onToTv({ type: 'q-get', p: m.p });
      if (!qOk('q' + m.p)) { stats.qRate = (stats.qRate || 0) + 1; return send({ type: 'qres', to: m.p, ok: false, act: 'rate', id: String(m.id || '').slice(0, 80) }); }
      if (m.type === 'q-add') { const id = String(m.id || ''); if (!/^[a-z0-9-]{1,80}$/.test(id)) return; return opts.onToTv({ type: 'q-add', p: m.p, id, mode: m.mode === 'play' ? 'play' : 'queue' }); }
      const qid = Math.round(+m.qid); if (Number.isInteger(qid) && qid > 0) return opts.onToTv({ type: 'q-del', p: m.p, qid });
      return;
    }
    if (m.type === 'guide-query') { if (!ctlOk('q')) return; return opts.onToTv({ type: 'guide-query' }); }
    // v13.16: the Worker's answer to a submitted score (rank, neighbours, who was passed) goes straight to the TV for the rank-up animation
    if (m.type === 'web-hs') { stats.hs = (stats.hs || 0) + 1; return opts.onToTv({ type: 'web-hs', ok: !!m.ok, song: String(m.song || '').slice(0, 80), title: String(m.title || '').slice(0, 120), kind: ['sing', 'beat', 'duet'].includes(m.kind) ? m.kind : 'sing', results: Array.isArray(m.results) ? m.results.slice(0, 5) : [], top: Array.isArray(m.top) ? m.top.slice(0, 5) : [] }); }
    // 'sync' (the DO's stored copy) and anything else: ignored
  }
  // v13.16: world top lists for the TV. One cached snapshot per kind (5 min); the Worker answers it from its edge cache.
  // Read-only: the relay credential may GET /api/lb/top and nothing else new. No timers: only fetched when the TV asks.
  const lbCache = {}, lbPending = {};
  function lbTop(kind, fresh) {
    kind = ['sing', 'beat', 'duet'].includes(kind) ? kind : 'sing';
    const c = lbCache[kind], now = Date.now();
    if (c && (now - c.at < 300000) && !(fresh && now - c.at > 20000)) return Promise.resolve(c.body);
    if (lbPending[kind]) return lbPending[kind];
    const lib = require(cfg.origin.startsWith('https') ? 'https' : 'http');
    const p = new Promise((resolve, reject) => {
      const req = lib.get(`${cfg.origin}${cfg.base}/api/lb/top?kind=${kind}${fresh ? '&fresh=1' : ''}`, { timeout: 7000, headers: { Cookie: 'ktv_inv=' + cfg.inv, 'User-Agent': 'KaraokeTV-MacBridge/13.16', Accept: 'application/json' } }, res => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', d => { buf += d; if (buf.length > 2e6) { res.destroy(); reject(new Error('too big')); } });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error('http ' + res.statusCode));
          try { const j = JSON.parse(buf); if (!j || typeof j.songs !== 'object') throw new Error('bad body'); lbCache[kind] = { at: Date.now(), body: buf }; resolve(buf); } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch (e) {} });
    }).finally(() => { delete lbPending[kind]; });
    lbPending[kind] = p;
    return p.catch(e => { if (c) return c.body; throw e; });   // stale beats nothing
  }
  const lbUrl = `${cfg.origin}${cfg.base}/leaderboard`;
  const ready = new Promise(r => { firstTry = r; });
  connect();
  return {
    room, phoneUrl, lbTop, lbUrl,
    up: () => up,
    ready: ms => Promise.race([ready, new Promise(r => setTimeout(r, ms))]).then(() => up),
    players: () => players,
    legMs: () => legMs,
    stats: () => ({ ...stats, up, legMs, room }),
    send,
    kick: () => { try { ws && ws.terminate(); } catch (e) {} },   // tests: simulate a network drop
    block: on => { blocked = !!on; if (!on) { clearTimeout(timer); backoff = 1000; if (!ws || ws.readyState > 1) connect(); } },   // tests: Worker unreachable
    close: () => { closed = true; clearTimeout(timer); clearTimeout(downT); clearInterval(pingT); clearInterval(joinT); try { ws && ws.close(); } catch (e) {} }
  };
}
module.exports = { startCloud, loadCfg, ROOM_RE };
