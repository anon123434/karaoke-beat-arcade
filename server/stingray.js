/*
 * Stingray Karaoke API v1 adapter (https://karaoke-api-doc.stingray.com/api/v1/, see Stingray's published docs).
 *
 * Auth (v1): every call sends header X-API-KEY (Stingray-issued developer key). POST /v1/login-device
 *   {device_id, country_code, language_code[, client_ip, account_id]} -> {token, duration_ms};
 *   catalog calls also send Authorization: Bearer <token>. CORS is disabled by Stingray, so this
 *   MUST run on a backend (this local server) — the key never goes to the TV.
 * Song: GET /v1/songs/{id}?withPlayLink=true&withKml=true&videoCodec=H264 ->
 *   resources{...: {mime_type 'video/mp4', uri (signed, expiring), mix_type A_MIX (no lead) | C_MIX (lead),
 *   video_codec H264|H265, background_theme, is_sample}}, kml_resource{uri}, bpm, key_pitch, duration_sec.
 * Lyrics: KML <pg id="lyrics.N"><ln c="pt.1"><lyr c d s t/></ln></pg> (seconds), optional <coldstartoffset C="ms">.
 * Pitch: Stingray provides NO reference melody (only song key/bpm). We derive one: lead-vocal track
 *   (C_MIX) minus instrumental (A_MIX) ≈ isolated lead vocal -> YIN -> one note per KML word (median pitch).
 * Royalties: POST /v1/play-log {song_id, duration_played_seconds} after every play (required by Stingray).
 *
 * Credentials: env STINGRAY_API_KEY, or .local/stingray.json {"api_key": "...", "device_id"?, "country_code"?,
 * "language_code"?, "base_url"?, "featured_song_id"?} (chmod 600). Never logged or sent to clients.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Yin = require('../shared/yin');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, '.local/stingray.json');
const CACHE_DIR = path.join(ROOT, '.local/stingray-cache');

function loadConfig(env = process.env, file = CONFIG_FILE) {
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('.local/stingray.json is not valid JSON'); }
  }
  const apiKey = env.STINGRAY_API_KEY || cfg.api_key || '';
  return {
    configured: !!apiKey,
    apiKey,
    baseUrl: (env.STINGRAY_BASE_URL || cfg.base_url || 'https://karaoke-api-service-prod.stingray.com').replace(/\/$/, ''),
    deviceId: env.STINGRAY_DEVICE_ID || cfg.device_id || 'karaoketv-mac-mini',
    countryCode: env.STINGRAY_COUNTRY || cfg.country_code || 'US',
    languageCode: env.STINGRAY_LANGUAGE || cfg.language_code || 'en',
    featuredSongId: env.STINGRAY_SONG_ID || cfg.featured_song_id || ''
  };
}

class StingrayClient {
  constructor(cfg, fetchImpl = globalThis.fetch) {
    this.cfg = cfg; this.fetch = fetchImpl; this.token = null; this.expires = 0;
  }
  async login() {
    const r = await this.fetch(this.cfg.baseUrl + '/v1/login-device', {
      method: 'POST',
      headers: { 'X-API-KEY': this.cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ device_id: this.cfg.deviceId, country_code: this.cfg.countryCode, language_code: this.cfg.languageCode })
    });
    if (!r.ok) throw new Error('Stingray login failed: HTTP ' + r.status + (r.status === 401 ? ' (API key missing or invalid)' : ''));
    const s = await r.json();
    if (!s.token) throw new Error('Stingray login returned no token');
    this.token = s.token;
    // duration_ms is documented as ms (example 86400 looks like seconds) — refresh conservatively.
    const ms = +s.duration_ms || 0;
    const life = ms > 600000 ? ms : (ms > 0 ? ms * 1000 : 3600e3);
    this.expires = Date.now() + Math.max(60e3, life - 60e3);
    return true;
  }
  async request(method, pathname, { query, body } = {}, retried = false) {
    if (!this.token || Date.now() > this.expires) await this.login();
    const u = new URL(this.cfg.baseUrl + pathname);
    for (const [k, v] of Object.entries(query || {})) if (v != null) u.searchParams.set(k, String(v));
    const r = await this.fetch(u.toString(), {
      method,
      headers: { 'X-API-KEY': this.cfg.apiKey, Authorization: 'Bearer ' + this.token, Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (r.status === 401 && !retried) { this.token = null; return this.request(method, pathname, { query, body }, true); }
    if (!r.ok) throw new Error(`Stingray ${method} ${pathname} failed: HTTP ${r.status}`);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }
  searchSongs(text, size = 10) { return this.request('GET', '/v1/search-songs', { query: { text, size, 'search-fields': 'title,artists' } }); }
  async getSong(id, videoCodec = 'H264') {
    const res = await this.request('GET', '/v1/songs/' + encodeURIComponent(id), { query: { withPlayLink: true, withKml: true, videoCodec } });
    return Array.isArray(res) ? res[0] : res;
  }
  playLog(songId, seconds) { return this.request('POST', '/v1/play-log', { body: { song_id: songId, duration_played_seconds: Math.ceil(seconds) } }); }
}

/** Choose a playable resource: full song, preferred mix, H.264 before H.265, mp4. */
function pickResource(song, mix = 'A_MIX') {
  const list = Object.values((song && song.resources) || {}).filter(r => r && r.uri && r.mix_type === mix);
  const rank = r => (r.is_sample ? 100 : 0) + (r.video_codec === 'H264' ? 0 : r.video_codec === 'H265' ? 1 : 2) + (/mp4/.test(r.mime_type || '') ? 0 : 5);
  return list.sort((a, b) => rank(a) - rank(b))[0] || null;
}

