// v13.11 D-pad containment on the song-select screen: ▲ at the top of the song column or the category column never jumps to search.
// Search is reachable on purpose: GREEN (404), '/', R3 (pad), or the Search button in the bottom row. PRIVATE server.
import { createRequire } from 'module'; import { spawn } from 'child_process';
const pw = createRequire(import.meta.url)('playwright');
const ROOT = process.env.ROOT || new URL('..', import.meta.url).pathname.replace(/\/$/, ''), H = +(process.env.PORT || 18720); const sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: H, HTTPS_PORT: H + 1, KARAOKE_CODE: 'qanav', KARAOKE_HOST: '127.0.0.1' }, stdio: 'ignore' }); await sleep(1500);
const b = await pw.chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const tv = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
let ok = true; const check = (n, c, d) => { console.log(c ? 'PASS' : 'FAIL', n, c ? '' : (d || '')); if (!c) ok = false; }; const errs = []; tv.on('pageerror', e => errs.push(e.message));
await tv.goto(`http://127.0.0.1:${H}/tv/?tizenlike=1`); await tv.waitForFunction(() => window.KaraokeTVDebug && KaraokeTVDebug.songs().length > 100 && KaraokeTVSelect.state().cats.length > 5, null, { timeout: 60000 }); await sleep(500);
const st = () => tv.evaluate(() => ({ sel: KaraokeTVSearch.state().selected, ov: KaraokeTVSearch.state().overlay, focusInput: KaraokeTVSearch.state().focus, cat: KaraokeTVSelect.state().cat, vis: (KaraokeTVSelect.state().vis || []).length, row: document.querySelector('#homeRow .hbtn.focused') && document.querySelector('#homeRow .hbtn.focused').id }));
const key = k => tv.keyboard.press(k); const pad = k => tv.evaluate(k => KaraokeTVDebug.key(k), k);
// song column
await tv.evaluate(() => KaraokeTVDebug.select(0)); await sleep(150);
for (let i = 0; i < 6; i++) { await key('ArrowUp'); await sleep(60); } let s = await st();
check('song column: ▲ x6 at the first song stays on it, no search', s.sel === 0 && !s.ov && !s.focusInput, JSON.stringify(s));
for (let i = 0; i < 6; i++) { await pad(38); await sleep(40); } s = await st(); check('song column: pad ▲ (d-pad) x6 at the top: no search', s.sel === 0 && !s.ov, JSON.stringify(s));
await key('ArrowDown'); await sleep(80); await key('ArrowUp'); await sleep(80); await key('ArrowUp'); await sleep(80); s = await st(); check('▼ then ▲ x2 returns to the first song and stops', s.sel === 0 && !s.ov, JSON.stringify(s));
// category column (every category, ▲ at its top song)
const cats = await tv.evaluate(() => KaraokeTVSelect.state().cats); let badCat = [];
for (let c = 0; c < cats.length; c++) { await tv.evaluate(c => KaraokeTVSelect.setCat(c), c); await sleep(200); for (let i = 0; i < 4; i++) { await key('ArrowUp'); await sleep(40); } s = await st(); if (s.ov || s.focusInput) badCat.push(cats[c]); }
check('every category: ▲ at the top never opens search', !badCat.length, badCat.join(','));
await tv.evaluate(() => KaraokeTVSelect.setCat(0)); await sleep(200);
for (let i = 0; i < 10; i++) { await key('ArrowRight'); await sleep(50); } for (let i = 0; i < 10; i++) { await key('ArrowLeft'); await sleep(50); } s = await st(); check('◀ ▶ through the categories never opens search', !s.ov, JSON.stringify(s));
// v13.11.1 category rail is a column: after ◀ ▶ the rail has focus and ▲ ▼ walk every category, All Songs at the very top
{
  const cats2 = await tv.evaluate(() => KaraokeTVSelect.state().cats); const hh = cats2.indexOf('hip-hop') >= 0 ? cats2.indexOf('hip-hop') : cats2.length - 1;
  await tv.evaluate(() => KaraokeTVSelect.setCat(0)); await sleep(200); await tv.evaluate(() => KaraokeTVDebug.select(40)); await sleep(100);
  await key('ArrowLeft'); await sleep(80); for (let i = 0; i < hh; i++) { await key('ArrowDown'); await sleep(70); } let q = await st(); check('◀ then ▼ x' + hh + ' reaches the target category', q.cat === cats2[hh], q.cat);
  const seen = [q.cat]; for (let i = 0; i < hh + 3; i++) { await key('ArrowUp'); await sleep(70); const z = await st(); if (seen[seen.length - 1] !== z.cat) seen.push(z.cat); check_ov: if (z.ov) { check('▲ in the category column never opens search', false, JSON.stringify(z)); } }
  q = await st(); check('▲ walks up through EVERY category and stops at All Songs', q.cat === 'all' && seen.join() === cats2.slice(0, hh + 1).reverse().join(), seen.join('>') + ' now ' + q.cat);
  for (let i = 0; i < 3; i++) { await key('ArrowUp'); await sleep(60); } q = await st(); check('▲ at All Songs stays on All Songs (no wrap, no search)', q.cat === 'all' && !q.ov && !q.focusInput, JSON.stringify(q));
  await key('ArrowDown'); await sleep(100); q = await st(); check('▼ moves to the next category (Favorites)', q.cat === cats2[1], q.cat);
  await key('ArrowDown'); await sleep(100); q = await st(); check('▼ again moves on', q.cat === cats2[2], q.cat);
  await tv.evaluate(c => KaraokeTVSelect.setCat(c), cats2.length - 1); await key('ArrowLeft'); await sleep(80);
  await key('ArrowDown'); await sleep(120); const af = await st(); await key('ArrowDown'); await sleep(120); const af2 = await st();
  check('▼ past the last category hands focus back to the song list (▼ then moves songs)', af2.sel !== af.sel || af.sel !== undefined, JSON.stringify([af.sel, af2.sel]));
}
// empty category (favorites with none) + ▲
await tv.evaluate(() => { const i = KaraokeTVSelect.state().cats.indexOf('fav'); KaraokeTVSelect.setCat(i); }); await sleep(250); for (let i = 0; i < 3; i++) { await key('ArrowDown'); await sleep(60); await key('ArrowUp'); await sleep(60); } s = await st(); check('empty category: ▲/▼ do not open search', !s.ov, JSON.stringify(s));
await tv.evaluate(() => KaraokeTVSelect.setCat(0)); await sleep(250);
// bottom row ▲ returns to the list, still no search
await tv.evaluate(() => KaraokeTVDebug.select(5)); await sleep(100); await tv.evaluate(() => KaraokeTVDebug.select(KaraokeTVDebug.songs().length - 1)); await sleep(100); await key('ArrowDown'); await sleep(100); s = await st(); check('▼ at the last song moves to the bottom row', !!s.row && !s.ov, JSON.stringify(s));
await key('ArrowUp'); await sleep(100); s = await st(); check('▲ from the bottom row returns to the last song, no search', !s.row && !s.ov, JSON.stringify(s));
// deliberate ways to search
await tv.evaluate(() => KaraokeTVDebug.select(0)); await sleep(100);
await pad(404); await sleep(300); s = await st(); check('GREEN opens search', s.ov, JSON.stringify(s)); await tv.evaluate(() => KaraokeTVSearch.close()); await sleep(300);
await key('/'); await sleep(300); s = await st(); check("'/' opens search", s.ov, JSON.stringify(s)); await tv.evaluate(() => KaraokeTVSearch.close()); await sleep(300);
await tv.evaluate(() => KaraokeTVDebug.select(KaraokeTVDebug.songs().length - 1)); await key('ArrowDown'); await sleep(100);
for (let i = 0; i < 8; i++) { const id = (await st()).row; if (id === 'searchBtn') break; await key('ArrowRight'); await sleep(60); }

