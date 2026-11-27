// Headless check of the v13.4.2 Duet layout: thinner pitch lane + 5-line lyric list (prev / current / next 3).
// Private server (never the live :8780). Sweeps EVERY line of every song through the real renderer (duetAt) and checks:
// the current line never advances before the next line starts, every slot fits (width + inside the lyric box), no overlap
// with the highway / lane. Screenshot of a real Duet round to .local/shots/duet-v1342.png. No scoring input is simulated.
import { createRequire } from 'module'; import { spawn } from 'child_process'; import path from 'path';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const H = 18164, HS = 18597, sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: HS, KARAOKE_CODE: 'duetlyr', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' });
await sleep(1000);
const browser = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? ' — ' + d : '')); };
try {
  const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = []; tv.on('pageerror', e => errs.push(e.message));
  await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVDebug, null, { timeout: 15000 });
  await tv.evaluate(() => { localStorage.setItem('karaoke.engine', 'webaudio'); localStorage.setItem('karaoke.play', 'duet-easy'); }); await tv.reload();
  await tv.waitForFunction(() => window.KaraokeTVDebug, null, { timeout: 15000 }); await sleep(1200);
  const songs = await tv.evaluate(() => KaraokeTVDebug.songs().map(s => s.id));
  // 1) real Duet round on Twinkle: layout + natural lyric rendering + screenshot
  await tv.evaluate(i => { KaraokeTVDebug.play('duet-easy'); KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, songs.indexOf('twinkle'));
  await tv.waitForFunction(() => KaraokeTVDebug.state().t > 13.2, null, { timeout: 30000 });
  const lay = await tv.evaluate(() => { const r = s => document.querySelector(s).getBoundingClientRect(); const v = id => document.getElementById(id).textContent;
    return { beat: r('#beatTrack'), lane: r('.lane-wrap'), lyr: r('#lyrics'), prog: r('#pCards'), prev: v('lyricPrev'), cur: v('lyricCur'), n1: v('lyricNext'), n2: v('lyricNext2'), n3: v('lyricNext3'), hi: !!document.querySelector('#lyricCur .lhi') }; });
  await tv.screenshot({ path: '.local/shots/duet-v1342.png' });
  check('pitch lane in the singer panel (≤ 276 px)', Math.round(lay.lane.height) <= 276, 'lane h ' + Math.round(lay.lane.height));
  check('v13.9 no overlap: lane + lyrics (singer panel) | highway, all above the player cards', lay.lane.right <= lay.beat.left && lay.lyr.right <= lay.beat.left && lay.lane.bottom <= lay.lyr.top && lay.lyr.bottom <= lay.prog.top + 2 && lay.beat.bottom <= lay.prog.top + 2, JSON.stringify({ beatL: lay.beat.left, beatB: lay.beat.bottom, laneR: lay.lane.right, laneB: lay.lane.bottom, lyrT: lay.lyr.top, lyrB: lay.lyr.bottom, progT: lay.prog.top }));
  check('real round shows current (wipe) + next lines (4-line list)', lay.cur && lay.n1 && lay.n2 && lay.hi, JSON.stringify([lay.prev, lay.cur, lay.n1, lay.n2, lay.n3]));
  // 2) frame rate stays (headless) while lyrics run
  const fps = await tv.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); (function f() { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n / 2); })(); }));
  check('Duet frame rate (headless)', fps >= 50, fps + ' fps');
  await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(400);
  // 3) sweep every line of every song through the renderer
  const noChart = [];
  let clipN = 0, tinyN = 0, lines = 0, early = [], wide = [], outside = [], lateSwitch = [], minFs = 99, twoRow = 0;
  for (const id of songs) {
    if (process.env.ONLY && !process.env.ONLY.split(',').includes(id)) continue;   // ONLY=user-a,user-b to sweep just those
    await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, songs.indexOf(id)); await sleep(350);
    if (!(await tv.evaluate(() => !!KaraokeTVDebug.beat()))) { noChart.push(id); await tv.evaluate(() => KaraokeTVDebug.quit()); await sleep(250); continue; }   // no beat chart yet (still importing): Duet falls back to Sing, nothing to sweep
    const r = await tv.evaluate(() => {
      const out = { n: 0, early: [], wide: [], outside: [], late: [], minFs: 99, two: 0 }, L = KaraokeTVDebug.songs().length && null;
      const probe = KaraokeTVDebug.duetAt(0), n = probe.n, ts = [];
      for (let i = 0; i < n; i++) ts.push(KaraokeTVDebug.lineT(i));
      for (let i = 0; i < n; i++) {
        const t = ts[i], tn = i + 1 < n ? ts[i + 1] : t + 4;
        // just after the line starts, and 0.2 s before the next line starts: the current line must still be line i
        const tiny = tn - t < 0.3;   // garbled source timing (two lines < 0.3 s apart): can't be held without delaying the next
        if (tiny) out.tiny = (out.tiny || 0) + 1;
        for (const h of tiny ? [] : [t + 0.05, tn - 0.2]) {
          const s = KaraokeTVDebug.duetAt(h); out.n++;
          const cur = s.slots[1];
          if (s.idx !== i) out.early.push(i + '@' + h.toFixed(2) + '->' + s.idx);
          for (const sl of s.slots) { if (sl.id === 'lyricPrev') continue;   // v13.9: 4-line list, prev hidden by design
            if (sl.sw > s.W + 2 && sl.clip && sl.id !== 'lyricCur') { out.clip = (out.clip || 0) + 1; } else if (sl.sw > s.W + 2) out.wide.push(i + ':' + sl.id + ' ' + sl.sw); if (sl.text && (sl.bottom > s.box.bottom + 1 || sl.top < s.box.top - 1)) out.outside.push(i + ':' + sl.id + (' ' + JSON.stringify({ h: +h.toFixed(2), top: Math.round(sl.top), bot: Math.round(sl.bottom), fs: sl.fs, box: [Math.round(s.box.top), Math.round(s.box.bottom)], txt: sl.text.slice(0, 40) }))); }
          if (cur.fs) out.minFs = Math.min(out.minFs, cur.fs); if (cur.rows === 2) out.two++;
        }
        if (i + 1 < n && !(i + 2 < n && ts[i + 2] - ts[i + 1] < 0.3)) { const s = KaraokeTVDebug.duetAt(ts[i + 1] + 0.01); if (s.idx !== i + 1) out.late.push(i + 1); }
      }
      return out;
    });
    lines += r.n; tinyN += r.tiny || 0; clipN += r.clip || 0; minFs = Math.min(minFs, r.minFs); twoRow += r.two;
    early.push(...r.early.slice(0, 3).map(x => id + ' ' + x)); wide.push(...r.wide.slice(0, 3).map(x => id + ' ' + x)); outside.push(...r.outside.slice(0, 3).map(x => id + ' ' + x)); lateSwitch.push(...r.late.slice(0, 3).map(x => id + ' ' + x));
    await tv.evaluate(() => { KaraokeTVDebug.lyricsOn(); KaraokeTVDebug.quit(); }); await sleep(250);
  }
  // static render of a long line (two-row wrap) for the report — labelled as a duetAt render, not live play
  await tv.evaluate(i => { KaraokeTVDebug.select(i); KaraokeTVDebug.start(); }, songs.indexOf('amazing-grace')); await sleep(500);
  await tv.evaluate(() => { let best = 0, bl = 0; for (let i = 0; i < KaraokeTVDebug.duetAt(0).n; i++) { const s = KaraokeTVDebug.duetAt(KaraokeTVDebug.lineT(i) + 0.6); if (s.slots[1].rows === 2 && s.slots[1].text.length > bl) { bl = s.slots[1].text.length; best = i; } } KaraokeTVDebug.duetAt(KaraokeTVDebug.lineT(best) + 0.6); });
  await sleep(200); await tv.screenshot({ path: '.local/shots/duet-v1342-wrap.png' });
  await tv.evaluate(() => { KaraokeTVDebug.lyricsOn(); KaraokeTVDebug.quit(); }); await sleep(250);
  check(`current line never leaves before the next line starts (${songs.length} songs, ${lines} probes)`, !early.length, early.slice(0, 6).join('; ') || tinyN + ' lines skipped: source timing < 0.3 s apart');
  check('next line takes over once it actually starts', !lateSwitch.length, lateSwitch.slice(0, 6).join('; '));
  check('every slot fits the lyric width (shrink / two-row wrap)', !wide.length, wide.slice(0, 6).join('; ') || `current min font ${minFs}px, ${twoRow} two-row probes; ${clipN} look-ahead probes ellipsised (very long lines, shown in full once current)`);
  check('every slot stays inside the lyric box', !outside.length, outside.slice(0, 6).join('; '));
  if (noChart.length) console.log('SKIP (no beat chart yet, Duet n/a): ' + noChart.join(', '));
  check('no page errors', !errs.length, errs.slice(0, 3).join(' | '));
} catch (e) { fail++; console.log('FAIL run — ' + e.message); }
await browser.close(); server.kill();
console.log(fail ? `${fail} FAILED` : 'ALL PASS'); process.exit(fail ? 1 : 0);
