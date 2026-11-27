// Assemble public/ (Workers static assets) from the KaraokeTV snapshot + song data, applying the web patches.
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');   // repo root (tv/, phone/, shared/, songs/)
const SRC = process.env.KTV_SRC || ROOT;
const SONGS = process.env.KTV_SONGS || path.join(ROOT, 'songs');
const OUT = path.join(import.meta.dirname, 'public');
const BASE = '/kba';
fs.rmSync(OUT, { recursive: true, force: true });
const dst = p => path.join(OUT, BASE.slice(1), p);
const cp = (a, b) => fs.cpSync(a, b, { recursive: true, filter: s => !path.basename(s).startsWith('._') && !s.includes('custom-versions') });
cp(path.join(SRC, 'tv'), dst('tv')); cp(path.join(SRC, 'phone'), dst('phone')); cp(path.join(SRC, 'shared'), dst('shared'));
cp(SONGS, dst('songs'));
fs.rmSync(dst('tv/songs'), { recursive: true, force: true });   // the TV bundle's local copy; served from /kba/songs instead
fs.copyFileSync(path.join(import.meta.dirname, 'web/m/logo.webp'), dst('tv/img/logo.webp'));
const must = (file, from, to, all) => {
  const f = dst(file); let s = fs.readFileSync(f, 'utf8');
  if (!s.includes(from)) throw new Error(`patch miss in ${file}: ${from.slice(0, 60)}`);
  s = all ? s.split(from).join(to) : s.replace(from, to); fs.writeFileSync(f, s);
};
// patches the TV repo may already contain (v13.9.1+ ships the NOW! logo itself): apply if the old text is still there
const maybe = (file, from, to, all) => { const f = dst(file); const s = fs.readFileSync(f, 'utf8'); if (s.includes(from)) must(file, from, to, all); else console.log('already in source, skipped:', file, from.slice(0, 50)); };
// --- TV app ---
fs.writeFileSync(dst('tv/config.js'), fs.readFileSync(path.join(import.meta.dirname, 'web/config.js'), 'utf8'));
must('tv/index.html', '<script src="config.js"></script>', '<script src="config.js"></script>\n<script src="../web/tv-web.js"></script>');
must('tv/index.html', '<script src="$WEBAPIS/webapis/webapis.js"></script>\n', '');
must('tv/index.html', '<head>', '<head>\n<meta name="robots" content="noindex, nofollow">\n<link rel="stylesheet" href="../web/tv-web.css">');
must('tv/index.html', 'Scan with the iPhone Camera', 'Scan with your phone camera');
maybe('tv/index.html', '<title>KaraokeTV</title>', '<title>NOW! Karaoke Beat Arcade</title>');
maybe('tv/index.html', '<div class="logo"><span class="logo-mic">&#127908;</span>Karaoke<span>TV</span></div>',
  '<img class="wordmark" src="img/logo.webp" alt="NOW! Karaoke Beat Arcade">', true);
maybe('tv/index.html', '<div class="g-logo"><span class="logo-mic">&#127908;</span>Karaoke<span>TV</span></div>',
  '<div class="g-logo"><img class="wordmark" src="img/logo.webp" alt="NOW! Karaoke Beat Arcade"></div>');
maybe('tv/index.html', '<section id="calib" class="screen">\n    <div class="cal-box">',
  '<section id="calib" class="screen">\n    <img class="wordmark" src="img/logo.webp" alt="NOW! Karaoke Beat Arcade">\n    <div class="cal-box">');
maybe('tv/index.html', '<section id="sync" class="screen">\n    <div class="sync-box">',
  '<section id="sync" class="screen">\n    <img class="wordmark" src="img/logo.webp" alt="NOW! Karaoke Beat Arcade">\n    <div class="sync-box">');
