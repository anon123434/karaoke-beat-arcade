// One Durable Object per room code: the port of server/index.js's WebSocket relay (one TV, up to 4 phones).
// Uses WebSocket hibernation; per-socket state lives in the socket attachment.
import { DurableObject } from 'cloudflare:workers';
import SONGS from './songs-meta.json';
import { badName } from './online-config.js';
const MAX_PLAYERS = 4;
const COLORS = ['#ff3fa4', '#3ff2ff', '#ffd75e', '#59ffa8'];
const cleanName = (n, slot) => { n = String(n || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 14); return n || 'Player ' + slot; };

export class Room extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; this.tvWs = null; }
  sockets(tag) { return this.ctx.getWebSockets(tag); }
  tv() { if (this.tvWs && this.tvWs.readyState === 1) return this.tvWs; const t = this.sockets('tv').filter(w => w.readyState === 1); this.tvWs = t[t.length - 1] || null; return this.tvWs; }
  phones() { return this.sockets('phone').map(ws => ({ ws, a: ws.deserializeAttachment() || {} })).filter(x => x.ws.readyState === 1 && x.a.slot); }
  uniq(name, slot) {   // two phones called "Bob" become "Bob" and "Bob 2" (TV list, results cards, leaderboard rows stay distinct)
    const taken = new Set(this.phones().filter(x => x.a.slot !== slot).map(x => String(x.a.name).toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let k = 2; k < 9; k++) { const n = name.slice(0, 12).trim() + ' ' + k; if (!taken.has(n.toLowerCase())) return n; }
    return name;
  }
  playerList() { return this.phones().sort((x, y) => x.a.slot - y.a.slot).map(({ a }) => ({ slot: a.slot, name: a.name, color: a.color, mic: a.mic || 'off', lat: Math.round(a.lat || 0) })); }
  phoneState() { const list = this.playerList(), live = list.find(p => p.mic === 'live'), first = live || list[0]; return { connected: list.length > 0, mic: first ? first.mic : 'off', lat: first ? first.lat : 0, players: list, certOk: true }; }
  send(ws, o) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); } catch (e) {} }
  toPhones(o) { const s = JSON.stringify(o); for (const { ws } of this.phones()) try { ws.send(s); } catch (e) {} }
  notifyTv() { this.send(this.tv(), { type: 'phone', ...this.phoneState() }); this.toPhones({ type: 'players', players: this.playerList() }); }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/info' || url.pathname.endsWith('/info')) {
      let seen = 0;
      try { seen = Number(await this.ctx.storage.get('tvSeen')) || 0; } catch (e) { console.log('room info tvSeen', String(e && e.message || e)); }
      const tv = !!this.tv();
      // v13.13.1: a connected TV is enough; don't 404 a live room if tvSeen was evicted
      const known = tv || (seen > 0 && Date.now() - seen < 7 * 86400e3);
      return Response.json({ known, tv, phone: this.phoneState() });
    }
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    const role = url.searchParams.get('role');
    if (role === 'tv') {
      for (const old of this.sockets('tv')) try { old.close(4002, 'replaced'); } catch (e) {}
      this.ctx.acceptWebSocket(server, ['tv']); server.serializeAttachment({ role: 'tv' }); this.tvWs = server;
      await this.ctx.storage.put('tvSeen', Date.now());
      this.notifyTv();
      const sync = await this.ctx.storage.get('sync'); if (sync) this.send(server, { type: 'sync', sync });
    } else if (role === 'phone') {
      if (!(await this.ctx.storage.get('tvSeen'))) { this.ctx.acceptWebSocket(server, ['dead']); server.close(4001, 'unknown room'); return new Response(null, { status: 101, webSocket: client }); }
      const cid = (url.searchParams.get('cid') || '').slice(0, 40) || 'anon-' + Math.random().toString(36).slice(2);
      const ph = this.phones(); let slot = ph.find(x => x.a.cid === cid)?.a.slot;
      if (slot) { for (const x of ph) if (x.a.cid === cid) try { x.ws.close(4002, 'replaced'); } catch (e) {} }
      else { const used = new Set(ph.map(x => x.a.slot)); for (let k = 1; k <= MAX_PLAYERS; k++) if (!used.has(k)) { slot = k; break; } }
      this.ctx.acceptWebSocket(server, ['phone']);
      if (!slot) { this.send(server, { type: 'full', max: MAX_PLAYERS }); server.close(4003, 'all player slots taken'); return new Response(null, { status: 101, webSocket: client }); }
      const a = { role: 'phone', slot, cid, name: this.uniq(cleanName(url.searchParams.get('name'), slot), slot), color: COLORS[slot - 1], mic: 'off', lat: 0 };
      server.serializeAttachment(a);
      this.send(server, { type: 'hello', tv: !!this.tv(), slot, name: a.name, color: a.color });
      this.send(server, { type: 'voice', master: false, vol: 0 });
      this.notifyTv(); this.send(this.tv(), { type: 'guide-query' }); this.send(this.tv(), { type: 'q-get', p: slot });
    } else return new Response('role required', { status: 400 });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string') return;   // voice-through-TV removed: binary audio is dropped
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'ping') return this.send(ws, { type: 'pong', id: m.id, server: Date.now() });
    const a = ws.deserializeAttachment() || {};
    if (a.role === 'phone') {
      if (m.type === 'pitch') return this.send(this.tv(), { type: 'pitch', p: a.slot, f: +m.f || 0, c: +m.c || 0, rms: +m.rms || 0, lat: a.lat || 0, seq: m.seq });
      if (m.type === 'search') return this.send(this.tv(), { type: 'search', q: String(m.q || '').slice(0, 60), src: m.src === 'voice' ? 'voice' : 'phone', final: !!m.final, p: a.slot });
      if (m.type === 'guide') return this.send(this.tv(), { type: 'guide', level: String(m.level || ''), from: 'phone', p: a.slot });
      if (m.type === 'voice') return;
      if (m.type === 'q-get') return this.send(this.tv(), { type: 'q-get', p: a.slot });
      if (m.type === 'q-add' || m.type === 'q-del') {   // phone song queue: the TV owns the queue; this relay only vets and rate-limits (1 per 2 s, burst 3, per phone slot)
        if (!this.qb) this.qb = new Map();
        const t = Date.now(); let b = this.qb.get(a.slot); if (!b) { b = { tok: 3, at: t }; this.qb.set(a.slot, b); }
        b.tok = Math.min(3, b.tok + (t - b.at) / 2000); b.at = t;
        if (b.tok < 1) return this.send(ws, { type: 'qres', ok: false, act: 'rate', id: String(m.id || '').slice(0, 80) });
        if (m.type === 'q-add') { const id = String(m.id || ''); if (!/^[a-z0-9-]{1,80}$/.test(id)) return; b.tok -= 1; return this.send(this.tv(), { type: 'q-add', p: a.slot, id, mode: m.mode === 'play' ? 'play' : 'queue' }); }
        const qid = Math.round(+m.qid); if (!Number.isInteger(qid) || qid < 1) return; b.tok -= 1; return this.send(this.tv(), { type: 'q-del', p: a.slot, qid });
      }
      if (m.type === 'vdelay') return this.send(this.tv(), { type: 'vdelay', p: a.slot, ms: Math.round(+m.ms || 0) });
      if (m.type === 'name') { a.name = this.uniq(cleanName(m.name, a.slot), a.slot); ws.serializeAttachment(a); return this.notifyTv(); }
      if (m.type === 'status') {
        const mic = String(m.mic || 'off').slice(0, 12), lat = m.lat != null ? +m.lat || 0 : a.lat;
        const changed = mic !== a.mic || Math.abs(lat - (a.lat || 0)) > 2; a.mic = mic; a.lat = lat; ws.serializeAttachment(a);
        if (changed) this.notifyTv(); return;
      }
      return;
    }
    if (a.role === 'tv') {
      if (m.type === 'perf') return;
      if (m.type === 'sync' && m.sync && typeof m.sync === 'object') { const s = JSON.stringify(m.sync); if (s.length < 20000) await this.ctx.storage.put('sync', m.sync); return; }
      if (m.type === 'voice') return this.toPhones({ type: 'voice', master: false, vol: 0 });
      if (m.type === 'state') await this.track(ws, m);
      if (m.type === 'online') await this.onlineSeen(m);
      if (m.type === 'online') { const o = { type: 'online', on: !!m.on, me: m.me, opp: m.opp }; const t = JSON.stringify(o); if (t.length < 600) this.toPhones(o); return; }   // online 1v1 strip on the phones
      if (['clock', 'state', 'feedback', 'guide', 'mode', 'searchres', 'queue', 'qres'].includes(m.type)) {
        if (m.state === 'results' && m.web) { const { web, ...rest } = m; m = rest; }
        if (m.to) { const p = this.phones().find(x => x.a.slot === +m.to); return p && this.send(p.ws, m); }
        return this.toPhones(m);
      }
    }
  }
  // Which online match this screen is singing in (only written when it changes), so a stand-in round never reaches the boards
  async onlineSeen(m) {
    const id = /^[a-z2-9]{12}$/.test(String(m.match || '')) ? m.match : null;
    if (m.on && id) { if (!this.omOn || !this.om || this.om.id !== id) { this.om = { id, at: Date.now() }; await this.ctx.storage.put('om', this.om); } this.omOn = true; }
    else if (!m.on) this.omOn = false;
  }
  async ghostPlay(play) {
    const om = this.om || await this.ctx.storage.get('om');
    if (!om || om.at < play.at - 30e3) return false;
    const r = await this.env.MATCH.get(this.env.MATCH.idFromName(om.id)).fetch('https://m/isghost').then(x => x.json()).catch(() => ({ g: false }));
    return !!r.g;
  }
  // Leaderboard: a play starts with state "playing" (+song); its first "results" message is submitted once.
  async track(ws, m) {
    if (m.state === 'playing' && m.song && m.players) await this.ctx.storage.put('play', { song: String(m.song), at: Date.now() });
    else if (m.state === 'home') await this.ctx.storage.delete('play');
    else if (m.state === 'results' && m.web && Array.isArray(m.web.rows)) {
      const play = await this.ctx.storage.get('play'); await this.ctx.storage.delete('play');
      const song = SONGS[play && play.song];
      if (!play || !song || play.song !== m.web.song) return;
      const elapsed = (Date.now() - play.at) / 1000, need = this.env.TEST_FAST === '1' ? 0 : Math.min(60, 0.6 * (song.d || 60));
      if (elapsed < need) return this.send(ws, { type: 'web-hs', ok: false, reason: 'short' });
      const kind = ['sing', 'beat', 'duet'].includes(m.web.kind) ? m.web.kind : 'sing';
      const rows = m.web.rows.slice(0, 5).map((r, i) => ({ name: badName(r.name) ? 'Singer ' + (i + 1) : cleanName(r.name, i + 1), score: Math.max(0, Math.min(100, Math.round(+r.score || 0))) }));
      if (!rows.length) return;   // v13.13: late joiners are not submitted; nothing left to submit
      if (this.env.MATCH && await this.ghostPlay(play)) return;   // online round vs a stand-in: not a leaderboard result
      const b = this.env.BOARD.get(this.env.BOARD.idFromName('global'));
      const res = await b.fetch('https://b/submit', { method: 'POST', body: JSON.stringify({ song: play.song, kind, rows, room: this.ctx.id.toString().slice(0, 12) }) }).then(r => r.json()).catch(() => null);
      if (res) { this.send(ws, { type: 'web-hs', ok: true, song: play.song, title: song.t, kind, ...res }); this.toPhones({ type: 'web-hs', ok: true, song: play.song, title: song.t, kind, ...res }); }
    }
  }
  async webSocketClose(ws, code) {
    const a = ws.deserializeAttachment() || {};
    try { ws.close(1000); } catch (e) {}
    if (a.role === 'tv') { if (this.tvWs === ws) this.tvWs = null; if (!this.tv()) this.toPhones({ type: 'state', state: 'tv-offline' }); }
    else if (a.role === 'phone') this.notifyTv();
  }
  async webSocketError(ws) { return this.webSocketClose(ws, 1011); }
}
