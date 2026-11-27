// Online 1v1 lobby: ONE global instance. Open challenges + quick-match tickets, atomic pairing, daily cap, rate limits.
// Screens hold a hibernatable WebSocket; the list is pushed only when it changes.
import { DurableObject } from 'cloudflare:workers';
import SONGS from './songs-meta.json';
import { ghostsOn, ghostDelay, makeGhost } from './ghost.js';
import PROF from './song-profiles.json';
import { QUICK_MATCH_SONGS, DAILY_MATCH_CAP, CHALLENGE_TTL_MS, BEAT_TIMEOUT_MS, LIMITS, cleanOnlineName, avatarOf, dayKey, rid, nkey } from './online-config.js';

// Spin random: every singable song (has pitch notes), [id, title, artist]
const SPIN = Object.keys(PROF).filter(id => SONGS[id] && id !== 'calibration').map(id => [id, SONGS[id].t, SONGS[id].a]);

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.env = env; this.sql = ctx.storage.sql; this.hits = new Map();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ch (id TEXT PRIMARY KEY, cid TEXT, name TEXT, av INTEGER, song TEXT, quick INTEGER, at INTEGER, beat INTEGER);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);`);
    try { this.sql.exec('ALTER TABLE ch ADD COLUMN gat INTEGER'); } catch (e) {}   // when a stand-in opponent takes this ticket (0 = never)
  }
  rows(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  limited(kind, key) {
    const [n, win] = LIMITS[kind], k = kind + ':' + key, now = Date.now();
    const a = (this.hits.get(k) || []).filter(t => now - t < win);
    if (a.length >= n) { this.hits.set(k, a); return true; }
    a.push(now); this.hits.set(k, a); if (this.hits.size > 5000) this.hits.clear(); return false;
  }
  banned(name) { return String(this.env.ONLINE_BANS || '').split(',').map(nkey).filter(Boolean).includes(nkey(name)); }
  count(day = dayKey(), pre = 'day:') { const r = this.rows('SELECT v FROM kv WHERE k=?', pre + day)[0]; return r ? +r.v : 0; }
  bump(pre = 'day:') { const d = dayKey(), n = this.count(d, pre) + 1; this.sql.exec('INSERT OR REPLACE INTO kv VALUES (?,?)', pre + d, String(n)); return n; }
  cap() { return +(this.env.ONLINE_DAILY_CAP || DAILY_MATCH_CAP); }
  resting() { return this.count() >= this.cap(); }
  socks() { return this.ctx.getWebSockets().filter(w => w.readyState === 1); }
  sockOf(cid) { return this.socks().filter(w => (w.deserializeAttachment() || {}).cid === cid); }
  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }
  view() {
    const items = this.rows('SELECT id, name, av, song, quick, at FROM ch ORDER BY at DESC LIMIT 40').map(r => ({ id: r.id, name: r.name, av: r.av, song: r.song, title: SONGS[r.song]?.t || r.song, artist: SONGS[r.song]?.a || '', d: Math.round(SONGS[r.song]?.d || 0), quick: !!r.quick, at: r.at, need: 1, max: 2 }));
    const cids = new Set(this.socks().map(w => (w.deserializeAttachment() || {}).cid));
    return { type: 'list', items, online: cids.size, resting: this.resting() };
  }
  broadcast() { const s = JSON.stringify(this.view()); for (const w of this.socks()) try { w.send(s); } catch (e) {} }
  async arm() {   // 5 s housekeeping, or sooner when a ticket is due for a stand-in opponent
    if (!this.rows('SELECT COUNT(*) c FROM ch')[0].c) return;
    const g = this.rows('SELECT MIN(gat) g FROM ch WHERE gat > 0')[0].g, next = Math.min(Date.now() + 5000, g || Infinity), cur = await this.ctx.storage.getAlarm();
    if (!cur || next < cur - 50) await this.ctx.storage.setAlarm(next);
  }
  async alarm() {
    const now = Date.now(), dead = this.rows('SELECT id, cid FROM ch WHERE beat < ? OR at < ?', now - BEAT_TIMEOUT_MS, now - CHALLENGE_TTL_MS);
    for (const d of dead) { this.sql.exec('DELETE FROM ch WHERE id=?', d.id); for (const w of this.sockOf(d.cid)) this.send(w, { type: 'expired', id: d.id }); }
    if (dead.length) this.broadcast();
    // nobody else showed up in time: pair the waiting player with a stand-in (a real player who joins first always wins the ticket)
    if (ghostsOn(this.env) && !this.resting()) for (const c of this.rows('SELECT * FROM ch WHERE gat > 0 AND gat <= ? ORDER BY at ASC', now + 30)) await this.pairGhost(c);
    await this.arm();
  }
  async pairGhost(c) {
    const hosts = this.sockOf(c.cid);
    if (!hosts.length) { this.sql.exec('DELETE FROM ch WHERE id=?', c.id); return this.broadcast(); }
    const avoid = [c.name, ...this.rows('SELECT name FROM ch').map(r => r.name)], g = makeGhost(avoid);
    this.sql.exec('DELETE FROM ch WHERE id=?', c.id); this.bump(); this.bump('ghost:');
    const match = rid(12), players = [{ cid: c.cid, name: c.name, av: c.av }, { cid: rid(16), name: g.name, av: g.av, ghost: true }];
    if (players[1].av === players[0].av) players[1].av = (players[1].av + 1) % 8;
    const r = await this.env.MATCH.get(this.env.MATCH.idFromName(match)).fetch('https://m/init', { method: 'POST', body: JSON.stringify({ id: match, song: c.song, quick: !!c.quick, players, ghost: g }) }).catch(() => null);
    if (!r || !r.ok) { this.sql.exec('INSERT OR REPLACE INTO ch (id, cid, name, av, song, quick, at, beat, gat) VALUES (?,?,?,?,?,?,?,?,?)', c.id, c.cid, c.name, c.av, c.song, c.quick, c.at, c.beat, 0); return; }
    const info = { type: 'matched', match, song: c.song, title: SONGS[c.song].t, artist: SONGS[c.song].a, d: Math.round(SONGS[c.song].d) };
    for (const h of hosts) this.send(h, { ...info, role: 'host', opp: { name: players[1].name, av: players[1].av }, you: players[0] });
    this.broadcast();
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/count' && req.method === 'POST') {   // a rematch asks for one more match today
      if (this.resting()) return Response.json({ ok: false }); this.bump(); return Response.json({ ok: true });
    }
    if (url.pathname === '/state') return Response.json({ ...this.view(), today: this.count(), cap: this.cap(), ghostsToday: this.count(dayKey(), 'ghost:'), ghosts: ghostsOn(this.env) });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('ws only', { status: 426 });
    const ip = req.headers.get('cf-connecting-ip') || '?';
    if (this.limited('connect', ip)) return new Response('slow down', { status: 429 });
    const cid = (url.searchParams.get('cid') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
    if (!cid) return new Response('cid required', { status: 400 });
    const name = cleanOnlineName(url.searchParams.get('name'));
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server); server.serializeAttachment({ cid, name, av: avatarOf(name), ip });
    this.send(server, { type: 'welcome', you: { name, av: avatarOf(name), banned: this.banned(name) }, quick: QUICK_MATCH_SONGS.length, spin: SPIN });
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 2000) return;
    let m; try { m = JSON.parse(data); } catch { return; }
    const a = ws.deserializeAttachment() || {}, now = Date.now(), err = msg => this.send(ws, { type: 'error', msg });
    if (m.type === 'beat') { this.sql.exec('UPDATE ch SET beat=? WHERE cid=?', now, a.cid); return; }
    if (m.type === 'list') return this.send(ws, this.view());
    if (m.type === 'cancel') { this.sql.exec('DELETE FROM ch WHERE cid=?', a.cid); this.send(ws, { type: 'cancelled' }); return this.broadcast(); }
    if (this.banned(a.name)) return err('Online play is off for this name.');
    if (m.type === 'create' || m.type === 'quick') {
      if (this.resting()) return err('Online is resting for today. Play Here still works!');
      const quick = m.type === 'quick';
      if (quick) {   // join the longest-waiting game from another home, else post a quick ticket
        if (this.limited('quick', a.cid) || this.limited('quick', a.ip)) return err('Too many tries. Wait a bit.');
        const open = this.rows('SELECT * FROM ch WHERE cid != ? ORDER BY at ASC LIMIT 1', a.cid)[0];
        if (open) return this.pair(open, ws, a);
      } else if (this.limited('create', a.cid) || this.limited('createIp', a.ip)) return err('That\u2019s a lot of challenges. Wait a bit.');
      let song = String(m.song || '');
      if (quick) { const pool = QUICK_MATCH_SONGS.filter(id => SONGS[id]); song = pool[Math.floor(Math.random() * pool.length)]; }
      if (!SONGS[song]) return err('Pick a song first.');
      this.sql.exec('DELETE FROM ch WHERE cid=?', a.cid);   // one open challenge per player
      const id = rid(8);
      this.sql.exec('INSERT INTO ch (id, cid, name, av, song, quick, at, beat, gat) VALUES (?,?,?,?,?,?,?,?,?)', id, a.cid, a.name, a.av, song, quick ? 1 : 0, now, now, ghostsOn(this.env) && PROF[song] ? now + ghostDelay() : 0);
      this.send(ws, { type: 'created', id, song, title: SONGS[song].t, artist: SONGS[song].a, d: Math.round(SONGS[song].d), quick });
      await this.arm(); return this.broadcast();
    }
    if (m.type === 'join') {
      if (this.resting()) return err('Online is resting for today. Play Here still works!');
      if (this.limited('join', a.cid)) return err('Too many tries. Wait a bit.');
      const c = this.rows('SELECT * FROM ch WHERE id=?', String(m.id || ''))[0];
      if (!c) { this.send(ws, { type: 'taken' }); return this.send(ws, this.view()); }
      if (c.cid === a.cid) return err('That\u2019s your own challenge.');
      return this.pair(c, ws, a);
    }
  }
  async pair(c, ws, a) {
    const hosts = this.sockOf(c.cid);
    this.sql.exec('DELETE FROM ch WHERE id=?', c.id);
    if (!hosts.length) { this.send(ws, { type: 'taken' }); return this.broadcast(); }
    this.sql.exec('DELETE FROM ch WHERE cid=?', a.cid);
    this.bump();
    const match = rid(12), players = [{ cid: c.cid, name: c.name, av: c.av }, { cid: a.cid, name: a.name, av: a.av }];
    if (players[1].av === players[0].av) players[1].av = (players[1].av + 1) % 8;   // two different faces on the VS screen
    const r = await this.env.MATCH.get(this.env.MATCH.idFromName(match)).fetch('https://m/init', { method: 'POST', body: JSON.stringify({ id: match, song: c.song, quick: !!c.quick, players }) }).catch(() => null);
    if (!r || !r.ok) { this.send(ws, { type: 'error', msg: 'Couldn\u2019t start the game. Try again.' }); return this.broadcast(); }
    const info = { type: 'matched', match, song: c.song, title: SONGS[c.song].t, artist: SONGS[c.song].a, d: Math.round(SONGS[c.song].d) };
    const pub = p => ({ name: p.name, av: p.av });   // no client ids to the other side
    for (const h of hosts) this.send(h, { ...info, role: 'host', opp: pub(players[1]), you: players[0] });
    this.send(ws, { ...info, role: 'guest', opp: pub(players[0]), you: players[1] });
    this.broadcast();
  }
  async webSocketClose(ws) {
    const a = ws.deserializeAttachment() || {};
    try { ws.close(1000); } catch (e) {}
    if (a.cid && !this.sockOf(a.cid).length) this.sql.exec('DELETE FROM ch WHERE cid=?', a.cid);
    this.broadcast();
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }
}