maybe('tv/config.xml', '<name>KaraokeTV</name>', '<name>NOW! Karaoke Beat Arcade</name>');
maybe('tv/index.html', "trust the KaraokeTV certificate, then the mic QR", "scan the QR with your phone camera");
must('tv/app.js', "'/api/session'", "'/api/session?s=' + encodeURIComponent(window.KTV_ROOM || '')");
must('tv/app.js', "'/ws?role=tv'", "'/ws?role=tv&s=' + encodeURIComponent(window.KTV_ROOM || '')");
must('tv/app.js', "Local server offline.<br>Start it: npm start", "Reconnecting\u2026");
must('tv/app.js', "  function grade(v) { return v >= 90 ? 'S' : v >= 75 ? 'A' : v >= 60 ? 'B' : v >= 40 ? 'C' : 'D'; }\n",
  "  function grade(v) { return v >= 90 ? 'S' : v >= 75 ? 'A' : v >= 60 ? 'B' : v >= 40 ? 'C' : 'D'; }\n  function kbaPack(kind, rows) {\n    var list = (rows || []).map(function (r, i) {\n      var sc = Math.max(0, Math.min(100, Math.round(+r.score || 0)));\n      return { slot: r.slot || (i + 1), name: r.name, color: r.color || '', av: r.av || ('img/av' + (i % 8) + '.webp'), score: sc, grade: sc >= 90 ? 'S' : sc >= 75 ? 'A' : sc >= 60 ? 'B' : sc >= 40 ? 'C' : 'D', stars: sc >= 90 ? 5 : sc >= 75 ? 4 : sc >= 60 ? 3 : sc >= 40 ? 2 : 1, pitch: r.pitch == null ? null : Math.round(r.pitch), rhythm: r.rhythm == null ? null : Math.round(r.rhythm), combo: r.combo == null ? null : r.combo, late: !!r.late };\n    });\n    var order = list.slice().sort(function (a, b) { return b.score - a.score || a.slot - b.slot; }), last = 0, i;\n    for (i = 0; i < order.length; i++) { if (!i || order[i].score < order[i - 1].score) last = i + 1; order[i]._r = last; }\n    var top = order[0] && order[0].score, one = order.filter(function (x) { return x.score === top; }).length === 1;\n    var art = (window.KARAOKE_CONFIG && KARAOKE_CONFIG.server ? KARAOKE_CONFIG.server : '') + '/songs/' + song.id + '/art.webp';\n    list.forEach(function (r) { var o = order.filter(function (x) { return x.slot === r.slot; })[0]; r.rank = o._r; r.won = list.length > 1 && one && r.score === top; r.kind = kind; r.song = song.id; r.title = song.title; r.artist = song.artist || ''; r.art = art; });\n    return { kind: kind, song: song.id, title: song.title, rows: list.filter(function (r) { return !r.late; }).map(function (r) { return { name: r.name, score: r.score }; }), cards: list };\n  }\n");
must('tv/app.js', "wsSend({ type: 'state', state: 'results', score: br.score });",
  "var pack = kbaPack('beat', [{ slot: 0, name: String(G.beatName || 'Drummer').replace(/^\\S+\\s/, ''), score: br.score, rhythm: typeof accPct === 'function' ? accPct(br.counts) : null, combo: br.maxCombo, av: avatarFor(1) }]); wsSend({ type: 'state', state: 'results', score: br.score, web: pack, cards: pack.cards });");
must('tv/app.js', "wsSend({ type: 'state', state: 'results', score: r.score });",
  "var sl = (G.slots && G.slots[0]) || 1, pack = kbaPack('sing', [{ slot: sl, name: pname(sl), color: slotColor(sl), av: avatarFor(sl), score: r.score, pitch: accPct(r.counts), combo: r.maxCombo }]); wsSend({ type: 'state', state: 'results', score: r.score, web: pack, cards: pack.cards });");
must('tv/app.js', "wsSend({ type: 'state', state: 'results', score: team });",
  "var pack = kbaPack('duet', rows); wsSend({ type: 'state', state: 'results', score: team, web: pack, cards: pack.cards });");
must('tv/app.js', "    var scores = {}; rows.forEach(function (x) { scores[x.slot] = x.score; });\n    wsSend({ type: 'state', state: 'results', score: rows[0].score, scores: scores, winner: battle && !tie ? rows[0].slot : 0, winnerName: battle && !tie ? pname(rows[0].slot) : '' });",
  "    var scores = {}; rows.forEach(function (x) { scores[x.slot] = x.score; });\n    var pack = kbaPack('sing', rows.map(function (x) { return { slot: x.slot, name: pname(x.slot), color: slotColor(x.slot), av: avatarFor(x.slot), score: x.score, pitch: accPct(x.counts), combo: x.combo, late: !!x.late }; }));\n    wsSend({ type: 'state', state: 'results', score: rows[0].score, scores: scores, winner: battle && !tie ? rows[0].slot : 0, winnerName: battle && !tie ? pname(rows[0].slot) : '', web: pack, cards: pack.cards });");
