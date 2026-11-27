// Karaoke Beat Arcade edge Worker:
//   /            -> redirect to /kba/
//   /kba/...    -> web build of the TV app (static assets + rooms + leaderboard), private (invite cookie / room code)
//   /karaoke    -> redirect to /kba/
//   anything else -> 404
// Secrets (wrangler secret put): INVITE_CODE, SECRET, RELAY_TOKEN (optional). See ../README.md.
import QRCode from 'qrcode';
import SONGS from './songs-meta.json';
import SIZES from './asset-sizes.json';
import { GATE_HTML, MOBILE_HTML, ABOUT_HTML } from './pages.js';
export { Room } from './room.js';
export { Board } from './board.js';
export { Lobby } from './lobby.js';
export { Match } from './match.js';

const BASE = '/kba';
const NOINDEX = 'noindex, nofollow, noarchive, nosnippet';
const ROOM_RE = /^[a-z2-9]{6}$/;
const enc = new TextEncoder();

async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  return btoa(String.fromCharCode(...s)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c])).slice(0, 32);
}
function cookies(req) { const o = {}; (req.headers.get('cookie') || '').split(/;\s*/).forEach(p => { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i)] = p.slice(i + 1); }); return o; }
async function access(req, env) {
  const c = cookies(req), out = { invite: false, room: null };
  if (c.ktv_inv && c.ktv_inv === await hmac(env.SECRET, 'inv:' + env.INVITE_CODE)) out.invite = true;
  if (c.ktv_ph) { const [room, sig] = c.ktv_ph.split('.'); if (ROOM_RE.test(room) && sig === await hmac(env.SECRET, 'ph:' + room)) out.room = room; }
  return out;
}
const isPhone = ua => /iPhone|iPod|Windows Phone|BlackBerry|IEMobile|Opera Mini/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua)) || /Mobile.*Firefox/i.test(ua);
const sec = h => { const r = new Headers(h); r.set('X-Robots-Tag', NOINDEX); r.set('Referrer-Policy', 'no-referrer'); r.set('X-Content-Type-Options', 'nosniff'); return r; };
const html = (body, status = 200, extra = {}) => new Response(body, { status, headers: sec({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra }) });
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: sec({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }) });
const redirect = (to, extra = {}) => new Response(null, { status: 302, headers: sec({ Location: to, 'Cache-Control': 'no-store', ...extra }) });
const NOT_FOUND_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Not found</title><style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#0a0a0a;color:#fafafa;font-family:system-ui,sans-serif;font-weight:700}h1{margin:0;font-size:clamp(40px,10vw,96px)}a{color:#bdbdbd;text-decoration:none;border-bottom:1px solid #3a3a3a;font-size:14px;letter-spacing:.06em}</style></head><body><h1>404</h1><a href="/kba/">Karaoke Beat Arcade</a></body></html>';
const notFound = () => new Response(NOT_FOUND_HTML, { status: 404, headers: sec({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }) });
const board = env => env.BOARD.get(env.BOARD.idFromName('global'));
const room = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));

async function asset(env, req, p, cacheCtl) {
  const u = new URL(req.url); u.pathname = p; u.search = '';
  const r = await env.ASSETS.fetch(new Request(u, { headers: req.headers, method: req.method === 'HEAD' ? 'HEAD' : 'GET' }));
  const h = sec(r.headers); if (cacheCtl) h.set('Cache-Control', cacheCtl);
  const range = req.headers.get('range'), size = +r.headers.get('content-length') || SIZES[p] || 0;
  const m = range && r.status === 200 && size ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {   // static assets ignore Range; Safari/TV media players need 206
    let start = m[1] ? +m[1] : Math.max(0, size - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    if (start >= size || start > end) { r.body && r.body.cancel(); h.set('Content-Range', `bytes */${size}`); return new Response(null, { status: 416, headers: h }); }
    h.set('Content-Range', `bytes ${start}-${end}/${size}`); h.set('Content-Length', String(end - start + 1)); h.set('Accept-Ranges', 'bytes');
    return new Response(slice(r.body, start, end + 1), { status: 206, headers: h });
  }
  h.set('Accept-Ranges', 'bytes');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

function slice(body, from, to) {
  let pos = 0; const reader = body.getReader();
  return new ReadableStream({
    async pull(ctl) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { ctl.close(); return; }
        const a = pos, b = pos + value.length; pos = b;
        if (b <= from) continue;
        if (a >= to) { reader.cancel(); ctl.close(); return; }
        ctl.enqueue(value.subarray(Math.max(0, from - a), Math.min(value.length, to - a)));
        if (b >= to) { reader.cancel(); ctl.close(); }
        return;
      }
    },
    cancel() { reader.cancel(); }
  });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), p = url.pathname;
    if (p === '/' || p === '/index.html') return redirect(BASE + '/');
    if (/^\/karaoke(\/.*)?$/i.test(p)) return redirect(BASE + '/');
    if (p === '/kba' || p.startsWith('/kba/')) return sing(req, env, ctx, url);
    if (p === '/favicon.ico') return env.ASSETS.fetch(new Request(new URL(BASE + '/tv/icon.png', url))).then(r => new Response(r.body, { status: r.status, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } }));
    if (p === '/robots.txt') return new Response('User-agent: *\nDisallow: /kba\nDisallow: /karaoke\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
    return notFound();
  }
};

