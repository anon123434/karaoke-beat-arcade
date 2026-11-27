// HEADLESS dense-section stress benchmark. SYNTHETIC chart (TEST-ONLY): 12 notes/s over all pad lanes with chords + holds,
// every note auto-hit (max effects). CPU throttled 6x to approximate the TV. Compares highway builds; reports frame times + heap growth.
// usage: node tools/perf-stress.mjs [secs]
import { createRequire } from 'module'; import fs from 'fs'; import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const secs = +(process.argv[2] || 12);
const variants = [['v13.4 (no streak fx)', '.local/beat-v1342.js', '.local/style-v1342.css', 1], ['v13.5 streaks', 'tv/beat.js', 'tv/style.css', 1]];
const beats = []; for (let t = 0; t < 400; t += 0.4) beats.push(+t.toFixed(3));   // 150 bpm grid
const song = { id: 'stress', duration: 400, beats: { t: beats, bpm: 150 }, notes: [], lines: [], chart: { v: 3, drums: true, ev: [] } };
const br = await pw.chromium.launch({ args: ['--enable-gpu-rasterization'] });
for (const [name, js, css, res] of variants) for (const [mode, cls, w, h] of [['beat', 'beatonly', 1000, 760], ['duet', 'duet', 600, 750]]) {
  const pg = await br.newPage({ viewport: { width: 1920, height: 1080 } }); const cdp = await pg.context().newCDPSession(pg);
  await pg.setContent(`<style>${fs.readFileSync(path.join(ROOT, css), 'utf8')}</style><body style="margin:0;background:#120"><div id="game" class="${cls}" style="position:absolute;inset:0"><div id="beatTrack" class="beat-track"></div></div></body>`);
  await pg.addScriptTag({ content: fs.readFileSync(path.join(ROOT, js), 'utf8') });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 }); await cdp.send('Performance.enable'); const M = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value])); await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  const heap0 = (await cdp.send('Runtime.getHeapUsage')).usedSize; let m0 = null; await pg.exposeFunction('__mark', async () => { m0 = await M(); });
  const r = await pg.evaluate(async ([song, w, h, res, secs]) => {
    const b = new KaraokeBeat(document.getElementById('beatTrack'), song, { diff: 'hard', input: 'pad', width: w, height: h, res });
    const lanes = Object.keys(b.tgt).map(Number), P = [];   // SYNTHETIC dense prompts
    for (let k = 0, t = 3; t < 3 + secs + 5; k++, t += 1 / 12) {
      P.push({ t, lane: lanes[k % lanes.length], dur: k % 37 === 0 ? 0.5 : 0, midi: 0, r: null, el: null, body: null, hold: 0 });
      if (k % 3 === 0) P.push({ t, lane: lanes[(k + 4) % lanes.length], dur: 0, midi: 0, r: null, el: null, body: null, hold: 0 });   // chords
    }
    b.prompts = P; b.units = P.length; b.next = 0;
    await window.__mark(); const t0 = performance.now(), iv = []; let last = t0, pi = 0, hits = 0;
    await new Promise(res => { function f(now) {
      const hh = 3 + (now - t0) / 1000; iv.push(now - last); last = now;
      while (pi < P.length && P[pi].t <= hh) { if (!P[pi].r) { b.press(P[pi].lane, P[pi].t); if (P[pi].dur) b.release(P[pi].lane, P[pi].t + P[pi].dur); hits++; } pi++; }
      b.draw(hh, hh); if (now - t0 < secs * 1000) requestAnimationFrame(f); else res(); } requestAnimationFrame(f); });
    iv.shift(); const s = iv.slice().sort((a, b) => a - b), q = p => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);
    return { fps: +(1000 / (iv.reduce((a, b) => a + b, 0) / iv.length)).toFixed(1), p50: q(0.5), p95: q(0.95), p99: q(0.99), worst: +s[s.length - 1].toFixed(1), over20ms: iv.filter(x => x > 20).length, frames: iv.length, hitsPerSec: +(hits / secs).toFixed(1) };
  }, [song, w, h, res, secs]);
  const heap1 = (await cdp.send('Runtime.getHeapUsage')).usedSize, m1 = await M(), d = k => m1[k] - m0[k], perF = v => +(v / r.frames).toFixed(2);
  console.log(JSON.stringify({ build: name, mode, fps: r.fps, p95: r.p95, p99: r.p99, worst: r.worst, over20ms: r.over20ms, hitsPerSec: r.hitsPerSec,
    styleRecalcPerFrame: perF(d('RecalcStyleCount')), layoutsPerFrame: perF(d('LayoutCount')), styleMsPerFrame: perF(d('RecalcStyleDuration') * 1000), layoutMsPerFrame: perF(d('LayoutDuration') * 1000),
    scriptMsPerFrame: perF(d('ScriptDuration') * 1000), taskMsPerFrame: perF(d('TaskDuration') * 1000), heapGrowKB: Math.round((heap1 - heap0) / 1024) }));
  await pg.close();
}
await br.close();
