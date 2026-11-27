#!/usr/bin/env node
/*
 * KaraokeTV local server (local machine). One TV session, up to 4 phones (player slots), one song.
 *   HTTP  :8780  -> TV app (ws://), browser preview of the TV UI, CA download for the iPhone
 *   HTTPS :8743  -> iPhone mic page (getUserMedia needs a secure context) + wss://
 * The server is only a relay + pairing point; scoring runs on the TV (shared/scoring.js).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const Stingray = require('./stingray');
const { startCloud } = require('./cloud');
const PhoneIndex = require('../shared/phone-index');

const ROOT = path.join(__dirname, '..');
// LAN address phones use to reach this machine. Set KARAOKE_HOST to override (e.g. a hostname).
const lanIp = () => { for (const l of Object.values(require('os').networkInterfaces())) for (const a of l || []) if (a.family === 'IPv4' && !a.internal) return a.address; return 'localhost'; };
const HOST = process.env.KARAOKE_HOST || lanIp();
const HTTP_PORT = +(process.env.HTTP_PORT || 8780);
const HTTPS_PORT = +(process.env.HTTPS_PORT || 8743);
// Pairing code: stable across restarts (stored in .local/) so the QR on the TV keeps working.
const CODE = process.env.KARAOKE_CODE || (() => {
  const f = path.join(ROOT, '.local/pairing-code');
  try { const c = fs.readFileSync(f, 'utf8').trim(); if (/^[0-9a-f]{8}$/.test(c)) return c; } catch {}
  const c = crypto.randomBytes(4).toString('hex');
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, c, { mode: 0o600 });
  return c;
})();
const PHONE_URL = `https://${HOST}:${HTTPS_PORT}/phone/?s=${CODE}`;
const CA_URL = `http://${HOST}:${HTTP_PORT}/ca`;

const STATIC = { '/tv/shared/': 'shared', '/tv/songs/': 'songs', '/tv/': 'tv', '/phone/': 'phone', '/shared/': 'shared', '/songs/': 'songs' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wav': 'audio/wav', '.png': 'image/png', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mid': 'audio/midi', '.lrc': 'text/plain' };

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function serveStatic(req, res, urlPath) {
  for (const prefix in STATIC) {
    if (!urlPath.startsWith(prefix)) continue;
    const base = path.join(ROOT, STATIC[prefix]);
    let file = path.normalize(path.join(base, decodeURIComponent(urlPath.slice(prefix.length)) || 'index.html'));
    if (!file.startsWith(base)) break;
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) break;
    const stat = fs.statSync(file);
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
    if (range) { // audio seeking in browsers
      const start = range[1] ? +range[1] : 0, end = range[2] ? +range[2] : stat.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
}

let phoneIdx = null;
let qrCache = null, cloudQr = null;
const QR_OPTS = { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0420', light: '#ffffff' } };
// v13.10: when the hosted Worker room relay is up, the TV QR is <origin>/kba/j/<room> (no cert, no local IP);
// otherwise (Worker unreachable / no credential) the local HTTPS QR + CA QR as before.
async function sessionInfo() {
  if (!qrCache) qrCache = { phone: await QRCode.toString(PHONE_URL, QR_OPTS), ca: await QRCode.toString(CA_URL, QR_OPTS) };
  if (cloud && !cloudReadyOnce) { cloudReadyOnce = true; await cloud.ready(3000); }   // first TV load: give the WSS a moment so the TV doesn't flash the local QR
  if (cloud && cloud.up()) {
    if (!cloudQr) cloudQr = await QRCode.toString(cloud.phoneUrl, QR_OPTS);
    return { code: cloud.room, phoneUrl: cloud.phoneUrl, caUrl: '', qrSvg: cloudQr, caQrSvg: '', cloud: true, localUrl: PHONE_URL, phone: phoneState(), tvConnected: !!tv };
  }
  return { code: CODE, phoneUrl: PHONE_URL, caUrl: CA_URL, qrSvg: qrCache.phone, caQrSvg: qrCache.ca, cloud: false,
    phone: phoneState(), tvConnected: !!tv };
}

async function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Access-Control-Allow-Origin', '*'); // TV widget origin is file://
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (u.pathname === '/') { res.writeHead(302, { Location: '/tv/' }); return res.end(); }
  if (u.pathname === '/api/cloud') {   // bridge status for tests/diagnostics (no credential in it)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(cloud ? cloud.stats() : { up: false, off: true }));
  }
  if (process.env.KTV_TEST === '1' && cloud && req.method === 'POST' && /^\/api\/cloud\/(kick|block|unblock)$/.test(u.pathname)) {   // test hooks (private test servers only)
    const act = u.pathname.split('/').pop(); if (act === 'kick') cloud.kick(); else cloud.block(act === 'block'); if (act === 'block') cloud.kick();
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}');
  }
  if (u.pathname === '/api/session') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(await sessionInfo()));
  }
  if (u.pathname === '/api/dev' && /^(::ffff:)?127\.0\.0\.1$|^::1$/.test(req.socket.remoteAddress)) {
    // localhost-only dev hook: drive the TV app for automated perf measurement
    send(tv, { type: 'dev', action: u.searchParams.get('action') || 'start', song: +(u.searchParams.get('song') || 0), flags: JSON.parse(u.searchParams.get('flags') || '{}'), value: u.searchParams.get('value') });
    return json(res, 200, { sent: !!tv });
  }
  if (u.pathname === '/phone/songs-index.json') {   // v13.12: the phone Songs tab filters this small list client-side (no audio)
    try {
      const fi = path.join(ROOT, 'songs/index.json'), fl = path.join(ROOT, 'songs/library.json');
      const key = fs.statSync(fi).mtimeMs + ':' + (fs.existsSync(fl) ? fs.statSync(fl).mtimeMs : 0);
      if (!phoneIdx || phoneIdx.key !== key) phoneIdx = { key, body: JSON.stringify(PhoneIndex.build(JSON.parse(fs.readFileSync(fi, 'utf8')), fs.existsSync(fl) ? JSON.parse(fs.readFileSync(fl, 'utf8')) : null)) };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }); return res.end(phoneIdx.body);
    } catch (e) { return json(res, 500, { error: 'index unavailable' }); }
  }
  if (u.pathname.startsWith('/api/stingray/')) return stingrayApi(req, res, u);
  if (u.pathname === '/api/stt' && req.method === 'POST') {   // v13.6: phone voice search fallback (Whisper on this Mac)
    const chunks = []; let size = 0, dead = false;
    req.on('data', c => { size += c.length; if (size > 4 * 1024 * 1024) { dead = true; json(res, 413, { error: 'too big' }); req.destroy(); } else chunks.push(c); });
    req.on('end', async () => {
      if (dead) return;
      const ct = String(req.headers['content-type'] || ''), ext = /mp4|aac|m4a/.test(ct) ? 'm4a' : /wav/.test(ct) ? 'wav' : /ogg/.test(ct) ? 'ogg' : 'webm';
      try { const r = await require('./stt').transcribe(Buffer.concat(chunks), ext); json(res, r.error ? 500 : 200, r); } catch (e) { json(res, 500, { error: String(e.message || e) }); }
    });
    return;
  }
  if (u.pathname === '/api/custom-chart' && req.method === 'POST') {   // v13.7: Record map -> song.json "custom" (atomic, with versions)
    const chunks = []; let size = 0, dead = false;
    req.on('data', c => { size += c.length; if (size > 2 * 1024 * 1024) { dead = true; json(res, 413, { error: 'too big' }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (dead) return;
      try { json(res, 200, saveCustomChart(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
      catch (e) { json(res, e.code === 'BAD' ? 400 : 500, { error: String(e.message || e) }); }
    });
    return;
  }
  if (u.pathname === '/api/favorites') {   // v13.9: song-select Favorites (□), kept on the server so they survive app reinstalls
    const FAV = process.env.FAV_FILE || path.join(__dirname, '..', '.local', 'favorites.json');
    const load = () => { try { const v = JSON.parse(fs.readFileSync(FAV, 'utf8')); return Array.isArray(v.ids) ? v.ids : []; } catch (e) { return []; } };
    if (req.method === 'GET') return json(res, 200, { ids: load() });
    if (req.method === 'POST') {
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size < 65536) chunks.push(c); });
      req.on('end', () => {
        try {
          const b = JSON.parse(Buffer.concat(chunks).toString('utf8')), id = String(b.id || '');
          if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id) || !fs.existsSync(path.join(__dirname, '..', 'songs', id, 'song.json'))) return json(res, 400, { error: 'bad id' });
          let ids = load().filter(x => x !== id); if (b.on) ids.unshift(id);
          fs.mkdirSync(path.dirname(FAV), { recursive: true }); const tmp = FAV + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ ids, saved: new Date().toISOString() })); fs.renameSync(tmp, FAV);
          json(res, 200, { ids });
        } catch (e) { json(res, 400, { error: String(e.message || e) }); }
      });
      return;
    }
  }
  if (u.pathname === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, time: Date.now() })); }
  if (u.pathname === '/ca' || u.pathname === '/rootCA.pem') {
    // Public CA certificate only. iOS installs it as a profile when served with this type.
    res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="KaraokeTV-rootCA.pem"' });
    return res.end(fs.readFileSync(path.join(ROOT, 'certs/rootCA.pem')));
  }
  serveStatic(req, res, u.pathname);
}

// ---------------- Stingray (credentials stay on this server) ----------------
let stingrayClient = null;
function saveCustomChart(b) {
  const bad = m => Object.assign(new Error(m), { code: 'BAD' });
  const id = String(b && b.id || '');
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) throw bad('bad song id');
  const dir = path.join(ROOT, 'songs', id), sj = path.join(dir, 'song.json');
  if (!fs.existsSync(sj)) throw bad('unknown song');
  if (!Array.isArray(b.ev) || b.ev.length > 20000) throw bad('bad notes');
  const ev = b.ev.map(e => [Math.round(+e[0] * 1000) / 1000, e[1] | 0, Math.max(0, Math.round((+e[2] || 0) * 1000) / 1000)])
    .filter(e => isFinite(e[0]) && e[0] >= 0 && e[1] >= 0 && e[1] <= 9).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const sections = (Array.isArray(b.sections) ? b.sections : []).slice(0, 200).map(r => [+r[0], +r[1]]).filter(r => isFinite(r[0]) && isFinite(r[1]) && r[1] > r[0]);
  const meta = JSON.parse(fs.readFileSync(sj, 'utf8'));
  const vdir = path.join(dir, 'custom-versions'); fs.mkdirSync(vdir, { recursive: true });
  const prev = meta.custom; const version = ((prev && prev.version) || 0) + 1;
  if (prev) fs.writeFileSync(path.join(vdir, 'v' + (prev.version || 0) + '-' + String(prev.saved || 'old').replace(/[:.]/g, '-') + '.json'), JSON.stringify(prev));
  const old = fs.readdirSync(vdir).filter(f => f.endsWith('.json')).sort((x, y) => fs.statSync(path.join(vdir, x)).mtimeMs - fs.statSync(path.join(vdir, y)).mtimeMs);
  while (old.length > 20) fs.unlinkSync(path.join(vdir, old.shift()));   // keep the last 20 versions
  meta.custom = { v: 1, version, saved: new Date().toISOString(), ev, sections, merge: b.merge !== false, src: 'record-map' };
  const tmp = sj + '.tmp-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(meta)); fs.renameSync(tmp, sj);
  fs.writeFileSync(path.join(vdir, 'current.json'), JSON.stringify(meta.custom));   // the latest map also lives beside the versions
  log('custom chart saved:', id, 'v' + version, ev.length, 'notes');
  return { ok: true, version, custom: meta.custom };
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e4) req.destroy(); }); req.on('end', () => r(b)); }); }
async function stingrayApi(req, res, u) {
  let cfg;
  try { cfg = Stingray.loadConfig(); } catch (e) { return json(res, 500, { error: e.message }); }
  if (u.pathname === '/api/stingray/status') return json(res, 200, { configured: cfg.configured, featuredSongId: cfg.featuredSongId || null });
  if (!cfg.configured) return json(res, 503, { error: 'Stingray not configured: set STINGRAY_API_KEY or .local/stingray.json' });
  if (!stingrayClient || stingrayClient.cfg.apiKey !== cfg.apiKey) stingrayClient = new Stingray.StingrayClient(cfg);
  try {
    if (u.pathname === '/api/stingray/search') {
      const r = await stingrayClient.searchSongs(u.searchParams.get('q') || '', 10);
      return json(res, 200, (r && r.songs || []).map(s => ({ id: s.id, title: s.title, artist: s.artist_display_name, duration: s.duration_sec })));
    }
    if (u.pathname === '/api/stingray/song') return json(res, 200, await Stingray.loadSong(stingrayClient, u.searchParams.get('id') || cfg.featuredSongId));
    if (u.pathname === '/api/stingray/play-log' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req) || '{}');
      await stingrayClient.playLog(String(b.id).replace(/^stingray:/, ''), +b.seconds || 0);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'unknown stingray endpoint' });
  } catch (e) { log('stingray error:', e.message); return json(res, 502, { error: e.message }); }
}

// ---------------- WebSocket relay ----------------
// One TV, up to 4 phones (player slots 1..4, each with a name + colour). A phone that reconnects with the same
// client id gets its slot back. Scoring happens per slot on the TV.
const MAX_PLAYERS = 4;
const COLORS = ['#ff3fa4', '#3ff2ff', '#ffd75e', '#59ffa8'];
let tv = null;
const players = new Map(); // slot -> { ws, slot, name, color, mic, lat, cid, secure }
let lastSecureJoin = 0;
let voiceMaster = false, voiceVol = 0; // TV's "Voice on TV" setting (phones stream mic audio only while on)
let cloud = null, cloudReadyOnce = false, cloudPlayers = [];   // v13.10 hosted-Worker room bridge (server/cloud.js)
const cloudSlots = () => new Set(cloudPlayers.map(p => p.slot));
function playerList() {
  const cs = cloudSlots();
  const local = [...players.values()].filter(p => !cs.has(p.slot)).map(p => ({ slot: p.slot, name: p.name, color: p.color, mic: p.mic, lat: Math.round(p.lat) }));
  return local.concat(cloudPlayers.map(p => ({ slot: p.slot, name: p.name, color: p.color, mic: p.mic, lat: p.lat, via: 'cloud' }))).sort((a, b) => a.slot - b.slot);
}
function phoneState() {
  const list = playerList(), live = list.find(p => p.mic === 'live');
  const first = live || list[0];
  return { connected: list.length > 0, mic: first ? first.mic : 'off', lat: first ? first.lat : 0, players: list, certOk: lastSecureJoin > 0 };
}
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function toPhones(obj) { for (const p of players.values()) send(p.ws, obj); }
function notifyTv() { send(tv, { type: 'phone', ...phoneState() }); toPhones({ type: 'players', players: playerList() }); }
// v13.12 phone song queue: phones send only a song id; the TV validates it against its own list. 1 add per 2 s (burst 3) per phone slot.
const qBuckets = new Map();
function qOk(slot) { const t = Date.now(); let b = qBuckets.get(slot); if (!b) { b = { tok: 3, at: t }; qBuckets.set(slot, b); } b.tok = Math.min(3, b.tok + (t - b.at) / 2000); b.at = t; if (b.tok < 1) return false; b.tok -= 1; return true; }
function queueMsg(m, slot) {
  if (m.type === 'q-get') return { type: 'q-get', p: slot };
  if (m.type === 'q-add') { const id = String(m.id || ''); if (!/^[a-z0-9-]{1,80}$/.test(id)) return null; return { type: 'q-add', p: slot, id, mode: m.mode === 'play' ? 'play' : 'queue' }; }
  if (m.type === 'q-del') { const q = Math.round(+m.qid); return Number.isInteger(q) && q > 0 ? { type: 'q-del', p: slot, qid: q } : null; }
  return null;
}
function cleanName(n, slot) { n = String(n || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 14); return n || 'Player ' + slot; }

function onConnection(ws, req) {
  const u = new URL(req.url, 'http://x');
  const role = u.searchParams.get('role');
  if (role === 'phone' && u.searchParams.get('s') !== CODE) { ws.close(4001, 'bad pairing code'); return; }
  if (role !== 'tv' && role !== 'phone') { ws.close(4000, 'role required'); return; }
  let me = null;
  if (role === 'tv') { if (tv && tv !== ws) tv.close(4002, 'replaced'); tv = ws; log('TV connected'); notifyTv(); try { send(ws, { type: 'sync', sync: JSON.parse(fs.readFileSync(path.join(ROOT, '.local/tv-sync.json'), 'utf8')) }); } catch (e) {} }
  else {
    const cid = (u.searchParams.get('cid') || '').slice(0, 40) || 'anon-' + Math.random().toString(36).slice(2);
    let slot = [...players.values()].find(p => p.cid === cid)?.slot;
    if (slot) { const old = players.get(slot); if (old.ws !== ws) old.ws.close(4002, 'replaced'); }
    else {
      const cs = cloudSlots();
      for (let k = 1; k <= MAX_PLAYERS; k++) if (!players.has(k) && !cs.has(k)) { slot = k; break; }
      if (!slot) { send(ws, { type: 'full', max: MAX_PLAYERS }); ws.close(4003, 'all player slots taken'); return; }
    }
    const secure = !!req.socket.encrypted;
    me = { ws, slot, cid, name: cleanName(u.searchParams.get('name'), slot), color: COLORS[slot - 1], mic: 'off', lat: 0, secure };
    players.set(slot, me);
    if (secure) lastSecureJoin = Date.now();
    log('phone connected: slot', slot, secure ? '(https)' : '');
    send(ws, { type: 'hello', tv: !!tv, slot, name: me.name, color: me.color });
    send(ws, { type: 'voice', master: voiceMaster, vol: voiceVol });
    notifyTv(); send(tv, { type: 'guide-query' }); send(tv, { type: 'q-get', p: slot });
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Voice monitoring: phone PCM packet -> TV, prefixed with the player slot and the server receive time
      // (8 bytes: u8 slot, 3 pad, u32 server ms LE). Dropped unless the TV has voice-through-TV on.
      if (!me || players.get(me.slot) !== me || !voiceMaster || !tv || data.length < 8 || data.length > 8192) return;
      if (tv.bufferedAmount > 64 * 1024) return;   // TV link congested: drop rather than queue (latency over completeness)
      const hdr = Buffer.alloc(8); hdr.writeUInt8(me.slot, 0); hdr.writeUInt32LE(Date.now() % 4294967296, 4);
      return tv.send(Buffer.concat([hdr, data]), { binary: true });
    }
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'ping') return send(ws, { type: 'pong', id: m.id, server: Date.now() });
    if (me) {
      if (players.get(me.slot) !== me) return; // replaced
      if (m.type === 'pitch') {
        // Forward with the phone's own latency estimate (half RTT + analysis delay) and its player slot.
        return send(tv, { type: 'pitch', p: me.slot, f: +m.f || 0, c: +m.c || 0, rms: +m.rms || 0, lat: me.lat, seq: m.seq });
      }
      if (m.type === 'search') return send(tv, { type: 'search', q: String(m.q || '').slice(0, 60), src: m.src === 'voice' ? 'voice' : 'phone', final: !!m.final, p: me.slot });   // v13.6: phone typed / spoken search -> TV song list
      if (m.type === 'guide') return send(tv, { type: 'guide', level: String(m.level || ''), from: 'phone', p: me.slot });
      if (m.type === 'q-add' || m.type === 'q-del' || m.type === 'q-get') {   // v13.12 phone song queue
        const q = queueMsg(m, me.slot); if (!q) return;
        if (q.type !== 'q-get' && !qOk(me.slot)) return send(ws, { type: 'qres', ok: false, act: 'rate', id: q.id || '' });
        return send(tv, q);
      }
      if (m.type === 'voice') return send(tv, { type: 'voice', p: me.slot, on: !!m.on, vol: Math.max(0, Math.min(1.5, +m.vol || 0)) });
      if (m.type === 'vdelay') {
        const rec = { at: new Date().toISOString(), type: 'vdelay', p: me.slot, ms: Math.round(+m.ms || 0), runs: (m.runs || []).slice(0, 10), autotune: !!m.autotune };
        fs.appendFile(path.join(ROOT, '.local/perf.log'), JSON.stringify(rec) + '\n', () => {});
        return send(tv, { type: 'vdelay', p: me.slot, ms: rec.ms });
      }
      if (m.type === 'name') { me.name = cleanName(m.name, me.slot); return notifyTv(); }
      if (m.type === 'status') { me.mic = String(m.mic || 'off'); if (m.lat != null) me.lat = +m.lat || 0; return notifyTv(); }
    } else if (ws === tv) {
      // TV -> phones: game state + song clock (broadcast), per-player feedback (to: slot).
      if (m.type === 'sync' && m.sync && typeof m.sync === 'object' && /Tizen/i.test(req.headers['user-agent'] || '')) { fs.writeFile(path.join(ROOT, '.local/tv-sync.json'), JSON.stringify(m.sync), () => {}); return; }
      if (m.type === 'perf') { fs.appendFile(path.join(ROOT, '.local/perf.log'), JSON.stringify({ at: new Date().toISOString(), ...m }) + '\n', () => {}); return; }
      if (m.type === 'voice') { voiceMaster = !!m.master; voiceVol = +m.vol || 0; return toPhones({ type: 'voice', master: voiceMaster, vol: voiceVol }); }
      if (m.type === 'clock' || m.type === 'state' || m.type === 'feedback' || m.type === 'guide' || m.type === 'mode' || m.type === 'searchres' || m.type === 'queue' || m.type === 'qres') {
        if (m.to) {
          if (cloud && cloudSlots().has(+m.to)) return cloud.send(m);
          const p = players.get(+m.to); return p && send(p.ws, m);
        }
        if (cloud && cloudPlayers.length) cloud.send(m);
        return toPhones(m);
      }
    }
  });
  ws.on('close', () => {
    if (ws === tv) { tv = null; voiceMaster = false; toPhones({ type: 'voice', master: false, vol: 0 }); log('TV disconnected'); toPhones({ type: 'state', state: 'tv-offline' }); }
    if (me && players.get(me.slot) === me) { players.delete(me.slot); log('phone disconnected: slot', me.slot); notifyTv(); }
  });
}

function start() {
  const httpServer = http.createServer(handler);
  const wss1 = new WebSocketServer({ server: httpServer, path: '/ws' });
  wss1.on('connection', onConnection);
  httpServer.listen(HTTP_PORT, '0.0.0.0', () => log(`HTTP  http://${HOST}:${HTTP_PORT}/tv/`));
  const servers = [httpServer];
  const keyFile = path.join(ROOT, 'certs/key.pem');
  if (fs.existsSync(keyFile)) {
    const httpsServer = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(path.join(ROOT, 'certs/cert.pem')) }, handler);
    const wss2 = new WebSocketServer({ server: httpsServer, path: '/ws' });
    wss2.on('connection', onConnection);
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => log(`HTTPS ${PHONE_URL}`));
    servers.push(httpsServer);
  } else log('No certs/ — run npm run cert (phone mic needs HTTPS)');
  cloud = startCloud({
    root: ROOT, log,
    onPhones: list => {
      cloudPlayers = list;
      for (const p of list) { const loc = players.get(p.slot); if (loc) { players.delete(p.slot); send(loc.ws, { type: 'full', max: MAX_PLAYERS }); loc.ws.close(4003, 'slot taken by a cloud phone'); } }
      notifyTv();
    },
    onToTv: m => send(tv, m),
    onState: upNow => { log('cloud relay', upNow ? 'UP: TV QR -> ' + cloud.phoneUrl.replace(/^https?:\/\//, '') : 'DOWN: TV QR -> local ' + HOST); sessionInfo().then(s => send(tv, { type: 'session', ...s })).catch(() => {}); }
  });
  return { close: () => { if (cloud) cloud.close(); servers.forEach(s => { s.closeAllConnections && s.closeAllConnections(); s.close(); }); }, code: CODE, cloud: () => cloud };
}

if (require.main === module) start();
module.exports = { start, CODE };
