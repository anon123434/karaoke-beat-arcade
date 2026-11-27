// Global leaderboard + shared state (favorites, Record-map custom charts, invite-code throttle). SQLite-backed DO.
import { DurableObject } from 'cloudflare:workers';
import SONGS from './songs-meta.json';
import { avatarOf } from './online-config.js';
const nkey = n => String(n).toLowerCase().replace(/\s+/g, ' ').trim();
export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env); this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS scores (id INTEGER PRIMARY KEY, name TEXT, nkey TEXT, song TEXT, kind TEXT, score INTEGER, at INTEGER, room TEXT);
      CREATE INDEX IF NOT EXISTS s_song ON scores(song, kind, score DESC);
      CREATE INDEX IF NOT EXISTS s_name ON scores(nkey);
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS fails (ip TEXT, at INTEGER);
      CREATE TABLE IF NOT EXISTS duels (id INTEGER PRIMARY KEY, match TEXT UNIQUE, song TEXT, a TEXT, ak TEXT, sa INTEGER, b TEXT, bk TEXT, sb INTEGER, wk TEXT, forfeit INTEGER, at INTEGER);
      CREATE INDEX IF NOT EXISTS d_a ON duels(ak); CREATE INDEX IF NOT EXISTS d_b ON duels(bk);
      CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, at INTEGER, reporter TEXT, target TEXT, match TEXT, reason TEXT, ip TEXT);`);
  }
  rows(q, ...a) { return this.sql.exec(q, ...a).toArray(); }
  top(song, kind, n = 10) {
    return this.rows(`SELECT name, MAX(score) AS score, MIN(at) AS at FROM (SELECT name, nkey, score, at FROM scores WHERE song=? AND kind=?) GROUP BY nkey ORDER BY score DESC, at ASC LIMIT ?`, song, kind, n);
  }
  overall(n = 20) {
    return this.rows(`SELECT name, SUM(best) AS total, COUNT(*) AS songs, MAX(best) AS best FROM (SELECT nkey, MAX(name) AS name, song, kind, MAX(score) AS best FROM scores GROUP BY nkey, song, kind) GROUP BY nkey ORDER BY total DESC LIMIT ?`, n);
  }
  record(k) {   // online W/L/D for one name key
    const r = this.rows(`SELECT SUM(CASE WHEN wk=? THEN 1 ELSE 0 END) w, SUM(CASE WHEN wk IS NOT NULL AND wk!=? THEN 1 ELSE 0 END) l, SUM(CASE WHEN wk IS NULL THEN 1 ELSE 0 END) d FROM duels WHERE ak=? OR bk=?`, k, k, k, k)[0];
    return { w: r.w || 0, l: r.l || 0, d: r.d || 0 };
  }
  topAll(kind, n) {   // per-song top-n (best per name), one query for the song-select panel snapshot
    const out = {};
    for (const r of this.rows(`SELECT song, name, score FROM (SELECT song, name, score, ROW_NUMBER() OVER (PARTITION BY song ORDER BY score DESC, at ASC) rn FROM (SELECT song, MAX(name) name, MAX(score) score, MIN(at) at FROM scores WHERE kind=? GROUP BY song, nkey)) WHERE rn<=? ORDER BY song, rn`, kind, n))
      (out[r.song] = out[r.song] || []).push([r.name, r.score, avatarOf(r.name)]);
    return out;
  }
  async fetch(req) {
    const u = new URL(req.url), p = u.pathname, J = o => Response.json(o, { headers: { 'Cache-Control': 'no-store' } });
    if (p === '/submit' && req.method === 'POST') {
      const b = await req.json(), now = Date.now(), out = [];
      for (const r of b.rows) {
        const k = nkey(r.name);
        const prev = this.rows('SELECT MAX(score) AS s FROM scores WHERE song=? AND kind=? AND nkey=?', b.song, b.kind, k)[0].s;
        const songBest = this.rows('SELECT MAX(score) AS s FROM scores WHERE song=? AND kind=?', b.song, b.kind)[0].s;
        this.sql.exec('INSERT INTO scores (name, nkey, song, kind, score, at, room) VALUES (?,?,?,?,?,?,?)', r.name, k, b.song, b.kind, r.score, now, b.room || '');
        const rank = this.rows('SELECT COUNT(*) AS c FROM (SELECT nkey, MAX(score) AS s FROM scores WHERE song=? AND kind=? GROUP BY nkey) WHERE s > ?', b.song, b.kind, r.score)[0].c + 1;
        out.push({ name: r.name, score: r.score, prevBest: prev, personalBest: prev == null || r.score > prev, songRecord: songBest == null || r.score > songBest, rank });
      }
      return J({ results: out, top: this.top(b.song, b.kind, 5) });
    }
    if (p === '/api/lb/song') { const id = u.searchParams.get('id') || '', kind = u.searchParams.get('kind') || 'sing'; return J({ song: id, title: SONGS[id]?.t || id, kind, top: this.top(id, kind, 10) }); }
    if (p === '/api/lb/overall') {
      const recent = this.rows('SELECT name, song, kind, score, at FROM scores ORDER BY at DESC LIMIT 12').map(r => ({ ...r, title: SONGS[r.song]?.t || r.song }));
      const hot = this.rows('SELECT song, kind, MAX(score) AS score, COUNT(*) AS plays FROM scores GROUP BY song, kind ORDER BY plays DESC LIMIT 30').map(r => ({ ...r, title: SONGS[r.song]?.t || r.song, artist: SONGS[r.song]?.a || '', leader: this.top(r.song, r.kind, 1)[0]?.name || '' }));
      return J({ overall: this.overall(20), recent, songs: hot });
    }
    if (p === '/api/lb/top') { const kind = ['sing', 'beat', 'duet'].includes(u.searchParams.get('kind')) ? u.searchParams.get('kind') : 'sing'; return J({ kind, n: 5, songs: this.topAll(kind, 5), at: Date.now() }); }
    if (p === '/api/lb/mine') {   // best + world rank per song for up to 4 names
      const kind = ['sing', 'beat', 'duet'].includes(u.searchParams.get('kind')) ? u.searchParams.get('kind') : 'sing', res = {};
      for (const name of String(u.searchParams.get('names') || '').split('|').slice(0, 4).filter(Boolean)) {
        const k = nkey(name), mine = {};
        for (const r of this.rows(`WITH best AS (SELECT song, nkey, MAX(score) s FROM scores WHERE kind=? GROUP BY song, nkey) SELECT b.song, b.s, (SELECT COUNT(*) FROM best c WHERE c.song=b.song AND c.s>b.s)+1 rank FROM best b WHERE b.nkey=?`, kind, k)) mine[r.song] = [r.s, r.rank];
        res[name] = { av: avatarOf(name), songs: mine };
      }
      return J({ kind, players: res });
    }
    if (p === '/online/result' && req.method === 'POST') {
      const b = await req.json(), ak = nkey(b.a.name), bk = nkey(b.b.name), wk = b.winner ? nkey(b.winner) : null;
      try { this.sql.exec('INSERT INTO duels (match, song, a, ak, sa, b, bk, sb, wk, forfeit, at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', b.match, b.song, b.a.name, ak, b.a.score, b.b.name, bk, b.b.score, wk, b.forfeit ? 1 : 0, Date.now()); } catch (e) {}
      // per-song scores reach the normal Sing board through each screen's own room (Room.track); duels only stores the 1v1 outcome
      const h = this.rows('SELECT SUM(CASE WHEN wk=? THEN 1 ELSE 0 END) aw, SUM(CASE WHEN wk=? THEN 1 ELSE 0 END) bw, SUM(CASE WHEN wk IS NULL THEN 1 ELSE 0 END) d FROM duels WHERE (ak=? AND bk=?) OR (ak=? AND bk=?)', ak, bk, ak, bk, bk, ak)[0];
      const rank = (k, sc) => sc == null ? null : this.rows('SELECT COUNT(*) c FROM (SELECT nkey, MAX(score) s FROM scores WHERE song=? AND kind=? GROUP BY nkey) WHERE s > ?', b.song, 'sing', sc)[0].c + 1;
      return J({ h2h: { a: h.aw || 0, b: h.bw || 0, d: h.d || 0 }, a: { ...this.record(ak), rank: rank(ak, b.a.score) }, b: { ...this.record(bk), rank: rank(bk, b.b.score) } });
    }
    if (p === '/api/online/record') return J(this.record(nkey(u.searchParams.get('name') || '')));
    if (p === '/api/lb/online') {
      const top = this.rows(`SELECT name, k, SUM(w) w, SUM(l) l, SUM(d) d FROM (SELECT a name, ak k, CASE WHEN wk=ak THEN 1 ELSE 0 END w, CASE WHEN wk IS NOT NULL AND wk!=ak THEN 1 ELSE 0 END l, CASE WHEN wk IS NULL THEN 1 ELSE 0 END d FROM duels UNION ALL SELECT b, bk, CASE WHEN wk=bk THEN 1 ELSE 0 END, CASE WHEN wk IS NOT NULL AND wk!=bk THEN 1 ELSE 0 END, CASE WHEN wk IS NULL THEN 1 ELSE 0 END FROM duels) GROUP BY k ORDER BY w DESC, l ASC LIMIT 20`).map(r => ({ name: r.name, w: r.w, l: r.l, d: r.d }));
      const recent = this.rows('SELECT a, sa, b, sb, wk, ak, bk, forfeit, song, at FROM duels ORDER BY at DESC LIMIT 12').map(r => ({ a: r.a, sa: r.sa, b: r.b, sb: r.sb, winner: r.wk === r.ak ? r.a : r.wk === r.bk ? r.b : null, forfeit: !!r.forfeit, title: SONGS[r.song]?.t || r.song, at: r.at }));
      return J({ top, recent });
    }
    if (p === '/online/report' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const n = this.rows('SELECT COUNT(*) c FROM reports WHERE ip=? AND at>?', String(b.ip || ''), Date.now() - 3600e3)[0].c;
      if (n >= 10) return J({ ok: false });
      this.sql.exec('INSERT INTO reports (at, reporter, target, match, reason, ip) VALUES (?,?,?,?,?,?)', Date.now(), String(b.reporter || '').slice(0, 20), String(b.target || '').slice(0, 20), String(b.match || '').slice(0, 30), String(b.reason || '').slice(0, 60), String(b.ip || '').slice(0, 60));
      return J({ ok: true });
    }
    if (p === '/admin/purge-test' && req.method === 'POST') {   // removes release-test rows (names starting "QA ") from scores and duels
      const a = this.rows("SELECT COUNT(*) c FROM scores WHERE nkey LIKE 'qa %'")[0].c, b = this.rows("SELECT COUNT(*) c FROM duels WHERE ak LIKE 'qa %' OR bk LIKE 'qa %'")[0].c;
      this.sql.exec("DELETE FROM scores WHERE nkey LIKE 'qa %'"); this.sql.exec("DELETE FROM duels WHERE ak LIKE 'qa %' OR bk LIKE 'qa %'"); this.sql.exec("DELETE FROM reports WHERE reporter LIKE 'QA %'");
      return J({ ok: true, scores: a, duels: b });
    }
    if (p === '/online/reports') return J({ reports: this.rows('SELECT at, reporter, target, match, reason FROM reports ORDER BY at DESC LIMIT 100') });
    if (p === '/fails') { const n = this.rows('SELECT COUNT(*) AS c FROM fails WHERE ip=? AND at>?', u.searchParams.get('ip'), Date.now() - 3600e3)[0].c; return J({ n }); }
    if (p === '/fail') { this.sql.exec('DELETE FROM fails WHERE at<?', Date.now() - 3600e3); this.sql.exec('INSERT INTO fails VALUES (?,?)', u.searchParams.get('ip'), Date.now()); return J({ ok: true }); }
    if (p === '/custom') { const r = this.rows('SELECT v FROM kv WHERE k=?', 'custom:' + u.searchParams.get('id'))[0]; return J({ custom: r ? JSON.parse(r.v) : null }); }
    if (p === '/api/favorites') {
      const load = () => { const r = this.rows('SELECT v FROM kv WHERE k=?', 'favs')[0]; return r ? JSON.parse(r.v) : []; };
      if (req.method === 'GET') return J({ ids: load() });
      const b = await req.json().catch(() => ({})), id = String(b.id || '');
      if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id) || !SONGS[id]) return Response.json({ error: 'bad id' }, { status: 400 });
      let ids = load().filter(x => x !== id); if (b.on) ids.unshift(id);
      this.sql.exec('INSERT OR REPLACE INTO kv VALUES (?,?)', 'favs', JSON.stringify(ids)); return J({ ids });
    }
    if (p === '/api/custom-chart' && req.method === 'POST') {
      let b; try { b = await req.json(); } catch (e) { return Response.json({ error: 'bad json' }, { status: 400 }); }
      const id = String(b && b.id || '');
      if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id) || !SONGS[id]) return Response.json({ error: 'unknown song' }, { status: 400 });
      if (!Array.isArray(b.ev) || b.ev.length > 20000) return Response.json({ error: 'bad notes' }, { status: 400 });
      const ev = b.ev.map(e => [Math.round(+e[0] * 1000) / 1000, e[1] | 0, Math.max(0, Math.round((+e[2] || 0) * 1000) / 1000)])
        .filter(e => isFinite(e[0]) && e[0] >= 0 && e[1] >= 0 && e[1] <= 9).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      const sections = (Array.isArray(b.sections) ? b.sections : []).slice(0, 200).map(r => [+r[0], +r[1]]).filter(r => isFinite(r[0]) && isFinite(r[1]) && r[1] > r[0]);
      const prevRow = this.rows('SELECT v FROM kv WHERE k=?', 'custom:' + id)[0], prev = prevRow ? JSON.parse(prevRow.v) : null;
      if (prev) this.sql.exec('INSERT OR REPLACE INTO kv VALUES (?,?)', `customv:${id}:${prev.version || 0}`, prevRow.v);
      const custom = { v: 1, version: ((prev && prev.version) || 0) + 1, saved: new Date().toISOString(), ev, sections, merge: b.merge !== false, src: 'record-map' };
      this.sql.exec('INSERT OR REPLACE INTO kv VALUES (?,?)', 'custom:' + id, JSON.stringify(custom));
      this.sql.exec("DELETE FROM kv WHERE k LIKE ? AND k NOT IN (SELECT k FROM kv WHERE k LIKE ? ORDER BY rowid DESC LIMIT 20)", `customv:${id}:%`, `customv:${id}:%`);
      return J({ ok: true, version: custom.version, custom });
    }
    return Response.json({ error: 'unknown' }, { status: 404 });
  }
}
