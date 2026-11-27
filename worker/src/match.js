// Online 1v1 match: one instance per game, two screens. Clock sync (ping/pong), ready check, shared start time,
// live score relay, final results + winner, 15 s reconnect grace (else forfeit), rematch.
import { DurableObject } from 'cloudflare:workers';
import SONGS from './songs-meta.json';
import { READY_TIMEOUT_MS, RECONNECT_GRACE_MS } from './online-config.js';
const COUNTDOWN_MS = 5000;

export class Match extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.env = env; this.m = null; }
  async load() { if (!this.m) this.m = (await this.ctx.storage.get('m')) || null; return this.m; }
  async save() { await this.ctx.storage.put('m', this.m); await this.schedule(); }
  socks() { return this.ctx.getWebSockets().filter(w => w.readyState === 1); }
  sockOf(cid) { return this.socks().filter(w => (w.deserializeAttachment() || {}).cid === cid); }
  // Never send a player the opponent's client id (it would let them connect as you and forfeit you): it is replaced by "opp".
  mask(ws, s) { const me = (ws.deserializeAttachment() || {}).cid; if (!this.m || !me) return s; for (const p of this.m.players) if (p.cid !== me && p.cid) s = s.split(p.cid).join('opp'); return s; }
  send(ws, o) { try { ws.send(this.mask(ws, JSON.stringify(o))); } catch (e) {} }
  to(cid, o) { for (const w of this.sockOf(cid)) this.send(w, o); }
  all(o) { const s = JSON.stringify(o); for (const w of this.socks()) try { w.send(this.mask(w, s)); } catch (e) {} }
  other(cid) { return this.m.players.find(p => p.cid !== cid); }
  pub() { const m = this.m; return { type: 'match', id: m.id, song: m.song, title: SONGS[m.song]?.t, artist: SONGS[m.song]?.a, d: Math.round(SONGS[m.song]?.d || 0), state: m.state, round: m.round, t0: m.t0, players: m.players.map(p => ({ name: p.name, av: p.av, cid: p.cid, ready: !!m.ready[p.cid], gone: !!m.gone[p.cid] })), server: Date.now() }; }
  async schedule() {
    const m = this.m; if (!m) return; const t = [];
    if (m.state === 'ready') t.push(m.readyBy);
    for (const c in m.gone) if (m.gone[c] && !m.forfeit[c]) t.push(m.gone[c] + RECONNECT_GRACE_MS);
    if (m.state === 'playing') t.push(m.t0 + (SONGS[m.song]?.d || 300) * 1000 + 90e3);   // nobody reported: close it
    if (m.state === 'results' || m.state === 'cancelled') t.push(m.doneAt + 10 * 60e3);
    if (t.length) await this.ctx.storage.setAlarm(Math.min(...t)); else await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    const m = await this.load(); if (!m) return; const now = Date.now();
    if (m.state === 'ready' && now >= m.readyBy) return this.cancel('load');
    for (const c in m.gone) if (m.gone[c] && !m.forfeit[c] && now >= m.gone[c] + RECONNECT_GRACE_MS) {
      if (m.state === 'playing') { m.forfeit[c] = true; this.to(this.other(c).cid, { type: 'opp-forfeit' }); await this.maybeFinish(); }
      else if (m.state !== 'results' && m.state !== 'cancelled') return this.cancel('left');
    }
    if (m.state === 'playing' && now > m.t0 + (SONGS[m.song]?.d || 300) * 1000 + 90e3) { for (const p of m.players) if (!m.finals[p.cid]) m.forfeit[p.cid] = true; return this.maybeFinish(true); }
    if ((m.state === 'results' || m.state === 'cancelled') && now >= m.doneAt + 10 * 60e3) { for (const w of this.ctx.getWebSockets()) try { w.close(1000, 'done'); } catch (e) {} await this.ctx.storage.deleteAll(); this.m = null; return; }
    await this.save();
  }
  async cancel(reason) { const m = this.m; m.state = 'cancelled'; m.doneAt = Date.now(); this.all({ type: 'cancel', reason }); await this.save(); }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/init' && req.method === 'POST') {
      const b = await req.json();
      this.m = { id: b.id, song: b.song, quick: !!b.quick, players: b.players.slice(0, 2), state: 'ready', round: 1, ready: {}, finals: {}, gone: {}, forfeit: {}, live: {}, rematch: {}, created: Date.now(), readyBy: Date.now() + READY_TIMEOUT_MS, t0: 0 };
      await this.save(); return Response.json({ ok: true });
    }
    const m = await this.load();
    if (!m) return new Response('no match', { status: 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return Response.json(this.pub());
    const cid = (url.searchParams.get('cid') || '').slice(0, 40), me = m.players.find(p => p.cid === cid);
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    if (!me || m.forfeit[cid]) { this.send(server, { type: 'cancel', reason: me ? 'forfeit' : 'not-yours' }); server.close(4003, 'not in this match'); return new Response(null, { status: 101, webSocket: client }); }
    for (const w of this.sockOf(cid)) if (w !== server) try { w.close(4002, 'replaced'); } catch (e) {}
    server.serializeAttachment({ cid });
    if (m.gone[cid]) { delete m.gone[cid]; this.to(this.other(cid).cid, { type: 'opp-back' }); await this.save(); }
    this.send(server, { ...this.pub(), you: cid, opp: this.other(cid).name, oppLive: m.live[this.other(cid).cid] || null });
    if (m.state === 'results' && m.result) this.send(server, m.result);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 4000) return;
    let x; try { x = JSON.parse(data); } catch { return; }
    if (x.type === 'ping') return this.send(ws, { type: 'pong', id: x.id, server: Date.now() });
    const m = await this.load(); if (!m) return;
    const cid = (ws.deserializeAttachment() || {}).cid; if (!cid) return;
    const opp = this.other(cid);
    if (x.type === 'ready' && m.state === 'ready') {
      m.ready[cid] = true;
      if (m.players.every(p => m.ready[p.cid]) && m.players.every(p => this.sockOf(p.cid).length)) {
        m.state = 'playing'; m.t0 = Date.now() + COUNTDOWN_MS; m.finals = {}; m.live = {};
        this.all({ type: 'start', t0: m.t0, round: m.round, server: Date.now() });
      } else this.to(opp.cid, { type: 'opp-ready' });
      return this.save();
    }
    if (x.type === 'score' && m.state === 'playing') {
      const live = { score: Math.max(0, Math.min(100, Math.round(+x.score || 0))), combo: Math.min(9999, Math.max(0, +x.combo | 0)), t: +x.t || 0 };
      m.live[cid] = live; this.to(opp.cid, { type: 'opp', ...live }); return;   // live bars: no storage write
    }
    if (x.type === 'final' && m.state === 'playing' && !m.finals[cid]) {
      const d = SONGS[m.song]?.d || 60, need = this.env.TEST_FAST === '1' ? 0 : Math.min(60, 0.6 * d) * 1000;
      const ok = Date.now() - m.t0 >= need;
      m.finals[cid] = { score: ok ? Math.max(0, Math.min(100, Math.round(+x.score || 0))) : 0, combo: Math.min(9999, Math.max(0, +x.combo | 0)), acc: x.acc == null ? null : Math.max(0, Math.min(100, Math.round(+x.acc))), short: !ok };
      this.to(opp.cid, { type: 'opp-final', score: m.finals[cid].score });
      return this.maybeFinish();
    }
    if (x.type === 'leave') {
      if (m.state === 'playing' && Date.now() < m.t0) return this.cancel('left');   // still on the VS countdown: call it off
      if (m.state === 'playing') { m.forfeit[cid] = true; this.to(opp.cid, { type: 'opp-forfeit' }); try { ws.close(1000, 'left'); } catch (e) {} return this.maybeFinish(); }
      if (m.state === 'ready') return this.cancel('left');
      if (m.state === 'results') { this.to(opp.cid, { type: 'opp-left' }); try { ws.close(1000, 'left'); } catch (e) {} return; }
      return;
    }
    if (x.type === 'rematch' && m.state === 'results') {
      m.rematch[cid] = true;
      if (m.players.every(p => m.rematch[p.cid])) {
        const ok = await this.env.LOBBY.get(this.env.LOBBY.idFromName('global')).fetch('https://l/count', { method: 'POST' }).then(r => r.json()).catch(() => ({ ok: false }));
        if (!ok.ok) { this.all({ type: 'error', msg: 'Online is resting for today.' }); m.rematch = {}; return this.save(); }
        m.state = 'ready'; m.round++; m.ready = {}; m.finals = {}; m.forfeit = {}; m.gone = {}; m.live = {}; m.rematch = {}; m.result = null; m.readyBy = Date.now() + READY_TIMEOUT_MS;
        this.all({ ...this.pub(), type: 'rematch-go' });
      } else this.to(opp.cid, { type: 'opp-rematch' });
      return this.save();
    }
  }
  async maybeFinish(force) {
    const m = this.m; if (m.state !== 'playing') return this.save();
    const done = m.players.every(p => m.finals[p.cid] || m.forfeit[p.cid]);
    if (!done && !force) return this.save();
    const [A, B] = m.players, fa = m.finals[A.cid], fb = m.finals[B.cid];
    let winner = null, forfeit = false;
    if (m.forfeit[A.cid] && !m.forfeit[B.cid]) { winner = B.cid; forfeit = true; }
    else if (m.forfeit[B.cid] && !m.forfeit[A.cid]) { winner = A.cid; forfeit = true; }
    else if (fa && fb && fa.score !== fb.score) winner = fa.score > fb.score ? A.cid : B.cid;
    const row = p => ({ name: p.name, av: p.av, cid: p.cid, ...(m.finals[p.cid] || { score: null }), forfeit: !!m.forfeit[p.cid] });
    let rec = null;
    if (!(m.forfeit[A.cid] && m.forfeit[B.cid])) {
      rec = await this.env.BOARD.get(this.env.BOARD.idFromName('global')).fetch('https://b/online/result', { method: 'POST', body: JSON.stringify({ match: m.id + ':' + m.round, song: m.song, a: row(A), b: row(B), winner: winner ? m.players.find(p => p.cid === winner).name : null, forfeit }) }).then(r => r.json()).catch(() => null);
    }
    m.state = 'results'; m.doneAt = Date.now();
    m.result = { type: 'results', round: m.round, song: m.song, title: SONGS[m.song]?.t, players: [row(A), row(B)], winner, draw: !winner, forfeit, record: rec };
    this.all(m.result);
    return this.save();
  }
  async webSocketClose(ws) {
    const cid = (ws.deserializeAttachment() || {}).cid; try { ws.close(1000); } catch (e) {}
    const m = await this.load(); if (!m || !cid || this.sockOf(cid).length) return;
    if (m.state === 'playing' && !m.forfeit[cid] && !m.finals[cid]) { m.gone[cid] = Date.now(); this.to(this.other(cid).cid, { type: 'opp-gone', grace: RECONNECT_GRACE_MS }); return this.save(); }
    if (m.state === 'ready') { m.gone[cid] = Date.now(); this.to(this.other(cid).cid, { type: 'opp-gone', grace: RECONNECT_GRACE_MS }); return this.save(); }
    if (m.state === 'results') this.to(this.other(cid).cid, { type: 'opp-left' });
  }
  async webSocketError(ws) { return this.webSocketClose(ws); }
}
