// Stingray v1 adapter tests against the DOCUMENTED schema with a mock fetch (no network, no credentials).
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const fs = require('fs'); const path = require('path');
const St = require('../server/stingray');
const Yin = require('../shared/yin');

const KML = `<?xml version="1.0"?><kml><coldstartoffset B="0" C="4597" D="0"/>
<duet><singer gender="female"><part>pt.1</part><part>pt.2</part></singer><singer gender="male"><part>pt.2</part><part>pt.3</part></singer></duet>
<pg d="0" id="info_page" t="0"></pg>
<pg d="8.24" id="lyrics.1" t="0"><ln c="pt.1"><lyr c="pt.1" d="0.29" s="WHERE'S " t="4.35"/><lyr c="pt.1" d="0.27" s="ALL " t="4.64"/><lyr c="pt.1" d="0.2" s="MY" t="4.91"/><lyr c="pt.1" d="0.31" s="SELF " t="5.11"/></ln></pg>
<pg d="5" id="lyrics.2" t="8"><ln c="pt.3"><lyr c="pt.3" d="0.5" s="MALE " t="9"/></ln><ln c="pt.2"><lyr c="pt.2" d="0.5" s="BOTH &amp; " t="10"/></ln></pg>
<pg d="0" id="credits_page" t="20"></pg></kml>`;

test('parseKml: words, joined syllables, cold start offset, duet part filter', () => {
  const { lines, coldStartOffsetMs } = St.parseKml(KML, 1);
  assert.strictEqual(coldStartOffsetMs, 4597);
  assert.strictEqual(lines.length, 2); // singer 1 has pt.1 + pt.2, not pt.3
  assert.deepStrictEqual(lines[0].words.map(w => w.text), ["WHERE'S", 'ALL', 'MY-', 'SELF']);
  assert.strictEqual(lines[0].words[0].t, 4.35);
  assert.strictEqual(lines[1].words[0].text, 'BOTH &');
  assert.strictEqual(St.parseKml(KML, 0).lines.length, 3);
});

test('pickResource prefers full-length A_MIX H264 mp4 over samples/H265', () => {
  const song = { resources: {
    a: { mix_type: 'A_MIX', uri: 'u-sample', video_codec: 'H264', mime_type: 'video/mp4', is_sample: true },
    b: { mix_type: 'A_MIX', uri: 'u-265', video_codec: 'H265', mime_type: 'video/mp4' },
    c: { mix_type: 'A_MIX', uri: 'u-264', video_codec: 'H264', mime_type: 'video/mp4' },
    d: { mix_type: 'C_MIX', uri: 'u-lead', video_codec: 'H264', mime_type: 'video/mp4' } } };
  assert.strictEqual(St.pickResource(song).uri, 'u-264');
  assert.strictEqual(St.pickResource(song, 'C_MIX').uri, 'u-lead');
});

test('config: env var or .local file, never required to be in code', () => {
  const tmp = path.join(os.tmpdir(), 'st-' + process.pid + '.json');
  fs.writeFileSync(tmp, JSON.stringify({ api_key: 'file-key', featured_song_id: 'KAR:1' }));
  assert.strictEqual(St.loadConfig({}, tmp).apiKey, 'file-key');
  assert.strictEqual(St.loadConfig({ STINGRAY_API_KEY: 'env-key' }, tmp).apiKey, 'env-key');
  assert.strictEqual(St.loadConfig({}, '/nonexistent').configured, false);
  fs.unlinkSync(tmp);
});

function mockApi() {
  const calls = []; let logins = 0; let expireNext = false;
  const resp = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetch = async (url, opts = {}) => {
    calls.push({ url, opts });
    const u = new URL(url);
    if (u.hostname === 'cdn.test') return resp(200, KML);
    if (opts.headers['X-API-KEY'] !== 'k123') return resp(401, { code: '401', message: 'API key is missing or invalid' });
    if (u.pathname === '/v1/login-device') { logins++; const b = JSON.parse(opts.body); assert.ok(b.device_id && b.country_code && b.language_code); return resp(200, { token: 'tok' + logins, duration_ms: 86400000 }); }
    if (opts.headers.Authorization !== 'Bearer tok' + logins || expireNext) { expireNext = false; return resp(401, { code: '401', message: 'expired' }); }
    if (u.pathname === '/v1/search-songs') return resp(200, { songs: [{ id: 'KAR:G:1', title: 'Test', artist_display_name: 'Band', duration_sec: 200 }], artists: [] });
    if (u.pathname.startsWith('/v1/songs/')) {
      assert.strictEqual(u.searchParams.get('withPlayLink'), 'true'); assert.strictEqual(u.searchParams.get('withKml'), 'true');
      return resp(200, [{ id: 'KAR:G:1', title: 'Test', artist_display_name: 'Band', duration_sec: 200, bpm: 120,
        kml_resource: { uri: 'https://cdn.test/song.kml' },
        resources: { x: { mix_type: 'A_MIX', uri: 'https://cdn.test/a.mp4', video_codec: 'H264', mime_type: 'video/mp4', duration_sec: 200 },
                     y: { mix_type: 'C_MIX', uri: 'https://cdn.test/c.mp4', video_codec: 'H264', mime_type: 'video/mp4', duration_sec: 200 } } }]);
    }
    if (u.pathname === '/v1/play-log') { const b = JSON.parse(opts.body); assert.ok(b.song_id && Number.isInteger(b.duration_played_seconds)); return resp(200, ''); }
    return resp(404, {});
  };
  return { fetch, calls, get logins() { return logins; }, expire() { expireNext = true; } };
}

