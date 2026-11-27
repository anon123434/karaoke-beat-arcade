// HEADLESS highway render benchmark (SYNTHETIC auto-play: every note is hit on time to max out the effects).
// A/B: old DOM highway vs current canvas highway, same chart, CPU throttled to mimic the TV. Not scoring input.
// usage: node tools/perf-highway.mjs <songId> [secs]
import { createRequire } from 'module'; import fs from 'fs'; import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const [sid, secs = '12'] = process.argv.slice(2);
const song = JSON.parse(fs.readFileSync(path.join(ROOT, 'songs', sid, 'song.json')));
const variants = { 'old-dom (v13.2)': ['.local/beat-v132-dom.js', '.local/style-v132.css'], 'canvas (v13.3)': ['tv/beat.js', 'tv/style.css'] };
const modes = [['beat', 'beatonly', 1000, 760, 'hard'], ['duet', 'duet', 600, 750, 'normal'], ['jam', 'beatonly jam', 1000, 760, 'normal']];
const br = await pw.chromium.launch({ args: ['--enable-gpu-rasterization'] });
const out = [];
for (const [vn, [js, css]] of Object.entries(variants)) for (const [mode, cls, w, h, diff] of modes) {
  const pg = await br.newPage({ viewport: { width: 1920, height: 1080 } });
  const cdp = await pg.context().newCDPSession(pg);
  await pg.setContent(`<style>${fs.readFileSync(path.join(ROOT, css), 'utf8')}</style><body style="margin:0;background:#120"><div id="game" class="${cls}" style="position:absolute;inset:0"><div id="beatTrack" class="beat-track"></div></div></body>`);
  await pg.addScriptTag({ content: fs.readFileSync(path.join(ROOT, js), 'utf8') });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const r = await pg.evaluate(async ([song, w, h, diff, jam, secs]) => {
    const b = new KaraokeBeat(document.getElementById('beatTrack'), song, { diff, input: 'pad', jam, width: w, height: h });
    const t0 = performance.now(), start = 60, iv = []; let last = t0, fired = 0, pi = 0;
    const lanes = Object.keys(b.tgt).map(Number);
    await new Promise(res => { function f(now) {
      const hh = start + (now - t0) / 1000; iv.push(now - last); last = now;
      if (jam) { if (Math.random() < 0.12) { b.press(lanes[fired++ % lanes.length], hh); } }
      else { const P = b.prompts; while (pi < P.length && P[pi].t <= hh) { if (P[pi].t > hh - 0.05 && !P[pi].r) { b.press(P[pi].lane, P[pi].t); if (P[pi].dur) b.release(P[pi].lane, P[pi].t + P[pi].dur); fired++; } pi++; } }
      b.draw(hh); if (now - t0 < secs * 1000) requestAnimationFrame(f); else res(); } requestAnimationFrame(f); });
    iv.shift(); iv.sort((a, b) => a - b); const med = iv[iv.length >> 1], p95 = iv[Math.floor(iv.length * 0.95)];
    return { frames: iv.length, fps: +(1000 / (iv.reduce((a, b) => a + b, 0) / iv.length)).toFixed(1), medMs: +med.toFixed(1), p95Ms: +p95.toFixed(1), worstMs: +iv[iv.length - 1].toFixed(1), hits: fired, els: document.querySelectorAll('#beatTrack *').length };
  }, [song, w, h, diff, mode === 'jam', +secs]);
  await cdp.send('LayerTree.enable'); const lay = await new Promise(res => { cdp.once('LayerTree.layerTreeDidChange', e => res((e.layers || []).length)); pg.evaluate(() => document.body.style.opacity = '0.999'); setTimeout(() => res(-1), 3000); });
  out.push({ variant: vn, mode, ...r, layers: lay }); console.log(JSON.stringify(out.at(-1)));
  await pg.close();
}
await br.close();