function decodeXml(s) { return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function attrs(tag) { const o = {}; tag.replace(/([\w:-]+)\s*=\s*"([^"]*)"/g, (_, k, v) => { o[k] = decodeXml(v); }); return o; }

/** KML -> normalised lines [{t,end,words:[{t,d,text}]}] for the parts sung by `singer` (1-based; 0 = all). */
function parseKml(xml, singer = 1) {
  const coldMatch = /<coldstartoffset\b[^>]*>/i.exec(xml);
  const coldStartOffsetMs = coldMatch ? +(attrs(coldMatch[0]).C || 0) : 0;
  let parts = null;
  const duet = /<duet\b[^>]*>([\s\S]*?)<\/duet>/i.exec(xml);
  if (duet && singer > 0) {
    const singers = duet[1].match(/<singer\b[\s\S]*?<\/singer>/gi) || [];
    if (singers[singer - 1]) parts = (singers[singer - 1].match(/<part>\s*([^<]+?)\s*<\/part>/gi) || []).map(p => p.replace(/<\/?part>/gi, '').trim());
  }
  const lines = [];
  const pageRe = /<pg\b([^>]*)>([\s\S]*?)<\/pg>/gi; let pg;
  while ((pg = pageRe.exec(xml))) {
    if (!/id="lyrics/i.test(pg[1])) continue;
    const lnRe = /<ln\b([^>]*)>([\s\S]*?)<\/ln>/gi; let ln;
    while ((ln = lnRe.exec(pg[2]))) {
      const lnPart = attrs('<x ' + ln[1] + '>').c;
      const words = [];
      (ln[2].match(/<lyr\b[^>]*\/?>/gi) || []).forEach(tag => {
        const a = attrs(tag);
        const part = a.c || lnPart;
        if (parts && part && !parts.includes(part)) return;
        if (a.s == null || a.t == null) return;
        const raw = a.s;
        // KML words carry their own trailing space; no trailing space = syllable joins the next one.
        const text = raw.trim() + (raw.endsWith(' ') ? '' : '-');
        words.push({ t: +a.t, d: +(a.d || 0.3), text });
      });
      if (words.length) {
        words[words.length - 1].text = words[words.length - 1].text.replace(/-$/, '');
        const last = words[words.length - 1];
        lines.push({ t: words[0].t, end: +(last.t + last.d).toFixed(3), words });
      }
    }
  }
  lines.sort((a, b) => a.t - b.t);
  return { lines, coldStartOffsetMs };
}

/**
 * Derive reference notes from an isolated (or lead-heavy) vocal signal: one note per lyric word,
 * pitch = median voiced YIN estimate inside the word. Words with <40% voiced frames are skipped.
 */
function melodyFromVocal(samples, sampleRate, lines) {
  const HOP = Math.round(sampleRate * 0.01), WIN = 1024;
  const frames = [];
  for (let i = 0; i + WIN <= samples.length; i += HOP) {
    const r = Yin.detect(samples.subarray(i, i + WIN), sampleRate, { threshold: 0.12, minRms: 0.01 });
    frames.push({ t: (i + WIN / 2) / sampleRate, f: r.freq });
  }
  const notes = [];
  lines.forEach((l, li) => l.words.forEach(w => {
    const a = w.t + w.d * 0.15, b = w.t + w.d * 0.85; // skip consonant edges
    const inWord = frames.filter(f => f.t >= a && f.t <= b);
    const voiced = inWord.filter(f => f.f > 0).map(f => 69 + 12 * Math.log2(f.f / 440)).sort((x, y) => x - y);
    if (!inWord.length || voiced.length / inWord.length < 0.4) return;
    notes.push({ t: w.t, d: w.d, midi: Math.round(voiced[Math.floor(voiced.length / 2)]), syl: w.text, line: li });
  }));
  return notes;
}

/** Best integer-sample lag (|lag| <= maxLag) aligning b to a: coarse cross-correlation, then exact refinement. */
function bestLag(a, b, maxLag, sampleRate = 16000) {
  const from = maxLag, to = Math.min(a.length - maxLag, maxLag + 20 * sampleRate);
  const corr = (lag, step) => { let s = 0; for (let i = from; i < to; i += step) s += a[i] * (b[i + lag] || 0); return s; };
  let best = 0, bestScore = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag += 4) { const s = corr(lag, 4); if (s > bestScore) { bestScore = s; best = lag; } }
  const coarse = best; bestScore = -Infinity;
  for (let lag = coarse - 4; lag <= coarse + 4; lag++) { const s = corr(lag, 1); if (s > bestScore) { bestScore = s; best = lag; } }
  return best;
}

/** Lead-vocal isolation by subtracting the aligned instrumental (A_MIX) from the vocal mix (C_MIX). */
function isolateVocal(cMix, aMix, sampleRate, maxLagSec = 0.5) {
  const lag = bestLag(cMix, aMix, Math.round(maxLagSec * sampleRate), sampleRate);
  // least-squares gain so level differences between masters don't leave residue
  let num = 0, den = 0;
  for (let i = 0; i < cMix.length; i++) { const v = aMix[i + lag] || 0; num += cMix[i] * v; den += v * v; }
  const g = den ? num / den : 1;
  const out = new Float32Array(cMix.length);
  for (let i = 0; i < cMix.length; i++) out[i] = cMix[i] - g * (aMix[i + lag] || 0);
  return { vocal: out, lag, gain: g };
}

function decodeAudio(url, sampleRate = 16000) {
  // ffmpeg (Homebrew) reads the signed https URL directly and outputs mono float32 PCM.
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', url, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1']);
    const chunks = [];
    p.stdout.on('data', c => chunks.push(c));
    p.on('error', reject);
    p.on('close', code => {
      if (code) return reject(new Error('ffmpeg could not decode the Stingray media'));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

/** Full pipeline -> the same song shape LocalSongSource produces (see shared/song-source.js). */
async function loadSong(client, id, { fetchImpl = globalThis.fetch, decode = decodeAudio, cacheDir = CACHE_DIR } = {}) {
  const song = await client.getSong(id);
  if (!song || song.is_blank) throw new Error('Stingray song not found: ' + id);
  const inst = pickResource(song, 'A_MIX');
  if (!inst) throw new Error('No instrumental (A_MIX) resource for this song');
  let lines = [], coldStartOffsetMs = 0;
  if (song.kml_resource && song.kml_resource.uri) {
    const r = await fetchImpl(song.kml_resource.uri);
    if (!r.ok) throw new Error('KML download failed: HTTP ' + r.status);
    ({ lines, coldStartOffsetMs } = parseKml(await r.text()));
  }
  const cacheFile = path.join(cacheDir, String(id).replace(/[^\w.-]/g, '_') + '.melody.json');
  let notes = null, melodySource = 'none';
  if (fs.existsSync(cacheFile)) { notes = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); melodySource = 'cache'; }
  else {
    const lead = pickResource(song, 'C_MIX');
    if (lead && lines.length) {
      const SR = 16000;
      const [c, a] = await Promise.all([decode(lead.uri, SR), decode(inst.uri, SR)]);
      const { vocal } = isolateVocal(c, a, SR, Math.max(0.5, coldStartOffsetMs / 1000 + 0.5));
      notes = melodyFromVocal(vocal, SR, lines);
      melodySource = 'derived-from-C_MIX-minus-A_MIX';
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(notes));
    }
  }
  return {
    id: 'stingray:' + song.id, provider: 'stingray', stingrayId: song.id,
    title: song.title, artist: song.artist_display_name || '',
    duration: inst.duration_sec || song.duration_sec, leadIn: lines.length ? lines[0].t : 0,
    audioUrl: inst.uri, mediaType: inst.mime_type || 'video/mp4', videoCodec: inst.video_codec,
    bpm: song.bpm, key: song.key, lines, notes: notes || [], scorable: !!(notes && notes.length), melodySource,
    theme: song.karaoke_theme_resource || null
  };
}

module.exports = { loadConfig, StingrayClient, pickResource, parseKml, melodyFromVocal, isolateVocal, bestLag, loadSong, decodeAudio };