test('client: X-API-KEY + device login + bearer, token re-login on 401, play-log', async () => {
  const api = mockApi();
  const c = new St.StingrayClient({ ...St.loadConfig({ STINGRAY_API_KEY: 'k123', STINGRAY_BASE_URL: 'https://api.test' }, '/none') }, api.fetch);
  const r = await c.searchSongs('test');
  assert.strictEqual(r.songs[0].id, 'KAR:G:1');
  api.expire();
  const song = await c.getSong('KAR:G:1');
  assert.strictEqual(song.title, 'Test');
  assert.strictEqual(api.logins, 2);
  await c.playLog('KAR:G:1', 12.2);
  const bad = new St.StingrayClient({ ...St.loadConfig({ STINGRAY_API_KEY: 'wrong', STINGRAY_BASE_URL: 'https://api.test' }, '/none') }, api.fetch);
  await assert.rejects(bad.searchSongs('x'), /API key missing or invalid/);
});

test('[synthetic] loadSong: KML lyrics + melody derived from C_MIX minus A_MIX, normalised song shape', async () => {
  const api = mockApi();
  const c = new St.StingrayClient(St.loadConfig({ STINGRAY_API_KEY: 'k123', STINGRAY_BASE_URL: 'https://api.test' }, '/none'), api.fetch);
  const SR = 16000, N = SR * 12;
  // synthetic "instrumental": C-major chord pad; synthetic "lead": sung notes on each KML word for singer 1
  const inst = new Float32Array(N), lead = new Float32Array(N);
  let sd = 3; const rnd = () => { sd = (sd * 1103515245 + 12345) % 2147483648; return sd / 1073741824 - 1; };
  for (let i = 0; i < N; i++) { const t = i / SR; inst[i] = 0.05 * rnd() * Math.exp(-((t * 2) % 1) * 8) + 0.2 * (1 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t)) * (Math.sin(2 * Math.PI * 130.81 * t) + Math.sin(2 * Math.PI * 164.81 * t) + Math.sin(2 * Math.PI * 196 * t)); }
  const sung = [[4.35, 0.29, 67], [4.64, 0.27, 69], [4.91, 0.2, 71], [5.11, 0.31, 72], [10, 0.5, 64]];
  sung.forEach(([t0, d, m]) => { const f = 440 * Math.pow(2, (m - 69) / 12); for (let i = Math.floor(t0 * SR); i < (t0 + d) * SR; i++) lead[i] = 0.3 * (Math.sin(2 * Math.PI * f * i / SR) + 0.5 * Math.sin(4 * Math.PI * f * i / SR)); });
  const lag = 37; // C_MIX master offset vs A_MIX
  const cmix = new Float32Array(N); for (let i = 0; i < N; i++) cmix[i] = (inst[i - lag] || 0) * 1.0 + lead[i];
  const decode = async url => (url.endsWith('c.mp4') ? cmix : inst);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stc-'));
  const s = await St.loadSong(c, 'KAR:G:1', { fetchImpl: api.fetch, decode, cacheDir });
  assert.strictEqual(s.id, 'stingray:KAR:G:1'); assert.strictEqual(s.audioUrl, 'https://cdn.test/a.mp4');
  assert.strictEqual(s.lines.length, 2); assert.ok(s.scorable);
  assert.deepStrictEqual(s.notes.map(n => n.midi), sung.map(x => x[2]));
  assert.strictEqual(s.leadIn, 4.35);
  const again = await St.loadSong(c, 'KAR:G:1', { fetchImpl: api.fetch, decode: () => { throw new Error('should use cache'); }, cacheDir });
  assert.strictEqual(again.melodySource, 'cache');
});