async function sing(req, env, ctx, url) {
  const p = url.pathname, ua = req.headers.get('user-agent') || '';
  if (p === '/kba') return redirect(BASE + '/' + url.search);
  const sub = p.slice(BASE.length);   // starts with /
  if (/^\/web\/m\/[a-z0-9-]+\.webp$/.test(sub)) return asset(env, req, p, 'public, max-age=604800');   // art for the public phone page
  const acc = await access(req, env);

  // --- QR join: /kba/j/<room>  (room code authorizes the phone; no invite code) ---
  let m;
  if ((m = /^\/j\/([a-z2-9]{6})\/?$/.exec(sub))) {
    const loadInfo = async () => {
      const r = await room(env, m[1]).fetch(new Request('https://room/info', { method: 'GET' }));
      const text = await r.text();
      try { return JSON.parse(text); } catch (e) { throw new Error('info http ' + r.status + ' ' + text.slice(0, 80)); }
    };
    let info = null, infoErr = '';
    try { info = await loadInfo(); } catch (e) {
      infoErr = String(e && e.message || e);
      console.log('join info fail', m[1], infoErr);
      try { info = await loadInfo(); infoErr = ''; } catch (e2) { infoErr = String(e2 && e2.message || e2); console.log('join info retry fail', m[1], infoErr); }
    }
    const ok = info && (info.known || info.tv);
    console.log('join', m[1], ok ? 'ok' : 'unknown', 'tv=' + !!(info && info.tv), 'known=' + !!(info && info.known));
    if (!ok) {
      const msg = /free tier|allowed volume/i.test(infoErr)
        ? 'Cloud join is full for today. Use the TV\u2019s local QR on the same Wi\u2011Fi, or try again after 4 PM Pacific.'
        : 'This code is old. Scan the code on the TV again.';
      return html(MOBILE_HTML.replace('%%MSG%%', msg), 404);
    }
    return redirect(`${BASE}/phone/?s=${m[1]}`, { 'Set-Cookie': `ktv_ph=${m[1]}.${await hmac(env.SECRET, 'ph:' + m[1])}; Path=/kba; Max-Age=86400; Secure; HttpOnly; SameSite=Lax` });
  }
  // --- invite code ---
  if (sub === '/api/invite' && req.method === 'POST') {
    const ip = req.headers.get('cf-connecting-ip') || '?';
    const fails = await board(env).fetch('https://b/fails?ip=' + encodeURIComponent(ip)).then(r => r.json()).catch(() => ({ n: 0 }));
    if (fails.n >= 15) return json({ ok: false, msg: 'Too many tries. Wait an hour.' }, 429);
    let code = ''; try { code = String((await req.json()).code || '').replace(/\D/g, ''); } catch (e) {}
    if (code !== String(env.INVITE_CODE)) { ctx.waitUntil(board(env).fetch('https://b/fail?ip=' + encodeURIComponent(ip), { method: 'POST' })); await new Promise(r => setTimeout(r, 600)); return json({ ok: false, msg: 'Not quite. Try again.' }, 403); }
    return json({ ok: true }, 200, { 'Set-Cookie': `ktv_inv=${await hmac(env.SECRET, 'inv:' + env.INVITE_CODE)}; Path=/kba; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax` });
  }

  // Public disclaimer (linked from the code screen and the phone page; no invite needed)
  if (sub === '/about' || sub === '/about/' || sub === '/disclaimer' || sub === '/disclaimer/') return html(ABOUT_HTML);

  // phone-scope paths (QR joiners): phone page, shared libs, art, song.json for pitch notes, STT, ws, leaderboard
  const phoneOk = /^\/(phone\/.*|shared\/.*|web\/.*|tv\/img\/.*|songs\/[a-z0-9-]+\/(song\.json|art\.webp)|api\/stt|ws|api\/lb\/.*|leaderboard\/?)$/.test(sub.replace(/^\//, '/'));
  // Mac relay (TV host role) credential: its own Worker secret, independent of INVITE_CODE, so changing the invite never disconnects the Mac bridge.
  const relayOk = !!(env.RELAY_TOKEN && sub === '/ws' && url.searchParams.get('role') === 'tv' && cookies(req).ktv_inv === env.RELAY_TOKEN);
  // v13.16: the local relay may READ the world top lists (GET only, same edge cache) so the Samsung TV can show them; it can never write
  const relayRead = !!(env.RELAY_TOKEN && req.method === 'GET' && cookies(req).ktv_inv === env.RELAY_TOKEN && sub === '/api/lb/top');
  const allowed = acc.invite || relayOk || relayRead || (acc.room && phoneOk);
  if (!allowed) {
    if (sub.startsWith('/api/') || sub === '/ws') return json({ error: 'Ask the host for the invite code.' }, 401);
    if (isPhone(ua)) return html(MOBILE_HTML.replace('%%MSG%%', ''));
    if (sub === '/' ) return html(GATE_HTML);
    return redirect(BASE + '/');
  }

  // --- websocket relay ---
  if (sub === '/ws') {
    if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'websocket only' }, 426);
    const role = url.searchParams.get('role'), code = url.searchParams.get('s') || '';
    if (!ROOM_RE.test(code)) return json({ error: 'bad room' }, 400);
    if (role === 'tv' && !acc.invite && !relayOk) return json({ error: 'invite needed' }, 401);
    if (role === 'phone' && !acc.invite && acc.room !== code) return json({ error: 'scan the TV code again' }, 401);
    return room(env, code).fetch(req);
  }
  // --- API ---
  if (sub === '/api/session') {
    const code = url.searchParams.get('s') || '';
    if (!ROOM_RE.test(code)) return json({ error: 'bad room' }, 400);
    const info = await room(env, code).fetch('https://room/info').then(r => r.json()).catch(() => ({}));
    const phoneUrl = `https://${url.host}${BASE}/j/${code}`;
    const qrSvg = await QRCode.toString(phoneUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b0420', light: '#ffffff' } });
    return json({ code, phoneUrl, caUrl: '', qrSvg, caQrSvg: '', phone: info.phone || { connected: false, mic: 'off', lat: 0, players: [], certOk: true }, tvConnected: !!info.tv });
  }
  // --- online 1v1 + song-select leaderboard panel (flags default OFF: ONLINE_ENABLED / LB_PANEL_ENABLED = "1") ---
  const onlineOn = env.ONLINE_ENABLED === '1', panelOn = env.LB_PANEL_ENABLED === '1';
  if (sub === '/api/flags') return json({ online: onlineOn && acc.invite, lbpanel: panelOn });
  if (sub === '/ws/lobby' || (m = /^\/ws\/match\/([a-z2-9]{12})$/.exec(sub))) {
    if (!onlineOn) return json({ error: 'online is off' }, 404);
    if (!acc.invite) return json({ error: 'invite needed' }, 401);
    if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'websocket only' }, 426);
    if (sub === '/ws/lobby') return env.LOBBY.get(env.LOBBY.idFromName('global')).fetch(req);
    return env.MATCH.get(env.MATCH.idFromName(m[1])).fetch(req);
  }
  if (sub === '/api/online/report' && req.method === 'POST') {
    if (!onlineOn || !acc.invite) return json({ error: 'off' }, 404);
    const b = await req.json().catch(() => ({}));
    return board(env).fetch('https://b/online/report', { method: 'POST', body: JSON.stringify({ ...b, ip: req.headers.get('cf-connecting-ip') || '' }) });
  }
  if (sub === '/api/admin/purge-test' && req.method === 'POST') {   // release-test cleanup; needs the Worker SECRET in x-admin
    if (!env.SECRET || req.headers.get('x-admin') !== env.SECRET) return json({ error: 'no' }, 403);
    return board(env).fetch('https://b/admin/purge-test', { method: 'POST' });
  }
  if (sub === '/api/admin/online') {   // reports + today's match count, same SECRET
    if (!env.SECRET || req.headers.get('x-admin') !== env.SECRET) return json({ error: 'no' }, 403);
    const [r, l, g] = await Promise.all([board(env).fetch('https://b/online/reports').then(x => x.json()), env.LOBBY.get(env.LOBBY.idFromName('global')).fetch('https://l/state').then(x => x.json()), board(env).fetch('https://b/online/ghost-stats').then(x => x.json())]);
    return json({ reports: r.reports, today: l.today, cap: l.cap, open: l.items.length, online: l.online, ghosts: { enabled: l.ghosts, matchesToday: l.ghostsToday, ...g } });
  }
  if (sub === '/api/online/record') return board(env).fetch('https://b' + sub + url.search);
  if (sub === '/api/lb/top') {   // one snapshot of every song's top 5, cached at the edge (the panel never fetches per highlight)
    const kind = ['sing', 'beat', 'duet'].includes(url.searchParams.get('kind')) ? url.searchParams.get('kind') : 'sing';
    const key = new Request('https://lb-cache.invalid/top?kind=' + kind), cache = caches.default;
    let r = url.searchParams.get('fresh') ? null : await cache.match(key);
    if (!r) {
      const body = await board(env).fetch('https://b/api/lb/top?kind=' + kind).then(x => x.text());
      r = new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' } });
      ctx.waitUntil(cache.put(key, r.clone()));
    }
    return new Response(r.body, { headers: sec({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }) });
  }
  if (sub === '/api/health') return json({ ok: true, time: Date.now() });
  if (sub.startsWith('/api/stingray/')) return sub === '/api/stingray/status' ? json({ configured: false, featuredSongId: null }) : json({ error: 'Stingray is not available on the web version' }, 503);
  if (sub === '/api/stt' && req.method === 'POST') {
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) return json({ error: 'too big' }, 413);
    try {
      const t = Date.now(); let b64 = ''; for (let i = 0; i < buf.length; i += 0x8000) b64 += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      const r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: btoa(b64), language: 'en', vad_filter: true, initial_prompt: 'A song title or an artist name for a karaoke library.' });
      let text = String(r.text || '').trim(); if (!/[a-z]{2}/i.test(text) || text.length > 120) text = '';
      return json({ text, ms: Date.now() - t });
    }
    catch (e) { return json({ error: 'Could not hear that. Try again.' }, 500); }
  }
  if (sub === '/api/favorites' || sub === '/api/custom-chart' || sub.startsWith('/api/lb/')) {
    if (sub === '/api/custom-chart' && req.method === 'POST') { const b = await req.text(); if (b.length > 2 * 1024 * 1024) return json({ error: 'too big' }, 413); }
    return board(env).fetch(new Request('https://b' + sub + url.search, req));
  }
  if (sub.startsWith('/api/')) return json({ error: 'unknown' }, 404);

  // --- pages + static ---
  if (sub === '/' || sub === '/index.html') {
    if (isPhone(ua)) return html(MOBILE_HTML.replace('%%MSG%%', ''));
    const r = await env.ASSETS.fetch(new Request(new URL(BASE + '/tv/index.html', url)));
    let t = await r.text();
    t = t.replace('<head>', '<head>\n<base href="' + BASE + '/tv/">');
    return html(t);
  }
  if (sub === '/leaderboard' || sub === '/leaderboard/') return asset(env, req, BASE + '/web/leaderboard.html', 'no-store');
  let ap = p;
  if (sub.startsWith('/tv/songs/')) ap = BASE + sub.slice(3);
  else if (sub.startsWith('/tv/shared/')) ap = BASE + sub.slice(3);
  else if (sub.startsWith('/tv/web/')) ap = BASE + sub.slice(3);
  if (/^\/kba\/phone\/?$/.test(ap)) ap = BASE + '/phone/index.html';
  if ((m = /^\/kba\/songs\/([a-z0-9-]+)\/song\.json$/.exec(ap))) {
    const r = await asset(env, req, ap, 'no-cache');
    if (r.status !== 200) return r;
    const custom = await board(env).fetch('https://b/custom?id=' + m[1]).then(x => x.json()).catch(() => null);
    if (!custom || !custom.custom) return r;
    const s = await r.json(); s.custom = custom.custom; return json(s, 200, { 'Cache-Control': 'no-cache' });
  }
  const isMedia = /\.(mp3|wav|webp|jpg|png|mid)$/.test(ap);
  return asset(env, req, ap, isMedia ? 'private, max-age=86400' : 'no-cache');
}