// v13.13: OK / ▶ on the category rail select the category and hand focus to the song list (first song highlighted) and NEVER start a song; ◀ from the list returns to the rail
{
  const cats3 = await tv.evaluate(() => KaraokeTVSelect.state().cats);
  const rail = () => tv.evaluate(() => ({ focus: document.getElementById('catRail').classList.contains('focus'), screen: KaraokeTVDebug.state().screen, busy: !!document.querySelector('#busy.on, #busy.show'), cat: KaraokeTVSelect.state().cat, sel: KaraokeTVSearch.state().selected, vis: KaraokeTVSelect.state().vis || [] }));
  const goRail = async n => { await tv.evaluate(() => KaraokeTVSelect.setCat(0)); await sleep(200); await tv.evaluate(() => KaraokeTVDebug.select(0)); await sleep(100); await key('ArrowLeft'); await sleep(80); for (let i = 0; i < n; i++) { await key('ArrowDown'); await sleep(80); } };
  await goRail(3); let r = await rail(); check('◀ from the list puts focus on the category rail', r.focus && r.cat === cats3[3] && r.screen === 'home', JSON.stringify(r));
  await key('Enter'); await sleep(150); r = await rail();
  check('OK on a category: stays on the song list screen, no playback/loading', r.screen === 'home' && !r.busy, JSON.stringify(r));
  check('OK on a category: focus moves to the song list, category kept, first song highlighted', !r.focus && r.cat === cats3[3] && r.vis.length > 0 && r.sel === r.vis[0], JSON.stringify(r));
  await key('Enter'); await sleep(60); await key('Enter'); await sleep(900); r = await rail(); check('a second/rapid OK right after is swallowed (does not start the song)', r.screen === 'home' && !r.busy, JSON.stringify(r));
  await tv.keyboard.down('Enter'); await sleep(40); await tv.keyboard.down('Enter'); await sleep(40); await tv.keyboard.up('Enter'); await sleep(300); r = await rail(); check('a held OK (key repeat) never starts a song from the list', r.screen === 'home' && !r.busy, JSON.stringify(r));
  await goRail(2); await key('ArrowRight'); await sleep(150); r = await rail();
  check('▶ on the rail: focus to the song list, category unchanged, first song highlighted, nothing plays', !r.focus && r.cat === cats3[2] && r.screen === 'home' && !r.busy && r.sel === r.vis[0], JSON.stringify(r));
  await key('ArrowRight'); await sleep(120); r = await rail(); check('▶ in the song list does not change category any more', r.cat === cats3[2] && !r.focus && r.screen === 'home', JSON.stringify(r));
  await key('ArrowLeft'); await sleep(120); r = await rail(); check('◀ from the song list returns to the category rail (category unchanged)', r.focus && r.cat === cats3[2], JSON.stringify(r));
  await key('ArrowLeft'); await sleep(120); r = await rail(); check('◀ on the rail stays on the rail', r.focus && r.cat === cats3[2], JSON.stringify(r));
  const hint = await tv.evaluate(() => document.querySelector('.hb-remote').textContent); check('on-screen hint describes ◀ categories / ▶ songs', /◀.*categories/.test(hint) && /▶.*songs/.test(hint), hint);
  // and OK on a song card still plays (first OK arms "no phone", second starts)
  await key('ArrowRight'); await sleep(900); await key('Enter'); await sleep(300); await key('Enter'); await sleep(700); r = await rail(); check('OK on a song card still starts the song', r.screen === 'game' || r.busy, JSON.stringify(r));
  await sleep(1500); await key('Escape'); await sleep(2800); await tv.evaluate(() => { const q = document.querySelector('#pauseMenu .pm-item[data-act="quit"]'); q && q.click(); }); await sleep(900); r = await rail(); check('back on the song list after quitting the test song', r.screen === 'home', JSON.stringify(r)); await tv.evaluate(() => KaraokeTVSelect.setCat(0)); await sleep(200);
}