// --- online 1v1 + song-select World Top 5 (web only; inert unless the Worker flags ONLINE_ENABLED / LB_PANEL_ENABLED are "1") ---
must('tv/index.html', '<script src="../web/tv-web.js"></script>', '<script src="../web/tv-web.js"></script>\n<script src="../web/lb-panel.js"></script>\n<script src="../web/online.js"></script>');
must('tv/index.html', '<link rel="stylesheet" href="../web/tv-web.css">', '<link rel="stylesheet" href="../web/tv-web.css">\n<link rel="stylesheet" href="../web/online.css">');
must('tv/app.js', "' <small>\\u25b3 difficulty</small>';\n  }", "' <small>\\u25b3 difficulty</small>';\n    if (window.KBA_LB) try { KBA_LB.song(song.id, playKind()); } catch (e) {}\n  }");
must('tv/app.js', "    if (md !== 'party' && slots.length < 2) md = 'party';\n", "    if (md !== 'party' && slots.length < 2) md = 'party';\n    if (window.KBA_ON && KBA_ON.active) { slots = [KBA_ON.slot(all)]; md = 'party'; }   // online 1v1: this screen's singer only\n");
must('tv/app.js', ": playKind();\n    if (kind === 'rec' && !REC.active)", ": (window.KBA_ON && KBA_ON.active ? 'sing' : playKind());\n    if (kind === 'rec' && !REC.active)");
must('tv/app.js', "  function startGame() {\n    if (!song) return;\n", "  function startGame() {\n    if (!song) return;\n    if (window.KBA_ON && KBA_ON.pickStart && KBA_ON.pickStart(song.id)) return;   // online: PLAY picks the challenge song\n");
must('tv/app.js', "    var r = scorer.finish();\n", "    var r = scorer.finish();\n    if (window.KBA_ON && KBA_ON.active) try { KBA_ON.finished({ score: r.score, combo: r.maxCombo, acc: accPct(r.counts) }); } catch (e) {}\n");
must('tv/app.js', "  window.KaraokeTVDebug = {", "  window.KaraokeTVOnline = {\n    pick: function (id) { for (var i = 0; i < songs.length; i++) if (songs[i] && songs[i].id === id) { if (screen !== 'home') goHome(); selectSong(i); pvStop(); if (audio.mode === 'webaudio' && audio.preload) audio.preload(song.audioUrl, ''); return true; } return false; },\n    ready: function () { return !!song && (audio.mode !== 'webaudio' || !audio.ready || audio.ready(song.audioUrl)); },\n    start: function () { startGame(); },\n    live: function () { return screen === 'game' && scorer ? { score: scorer.liveScore(), combo: scorer.combo || 0, t: +clock().toFixed(2) } : null; },\n    screen: function () { return screen; }, song: function () { return song && song.id; }, players: function () { return PLAYERS; },\n    home: function () { if (screen !== 'home') goHome(); }\n  };\n  window.KaraokeTVDebug = {");
// --- phone page ---
must('phone/index.html', '<script src="/shared/yin.js"></script>', `<script src="${BASE}/shared/yin.js"></script>`);
must('phone/index.html', '<script src="/shared/autotune.js"></script>', `<script src="${BASE}/shared/autotune.js"></script>`);
maybe('phone/index.html', '<script src="/shared/search.js"></script>', `<script src="${BASE}/shared/search.js"></script>`);   // phone Songs tab (v13.12): fuzzy search + songs-tab.js (relative) + songs-index.json (below)
must('phone/index.html', '<script src="phone.js"></script>', `<script src="${BASE}/web/phone-web.js"></script>`);
must('phone/index.html', 'url(/tv/img/stage.jpg)', `url(${BASE}/tv/img/stage.jpg)`);
maybe('phone/index.html', '<title>KaraokeTV Mic</title>', '<title>NOW! Karaoke Beat Arcade</title>');
maybe('phone/index.html', 'src="/tv/img/logo.webp"', 'src="' + BASE + '/web/m/logo.webp"');
maybe('phone/index.html', '<h1>Karaoke<span>TV</span> Mic</h1>', '<img class="wordmark" src="' + BASE + '/web/m/logo.webp" alt="NOW! Karaoke Beat Arcade">');
must('phone/index.html', '<head>', '<head>\n<meta name="robots" content="noindex, nofollow">\n<link rel="stylesheet" href="' + BASE + '/web/phone-web.css">');
must('phone/phone.js', "'/songs/'", `'${BASE}/songs/'`);
must('phone/phone.js', "'/api/stt'", `'${BASE}/api/stt'`);
must('phone/phone.js', "location.host + '/ws?role=phone", `location.host + '${BASE}/ws?role=phone`);
must('phone/phone.js', '  connect();\n', '  window.KTV_PHONE_CONNECT = connect; if (window.KTV_NAME_READY) connect();\n');
must('phone/phone.js', "'No pairing code — scan the TV QR'", "'📷 Scan the TV code again'");
must('phone/phone.js', "'Old QR — rescan the TV'", "'📷 Scan the TV code again'");
must('phone/phone.js', "'Game full (4 players)'", "'😅 4 singers already'");
must('phone/phone.js', "'Reconnecting…'", "'📶 Hold on…'");
must('phone/phone.js', "'TV offline', 'bad'", "'📺 TV is off', 'bad'");
must('phone/phone.js', "'Microphone needs HTTPS. Trust the NOW! Karaoke Beat Arcade certificate on this iPhone (see TV), then reopen this page.'", "'🎤 The mic didn\\u2019t start. Ask to try again.'");
must('phone/phone.js', "'Microphone permission was denied (' + err.name + '). Settings → Safari → Microphone → Allow, then reload.'", "'🎤 The mic is blocked. Ask a grown-up to tap Allow, then reload.'");
must('phone/phone.js', "$('mic').textContent = 'Listening';", "$('mic').textContent = '🎤 Sing!';");
must('phone/index.html', '<button id="mic">Tap to start mic</button>', '<button id="mic">🎤 Tap to sing</button>');
cp(path.join(import.meta.dirname, 'web'), dst('web'));
fs.rmSync(dst('web/config.js'));
// song list for the server-side checks (durations)
const idx = JSON.parse(fs.readFileSync(path.join(SONGS, 'index.json'), 'utf8'));
// phone Songs tab index (titles, artists, categories; no audio). Only when the TV source has the Songs tab (shared/phone-index.js)
if (fs.existsSync(path.join(SRC, 'shared/phone-index.js'))) {
  const { createRequire } = await import('node:module');
  const PhoneIndex = createRequire(import.meta.url)(path.join(SRC, 'shared/phone-index.js'));
  fs.writeFileSync(dst('phone/songs-index.json'), JSON.stringify(PhoneIndex.build(idx, (fs.existsSync(path.join(SONGS, 'library.json')) ? JSON.parse(fs.readFileSync(path.join(SONGS, 'library.json'), 'utf8')) : {}))));
}
fs.writeFileSync(path.join(import.meta.dirname, 'src/songs-meta.json'), JSON.stringify(Object.fromEntries(idx.map(s => [s.id, { t: s.title, a: s.artist, d: s.duration }]))));
// online 1v1 opponent model + Spin random: per-song line timing/weights from the pitch notes (no lyrics, no audio). Songs without notes are not singable.
{
  const prof = {};
  for (const s of idx) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(SONGS, s.id, 'song.json'), 'utf8')); } catch (e) { continue; }
    const notes = (j.notes || []).filter(n => n && n.d > 0 && isFinite(n.t)); if (notes.length < 20) continue;
    const tot = notes.reduce((a, n) => a + n.d, 0), by = new Map();
    for (const n of notes) { const k = n.line == null ? Math.floor(n.t / 6) : n.line; const g = by.get(k) || { t: n.t, e: 0, w: 0, n: 0 }; g.t = Math.min(g.t, n.t); g.e = Math.max(g.e, n.t + n.d); g.w += n.d; g.n++; by.set(k, g); }
    const L = [...by.values()].sort((a, b) => a.t - b.t).map(g => [+g.t.toFixed(2), +g.e.toFixed(2), Math.max(1, Math.round(1000 * g.w / tot)), g.n]);
    const span = Math.max(1, notes[notes.length - 1].t - notes[0].t), dens = notes.length / span;
    const m = notes.map(n => n.midi).filter(Number.isFinite), mean = m.reduce((a, b) => a + b, 0) / m.length, sd = Math.sqrt(m.reduce((a, b) => a + (b - mean) ** 2, 0) / m.length);
    let jumps = 0; for (let i = 1; i < notes.length; i++) jumps += Math.min(12, Math.abs(notes[i].midi - notes[i - 1].midi)); jumps /= notes.length;
    const df = Math.max(0, Math.min(1, 0.35 * Math.min(1, dens / 4) + 0.35 * Math.min(1, sd / 6) + 0.3 * Math.min(1, jumps / 5)));
    prof[s.id] = { n: notes.length, df: +df.toFixed(2), L };
  }
  fs.writeFileSync(path.join(import.meta.dirname, 'src/song-profiles.json'), JSON.stringify(prof));
  console.log('song profiles:', Object.keys(prof).length, 'singable of', idx.length);
}
const sizes = {}; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(mp3|wav)$/.test(e.name)) sizes['/' + path.relative(OUT, p)] = fs.statSync(p).size; } })(OUT);
fs.writeFileSync(path.join(import.meta.dirname, 'src/asset-sizes.json'), JSON.stringify(sizes));
let n = 0, big = 0; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { n++; if (fs.statSync(p).size > 25 * 1024 * 1024) big++; } } })(OUT);
console.log('built', n, 'files;', big, 'over 25 MiB;', idx.length, 'songs');
