// notes per minute by difficulty/input from the real KaraokeBeat.chart() (node vm, no browser). usage: node tools/chart-stats.mjs [id...]
import fs from 'fs'; import vm from 'vm';
const ctx = { window: {}, document: { createElement: () => ({ getContext: () => null, style: {} }) }, performance: { now: () => 0 }, console };
ctx.window = ctx; vm.createContext(ctx); vm.runInContext(fs.readFileSync(process.env.BEATJS || new URL('../tv/beat.js', import.meta.url), 'utf8'), ctx);
const B = ctx.KaraokeBeat; const ids = process.argv.slice(2).length ? process.argv.slice(2) : JSON.parse(fs.readFileSync('songs/index.json')).map(e => e.id).filter(i => i.startsWith('user-'));
const agg = {}; const per = {};
for (const id of ids) {
  const s = JSON.parse(fs.readFileSync(`songs/${id}/song.json`)); if (process.env.OLD) { const o = JSON.parse(fs.readFileSync(`.local/chart-v3/${id}.json`)); s.chart = o.chart; s.beats.t = o.beats_t || s.beats.t; } const d = (s.duration || 1) / 60;
  for (const inp of ['pad', 'remote']) for (const df of ['easy', 'normal', 'hard']) {
    const c = B.chart(s, df, inp), k = inp + '-' + df; const solo = c.filter(p => p.solo).length;
    (agg[k] = agg[k] || []).push(c.length / d); (per[id] = per[id] || {})[k] = Math.round(c.length / d);
    if (inp === 'pad') { const kit = c.filter(p => p.lane <= 1).length / d; (agg[k + '-kit'] = agg[k + '-kit'] || []).push(kit); (agg[k + '-solo'] = agg[k + '-solo'] || []).push(solo / d); }
  }
}
for (const k of Object.keys(agg)) console.log(k.padEnd(18), 'mean', (agg[k].reduce((a, b) => a + b, 0) / agg[k].length).toFixed(1), '/min');
if (ids.length < 6) console.log(JSON.stringify(per));