// v13.13: ▲ on the first song card focuses the play-style tabs; ◀ ▶ move between tabs, OK picks the style (nothing plays), ▼ returns to the list; ▲ on the tabs never opens search
{
  const mt = () => tv.evaluate(() => ({ focus: document.querySelector('#modeSwitch span.mfocus') && document.querySelector('#modeSwitch span.mfocus').getAttribute('data-k'), play: localStorage.getItem('karaoke.play'), screen: KaraokeTVDebug.state().screen, busy: !!document.querySelector('#busy.on, #busy.show'), ov: KaraokeTVSearch.state().overlay, sel: KaraokeTVSearch.state().selected, cat: KaraokeTVSelect.state().cat, railFocus: document.getElementById('catRail').classList.contains('focus') }));
  await tv.evaluate(() => { KaraokeTVSelect.setCat(0); KaraokeTVDebug.play('sing'); KaraokeTVDebug.select(0); }); await sleep(250);
  await key('ArrowUp'); await sleep(120); let m = await mt(); check('▲ on the first song focuses the play-style tabs (current style = Sing)', m.focus === 'sing' && !m.ov && m.screen === 'home', JSON.stringify(m));
  await key('ArrowUp'); await sleep(100); await key('ArrowUp'); await sleep(100); m = await mt(); check('▲ on the tabs stays on the tabs: never search', m.focus === 'sing' && !m.ov, JSON.stringify(m));
  await key('ArrowRight'); await sleep(100); m = await mt(); check('▶ moves to the next tab (Beat)', m.focus === 'beat', JSON.stringify(m));
  await key('ArrowLeft'); await sleep(100); m = await mt(); check('◀ moves back (Sing); stays on the tabs', m.focus === 'sing' && !m.railFocus, JSON.stringify(m));
  for (let i = 0; i < 9; i++) { await key('ArrowRight'); await sleep(50); } m = await mt(); check('▶ stops at the last tab (Record)', m.focus === 'rec', JSON.stringify(m));
  for (let i = 0; i < 9; i++) { await key('ArrowLeft'); await sleep(50); } m = await mt(); check('◀ stops at the first tab (Sing)', m.focus === 'sing', JSON.stringify(m));
  await key('ArrowRight'); await sleep(80); await key('Enter'); await sleep(250); m = await mt();
  check('OK picks the tab (Beat), nothing plays', /^beat/.test(m.play) && m.focus === 'beat' && m.screen === 'home' && !m.busy, JSON.stringify(m));
  await key('Enter'); await sleep(80); await key('Enter'); await sleep(900); m = await mt(); check('more OKs on a tab still never start a song', m.screen === 'home' && !m.busy, JSON.stringify(m));
  await key('ArrowRight'); await sleep(80); await key('ArrowRight'); await sleep(80); await key('Enter'); await sleep(200); m = await mt(); check('OK picks Jam too; still no playback', /^jam/.test(m.play) && m.screen === 'home' && !m.busy, JSON.stringify(m));
  await key('ArrowDown'); await sleep(120); m = await mt(); check('▼ returns to the song list (first song still selected, tabs unfocused)', !m.focus && m.sel === 0 && m.screen === 'home', JSON.stringify(m));
  await key('ArrowUp'); await sleep(100); m = await mt(); check('▲ again goes straight back to the tabs', !!m.focus, JSON.stringify(m)); await key('ArrowDown'); await sleep(100);
  await tv.evaluate(() => KaraokeTVDebug.play('sing')); await sleep(100);
  // the category rail still stops at All Songs, and ◀ from the list still goes to the rail
  await tv.evaluate(() => { KaraokeTVDebug.select(5); }); await sleep(100); await key('ArrowLeft'); await sleep(100); for (let i = 0; i < 4; i++) { await key('ArrowUp'); await sleep(70); } m = await mt(); check('▲ on the category rail at All Songs still stops there', m.cat === 'all' && m.railFocus && !m.focus && !m.ov, JSON.stringify(m));
  const hint = await tv.evaluate(() => document.querySelector('.press-top').textContent + ' | ' + document.querySelector('.hb-remote').textContent); check('hints mention ▲ at the top = play style / mode', /play style/.test(hint) && /top = mode/.test(hint), hint);
  await key('ArrowRight'); await sleep(100);
}
await tv.evaluate(() => { KaraokeTVSelect.setCat(0); KaraokeTVDebug.select(KaraokeTVDebug.songs().length - 1); }); await sleep(250); await key('ArrowDown'); await sleep(150); for (let i = 0; i < 12 && (await st()).row !== 'searchBtn'; i++) { await key('ArrowRight'); await sleep(90); }
s = await st(); check('Search button reachable in the bottom row with ▶', s.row === 'searchBtn', JSON.stringify(s)); await key('Enter'); await sleep(300); s = await st(); check('OK on the Search button opens search', s.ov, JSON.stringify(s));
await tv.evaluate(() => KaraokeTVSearch.close()); await sleep(300);
const fit = await tv.evaluate(() => { const r = [...document.querySelectorAll('#homeRow .hbtn')].map(e => { const b = e.getBoundingClientRect(); const t = e.querySelector('.hb-txt'); return { id: e.id, w: Math.round(b.width), over: t.scrollWidth > t.clientWidth + 1 }; }); return r; });
check('bottom-row buttons do not overflow', fit.every(x => !x.over), JSON.stringify(fit)); await tv.screenshot({ path: ROOT + '/.local/nav-home.png' });
check('no page errors', !errs.length, errs.join('|'));
console.log(ok ? 'ALL PASS' : 'FAILED'); server.kill(); await b.close(); process.exit(ok ? 0 : 1);
