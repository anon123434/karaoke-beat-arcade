// Sliced decode must equal the one-shot decode (samples + length) for every MP3 stem. PRIVATE server. IDS=a,b to limit; default all.
import { createRequire } from 'module'; import { spawn } from 'child_process'; import fs from 'fs';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = process.env.ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, ''), H = +(process.env.PORT || 18630), THR = +(process.env.THR || 1);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'qaslice', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1500);
const b = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await b.newContext(); const pg = await ctx.newPage();
await pg.addInitScript(() => { const A = window.AudioContext; window.AudioContext = class extends A { constructor(o) { super({ ...(o || {}), sampleRate: 44100 }); } }; });
const cdp = await ctx.newCDPSession(pg); if (THR > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: THR });
await pg.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await pg.waitForFunction(() => window.KaraokeEngine);
const idx = JSON.parse(fs.readFileSync(ROOT + '/songs/index.json', 'utf8')); let ids = idx.map(e => e.id); if (process.env.IDS) ids = process.env.IDS.split(',');
let bad = 0, n = 0, worst = 0, sl = [];
for (const id of ids) for (const f of ['instrumental.mp3', 'vocals.mp3']) {
  if (!fs.existsSync(`${ROOT}/songs/${id}/${f}`)) continue;
  const url = `/songs/${id}/${f}`;
  const r = await pg.evaluate(async (url) => {
    const el = document.createElement('audio'); const E = new KaraokeEngine(el, { prefer: 'webaudio', slice: true }); E.pending = false; E.sliceKeep = url;
    const ab = await (await fetch(url)).arrayBuffer();
    const tf = performance.now(); const full = await new Promise((res, rej) => E.ctx.decodeAudioData(ab.slice(0), res, rej));
    const fullMs = Math.round(performance.now() - tf); const t0 = performance.now(); const sl = await new Promise(res => E.decodeSliced(url, ab, (b, e) => res({ b, e: e && e.message })));
    const ms = performance.now() - t0; if (!sl.b) return { err: sl.e, flen: full.length, sr: E.ctx.sampleRate };
    let mx = 0, firstBad = -1; for (let c = 0; c < full.numberOfChannels; c++) { const x = full.getChannelData(c), y = sl.b.getChannelData(c), m = Math.min(x.length, y.length); for (let i = 0; i < m; i++) { const d = Math.abs(x[i] - y[i]); if (d > mx) { mx = d; } if (d > 1e-4 && firstBad < 0) firstBad = i; } }
    E.ctx.close(); return { flen: full.length, slen: sl.b.length, mx, firstBad, ms: Math.round(ms), fullMs, info: E.lastSlice };
  }, url);
  n++; const ok = !r.err && Math.abs(r.flen - r.slen) <= 2304 && r.mx < 1e-4;
  if (r.slen) sl.push(r.info); worst = Math.max(worst, r.mx || 0);
  if (!ok) { bad++; console.log('BAD', id, f, JSON.stringify(r)); } else if (n % 20 === 1) console.log('ok', id, f, JSON.stringify(r));
}
console.log('checked', n, 'bad', bad, 'worst maxdiff', worst, 'avg slices', Math.round(sl.reduce((a, x) => a + x.slices, 0) / Math.max(1, sl.length)), 'max slice ms', Math.max(...sl.map(x => x.maxSliceMs)), 'skip set', [...new Set(sl.map(x => x.skip))].join(','));
server.kill(); await b.close(); process.exit(bad ? 1 : 0);
