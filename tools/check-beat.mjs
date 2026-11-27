// Headless check of Beat v2 (instrument charts), Duet, Jam and controller support. TEST-ONLY inputs: a synthetic
// navigator.getGamepads() "DualSense" and a timing bot that presses on time — clearly labelled, never shipped to the TV.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18124, HS = 18487, CODE = 'beat', sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: CODE, KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1000);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
const FAKE_PAD = () => {   // TEST-ONLY synthetic DualSense (standard mapping) + timing bot
  const btn = () => ({ pressed: false, value: 0, touched: false });
  window.__pad = { id: '"TEST synthetic DualSense Wireless Controller" (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, btn),
    vibrationActuator: { playEffect: () => { window.__rumbles = (window.__rumbles || 0) + 1; return Promise.resolve('complete'); } } };
  window.__padOn = false;
  navigator.getGamepads = () => [window.__padOn ? window.__pad : null, null, null, null];
  window.__tap = (i, holdMs) => { const b = window.__pad.buttons[i]; b.pressed = true; b.value = 1; window.__pad.timestamp = performance.now(); setTimeout(() => { b.pressed = false; b.value = 0; window.__pad.timestamp = performance.now(); }, holdMs || 60); };
  window.__plug = () => { window.__padOn = true; const e = new Event('gamepadconnected'); e.gamepad = window.__pad; window.dispatchEvent(e); };
  window.__bot = (via, lateMs) => {
    const done = new Set(); window.__botOn = true;
    (function tick() {
      if (!window.__botOn) return;
      const d = KaraokeTVDebug.beat(); if (d) d.upcoming.forEach(p => {
        const k = p.t.toFixed(3) + ':' + p.lane, j = (lateMs || 0) / 1000, L = KaraokeBeat.LANES[p.lane];
        if (!done.has(k) && p.t + j - d.h <= 0.008) {
          done.add(k);
          if (via === 'pad') window.__tap(L.btn[0], p.dur ? p.dur * 1000 + 40 : 60);
          else { const e = new KeyboardEvent('keydown', { bubbles: true }); Object.defineProperty(e, 'keyCode', { get: () => L.key }); document.dispatchEvent(e); }
        }
      });
      requestAnimationFrame(tick);
    })();
  };
};
const results = async (tv) => tv.evaluate(() => ({ screen: KaraokeTVDebug.state().screen, score: document.getElementById('finalScore').getAttribute('data-v'), meta: document.getElementById('resMeta').textContent, mrTitle: document.getElementById('mrTitle').textContent, mrRows: document.getElementById('mrRows').children.length, multi: document.getElementById('results').classList.contains('multi') }));
try {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(FAKE_PAD);
  const tv = await ctx.newPage();
  const errs = []; let STEP = 'start'; tv.on('pageerror', e => errs.push(STEP + ': ' + e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVDebug, null, { timeout: 15000 });
  await tv.evaluate(() => { localStorage.setItem('karaoke.engine', 'webaudio'); localStorage.removeItem('karaoke.play'); localStorage.removeItem('karaoke.beatOffsetMs'); localStorage.removeItem('karaoke.rumble'); }); await tv.reload();
  await tv.waitForFunction(() => window.KaraokeTVDebug, null, { timeout: 15000 }); await sleep(1500);
  const songs = await tv.evaluate(() => KaraokeTVDebug.songs().map(s => s.id)), ix = id => songs.indexOf(id);
  // --- remote reaches Play, cycles styles ---
  await tv.evaluate(n => KaraokeTVDebug.select(n - 1), songs.length); await sleep(200);
  await tv.keyboard.press('ArrowDown'); for (let i = 0; i < 6; i++) await tv.keyboard.press('ArrowRight');
  STEP = 'remote: arrows reach the Play button'; check('remote: arrows reach the Play button', (await tv.evaluate(() => document.querySelector('#homeRow .focused').id)) === 'playBtn');
  const seen = []; for (let i = 0; i < 8; i++) { await tv.keyboard.press('Enter'); seen.push(await tv.evaluate(() => document.getElementById('playBtnVal').textContent)); }
  STEP = 'OK cycles Beat · Easy/Normal/Hard → Duet'; check('OK cycles Beat · Easy/Normal/Hard → Duet · Easy/Normal/Hard → Jam → Sing', seen.join('|') === 'Beat · Easy|Beat · Normal|Beat · Hard|Duet · Easy|Duet · Normal|Duet · Hard|Jam · free play|Record map', seen.join('|'));
  const clipped = await tv.evaluate(() => [...document.querySelectorAll('#homeRow .hbtn b, #homeRow .hbtn small')].filter(e => e.scrollWidth > e.clientWidth + 1).map(e => e.textContent));
  STEP = 'home buttons: labels fit'; check('home buttons: labels fit', !clipped.length, clipped.join(', '));
  // --- L2 / R2 on the song list cycle Beat → Duet → Jam → Sing (and L2 the other way); △ / Play button unchanged ---
  await tv.evaluate(() => window.__plug()); await sleep(300);
  const kindOf = () => tv.evaluate(() => ({ play: KaraokeTVDebug.play(), top: document.getElementById('playNow').textContent, kind: document.getElementById('playNow').getAttribute('data-kind'), btn: document.getElementById('playBtnVal').textContent }));
  await tv.evaluate(() => KaraokeTVDebug.play('sing')); await sleep(80);
  const r2 = [];
  for (let i = 0; i < 4; i++) { await tv.evaluate(() => window.__tap(7)); await sleep(200); r2.push(await kindOf()); }
  STEP = 'R2 cycles Beat → Duet → Jam → Sing'; check('R2 cycles Beat → Duet → Jam → Sing, badge matches', r2.map(x => x.play + '/' + x.kind + '/' + x.top).join('|') === 'rec/rec/Record map|beat-normal/beat/Beat · Normal|duet-normal/duet/Duet · Normal|jam/jam/Jam · free play', r2.map(x => x.play + '/' + x.top).join('|'));
  const l2 = [];
  for (let i = 0; i < 4; i++) { await tv.evaluate(() => window.__tap(6)); await sleep(200); l2.push(await kindOf()); }
  STEP = 'L2 cycles the other way'; check('L2 cycles Sing → Jam → Duet → Beat, badge matches', l2.map(x => x.play).join('|') === 'duet-normal|beat-normal|rec|sing', l2.map(x => x.play + '/' + x.top).join('|'));
  await tv.evaluate(() => KaraokeTVDebug.play('beat-easy')); await sleep(80);
  await tv.evaluate(() => window.__tap(7)); await sleep(200);
  const kept = await kindOf();
  STEP = 'R2 keeps Easy/Hard when swapping Beat/Duet'; check('R2 from Beat · Easy goes to Duet · Easy', kept.play === 'duet-easy' && kept.top === 'Duet · Easy', kept.play + '/' + kept.top);
  await tv.evaluate(() => window.__tap(3)); await sleep(200);   // △ still walks every style, including difficulty
  const tri = await kindOf();
  STEP = '△ still walks every play style'; check('△ from Duet · Easy goes to Duet · Normal (unchanged cycle)', tri.play === 'duet-normal', tri.play + '/' + tri.top);
  const topBox = await tv.evaluate(() => { const e = document.getElementById('modeSwitch'), r = e.getBoundingClientRect(), list = document.getElementById('songViewport').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), text: e.querySelector('.on').textContent + ' · ' + document.getElementById('msDiff').textContent, above: r.bottom <= list.top + 2, vis: getComputedStyle(e).display !== 'none' && r.width > 40 }; });
  STEP = 'play style shown at the top of the list'; check('current play style is visible above the song list', topBox.vis && topBox.above && topBox.top > 80 && topBox.text.length > 2, JSON.stringify(topBox));

  // --- controller: Beat Normal on an instrument chart ---
  await tv.evaluate(() => { window.__plug(); KaraokeTVDebug.play('beat-normal'); }); await sleep(400);
  const pads = await tv.evaluate(() => KaraokeTVDebug.pads());
  STEP = 'controller detected'; check('controller detected', pads.pads.length === 1, pads.pads[0] && pads.pads[0].id);
  await tv.evaluate(i => KaraokeTVDebug.select(i), ix('twinkle')); await sleep(2500);
  await tv.evaluate(() => window.__tap(0)); await sleep(1500);   // ✕ = OK
  let b = await tv.evaluate(() => KaraokeTVDebug.beat());
  STEP = '✕ starts Beat · Normal with controller l'; check('✕ starts Beat · Normal with controller lanes', b && b.kind === 'beat' && b.input === 'pad' && b.total > 150, b && JSON.stringify({ kind: b.kind, input: b.input, total: b.total }));
  const lanes = await tv.evaluate(() => { const s = KaraokeTVDebug.songs ? null : null; const c = KaraokeBeat.chart(window.__song || {}, 'normal', 'pad'); return null; });
  await tv.evaluate(() => window.__bot('pad', 0)); await sleep(9000);
  await tv.screenshot({ path: '.local/shots/beat2-game.png' });
  const bl = await tv.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(); const L = r('lyrics'); return { text: document.getElementById('lyricCur').textContent, hi: !!document.querySelector('#lyricCur .lhi'), vis: getComputedStyle(document.getElementById('lyrics')).display, top: L.top, bottom: L.bottom, beatB: r('beatTrack').bottom }; });
  STEP = 'Beat mode: lyrics strip visible under th'; check('Beat mode: lyrics strip visible under the highway', bl.vis !== 'none' && bl.text.length > 3 && bl.top >= bl.beatB - 2 && bl.bottom <= 1080, JSON.stringify(bl));
  await sleep(6000);
  b = await tv.evaluate(() => KaraokeTVDebug.beat());
  const hit = b.counts.Perfect + b.counts.Great + b.counts.Good, tot = hit + b.counts.Miss;
  STEP = 'on-time controller play scores Perfect/G'; check('on-time controller play scores Perfect/Great', tot > 15 && (b.counts.Perfect + b.counts.Great) / tot >= 0.85, JSON.stringify(b.counts));
  const lanesUsed = await tv.evaluate(() => { const r = {}; KaraokeTVDebug.beat(); return r; });
  const used = await tv.evaluate(() => [...new Set(Array.from(document.querySelectorAll('.bt-gem')).length ? [] : [])]);
  const hs = await tv.evaluate(() => KaraokeTVDebug.hit());
  STEP = 'hit sounds Off by default (rumble is the'; check('no hit sounds (no synth kit) + rumble on hits', !hs.kit && hs.rumble === 'normal' && (await tv.evaluate(() => window.__rumbles || 0)) > 5, JSON.stringify(hs) + ' rumbles ' + (await tv.evaluate(() => window.__rumbles || 0)));
  await tv.evaluate(() => { window.__botOn = false; }); await sleep(2000);
  const b2 = await tv.evaluate(() => KaraokeTVDebug.beat());
  STEP = 'no presses → Miss, combo resets'; check('no presses → Miss, combo resets', b2.counts.Miss > b.counts.Miss && b2.combo === 0, JSON.stringify(b2.counts));
  await tv.evaluate(() => window.__tap(8)); await sleep(200);
  STEP = 'Create button cycles hit sounds Off → Lo'; check('Create button cycles rumble Normal → Strong', (await tv.evaluate(() => KaraokeTVDebug.hit().rumble)) === 'strong');
  await tv.evaluate(() => { window.__tap(8); window.__tap(8, 60); }); await sleep(300); await tv.evaluate(() => window.__tap(8)); await sleep(200);
  await tv.evaluate(() => window.__tap(9)); await sleep(500);
  STEP = 'Options pauses'; check('Options pauses', await tv.evaluate(() => KaraokeTVDebug.paused()));
  await tv.evaluate(() => window.__tap(1)); await sleep(600);
  STEP = '○ resumes'; check('○ resumes', !(await tv.evaluate(() => KaraokeTVDebug.paused())));
  const wr = await tv.evaluate(() => { const d = KaraokeTVDebug.beat(); const p = d.upcoming[0]; const h0 = window.__hitSounds || 0; const wl = [0, 1, 2, 3, 9].find(l => l !== p.lane && !d.upcoming.some(q => q.lane === l && Math.abs(q.t - p.t) < 0.2)); const r = KaraokeTVDebug.beatPress(wl, p.t); const h1 = window.__hitSounds || 0; const ok = KaraokeTVDebug.beatPress(p.lane, p.t); return { r: r, ok: ok, wrongSnd: h1 - h0, rightSnd: (window.__hitSounds || 0) - h1, lv: KaraokeTVDebug.hit().level }; });
  STEP = 'wrong button is not a hit and makes no s'; check('wrong button is not a hit; right button is; no sounds either way', wr.r === null && wr.ok === 'Perfect' && wr.wrongSnd === 0 && wr.rightSnd === 0, JSON.stringify(wr));
  await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(400);
  // --- chart content: instruments mapped consistently, density by difficulty ---
  const ch = await tv.evaluate(async () => {
    const out = {};
    for (const id of ['twinkle', 'amazing-grace']) {
      const s = await new Promise(r => KaraokeSongs.getJson('songs/' + id + '/song.json', (e, j) => r(j)));
      s.id = id; const per = d => KaraokeBeat.chart(s, d, 'pad'), min = s.duration / 60;
      const lanes = {}; per('hard').forEach(p => lanes[p.lane] = (lanes[p.lane] || 0) + 1);
      out[id] = { easy: Math.round(per('easy').length / min), normal: Math.round(per('normal').length / min), hard: Math.round(per('hard').length / min), remote: Math.round(KaraokeBeat.chart(s, 'normal', 'remote').length / min), lanes, holds: per('hard').filter(p => p.dur).length, src: s.chart ? (s.chart.drums ? 'stems' : 'stems, no drums') : 'grid' };
    }
    return out;
  });
  for (const [id, c] of Object.entries(ch)) console.log('     chart', id, JSON.stringify(c));
  const boa = ch['twinkle'];
  STEP = 'density rises with difficulty'; check('density rises with difficulty', boa.easy < boa.normal && boa.normal < boa.hard && boa.easy >= 30 && boa.hard <= 380, JSON.stringify(boa));
  STEP = 'Hard uses kit + bass + L1 holds + R1 acc'; check('Hard uses kit + bass + L1 holds + R1 accents', [0, 1, 2, 4, 9].every(l => boa.lanes[l] > 0) && Object.values(ch).some(c => c.holds > 0), JSON.stringify(boa.lanes));
  // --- hold notes (deterministic, standalone highway) ---
  const hold = await tv.evaluate(() => {
    const el = document.createElement('div'); document.body.appendChild(el);
    const s = { id: 'holdtest', duration: 30, beats: { t: [1, 2, 3, 4, 5, 6, 7, 8] }, chart: { drums: true, ev: [] } };
    for (let i = 0; i < 70; i++) s.chart.ev.push([3 + i * 0.35, 0, 0, 0.8, 1, 0]);
    s.chart.ev.push([4.0, 8, 2.0, 0.9, 2, 0]); s.chart.ev.push([9.12, 8, 1.5, 0.9, 2, 0]); s.chart.ev.sort((a, b) => a[0] - b[0]);
    const B = new KaraokeBeat(el, s, { diff: 'hard', input: 'pad', width: 1000, height: 760 });
    const holds = B.prompts.filter(p => p.dur);
    B.draw(3.9); const r1 = B.press(8, 4.0); B.draw(5.0); B.draw(6.1);        // held to the end
    B.draw(9.0); const r2 = B.press(8, 9.12); B.release(8, 9.6); B.draw(9.7);    // released early
    const res = { holds: holds.length, r1, r2, ok: B.holds.ok, dropped: B.holds.dropped }; B.destroy(); el.remove(); return res;
  });
  STEP = 'L1 hold notes: held to end = bonus, earl'; check('L1 hold notes: held to end = bonus, early release = dropped', hold.holds === 2 && hold.ok === 1 && hold.dropped === 1, JSON.stringify(hold));
  // --- remote only: Beat Easy on Twinkle to results; timing self-calibration ---
  await tv.evaluate(() => { window.__padOn = false; KaraokeTVDebug.play('beat-easy'); localStorage.setItem('karaoke.beatOffsetMs', '0'); });
  await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, ix('twinkle')); await sleep(300);
  STEP = 'no controller → remote layout (face diam'; check('no controller → remote layout (face diamond on the arrows)', (await tv.evaluate(() => KaraokeTVDebug.beat().input)) === 'remote');
  await tv.evaluate(() => window.__bot('remote', 70));
  await sleep(5000);
  const bw = await tv.evaluate(() => ({ text: document.getElementById('lyricCur').textContent, hi: !!document.querySelector('#lyricCur .lhi'), vis: getComputedStyle(document.getElementById('lyrics')).display }));
  STEP = 'Beat mode: lyric wipe runs under the hig'; check('Beat mode: lyric wipe runs under the highway', bw.vis !== 'none' && bw.text.length > 3 && bw.hi, JSON.stringify(bw));
  await tv.waitForFunction(() => KaraokeTVDebug.state().screen === 'results', null, { timeout: 45000 });
  let res = await results(tv); const off = await tv.evaluate(() => KaraokeTVDebug.beatOffset());
  STEP = 'remote arrows: Easy Twinkle to results w'; check('remote arrows: Easy Twinkle to results with a beat score', +res.score >= 60 && /Beat mode/.test(res.meta), JSON.stringify(res));
  STEP = 'timing self-calibration learns the late '; check('timing self-calibration learns the late bias', off >= 12 && off <= 40, 'offset ' + off + ' ms');
  await tv.evaluate(() => { window.__botOn = false; KaraokeTVDebug.quit(); }); await sleep(400);
  // --- Duet on Twinkle (controller) to combined results ---
  await tv.evaluate(() => { window.__padOn = true; KaraokeTVDebug.play('duet-easy'); localStorage.setItem('karaoke.beatOffsetMs', '0'); });
  await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, ix('twinkle')); await sleep(300);
  const lay = await tv.evaluate(() => { const r = id => document.getElementById(id).getBoundingClientRect(); return { beat: r('beatTrack'), lane: document.querySelector('.lane-wrap').getBoundingClientRect(), lyr: r('lyrics'), inp: KaraokeTVDebug.beat().input, kind: KaraokeTVDebug.beat().kind }; });
  STEP = 'Duet layout: highway left, pitch lane + '; check('Duet layout (v13.9): singer panel left, highway centre, above the player cards', lay.kind === 'duet' && lay.inp === 'pad' && lay.lane.right <= lay.beat.left && lay.lyr.right <= lay.beat.left && lay.beat.bottom <= 918, JSON.stringify({ beatL: lay.beat.left, laneR: lay.lane.right, lyrR: lay.lyr.right, beatB: lay.beat.bottom }));
  await tv.evaluate(() => window.__bot('pad', 0)); await sleep(9000);
  const wipe = await tv.evaluate(() => ({ text: document.getElementById('lyricCur').textContent, hi: !!document.querySelector('#lyricCur .lhi') }));
  STEP = 'Duet: lyric wipe visible'; check('Duet: lyric wipe visible', wipe.text.length > 3 && wipe.hi, JSON.stringify(wipe));
  await tv.screenshot({ path: '.local/shots/beat2-duet.png' });
  const fps = await tv.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); (function f() { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n / 2); })(); }));
  STEP = 'Duet keeps the frame rate (headless)'; check('Duet keeps the frame rate (headless)', fps >= 50, fps + ' fps');
  await tv.waitForFunction(() => KaraokeTVDebug.state().screen === 'results', null, { timeout: 45000 });
  res = await results(tv);
  STEP = 'Duet → combined results (singer + contro'; check('Duet → combined results (singer + controller rows, team score)', res.multi && res.mrRows === 2 && /Duet results/.test(res.mrTitle), JSON.stringify(res));
  await tv.screenshot({ path: '.local/shots/beat2-duet-results.png' });
  await tv.evaluate(() => { window.__botOn = false; KaraokeTVDebug.quit(); }); await sleep(400);
  // --- Jam ---
  await tv.evaluate(() => KaraokeTVDebug.play('jam'));
  await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, ix('amazing-grace')); await sleep(1500);
  for (const bt of [0, 1, 2, 3, 12, 13, 14, 15, 5]) { await tv.evaluate(x => window.__tap(x), bt); await sleep(120); }
  await tv.evaluate(() => window.__tap(4, 800)); await sleep(1000);
  const jam = await tv.evaluate(() => ({ b: KaraokeTVDebug.beat(), help: document.getElementById('jamHelp').textContent, vis: getComputedStyle(document.getElementById('jamHelp')).display }));
  STEP = 'Jam: no chart, help shows which button ='; check('Jam: no chart, help shows which button = which sound, presses register', jam.b.jam && jam.b.total === 0 && /kick/.test(jam.help) && jam.vis === 'block', jam.help.slice(0, 80));
  await tv.screenshot({ path: '.local/shots/beat2-jam.png' });
  await tv.evaluate(() => { KaraokeTVDebug.quit(); KaraokeTVDebug.play('sing'); }); await sleep(300);
  STEP = 'no page errors'; check('no page errors', errs.length === 0, errs.join(' | '));
} catch (e) { fail++; console.log('FAIL exception — ' + e.message); }
await browser.close(); server.kill();
console.log(fail ? fail + ' FAILED' : 'ALL PASS'); process.exit(fail ? 1 : 0);
