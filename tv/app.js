/* KaraokeTV — TV side: song playback, lyrics, pitch lane, live scoring from real phone pitch frames. */
(function () {
  'use strict';
  var CFG = window.KARAOKE_CONFIG;
  var BUILD = 'v13.15.1';
  var DEV = window.KaraokeDev = { overlay: true, tiles: true, feedback: true, lyrics: true, hud: true, bg: true };
  var S = window.KaraokeScoring;
  var $ = function (id) { return document.getElementById(id); };
  // TV: the old <audio> player until the silent engine check passes (karaoke.engine = 'webaudio'); browsers: Web Audio.
  var TVLIKE = !!window.tizen || /[?&]tizenlike=1/.test(location.search);   // ?tizenlike=1: headless tests of the TV code path
  var audio = new KaraokeEngine($('audio'), { prefer: TVLIKE ? (localStorage.getItem('karaoke.engine') || 'element') : 'webaudio', slice: TVLIKE || /[?&]slice=1/.test(location.search) });   // Web Audio: backing + guide sample-locked, live voices (falls back to <audio>)
  var params = new URLSearchParams(location.search);

  // ---------- stage scaling (designed at 1920x1080) ----------
  // safeScale < 1 shrinks the whole 1920x1080 stage (for TVs with overscan); remembered per TV
  var safeScale = +(localStorage.getItem('karaoke.safeScale') || 1);
  var imeLock = false, fitBusy = false, fitIgnored = 0, lastGood = { w: 1920, h: 1080 };
  function fit() {
    // Lock the 1920x1080 stage. The Tizen IME shrinks innerHeight; rescaling the whole tree
    // (109 song cards + art) was what made the background shrink and then crashed the TV.
    if (fitBusy) return; fitBusy = true;
    try {
      if (imeLock) { fitIgnored++; return; }
      var iw = window.innerWidth, ih = window.innerHeight;
      var sw = (window.screen && window.screen.width) || iw, sh = (window.screen && window.screen.height) || ih;
      if (TVLIKE) { iw = sw; ih = sh; }   // TV (and tizenlike tests): always the hardware screen, never the IME viewport
      var k = Math.min(iw / 1920, ih / 1080) * safeScale;
      var st = $('stage');
      st.style.transform = Math.abs(k - 1) < 0.001 ? 'none' : 'scale(' + k + ')';
      st.style.left = Math.round((iw - 1920 * k) / 2) + 'px';
      st.style.top = Math.round((ih - 1080 * k) / 2) + 'px';
      st.style.width = '1920px'; st.style.height = '1080px';
      fit.k = k; lastGood = { w: iw, h: ih };
    } finally { fitBusy = false; }
  }
  function viewportReport() {
    var d = document.documentElement, st = $('stage');
    return { type: 'perf', screen: 'viewport', build: BUILD, iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio,
      sw: window.screen && window.screen.width, sh: window.screen && window.screen.height, cw: d.clientWidth, ch: d.clientHeight,
      stageScale: fit.k, safeScale: safeScale, imeLock: imeLock, fitIgnored: fitIgnored,
      stageT: st && st.style.transform, ua: navigator.userAgent.slice(0, 160), src: /Tizen/i.test(navigator.userAgent) ? 'tv' : 'browser' };
  }
  function onWinResize() { fit(); }
  window.addEventListener('resize', onWinResize);
  if (window.visualViewport) visualViewport.addEventListener('resize', function () { if (imeLock) { fitIgnored++; return; } });
  fit();
  window.KaraokeTVFit = { state: function () { var st = $('stage'), r = st.getBoundingClientRect(); return { k: fit.k || 1, imeLock: imeLock, ignored: fitIgnored, iw: window.innerWidth, ih: window.innerHeight, tw: st.offsetWidth, th: st.offsetHeight, t: st.style.transform || 'none', left: st.style.left, top: st.style.top, rw: r.width, rh: r.height }; }, lock: function (on) { imeLock = !!on; }, fit: fit };

  // ---------- state ----------
  var screen = 'home', song = null, scorer = null, trail = [], phone = { connected: false, mic: 'off' };
  var tvLegMs = 20, phoneLatMs = 60, tvRtts = [], lastClockSent = 0, startConfirmed = false, finished = false;
  var source = null;

  function show(id) {
    if (id !== screen && typeof foBegin === 'function' && id !== 'home') foBegin('screen:' + id);
    if (id !== 'home' && typeof catFocusSet === 'function') { catFocusSet(false); mtFocusSet(false); }
    if (id === 'home' && QFORCE) { QFORCE = false; try { renderPlay(); } catch (e) {} }
    screen = id; var st = $('stage'); if (st) st.className = 'on-' + id; if (id !== 'home' && typeof pvStop === 'function') pvStop(); if (id !== 'home' && imeLock && typeof searchClose === 'function') searchClose(false);
    ['home', 'game', 'results', 'calib', 'sync'].forEach(function (s) { $(s).classList.toggle('active', s === id); });
  }

  // ---------- songs: built-in Twinkle + optional Stingray featured song ----------
  var songs = [], selected = 0, focusCal = false;
  function prepSong(s) {
    var lo = 127, hi = 0;
    (s.notes.length ? s.notes : [{ midi: 60 }, { midi: 72 }]).forEach(function (n) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); });
    s.lo = lo - 4; s.hi = hi + 4;
    if (s.scorable == null) s.scorable = s.notes.length > 0;
    return s;
  }
  function selectSong(i) { if (MTZ) mtFocusSet(false);
    prepLines(songs[i]);
    selected = i; song = songs[i];
    var cards = document.querySelectorAll('.song-card');
    for (var k = 0; k < cards.length; k++) cards[k].classList.toggle('focused', k === i);
    var rb = $('homeRow').children; for (k = 0; k < rb.length; k++) rb[k].classList.remove('focused'); focusCal = false;
    scrollList(i);
    if (typeof showGuide === 'function') try { showGuide(); } catch (e) {}
    $('tEnd').textContent = fmt(song.duration);
    var titles = document.querySelectorAll('.hud-title'); for (k = 0; k < titles.length; k++) titles[k].textContent = song.title;
    // v13.11: highlighting a song loads NO audio (no decode, no prefetch, no preview): audio is fetched/decoded only when the user starts it
    if (audio.mode === 'webaudio' && audio.getAttribute('src') !== song.audioUrl) audio.src = song.audioUrl;
    showCalInfo(); if (typeof renderPlay === 'function') renderPlay();
    renderPreviewCard(); pvSchedule(); try { warmArt(); } catch (e) {}
  }
  // TV widget (file://): songs + audio stream from the local server, so the package stays small and new songs need no reinstall.
  var REMOTE_SONGS = !/^https?:/.test(location.protocol), SONG_BASE = REMOTE_SONGS ? CFG.server + '/songs/' : 'songs/';
  source = new KaraokeSongs.LocalSongSource(SONG_BASE);
  function addCard(i, s, extraArtist, icon, chips) {
    var card = i === 0 ? $('songCard') : $('songCard').cloneNode(true);
    if (i > 0) { card.id = 'songCard' + i; card.classList.remove('focused'); }
    card.querySelector('.title').textContent = s.title;
    card.querySelector('.artist').textContent = s.artist + extraArtist;
    card.querySelector('.star').textContent = icon;
    var im = card.querySelector('.art-img'); im.onerror = function () { this.style.display = 'none'; }; im.style.display = ''; im.src = SONG_BASE + s.id + '/art.webp';
    card.querySelector('.chips').innerHTML = chips.filter(Boolean).map(function (c) { return '<span class="chip">' + esc(c) + '</span>'; }).join('');
    if (i > 0) $('songList').appendChild(card);
    listGeom = null;
  }
  // song list = clipped viewport scrolled with translate3d so the focused card (and cal button) always fit on screen
  var listGeom = null, listY = 0;
  function scrollList(i) {
    var cards = $('songList').children, vp = $('songViewport');
    if (!listGeom) listGeom = { vh: vp.clientHeight, tops: [], hs: [], total: $('songList').offsetHeight };
    if (listGeom.tops.length !== cards.length) for (var k = 0; k < cards.length; k++) { listGeom.tops[k] = cards[k].offsetTop; listGeom.hs[k] = cards[k].offsetHeight; }
    var g = listGeom, max = Math.max(0, g.total - g.vh), margin = (g.hs[0] || 104) * 0.6;
    if (i >= 0 && i < cards.length) {
      var top = g.tops[i], bot = top + g.hs[i];
      if (top - listY < margin) listY = top - margin;
      if (bot - listY > g.vh - margin) listY = bot - g.vh + margin;
    }
    listY = Math.round(Math.max(0, Math.min(max, listY)));
    $('songList').style.transform = 'translate3d(0,' + (-listY) + 'px,0)';
    $('fadeTop').classList.toggle('show', listY > 2);
    var below = 0; for (k = 0; k < cards.length; k++) if (g.tops[k] + g.hs[k] * 0.5 > listY + g.vh) below++;
    $('fadeBottom').classList.toggle('show', listY < max - 2);
    $('moreBelow').textContent = below ? '\u25bc ' + below + ' more' : '';
    $('songCount').textContent = visList ? '\u00b7 ' + visList.length + ' match' + (visList.length === 1 ? '' : 'es') : '\u00b7 ' + (i + 1) + ' / ' + cards.length;
  }
  var ICONS = { twinkle: '★', 'amazing-grace': '✦' };
  KaraokeSongs.getJson(SONG_BASE + 'index.json', function (err, list) {
    if (err && REMOTE_SONGS) { setTimeout(function () { toast('Can\u2019t reach the song server on the server (' + CFG.server + ') \u2014 check it\u2019s on, then reopen the app.', 15000); }, 1500); }
    if (err) list = [{ id: 'twinkle' }];
    var pending = list.length, loaded = [];
    list.forEach(function (entry, i) {
      source.load(entry.id, function (e, s) {
        if (!e) { loaded[i] = prepSong(s); try { s.pick = localStorage.getItem('karaoke.pick.' + s.id) || 'auto'; } catch (x) { s.pick = 'auto'; } }
        if (--pending) return;
        loaded.filter(Boolean).forEach(function (sg, j) {
          songs[j] = sg;
          addCard(j, sg, sg.source === 'ingest' ? '' : ' · Piano karaoke', ICONS[sg.id] || '♪', [fmt(sg.duration), sg.source === 'ingest' ? (sg.notes.length ? 'Scored' : 'Sing-along') : (sg.difficulty || 'Easy')]);
        });
        if (!songs.length) { toast('Could not load songs.'); return; }
        selectSong(0); loadLibrary(); renderPlayerPill(); warmStart();
        if (params.get('autostart')) setTimeout(startGame, 300);
        loadStingray();
      });
    });
  });


  // ---------- v13.7: Record map (lay out your own beat pattern with the controller, save it on the server) ----------
  var REC = { ui: null, idx: 0, draft: null, hist: [], dirty: false, sec: 0, a: 0, b: 0, snap: 2, speed: 0, count: true, lane: 0, active: null, preview: null, warn: false, msg: '' };
  var SNAPS = [['1/4', 1], ['1/8', 2], ['1/16', 4], ['off', 0]], SPEEDS = [1, 0.75];
  function recBeatLen(t) { var bt = song.beats && song.beats.t; if (!bt || bt.length < 2) return 0.5; var k = 0; while (k < bt.length - 2 && bt[k + 1] <= t) k++; return bt[k + 1] - bt[k]; }
  function recSnap(t, div) {
    var bt = song.beats && song.beats.t; if (!div || !bt || bt.length < 2 || t < bt[0] || t >= bt[bt.length - 1]) return t;
    var lo = 0, hi = bt.length - 2; while (lo < hi) { var m = (lo + hi + 1) >> 1; if (bt[m] <= t) lo = m; else hi = m - 1; }
    var L = bt[lo + 1] - bt[lo], q = Math.round((t - bt[lo]) / L * div); return Math.round((bt[lo] + q * L / div) * 1000) / 1000;
  }
  function recParts() {
    var d = song.duration || 0, out = [{ name: 'Whole song', a: 0, b: d }], f = (song.chart && song.chart.feat) || [], cut = [0, d], i;
    f.forEach(function (x) { if (x[2] === 'solo') out.push({ name: 'Solo ' + fmt(x[0]) + '\u2013' + fmt(x[1]), a: x[0], b: x[1] }); else cut.push(x[0]); });
    cut.sort(function (p, q) { return p - q; }); var cl = [];
    cut.forEach(function (t) { if (!cl.length || t - cl[cl.length - 1] >= 8) cl.push(t); else if (t === d) cl[cl.length - 1] = d; });
    for (i = 0; i + 1 < cl.length; i++) out.push({ name: 'Part ' + (i + 1) + ' \u00b7 ' + fmt(cl[i]) + '\u2013' + fmt(cl[i + 1]), a: cl[i], b: cl[i + 1] });
    out.push({ name: 'Custom start / end', a: null, b: null });
    return out;
  }
  function recSetPart(n) {
    var P = recParts(); REC.sec = (n + P.length) % P.length; var p = P[REC.sec];
    if (p.a != null) { REC.a = p.a; REC.b = p.b; }
  }
  function recOpen() {
    if (!song || !(song.beats && song.beats.t)) { toast('This song has no beat grid yet, so it can\u2019t be recorded.', 4000); return; }
    var C = song.custom;
    REC.draft = { ev: C && C.ev ? C.ev.map(function (e) { return e.slice(); }) : [], sections: C && C.sections ? C.sections.map(function (r) { return r.slice(); }) : [], merge: C ? C.merge !== false : true };
    REC.hist = []; REC.dirty = false; REC.idx = 0; REC.warn = false; REC.lane = 0; REC.msg = C && C.ev && C.ev.length ? 'Loaded your saved map (' + C.ev.length + ' notes, saved ' + String(C.saved || '').slice(0, 10) + ')' : 'No map for this song yet: record a section to start.';
    recSetPart(0); REC.ui = 'menu'; recRender(); $('recPanel').classList.add('show');
  }
  function recClose() { REC.ui = null; $('recPanel').classList.remove('show'); renderPlay(); }
  var REC_LANES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  function laneName(l) { var L = KaraokeBeat.LANES[l]; return L.sym + ' ' + L.name; }
  function recRows() {
    var P = recParts(); REC.sec = Math.max(0, Math.min(P.length - 1, REC.sec)); var d = REC.draft, inSec = d.ev.filter(function (e) { return e[0] >= REC.a && e[0] < REC.b; }).length, has = d.ev.length > 0;
    return [
      { k: 'sec', label: 'Section', val: P[REC.sec].a == null ? 'Custom' : P[REC.sec].name, lr: function (x) { recSetPart(REC.sec + x); } },
      { k: 'a', label: 'Start', val: fmt(REC.a), lr: function (x) { REC.sec = P.length - 1; REC.a = Math.max(0, Math.min(REC.b - 2, REC.a + x)); } },
      { k: 'b', label: 'End', val: fmt(REC.b), lr: function (x) { REC.sec = P.length - 1; REC.b = Math.min(song.duration, Math.max(REC.a + 2, REC.b + x)); } },
      { k: 'snap', label: 'Snap to beat grid', val: SNAPS[REC.snap][0] + (SNAPS[REC.snap][1] ? ' note' : ' (exact)'), lr: function (x) { REC.snap = (REC.snap + x + SNAPS.length) % SNAPS.length; } },
      { k: 'speed', label: 'Speed', val: Math.round(SPEEDS[REC.speed] * 100) + '%', lr: function (x) { REC.speed = (REC.speed + x + SPEEDS.length) % SPEEDS.length; } },
      { k: 'count', label: 'Count-in', val: REC.count ? '4 beats' : 'Off', lr: function () { REC.count = !REC.count; } },
      { k: 'rec', label: '\u25cf Record this section', act: recStart, val: inSec ? 'replaces ' + inSec + ' notes' : '', hot: true },
      { k: 'prev', label: '\u25b6 Preview / play it', act: has ? recPreview : null, val: has ? fmt(REC.a) + '\u2013' + fmt(REC.b) : 'nothing recorded yet' },
      { k: 'undo', label: '\u27f2 Undo last change', act: REC.hist.length ? recUndo : null, val: REC.hist.length ? REC.hist.length + ' step' + (REC.hist.length > 1 ? 's' : '') : '' },
      { k: 'lane', label: '\u2716 Clear a lane in this section', val: laneName(REC_LANES[REC.lane]), lr: function (x) { REC.lane = (REC.lane + x + REC_LANES.length) % REC_LANES.length; }, act: inSec ? recClearLane : null },
      { k: 'merge', label: 'Outside my sections', val: d.merge ? 'Auto chart plays' : 'Empty (only my notes)', lr: function () { d.merge = !d.merge; REC.dirty = true; } },
      { k: 'save', label: '\ud83d\udcbe Save my map', act: has || (song.custom && song.custom.ev) ? recSave : null, val: REC.dirty ? 'unsaved changes' : (song.custom && song.custom.ev ? 'saved' : ''), hot: REC.dirty },
      { k: 'pick', label: 'Play this song with', val: song.pick === 'mine' ? 'My map' : 'Auto map', lr: function () { if (song.custom && song.custom.ev && song.custom.ev.length) togglePick(true); }, act: null },
      { k: 'exit', label: '\u23cf Back to the song list', act: recExit }
    ];
  }
  function recRender() {
    var R = recRows(); REC.idx = Math.max(0, Math.min(R.length - 1, REC.idx));
    $('recSong').textContent = song.title + ' \u2014 ' + song.artist;
    var d = REC.draft, secs = d.sections.length;
    $('recStatus').textContent = (REC.msg ? REC.msg + ' \u00b7 ' : '') + 'Draft: ' + d.ev.length + ' notes' + (secs ? ' in ' + secs + ' section' + (secs > 1 ? 's' : '') : '') + (REC.dirty ? ' \u00b7 not saved' : '');
    $('recRows').innerHTML = R.map(function (r, i) {
      var dis = !r.act && !r.lr;
      return '<div class="rec-row' + (i === REC.idx ? ' focused' : '') + (dis ? ' dis' : '') + (r.hot ? ' hot' : '') + '"><span class="rr-l">' + esc(r.label) + '</span><span class="rr-v">' + (r.lr ? '\u25c0 ' : '') + esc(r.val || '') + (r.lr ? ' \u25b6' : '') + '</span></div>';
    }).join('');
  }
  function recKey(k) {
    var R = recRows(), r = R[REC.idx];
    if (k === 38 || k === 40) { REC.idx = (REC.idx + (k === 40 ? 1 : -1) + R.length) % R.length; REC.warn = false; }
    else if ((k === 37 || k === 39) && r.lr) { r.lr(k === 39 ? (r.k === 'a' || r.k === 'b' ? 1 : 1) : -1); }
    else if (k === 13 && r.act) { REC.warn = false; r.act(); if (!REC.ui) return; }
    else if (k === 13 && r.lr) r.lr(1);
    else if (k === 10009 || k === 8 || k === 27) { recExit(); if (!REC.ui) return; }
    recRender();
  }
  function recExit() {
    if (REC.dirty && !REC.warn) { REC.warn = true; REC.msg = 'Not saved! Press Back again to throw this take away, or pick \ud83d\udcbe Save'; recRender(); return; }
    recClose(); toast(REC.dirty ? 'Recording discarded' : '', 1500);
  }
  function recStart() {
    var a = REC.a, b = REC.b, bl = recBeatLen(a), rate = SPEEDS[REC.speed];
    REC.active = { a: a, b: b, from: Math.max(0, a - (REC.count ? 4 * bl + 0.3 : 1.0)), bl: bl, rate: rate, div: SNAPS[REC.snap][1], notes: [], held: {},
      ghost: REC.draft.ev.map(function (e) { return { t: e[0], lane: e[1], dur: e[2] || 0 }; }) };
    REC.ui = null; $('recPanel').classList.remove('show');
    startGame();
  }
  function recHelp(input) {
    var A = REC.active; return '<b>\u25cf REC</b> ' + fmt(A.a) + '\u2013' + fmt(A.b) + ' \u00b7 snap ' + SNAPS[REC.snap][0] + (A.rate !== 1 ? ' \u00b7 ' + Math.round(A.rate * 100) + '% speed' : '') + ' \u2014 ' +
      (input === 'pad' ? '\u2715 \u25cb \u25a1 \u25b3, D-pad, L1, R1 each put a note in their lane (hold = long note).' : 'the arrows put notes in the \u2715 \u25cb \u25a1 \u25b3 lanes.') + ' Back/Options = stop';
  }
  function recCount(t) {
    var A = REC.active || REC.preview, toGo = A.a - t, bl = REC.active ? REC.active.bl : 0.5;
    if (REC.active && REC.count && toGo > 0 && toGo <= 4 * bl) return String(Math.min(4, Math.ceil(toGo / bl - 1e-3)));
    if (REC.active && toGo <= 0 && toGo > -0.7) return '\u25cf REC';
    return '';
  }
  function recTime(src, ageMs) {   // song time the player HEARD when pressing (output + input latency, learned human bias), in song seconds
    var r = audio.rate || 1; return clock() - r * (judgeLagMs(src) + (ageMs || 0) - beatOffsetMs()) / 1000;
  }
  function recPress(lane, src, ageMs) {
    var A = REC.active; if (!A || screen !== 'game' || finished || paused || !beat) return null;
    var raw = recTime(src, ageMs); rumble(lane, 'Good'); beat.fxHit(lane, 'Great');
    if (raw < A.a - 0.15 || raw > A.b + 0.15) return null;
    var t = Math.max(A.a, Math.min(A.b - 0.001, recSnap(raw, A.div)));
    var n = { t: t, lane: lane, dur: 0, raw: raw, live: true }; A.notes.push(n); A.held[lane] = n; return 'Rec';
  }
  function recRelease(lane, src, ageMs) {
    var A = REC.active; if (!A) return; var n = A.held[lane]; if (!n) return; delete A.held[lane];
    var end = recTime(src, ageMs), d = end - n.raw; n.live = false;
    if (d >= 0.3) { var e2 = Math.min(A.b, recSnap(n.t + d, A.div || 4)); n.dur = Math.max(0.2, Math.round((e2 - n.t) * 1000) / 1000); }
  }
  function recEnd() {
    var A = REC.active; if (!A) return; REC.active = null;
    for (var l in A.held) { var n = A.held[l]; n.live = false; var d = A.b - n.raw; if (d >= 0.3) n.dur = Math.round(d * 1000) / 1000; }
    finished = true; audio.pause(); stopGuide(); audio.setRate && audio.setRate(1); paused = false; $('game').classList.remove('paused', 'recording');
    if (beat) { beat.destroy(); beat = null; }
    var d0 = REC.draft; REC.hist.push(JSON.stringify(d0)); if (REC.hist.length > 30) REC.hist.shift();
    var keep = d0.ev.filter(function (e) { return !(e[0] >= A.a && e[0] < A.b); }), seen = {}, add = [];
    A.notes.sort(function (p, q) { return p.t - q.t; }).forEach(function (n) { var key = n.lane + '@' + Math.round(n.t * 25); if (seen[key]) return; seen[key] = 1; add.push([n.t, n.lane, n.dur || 0]); });
    d0.ev = keep.concat(add).sort(function (p, q) { return p[0] - q[0] || p[1] - q[1]; });
    var S = d0.sections.concat([[A.a, A.b]]).sort(function (p, q) { return p[0] - q[0]; }), M = [];
    S.forEach(function (r) { if (M.length && r[0] <= M[M.length - 1][1] + 0.01) M[M.length - 1][1] = Math.max(M[M.length - 1][1], r[1]); else M.push(r.slice()); });
    d0.sections = M; REC.dirty = true;
    REC.msg = add.length ? 'Recorded ' + add.length + ' notes in ' + fmt(A.a) + '\u2013' + fmt(A.b) : 'No presses: that section is now empty (\u27f2 Undo brings it back)';
    show('home'); wsSend({ type: 'state', state: 'home' });
    REC.ui = 'menu'; REC.idx = 7; recRender(); $('recPanel').classList.add('show');
    wsSend({ type: 'perf', screen: 'recmap', build: BUILD, src: window.tizen ? 'tv' : 'browser', song: song.id, a: A.a, b: A.b, notes: add.length, rate: A.rate, snap: SNAPS[REC.snap][0] });
  }
  function recPreview() {
    var a = REC.a, b = REC.b, any = REC.draft.ev.some(function (e) { return e[0] >= a && e[0] < b; });
    if (!any && REC.draft.sections.length) { var s0 = REC.draft.sections[0]; a = s0[0]; b = s0[1]; }
    REC.preview = { a: a, b: b, from: Math.max(0, a - 2) }; REC.ui = null; $('recPanel').classList.remove('show');
    startGame();
  }
  function previewEnd() {
    var P = REC.preview; if (!P) return; REC.preview = null;
    var br = beat ? beat.result() : null;
    finished = true; audio.pause(); stopGuide(); paused = false; $('game').classList.remove('paused');
    if (beat) { beat.destroy(); beat = null; }
    show('home'); wsSend({ type: 'state', state: 'home' });
    REC.msg = br ? 'Preview: ' + br.counts.Perfect + ' Perfect \u00b7 ' + br.counts.Great + ' Great \u00b7 ' + br.counts.Good + ' Good \u00b7 ' + br.counts.Miss + ' Miss (score ' + br.score + ')' : 'Preview done';
    REC.ui = 'menu'; recRender(); $('recPanel').classList.add('show');
  }
  function recUndo() { if (!REC.hist.length) return; REC.draft = JSON.parse(REC.hist.pop()); REC.dirty = true; REC.msg = 'Undone'; }
  function recClearLane() {
    var L = REC_LANES[REC.lane], a = REC.a, b = REC.b, d = REC.draft, n0 = d.ev.length; REC.hist.push(JSON.stringify(d));
    d.ev = d.ev.filter(function (e) { return !(e[1] === L && e[0] >= a && e[0] < b); }); REC.dirty = true;
    REC.msg = 'Cleared ' + (n0 - d.ev.length) + ' ' + KaraokeBeat.LANES[L].name + ' notes in ' + fmt(a) + '\u2013' + fmt(b);
  }
  function recSave() {
    var d = REC.draft, x = new XMLHttpRequest(), id = song.id, sg = song;
    REC.msg = 'Saving\u2026'; recRender();
    x.open('POST', CFG.server + '/api/custom-chart'); x.setRequestHeader('Content-Type', 'application/json');
    x.onload = function () {
      var r = null; try { r = JSON.parse(x.responseText); } catch (e) {}
      if (x.status === 200 && r && r.custom) {
        sg.custom = r.custom; sg.pick = 'mine'; try { localStorage.setItem('karaoke.pick.' + id, 'mine'); } catch (e) {}
        REC.dirty = false; REC.warn = false; REC.msg = 'Saved \u2713 on the server (version ' + r.version + '). This song now plays My map';
      } else REC.msg = 'Save failed (' + (r && r.error || x.status) + ') \u2014 try again';
      if (REC.ui) recRender(); renderPlay();
    };
    x.onerror = function () { REC.msg = 'Save failed: can\u2019t reach the server'; if (REC.ui) recRender(); };
    x.send(JSON.stringify({ id: id, ev: d.ev, sections: d.sections, merge: d.merge }));
  }
  function togglePick(quiet) {
    if (!song || !(song.custom && song.custom.ev && song.custom.ev.length)) { if (!quiet) toast('No map of yours for this song yet \u2014 pick Record map (R2) and press OK to make one.', 3500); return; }
    song.pick = song.pick === 'mine' ? 'auto' : 'mine'; try { localStorage.setItem('karaoke.pick.' + song.id, song.pick); } catch (e) {}
    renderPlay(); if (!quiet) toast('Beat map for this song: ' + (song.pick === 'mine' ? 'My map (' + song.custom.ev.length + ' notes)' : 'Auto map'), 2500);
  }
  window.KaraokeTVRecBeats = function () { return song && song.beats ? song.beats.t : []; };
  window.KaraokeTVRec = { state: function () { return { ui: REC.ui, idx: REC.idx, rows: REC.draft ? recRows().map(function (r) { return r.k + '=' + (r.val || ''); }) : [], draft: REC.draft, dirty: REC.dirty, active: REC.active && { a: REC.active.a, b: REC.active.b, n: REC.active.notes.length }, preview: !!REC.preview, msg: REC.msg, pick: song && song.pick, custom: song && song.custom ? song.custom.ev.length : 0 }; },
    set: function (o) { for (var k in o) REC[k] = o[k]; if (REC.ui) recRender(); } };
  // ---------- v13.9: SONG SELECT (category rail, favorites on the Mac, art cards, difficulty meters, hover preview) ----------
  var LIB = { songs: {}, cats: [{ id: 'all', name: 'All Songs', count: 0 }, { id: 'fav', name: 'Favorites', count: 0 }] }, FAVS = {}, catIdx = 0;
  function libOf(s) { return (s && LIB.songs[s.id]) || null; }
  function catId() { return (LIB.cats[catIdx] || LIB.cats[0]).id; }
  function inCat(i) { var c = catId(), s = songs[i]; if (c === 'all') return true; if (c === 'fav') return !!FAVS[s.id]; var L = libOf(s); return !!(L && L.cats.indexOf(c) >= 0); }
  function stars(n) { var o = ''; for (var k = 1; k <= 5; k++) o += k <= n ? '\u2605' : '\u2606'; return o; }
  function barsHtml(el, n) { var b = el.children; for (var k = 0; k < b.length; k++) b[k].className = k < n ? 'on b' + n : ''; }
  function decorateCard(card, s) {
    var L = libOf(s); card.classList.toggle('fav', !!FAVS[s.id]);
    if (!L) return; barsHtml(card.querySelector('.bars'), L.bars); card.querySelector('.stars').textContent = stars(L.stars);
  }
  function renderCats() {
    var counts = { all: songs.length, fav: 0 }; songs.forEach(function (s) { if (FAVS[s.id]) counts.fav++; });
    $('catRail').innerHTML = '<div class="cr-h">CATEGORIES</div>' + LIB.cats.map(function (c, i) {
      var n = counts[c.id] != null ? counts[c.id] : c.count;
      return '<div class="cr-i' + (i === catIdx ? ' on' : '') + '" data-c="' + c.id + '"><span>' + esc(c.name) + '</span><b>' + n + '</b></div>';
    }).join('');
  }
  function setCat(i, quiet) {
    var n = LIB.cats.length; catIdx = (i + n) % n; renderCats(); applySearch(searchQ, 'cat');
    if (!quiet) toast(LIB.cats[catIdx].name + (catId() === 'fav' && !visList.length ? ' \u2014 none yet: press \u25a1 on a song to add it' : ''), 2200);
  }
  // v13.11.1: the category rail is a real column. Once you change category with \u25c0 \u25b6 / L1 / R1 the rail has focus: \u25b2 \u25bc then walk the categories one by one
  // (All Songs at the top, stops there; no wrap, no search). \u25bc past the last category hands focus back to the song list; OK/Back/leaving the screen also do.
  var CATZ = false, homeEnterBlock = 0;
  function catFocusSet(on) { CATZ = !!on; var r = $('catRail'); if (r) r.classList.toggle('focus', CATZ); if (on && MTZ) mtFocusSet(false); }
  // v13.13: the play-style tabs (Sing / Beat / Duet / Jam / Record) above the song list are reachable with the remote: \u25b2 on the first song focuses them,
  // \u25c0 \u25b6 move between tabs, OK picks the style (nothing plays), \u25bc goes back to the list. \u25b2 on the tabs stays there (never opens search).
  var MTZ = false, mtIdx = 0;
  function mtTabs() { var ms = $('modeSwitch'); return ms ? ms.querySelectorAll('[data-k]') : []; }
  function mtPaint() { var t = mtTabs(); for (var i = 0; i < t.length; i++) t[i].classList.toggle('mfocus', MTZ && i === mtIdx); var ms = $('modeSwitch'); if (ms) ms.classList.toggle('focus', MTZ); }
  function mtFocusSet(on) {
    MTZ = !!on;
    if (on) { CATZ = false; var r = $('catRail'); if (r) r.classList.remove('focus'); var t = mtTabs(), k = playKind(); mtIdx = 0; for (var i = 0; i < t.length; i++) if (t[i].getAttribute('data-k') === k) mtIdx = i; }
    mtPaint();
  }
  function mtKey(k) {   // returns true when it consumed the key
    if (!MTZ || focusCal) return false;
    var t = mtTabs();
    if (k === 37 || k === 39) { mtIdx = Math.max(0, Math.min(t.length - 1, mtIdx + (k === 39 ? 1 : -1))); mtPaint(); return true; }
    if (k === 40) { mtFocusSet(false); return true; }
    if (k === 38) return true;
    if (k === 10009 || k === 8 || k === 27) { mtFocusSet(false); return true; }
    if (k === 13) {
      var kk = t[mtIdx] && t[mtIdx].getAttribute('data-k'); if (!kk) return true;
      localStorage.setItem('karaoke.play', (kk === 'beat' || kk === 'duet') ? kk + '-' + playDiff() : kk); renderPlay();
      var el = t[mtIdx]; el.classList.add('pressed'); setTimeout(function () { el.classList.remove('pressed'); }, 260);
      toast('Mode: ' + PLAY_NAME[play()], 1800); return true;
    }
    return false;
  }
  function catKey(k) {   // returns true when it consumed the key
    if (!CATZ || focusCal) return false;
    var n = LIB.cats.length;
    if (k === 38) { if (catIdx > 0) setCat(catIdx - 1, true); return true; }
    if (k === 40) { if (catIdx < n - 1) setCat(catIdx + 1, true); else { catFocusSet(false); if (visList && visList.length) selectSong(visList[0]); } return true; }
    return false;
  }
  function renderPreviewCard() {
    if (!song) return; var L = libOf(song);
    var img = $('pvArt'); var u = SONG_BASE + song.id + '/art.webp'; if (img.getAttribute('src') !== u) img.src = u;
    $('pvTitle').textContent = song.title; $('pvArtist').textContent = song.artist;
    $('pvChips').innerHTML = [L && L.year > 1900 ? String(L.year) : '', L ? GENRE_NAME[L.genre] || '' : '', fmt(song.duration), FAVS[song.id] ? '\u2665 Favorite' : ''].filter(Boolean).map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('');
    barsHtml($('pvBars'), L ? L.bars : 0); $('pvStars').textContent = stars(L ? L.stars : 0);
    var k = playKind(); $('pvMode').innerHTML = '<b>' + esc(PLAY_NAME[play()]) + '</b>' + ((k === 'beat' || k === 'duet') && song.custom && song.custom.ev && song.custom.ev.length ? ' \u00b7 ' + (song.pick === 'mine' ? 'My map' : 'Auto map') : '') + ' <small>\u25b3 difficulty</small>';
  }
  var GENRE_NAME = { rnb: 'R&B', hiphop: 'Hip-Hop', rock: 'Rock', pop: 'Pop', soul: 'Soul', country: 'Country', dance: 'Dance', reggae: 'Reggae', latin: 'Latin', xmas: 'Christmas', kids: 'Sing-along', gospel: 'Gospel' };
  function toggleFav() {
    if (!song) return; var on = !FAVS[song.id]; if (on) FAVS[song.id] = 1; else delete FAVS[song.id];
    var card = $('songList').children[selected]; if (card) card.classList.toggle('fav', on);
    renderCats(); renderPreviewCard(); toast(on ? '\u2665 Added to Favorites' : 'Removed from Favorites', 1800);
    var x = new XMLHttpRequest(); x.open('POST', CFG.server + '/api/favorites'); x.setRequestHeader('Content-Type', 'application/json');
    x.onerror = function () { toast('Couldn\u2019t save Favorites on the server', 2500); }; x.send(JSON.stringify({ id: song.id, on: on }));
    if (catId() === 'fav' && !on) applySearch(searchQ, 'cat');
  }
  function cycleDiff() {   // △: Easy -> Normal -> Hard (-> My map when this song has one) for Beat / Duet
    var k = playKind(); if (k !== 'beat' && k !== 'duet') { toast('Difficulty is for Beat and Duet \u2014 switch with L2 / R2', 2200); return; }
    var mine = song && song.custom && song.custom.ev && song.custom.ev.length, d = playDiff(), order = ['easy', 'normal', 'hard'];
    if (mine && song.pick === 'mine') { togglePick(true); localStorage.setItem('karaoke.play', k + '-easy'); }
    else if (d === 'hard' && mine) { togglePick(true); }
    else localStorage.setItem('karaoke.play', k + '-' + order[(order.indexOf(d) + 1) % 3]);
    renderPlay(); toast('Difficulty: ' + (song.pick === 'mine' && mine ? 'My map' : cap1(playDiff())), 1500);
  }
  function loadLibrary() {
    KaraokeSongs.getJson(SONG_BASE + 'library.json', function (err, L) {
      if (!err && L && L.songs) { LIB = L; }
      var x = new XMLHttpRequest(); x.open('GET', CFG.server + '/api/favorites');
      x.onload = function () { try { (JSON.parse(x.responseText).ids || []).forEach(function (id) { FAVS[id] = 1; }); } catch (e) {} done(); };
      x.onerror = done; x.send();
    });
    function done() { var cards = $('songList').children; for (var k = 0; k < cards.length && k < songs.length; k++) decorateCard(cards[k], songs[k]); renderCats(); renderPreviewCard(); }
  }
  // hover preview: after ~400 ms on a song, play its pre-cut 18 s hook (songs/<id>/preview.mp3, faded on the server) through Web Audio.
  // Any move cancels it at once. Never sends 'playing' / game state, so the install idle-guard sees "on the song list".
  var PV = { armed: false, timer: 0, want: '', node: null, gain: null, buf: {}, order: [], on: false };
  function pvStop() {
    clearTimeout(PV.timer); PV.want = ''; var n = PV.node, g = PV.gain; PV.node = null; PV.gain = null; PV.on = false; $('pvCard').classList.remove('playing');
    if (n && audio.ctx) { var t = audio.ctx.currentTime; try { g.gain.cancelScheduledValues(t); g.gain.setTargetAtTime(0, t, 0.03); n.stop(t + 0.15); } catch (e) {} }
  }
  function pvSchedule() {
    pvStop(); if (screen !== 'home' || !song || !audio.ctx || localStorage.getItem('karaoke.preview') !== 'on') return;   // v13.11: hover preview is OFF by default (opt-in: localStorage karaoke.preview='on'): no audio when highlighting a song
    var id = song.id; PV.want = id; PV.timer = setTimeout(function () { pvLoad(id); }, 400);
  }
  function pvLoad(id) {
    if (PV.want !== id) return;
    if (PV.buf[id]) return pvPlay(id);
    var x = new XMLHttpRequest(); x.open('GET', SONG_BASE + id + '/preview.mp3'); x.responseType = 'arraybuffer';
    x.onload = function () {
      if (x.status !== 200 || PV.want !== id) return;
      try { audio.ctx.decodeAudioData(x.response, function (b) { PV.buf[id] = b; PV.order.push(id); if (PV.order.length > 6) delete PV.buf[PV.order.shift()]; pvPlay(id); }, function () {}); } catch (e) {}
    };
    x.send();
  }
  function pvPlay(id) {
    if (PV.want !== id || screen !== 'home' || REC.ui) return; var ctx = audio.ctx; if (ctx.state !== 'running' && ctx.resume) ctx.resume();
    var n = ctx.createBufferSource(), g = ctx.createGain(), t = ctx.currentTime; n.buffer = PV.buf[id]; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.8, t + 0.35);
    n.connect(g); g.connect(ctx.destination); n.start(t); PV.node = n; PV.gain = g; PV.on = id; $('pvCard').classList.add('playing');
    n.onended = function () { if (PV.node === n) { PV.node = null; PV.on = false; $('pvCard').classList.remove('playing'); } };
  }
  var POINTS = +(localStorage.getItem('karaoke.points') || 0);
  function addPoints(v) { POINTS += Math.max(0, Math.round(v)); try { localStorage.setItem('karaoke.points', String(POINTS)); } catch (e) {} renderPlayerPill(); }
  function renderPlayerPill() {
    var list = typeof PLAYERS === 'object' ? Object.keys(PLAYERS).map(function (k) { return PLAYERS[k]; }) : [];
    $('ppName').textContent = list.length ? list.map(function (p) { return p.name; }).slice(0, 3).join(' \u00b7 ') : 'Player 1';
    $('ppPts').textContent = POINTS.toLocaleString ? POINTS.toLocaleString('en-US') : String(POINTS);
  }
  window.KaraokeTVSelect = { state: function () { return { cat: catId(), cats: LIB.cats.map(function (c) { return c.id; }), vis: visList, favs: Object.keys(FAVS), preview: PV.on, want: PV.want, selected: song && song.id }; }, setCat: function (i) { setCat(i, true); }, fav: toggleFav, diff: cycleDiff, stopPreview: pvStop };
  // ---------- v13.6: song search (type on the TV keyboard, or speak/type on the phone) ----------
  var searchIdx = null, searchQ = '', visList = null, selTimer = 0, SEARCH_BUILD = 0;
  function searchIndex() { if (!searchIdx || SEARCH_BUILD !== songs.length) { searchIdx = KaraokeSearch.index(songs); SEARCH_BUILD = songs.length; } return searchIdx; }
  function searchOpen() { catFocusSet(false);
    if (screen !== 'home') return;
    foBegin('search'); imeLock = true; if (typeof pvStop === 'function') pvStop();
    var ov = $('searchOverlay'); if (ov) { ov.classList.add('open'); ov.setAttribute('aria-hidden', 'false'); }
    $('home').classList.add('so-open');
    var inp = $('searchInput'); $('searchBar').classList.add('active');
    inp.focus(); setTimeout(function () { if (imeLock) inp.focus(); }, 0);
    toast('Type with the TV keyboard \u2014 press OK to open it. \u25bc or Done = back to the list, Back = clear.', 5000);
  }
  function searchClose(toList) {
    imeLock = false;
    var ov = $('searchOverlay'); if (ov) { ov.classList.remove('open'); ov.setAttribute('aria-hidden', 'true'); }
    $('home').classList.remove('so-open');
    $('searchInput').blur(); $('searchBar').classList.remove('active');
    if (toList && songs.length) { var n = visList ? visList.length : songs.length; if (n) selectSong(visList ? (visList.indexOf(selected) >= 0 ? selected : visList[0]) : selected); else focusRow(rowIdx < 0 ? 0 : rowIdx); }
    else if (songs[selected]) selectSong(selected);
  }
  function searchKey(e) {
    var k = e.keyCode, inp = $('searchInput');
    if (document.activeElement !== inp && k === 13 && e.src !== 'pad' && !window.__searchEnterLeaves) { if (e.preventDefault) e.preventDefault(); inp.focus(); return true; }   // v13.9.3: overlay up, keyboard closed: OK reopens it
    if (k === 40) { if (e.preventDefault) e.preventDefault(); searchClose(true); return true; }
    if (k === 65376 || k === 65385) { if (e.preventDefault) e.preventDefault(); searchClose(true); return true; }   // Tizen IME Done / Cancel
    if (k === 10009 || k === 27) {                                                                                   // Back: clear the search, leave the field
      if (e.preventDefault) e.preventDefault(); if (inp.value) applySearch('', 'back'); searchClose(true); return true;
    }
    if (k === 13 && e.src === 'pad') { if (e.preventDefault) e.preventDefault(); searchClose(true); return true; }   // pad ✕ confirms
    if (k === 13 && window.__searchEnterLeaves) { if (e.preventDefault) e.preventDefault(); searchClose(true); return true; }   // desktop keyboard / tests
    return true;   // everything else (letters, backspace, arrows, OK = open the TV keyboard) belongs to the input: no app action, no preventDefault
  }
  function applySearch(q, from) {
    q = String(q || '').replace(/^\s+/, '');
    var inp = $('searchInput'); if (inp.value !== q) inp.value = q;
    searchQ = q.replace(/\s+$/, '');
    var cards = $('songList').children, r = searchQ ? KaraokeSearch.rank(searchIndex(), searchQ) : null, i, set = {};
    if (catId() !== 'all') { if (!r) { r = []; for (i = 0; i < songs.length; i++) r.push({ i: i }); } r = r.filter(function (x) { return inCat(x.i); }); }   // v13.9 category rail
    if (catId() === 'new' && r) r = r.slice().sort(function (a, b) { var da = (libOf(songs[a.i]) || {}).added || '', db = (libOf(songs[b.i]) || {}).added || ''; return da < db ? 1 : da > db ? -1 : 0; });   // v13.14: Newly Added, newest first
    $('songList').classList.toggle('searching', !!r);
    if (r) r.forEach(function (x, n) { set[x.i] = n; });
    for (i = 0; i < cards.length; i++) {
      var hide = !!r && set[i] == null; cards[i].classList.toggle('nomatch', hide); cards[i].style.order = r && !hide ? String(set[i]) : '';
    }
    visList = r ? r.map(function (x) { return x.i; }) : null;
    $('searchBar').classList.toggle('has', !!searchQ);
    $('searchEmpty').classList.toggle('show', !!r && !r.length); $('seQ').textContent = searchQ ? '\u201c' + searchQ + '\u201d' + (catId() !== 'all' ? ' in ' + LIB.cats[catIdx].name : '') : 'in ' + LIB.cats[catIdx].name + (catId() === 'fav' ? ' yet \u2014 press \u25a1 on a song' : '');
    listGeom = null; listY = 0; $('songList').style.transform = 'translate3d(0,0,0)';
    clearTimeout(selTimer);
    var pick = function () {
      if (visList && visList.length) { if (visList.indexOf(selected) !== 0 || focusCal) selectSong(visList[0]); else scrollList(selected); }
      else if (!visList && songs[selected]) selectSong(selected);
      if (visList) $('songCount').textContent = '\u00b7 ' + visList.length + ' match' + (visList.length === 1 ? '' : 'es');
      if (from === 'phone' || from === 'voice') wsSend({ type: 'searchres', q: searchQ, n: visList ? visList.length : songs.length, top: visList && visList.length ? songs[visList[0]].title + ' \u2014 ' + songs[visList[0]].artist : '', list: (visList || []).slice(0, 5).map(function (j) { return songs[j].title + ' \u2014 ' + songs[j].artist; }) });
    };
    if (from === 'type') selTimer = setTimeout(pick, 280); else pick();   // typing: settle before moving the selection (audio preload follows it)
  }
  function searchFromPhone(m) {
    if (screen !== 'home' || !songs.length) { wsSend({ type: 'searchres', q: String(m.q || ''), busy: true }); return; }
    var q = String(m.q || '').slice(0, 60);
    if (document.activeElement === $('searchInput')) searchClose(false);
    applySearch(q, m.src === 'voice' ? 'voice' : 'phone');
    if (q && m.src === 'voice' && m.final) toast('\ud83c\udfa4 Heard \u201c' + q + '\u201d', 2500);
  }
  $('searchInput').addEventListener('input', function () { applySearch(this.value, 'type'); });
  $('searchInput').addEventListener('blur', function () { /* keep the overlay up through Tizen IME focus churn */ });
  window.KaraokeTVSearch = { open: searchOpen, close: function () { searchClose(true); }, apply: function (q) { applySearch(q, 'test'); }, state: function () { return { q: searchQ, vis: visList, selected: selected, focus: document.activeElement === $('searchInput'), overlay: !!($('searchOverlay') && $('searchOverlay').classList.contains('open')), shown: Array.prototype.filter.call($('songList').children, function (c) { return !c.classList.contains('nomatch'); }).length, empty: $('searchEmpty').classList.contains('show') }; } };
  var stingray = null;
  function loadStingray() {
    stingray = new KaraokeSongs.StingraySongSource(CFG.server);
    stingray.status(function (err, st) {
      if (err || !st || !st.configured || !st.featuredSongId) return; // no credentials: Twinkle only
      stingray.load(st.featuredSongId, function (e, s) {
        if (e || !s || !s.audioUrl) { toast('Stingray song unavailable right now.', 4000); return; }
        var idx = songs.length;
        songs[idx] = prepSong(s);
        addCard(idx, s, ' · Stingray Karaoke', '♪', [fmt(s.duration), s.scorable ? 'Scored' : 'Sing-along (no melody data)']);
      });
    });
  }

  // ---------- server session + websocket ----------
  var ws = null;
  function loadSession() {
    KaraokeSongs.getJson(CFG.server + '/api/session', function (err, s) {
      if (err) {
        $('qr').innerHTML = '<div class="qr-wait">Local server offline.<br>Start it: npm start</div>';
        return setTimeout(loadSession, 3000);
      }
      applySession(s);
      connectWs();
    });
  }
  // v13.10: the server pushes {type:'session'} when the hosted room relay comes up / falls back to the local IP
  var cloudMode = false;
  function applySession(s) {
    cloudMode = !!s.cloud;
    $('qr').innerHTML = s.qrSvg; $('caQr').innerHTML = s.caQrSvg || ''; $('caUrl').textContent = String(s.caUrl || '').replace('http://', '');
    $('qrUrl').textContent = cloudMode ? String(s.phoneUrl || '').replace(/^https:\/\//, '') : '';
    $('home').classList.toggle('cloud', cloudMode);
    JQ.svg = s.qrSvg || ''; JQ.cloud = cloudMode; renderJoinQr();
    if (s.phone) setPhone(s.phone); else renderHomePlayers();
  }
  function connectWs() {
    if (ws && ws.readyState <= 1) return;
    ws = new WebSocket(CFG.server.replace(/^http/, 'ws') + '/ws?role=tv'); ws.binaryType = 'arraybuffer';
    ws.onopen = function () { ping(); try { wsSend(viewportReport()); } catch (e) {} try { if (AOUT) detectAudioOut('ws-open'); } catch (e) {} };   // startup detection runs before the socket is up; re-run so the output-device report reaches the server
    ws.onclose = function () { setPhone({ connected: false, mic: 'off' }); setTimeout(connectWs, 2000); };
    ws.onmessage = function (ev) {
      if (typeof ev.data !== 'string') { onVoice(ev.data); return; }
      var m = JSON.parse(ev.data);
      if (m.type === 'pong') {
        var rtt = performance.now() - m.id; if (m.server) srvOffs.push({ rtt: rtt, off: m.server - (Date.now() - rtt / 2) });
        if (srvOffs.length > 9) srvOffs.shift(); srvOff = srvOffs.slice().sort(function (a, b) { return a.rtt - b.rtt; })[0].off; // best = lowest-RTT sample
        tvRtts.push(rtt); if (tvRtts.length > 9) tvRtts.shift();
        var s = tvRtts.slice().sort(function (a, b) { return a - b; }); tvLegMs = s[Math.floor(s.length / 2)] / 2;
      } else if (m.type === 'phone') setPhone(m);
      else if (m.type === 'pitch') onPitch(m);
      else if (m.type === 'session') applySession(m);
      else if (m.type === 'sync' && m.sync && m.sync.byDev && localStorage.getItem('karaoke.sync') === null) saveSync(m.sync, false);   // restore after a reinstall
      else if (m.type === 'guide') setGuide(m.level);
      else if (m.type === 'guide-query') { showGuide(); sendVoiceState(); }
      else if (m.type === 'voice' && m.p) { audio.setVoiceGain(m.p, false, 0); }   // v13.8.1: voice through TV removed (always off)
      else if (m.type === 'vdelay' && m.p) { voiceMeasured[m.p] = m.ms; toastAny('🎤 ' + pname(m.p) + ': voice delay measured ' + m.ms + ' ms (mouth → TV speaker)', 5000); }
      else if (m.type === 'search') searchFromPhone(m);
      else if (/^q-/.test(m.type) && window.KTVQueue) KTVQueue.onMsg(m);   // v13.12: q-add / q-del / q-get from phones
      else if (m.type === 'dev') { if (m.action === 'start') { if (songs[m.song]) selectSong(m.song); armedNoPhone = true; startGame(); } else if (m.action === 'home') goHome(); else if (m.action === 'fps') toggleFps(); else if (m.action === 'safe') { safeScale = Math.max(0.85, Math.min(1, +m.value || 1)); localStorage.setItem('karaoke.safeScale', safeScale); fit(); wsSend(viewportReport()); } else if (m.action === 'viewport') wsSend(viewportReport()); else if (m.action === 'probe') wsSend(probe()); else if (m.action === 'enginecheck') engineCheck(+m.song || 0); else if (m.action === 'engine') { if (screen === 'home' && (m.value === 'webaudio' || m.value === 'element')) { localStorage.setItem('karaoke.engine', m.value); location.reload(); } } else if (m.action === 'mute') { audio.volume = m.value === '1' ? 0 : 1; if (audio.master) audio.master.gain.value = m.value === '1' ? 0 : 1; wsSend(probe()); } else if (m.action === 'select') { if (screen === 'home' && songs[+m.song]) selectSong(+m.song); wsSend(probe()); } else if (m.action === 'play') { if (PLAYS.indexOf(m.value) >= 0) { localStorage.setItem('karaoke.play', m.value); renderPlay(); } wsSend(probe()); } else if (m.action === 'pads') { wsSend({ type: 'perf', screen: 'gamepad', build: BUILD, src: window.tizen ? 'tv' : 'browser', ev: { type: 'status' }, info: padInfo() }); } else if (m.action === 'mode') { if (MODES.indexOf(m.value) >= 0) localStorage.setItem('karaoke.mode', m.value); renderHomePlayers(); } else if (m.action === 'flags') { for (var fk in m.flags) DEV[fk] = !!m.flags[fk]; document.body.classList.toggle('nobg', !DEV.bg); } }
    };
  }
  function engineCheck(i) {
    // Only from the song list (never during a song); silent: everything plays at gain 0 / volume 0.
    if (screen !== 'home' || !songs[i] || !songs[i].guideUrl) { wsSend({ type: 'perf', screen: 'enginecheck', build: BUILD, src: window.tizen ? 'tv' : 'browser', skipped: screen !== 'home' ? 'not on home' : 'song has no guide' }); return; }
    var s = songs[i];
    audio.selfTest(s.audioUrl, s.guideUrl, 6, function (r) {
      r.type = 'perf'; r.screen = 'enginecheck'; r.build = BUILD; r.src = window.tizen ? 'tv' : 'browser'; r.song = s.id; r.engineNow = audio.mode;
      wsSend(r); if (screen === 'home') selectSongAudio();   // never reload the player under a running song
    });
  }
  function probe() {
    var er = audio.error;
    return { type: 'perf', screen: 'probe', build: BUILD, latMs: outLat(), audioOut: AOUT.type, avMs: avMs(), rumble: typeof rumbleLevel === 'function' ? rumbleLevel() : null, src: window.tizen ? 'tv' : 'browser', at: screen, paused: paused, finished: finished, song: song && song.id,
      engine: audio.mode, cache: audio.cacheInfo ? audio.cacheInfo() : null, guideLocked: audio.guideLocked ? audio.guideLocked() : false, guideLevel: guideLevel(), hasGuide: hasGuide(), master: audio.master ? audio.master.gain.value : null, audio: { paused: audio.paused, t: +audio.currentTime.toFixed(2), dur: audio.duration, ready: audio.readyState, net: audio.networkState, err: er ? er.code : 0, vol: audio.volume, muted: audio.muted, src: audio.getAttribute('src') },
      guide: { paused: guideEl.paused, vol: guideEl.volume }, focusRow: focusCal, rowIdx: rowIdx, play: play(), beat: beat ? { kind: G.kind, score: beat.score(), judged: beat.judged } : null, pads: padInfo(), beatOffsetMs: beatOffsetMs(), toast: $('homeToast').textContent, armed: armedNoPhone, phone: phone };
  }
  audio.addEventListener('error', function () { var p = probe(); p.screen = 'audio-error'; wsSend(p); if (screen === 'game') $('lyricCur').textContent = 'Audio error (' + (audio.error ? audio.error.code : '?') + ') — press BACK and try again'; });
  function wsSend(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function ping() { wsSend({ type: 'ping', id: performance.now() }); }
  setInterval(ping, 2000);

  // ---------- voice monitoring: phone mics -> TV speakers (PCM over wss, jitter buffer, light reverb) ----------
  var srvOff = 0, srvOffs = [], voiceMeasured = {};
  var VOICE_ORDER = ['off', 'low', 'med', 'high'], VOICE_VOL = { off: 0, low: 0.5, med: 0.8, high: 1.1 }, VOICE_NAME = { off: 'Off', low: 'On · Low', med: 'On · Medium', high: 'On · High' };
  // v13.4: Voice on TV is OFF by default (echo). One-time reset at app start (never mid-song); later choices persist.
  try { if (localStorage.getItem('karaoke.voiceOffMigrated') !== '1') { localStorage.setItem('karaoke.voiceLevel', 'off'); localStorage.setItem('karaoke.voiceOffMigrated', '1'); } } catch (e) {}
  // v13.8.1: 'Voice through TV' was removed entirely: always off, any saved value is forced off (no UI to turn it on)
  try { localStorage.setItem('karaoke.voiceLevel', 'off'); } catch (e) {}
  function voiceLevel() { return 'off'; }
  function sendVoiceState() { var lv = voiceLevel(); wsSend({ type: 'voice', master: lv !== 'off', vol: VOICE_VOL[lv] }); }
  function applyVoice() {
    var lv = voiceLevel(); audio.setVoiceMaster(lv !== 'off', VOICE_VOL[lv]);
    var t = audio.ctx ? VOICE_NAME[lv] : 'not supported';
    if ($('voiceBtnVal')) $('voiceBtnVal').textContent = t;
    if ($('pmVoice')) $('pmVoice').textContent = t;
    sendVoiceState();
  }
  window.toggleVoiceMaster = function () {
    localStorage.setItem('karaoke.voiceLevel', 'off'); applyVoice();   // v13.8.1: removed; stays off
  };
  function toastAny(msg, ms) { if (screen === 'home') toast(msg, ms); else { var h = $('hudGuide'); if (h) { h.textContent = msg; clearTimeout(toastAny.t); toastAny.t = setTimeout(showGuide, ms || 3000); } } }
  function onVoice(ab) {
    if (ab.byteLength < 18) return;
    var dv = new DataView(ab), slot = dv.getUint8(0), srvMs = dv.getUint32(4, true);
    var phoneHalf = dv.getUint16(12, true), pcm = new Int16Array(ab, 16, (ab.byteLength - 16) >> 1);
    var v = audio.voice ? audio.voice(slot) : null; if (!v) return;
    var nowSrv = (Date.now() + srvOff) % 4294967296, leg = nowSrv - srvMs; if (leg < -1e6) leg += 4294967296;
    if (leg > -50 && leg < 2000) { v.net.push(phoneHalf + Math.max(0, leg)); if (v.net.length > 200) v.net.shift(); }
    audio.pushVoice(slot, pcm, 24000);
  }
  function voiceReport() {
    var st = audio.voiceStats ? audio.voiceStats() : {}, out = audio.outputInfo ? audio.outputInfo() : {};
    var rep = { voiceLevel: voiceLevel(), engine: out, voices: st, calibratedOutMs: outLat(), audioOut: AOUT.type, avMs: avMs() };
    Object.keys(st).forEach(function (k) {
      var x = st[k]; if (x.netMs == null) return;
      // mouth -> TV speaker: phone capture buffer (10.7 ms) + network + jitter buffer + TV audio output (Web Audio reported, or calibrated)
      x.estMs = Math.round(10.7 + x.netMs + (x.bufMs || 0) + (out.outMs || out.baseMs || 0));
      if (voiceMeasured[k]) x.measuredMs = voiceMeasured[k];
    });
    return rep;
  }

  // ---------- players (up to 4 phones) + game modes ----------
  var PLAYERS = {};
  var MODES = ['party', 'battle-alt', 'battle-same'];
  var MODE_NAME = { party: 'Party · everyone sings', 'battle-alt': 'Battle · trade lines', 'battle-same': 'Battle · same parts' };
  function mode() { var m = localStorage.getItem('karaoke.mode'); return MODES.indexOf(m) >= 0 ? m : 'party'; }
  function cycleMode(dir) { var i = MODES.indexOf(mode()); localStorage.setItem('karaoke.mode', MODES[(i + dir + MODES.length) % MODES.length]); renderHomePlayers(); }
  // play style: Sing (pitch-scored), Beat (press buttons on the beat, tv/beat.js), or both at once
  var PLAYS = ['sing', 'beat-easy', 'beat-normal', 'beat-hard', 'duet-easy', 'duet-normal', 'duet-hard', 'jam', 'rec'];
  var PLAY_NAME = { sing: 'Sing', 'beat-easy': 'Beat · Easy', 'beat-normal': 'Beat · Normal', 'beat-hard': 'Beat · Hard',
    'duet-easy': 'Duet · Easy', 'duet-normal': 'Duet · Normal', 'duet-hard': 'Duet · Hard', jam: 'Jam · free play', rec: 'Record map' };
  var QFORCE = false;   // v13.12: a song started from the phone queue is sung (not drummed) whatever the TV's Play setting; cleared when we are back on the song list
  function play() { if (QFORCE) return 'sing'; var v = localStorage.getItem('karaoke.play'); if (v === 'both') v = 'duet-normal'; return PLAYS.indexOf(v) >= 0 ? v : 'sing'; }
  function playKind() { var v = play(); return v.split('-')[0]; }          // sing | beat | duet | jam
  function playDiff() { var v = play(); return v.indexOf('-') > 0 ? v.split('-')[1] : 'normal'; }
  function soloBeat() { return G && (G.kind === 'beat' || G.kind === 'jam' || G.kind === 'rec'); }  // no singing lane/scoring
  function renderPlay() {
    var name = PLAY_NAME[play()];
    if ($('playBtnVal')) $('playBtnVal').textContent = name;
    if ($('playNow')) { $('playNow').textContent = name + ((playKind() === 'beat' || playKind() === 'duet') && song && song.custom && song.custom.ev && song.custom.ev.length ? (song.pick === 'mine' ? ' \u00b7 My map' : ' \u00b7 Auto map') : ''); $('playNow').setAttribute('data-kind', playKind()); }
    if ($('pmHit') && typeof rumbleLevel === 'function') $('pmHit').textContent = RUMBLE_NAME[rumbleLevel()];
    var ms = $('modeSwitch'); if (ms) { var k = playKind(); for (var i = 0; i < ms.children.length; i++) { var c = ms.children[i]; if (c.getAttribute('data-k')) c.className = c.getAttribute('data-k') === k ? 'on' : ''; }
      if (typeof mtPaint === 'function') mtPaint();
      if (typeof renderPreviewCard === 'function' && song) renderPreviewCard();
      $('msDiff').textContent = (k === 'beat' || k === 'duet') ? cap1(playDiff()) + (song && song.custom && song.custom.ev && song.custom.ev.length ? ' \u00b7 ' + (song.pick === 'mine' ? 'My map' : 'Auto map') : '') : k === 'sing' ? 'Live pitch' : k === 'jam' ? 'Free play' : 'Your map'; }
  }
  function cap1x() {}
  function cap1(x) { return x.charAt(0).toUpperCase() + x.slice(1); }
  // v13.8 HUD: logo badge, difficulty pill (level from notes per minute, 1-5 stars), glass Score / Combo / Accuracy panels
  function gameHud(kind) {
    var lvl = 0, stars = '', txt;
    if (beat && beat.prompts.length && song.duration) { var npm = beat.prompts.length / (song.duration / 60); lvl = Math.max(1, Math.min(10, Math.round(npm / 16))); var st = Math.ceil(lvl / 2); stars = new Array(st + 1).join('\u2605') + new Array(6 - st).join('\u2606'); }
    txt = kind === 'sing' ? '<b>SING</b><span>Live pitch</span>' : kind === 'jam' ? '<b>JAM</b><span>Free play</span>' : kind === 'rec' ? '<b class="rec">\u25cf REC</b><span>Record map</span>' : '<b>' + (REC.preview ? 'PREVIEW' : playDiff().toUpperCase()) + '</b>' + (lvl ? '<span>LV ' + lvl + '</span><i>' + stars + '</i>' : '');
    $('gPill').innerHTML = txt; $('gpScore').textContent = '0'; $('gpCombo').textContent = '\u00d70'; $('gpMax').textContent = ''; $('gpAcc').textContent = '\u2013'; $('gpAccBar').style.transform = 'scaleX(0)';
  }
  function singPanels(sc) {   // Sing: same right-hand SCORE / COMBO / ACCURACY cards, from the real pitch scorer
    if (!sc) return; var a = accPct(sc.counts);
    $('gpScore').textContent = String(sc.liveScore()); $('gpCombo').textContent = '\u00d7' + sc.combo; $('gpMax').textContent = sc.maxCombo > 2 ? 'best ' + sc.maxCombo : '';
    $('gpAcc').textContent = a == null ? '\u2013' : a + '%'; $('gpAccBar').style.transform = 'scaleX(' + ((a || 0) / 100).toFixed(3) + ')';
  }
  function hudPanels(b) {
    var n = b.counts.Perfect + b.counts.Great + b.counts.Good + b.counts.Miss, acc = n ? Math.min(100, (100 * (b.counts.Perfect + b.counts.Great * 0.75 + b.counts.Good * 0.45)) / n) : 0;
    $('gpScore').textContent = String(b.score()); $('gpCombo').textContent = '\u00d7' + b.combo; $('gpMax').textContent = b.maxCombo > 2 ? 'best ' + b.maxCombo : '';
    $('gpAcc').textContent = n ? acc.toFixed(1) + '%' : '\u2013'; $('gpAccBar').style.transform = 'scaleX(' + (acc / 100).toFixed(3) + ')';
  }
  // ---------- v13.9 game HUD: top song bar, player cards (duet / multi), big combo, singer tag ----------
  var PC = { t: 0, lead: 0, rows: [] };
  function pcHtml(r) {
    var c = slotColor(r.slot), lt = G && G.late && G.late[r.slot];
    return '<div class="pc' + (r.enter ? ' enter' : '') + '" id="pc' + r.slot + '" style="--c:' + c + ';--cb:' + rgba(c, 0.2) + ';--cg:' + rgba(c, 0.45) + '"><img src="' + avatarFor(r.slot) + '" alt=""><div class="pc-m"><div class="pc-n"><span class="pc-p">P' + r.slot + '</span>' + esc(r.name) + (lt ? '<em class="pc-late">joined late</em>' : '') + '<em class="pc-ic">' + (r.sing ? '\ud83c\udfa4' : '\ud83e\udd41') + '</em></div><b id="pcs' + r.slot + '">0</b><u><s id="pce' + r.slot + '"></s></u></div><i class="pc-crown">\u265b</i></div>';
  }
  function hudStart(kind) {
    $('gsArt').src = SONG_BASE + song.id + '/art.webp'; $('gsTitle').textContent = song.title; $('gsArtist').textContent = song.artist || '';
    $('gsBar').style.transform = 'scaleX(0)'; $('gsTime').textContent = '0:00 / ' + fmt(song.duration || 0);
    $('gbcN').textContent = '0'; $('gBigCombo').className = 'g-bigcombo'; $('gsgTag').textContent = ''; $('gsgTag').className = 'gsg-tag';
    var sl = G.slots[0] || 1; $('gsgAv').src = avatarFor(sl); $('gsgP').textContent = 'P' + sl; $('gsgP').style.background = slotColor(sl); $('game').style.setProperty('--pc', slotColor(sl));   // v13.15: SCORE / COMBO panels use the same colour as the pitch trace
    G.hudSet = false; if (!soloBeat() && phone && typeof setPhone === 'function') try { setPhone(phone); } catch (e) {}
    var cards = kind === 'duet' || G.multi; $('game').classList.toggle('cards', !!cards); PC.rows = []; PC.lead = 0;
    if (!cards) { $('pCards').innerHTML = ''; renderJoinQr(); return; }
    PC.rows = G.slots.map(function (x) { return { slot: x, name: pname(x), sing: true }; });
    if (kind === 'duet') PC.rows.push({ slot: G.slots.length + 1, name: G.beatName.replace(/^\S+\s/, ''), sing: false });
    var html = PC.rows.map(pcHtml).join('');
    if (PC.rows.length < 2) html += '<div class="pc ghost"><div class="pc-m"><div class="pc-n">P2</div><b>JOIN</b><small>scan the QR or plug in a controller</small></div></div>';
    $('pCards').innerHTML = html; renderJoinQr();
  }
  function hudTick(t) {   // ~4x a second: song bar time + player cards (cheap text/transform updates only)
    var now = performance.now(); if (now - PC.t < 250) return; PC.t = now;
    $('gsTime').textContent = fmt(t) + ' / ' + fmt(song.duration || 0); $('gsBar').style.transform = 'scaleX(' + Math.min(1, Math.max(0, t / (song.duration || 1))).toFixed(4) + ')';
    if (!PC.rows.length) return;
    var best = -1, lead = 0;
    PC.rows.forEach(function (r) {
      var v, e;
      if (r.sing) { var sc = G.scorers[r.slot]; if (!sc) return; v = sc.liveScore(); e = Math.min(1, sc.combo / 12); }
      else { if (!beat) return; v = beat.score(); e = Math.min(1, beat.combo / 30); }
      if (r.v !== v) { r.v = v; $('pcs' + r.slot).textContent = v; }
      if (r.e !== e) { r.e = e; $('pce' + r.slot).style.transform = 'scaleX(' + e.toFixed(3) + ')'; }
      if (v > best) { best = v; lead = r.slot; } else if (v === best) lead = 0;
    });
    if (lead !== PC.lead) { if (PC.lead && $('pc' + PC.lead)) $('pc' + PC.lead).classList.remove('lead'); PC.lead = best > 0 ? lead : 0; if (PC.lead) $('pc' + PC.lead).classList.add('lead'); }
  }
  function singerTag(rating, text) { if (G.kind !== 'duet') return; var el = $('gsgTag'); el.textContent = (text || rating).toUpperCase(); el.className = 'gsg-tag ' + rating; void el.offsetWidth; el.className = 'gsg-tag show ' + rating; }
  function bigCombo(n) {
    if (G.kind !== 'duet') return; var el = $('gBigCombo');
    if (n < 3) { if (el.className !== 'g-bigcombo') el.className = 'g-bigcombo'; return; }
    $('gbcN').textContent = n; el.className = 'g-bigcombo on' + (n >= 25 ? ' hot' : '') + (n % 2 ? ' p1' : ' p2');
  }
  function cyclePlay() { localStorage.setItem('karaoke.play', PLAYS[(PLAYS.indexOf(play()) + 1) % PLAYS.length]); renderPlay(); }
  // L2 / R2 on the song list: cycle the four play kinds (Beat → Duet → Jam → Sing), keeping Easy/Normal/Hard when it applies.
  // △ and the Play button still walk every style including difficulty (cyclePlay).
  var PLAY_KINDS = ['beat', 'duet', 'jam', 'sing', 'rec'];
  function cyclePlayKind(dir) {
    var i = PLAY_KINDS.indexOf(playKind()); if (i < 0) i = PLAY_KINDS.length - 1;
    var next = PLAY_KINDS[(i + dir + PLAY_KINDS.length) % PLAY_KINDS.length];
    localStorage.setItem('karaoke.play', (next === 'beat' || next === 'duet') ? next + '-' + playDiff() : next);
    renderPlay();
  }
  function announcePlay() {
    toast('Play: ' + PLAY_NAME[play()] + ({ beat: ' — you play the song like an instrument: hit each gem as it lands on its button (remote: \u25b2 \u25b6 \u25c0 \u25bc)', duet: ' — phone singer(s) sing while the controller (or remote) plays the beat highway', jam: ' — free play: the controller is a drum kit + bass over the song', rec: ' — make your own beat map: press OK, pick a section, and play your pattern on the controller' }[playKind()] || ''), 5000);
  }
  var certOk = localStorage.getItem('karaoke.certOk') === '1', setupShown = false;
  function renderHomePlayers() {
    var list = Object.keys(PLAYERS).map(function (k) { return PLAYERS[k]; });
    $('playersHome').innerHTML = list.length ? list.map(function (p) {
      return '<span class="pchip' + (p.mic === 'live' ? ' live' : '') + '" style="--c:' + p.color + '"><i></i>' + esc(p.name) + (p.mic === 'live' ? ' 🎤' : '') + '</span>';
    }).join('') : '<span class="pnone">No phones yet · up to 4 players</span>';
    var md = mode(), n = list.length;
    $('modeHome').innerHTML = MODE_NAME[md] + (md !== 'party' && n < 2 ? ' <span class="dim">(needs 2 phones — starts as Party until a second mic is live)</span>' : ' <span class="dim">· up to 4 singers</span>');
    $('modeBtnVal').textContent = MODE_NAME[md].split(' · ')[0] + (md === 'battle-alt' ? ' · trade lines' : md === 'battle-same' ? ' · same parts' : '');
    var showCa = cloudMode ? setupShown : (!certOk || setupShown);   // cloud join needs no certificate
    $('caBox').style.display = showCa && !cloudMode ? '' : 'none';
    $('home').classList.toggle('setup', showCa); if (typeof renderPlayerPill === 'function') renderPlayerPill();
    $('setupHint').textContent = showCa ? '' : 'Phone setup QR hidden · “Add phone” below shows it';
    $('phoneBtnVal').textContent = showCa ? 'hide setup QR' : 'show setup QR';
  }
  function setPhone(p) {
    phone = p;
    PLAYERS = {}; (p.players || []).forEach(function (x) { PLAYERS[x.slot] = x; });
    if (p.certOk && !certOk) { certOk = true; try { localStorage.setItem('karaoke.certOk', '1'); } catch (e) {} }
    renderHomePlayers(); renderJoinQr(); lateCheck();
    var nLive = (p.players || []).filter(function (x) { return x.mic === 'live'; }).length;
    var el = $('phoneStatus'), hud = (screen === 'game' && soloBeat()) ? document.createElement('div') : $('hudPhone');
    if (!p.connected) { el.className = 'status-pill'; el.textContent = '● Waiting for phone'; hud.className = 'hud-sub bad'; hud.textContent = 'No phone mic connected — not scoring'; return; }
    if (nLive > 1) { el.className = 'status-pill ok'; el.textContent = '● ' + nLive + ' mics live'; hud.className = 'hud-sub ok'; hud.textContent = '🎤 ' + nLive + ' singers'; }
    else if (p.mic === 'live') { el.className = 'status-pill ok'; el.textContent = '● iPhone mic live'; hud.className = 'hud-sub ok'; hud.textContent = '🎤 iPhone mic live'; }
    else if (p.mic === 'denied' || p.mic === 'insecure') { el.className = 'status-pill warn'; el.textContent = p.mic === 'insecure' ? '● Phone needs the certificate' : '● Mic permission denied'; hud.className = 'hud-sub bad'; hud.textContent = 'Mic blocked on phone'; }
    else { el.className = 'status-pill warn'; el.textContent = '● Phone connected — tap “Start mic”'; hud.className = 'hud-sub'; hud.textContent = 'Phone connected, mic off'; }
  }

  // ---------- clock: audio.currentTime smoothed with performance.now() ----------
  // Smoothed, monotonic song clock: audio.currentTime is coarse on TVs (updates every ~20–250 ms);
  // we advance with performance.now() and slew gently toward the audio position (snap if > 250 ms off).
  var sm = { t: 0, perf: 0, playing: false };
  function clock() {
    var now = performance.now();
    if (audio.paused) { sm.playing = false; sm.t = audio.currentTime; sm.perf = now; return sm.t; }
    if (!sm.playing) { sm.playing = true; sm.t = audio.currentTime; sm.perf = now; return sm.t; }
    var pred = sm.t + (now - sm.perf) / 1000 * (audio.rate || 1), err = audio.currentTime - pred;
    // currentTime lags between its coarse updates, so only pull forward fully, and backward slowly
    sm.t = Math.abs(err) > 0.25 ? audio.currentTime : pred + err * (err > 0 ? 0.08 : 0.02);
    sm.perf = now;
    return sm.t;
  }

  // ---------- pitch frames from the phone ----------
  // v13.10 de-jitter: phones send one pitch frame per audio hop (fixed sample-clock cadence) with a running seq, so
  // seq x period is the phone's own timeline. Frames relayed via the cloud relay sometimes arrive in clumps (p90 ~+60 ms);
  // we map each frame back to when it was produced: production ~ seq*P + min(arrival - seq*P) over the last ~400 frames.
  // Returns the extra queueing delay (ms) of this frame beyond the best-case path; the phone's lat covers the rest.
  var DJ = {}, dejitterOn = localStorage.getItem('karaoke.dejitter') !== '0';
  function jitterMs(slot, seq, now) {
    if (!dejitterOn || typeof seq !== 'number' || !(seq >= 0)) return 0;
    var d = DJ[slot];
    if (!d || seq <= d.last || seq - d.last > 500) d = DJ[slot] = { pts: [], P: 0, last: seq, n: 0 };   // new phone / reload / long gap: restart
    d.last = seq; d.pts.push(seq, now); if (d.pts.length > 800) d.pts.splice(0, 2);
    var k = d.pts.length / 2; if (k < 40) return 0;
    if (!d.P || ++d.n % 25 === 0) {
      var s0 = d.pts[0], a0 = d.pts[1], P = d.P || (now - a0) / (seq - s0);
      for (var it = 0; it < 2; it++) {   // lower envelope: least-delayed frame in each half of the window
        var h = Math.floor(k / 2), b1 = 1e12, b2 = 1e12, i1 = 0, i2 = h;
        for (var i = 0; i < k; i++) { var o = d.pts[2 * i + 1] - d.pts[2 * i] * P; if (i < h) { if (o < b1) { b1 = o; i1 = i; } } else if (o < b2) { b2 = o; i2 = i; } }
        var ds = d.pts[2 * i2] - d.pts[2 * i1]; if (ds > 20) P = (d.pts[2 * i2 + 1] - d.pts[2 * i1 + 1]) / ds;
      }
      if (P > 4 && P < 60) d.P = P; else return 0;
      d.off = 1e12; for (var j = 0; j < k; j++) { var oo = d.pts[2 * j + 1] - d.pts[2 * j] * d.P; if (oo < d.off) d.off = oo; }   // full rescan every 25 frames (window slides)
    } else d.off = Math.min(d.off, now - seq * d.P);
    return Math.max(0, Math.min(250, now - (seq * d.P + d.off)));
  }
  function onPitch(m) {
    var jit = jitterMs(m.p || 0, m.seq, performance.now()); jitStat(jit);
    if (screen === 'calib' && calFrames && !audio.paused) { calFrames.push({ t: clock() - ((m.lat || 0) + tvLegMs + jit) / 1000, f: m.f > 0 ? m.f : 0 }); return; }
    if (screen !== 'game' || !G || audio.paused) return;
    var slot = m.p || G.slots[0];
    var sc = G.scorers[slot]; if (!sc) return; // phone joined mid-song: not in this round
    // Map arrival to the song timeline the singer heard: subtract network+analysis latency and TV speaker delay.
    G.lat[slot] = m.lat || 0; phoneLatMs = Math.max.apply(null, G.slots.map(function (s) { return G.lat[s] || 0; }));
    var t = clock() - ((m.lat || 0) + tvLegMs + outLat() + jit) / 1000;
    var f = m.f > 0 ? m.f : 0;
    sc.addFrame(t, f, m.c);   // scoring uses the raw frames (+ confidence); only the drawn trace is smoothed
    if (!lane) return;
    // v13.15 render-only smoothing: low-confidence frames ignored, octave jumps folded, median-of-3 + one-euro filter, gaps < 150 ms bridged.
    var smo = (G.sm = G.sm || {})[slot] || (G.sm[slot] = new S.PitchSmoother());
    var nn = noteAt(t), ref = nn ? nn.midi : refMidiAt(t), pt = smo.push(t, f, m.c, ref);
    if (!pt) return;
    var mm = pt.m, c = nn ? Math.abs(mm - nn.midi) * 100 : 999;
    var pcol = slotColor(slot);   // v13.15: the trace, dot, scoreboard / HUD panels and results all use slotColor(slot)
    if (pt.join && pt.pm != null) lane.addSegment({ t0: pt.pt, m0: pt.pm, t1: pt.t, m1: mm, col: pcol, lit: !!nn && c <= 100, midi: nn ? nn.midi : 0 });
    lane.setLive({ t: pt.t, m: mm, c: c, hz: f, note: nn, color: pcol }, G.multi ? slot : 0);
  }
  // per-round player setup: who sings, which notes each player is scored on
  var JS = { n: 0, sum: 0, max: 0, over50: 0 };
  function jitStat(j) { JS.n++; JS.sum += j; if (j > JS.max) JS.max = j; if (j > 50) JS.over50++; }
  var G = null, RANK = { Miss: 0, Good: 1, Great: 2, Perfect: 3 };
  function lineOfNote(n) {
    if (typeof n.line === 'number') return n.line;
    for (var i = song.lines.length - 1; i >= 0; i--) if (n.t >= song.lines[i].t - 0.3) return i;
    return 0;
  }
  function setupRound() {
    prepLines(song);
    var all = Object.keys(PLAYERS).map(Number).sort();
    var live = all.filter(function (k) { return PLAYERS[k].mic === 'live'; });
    var slots = live.length ? live : all.length ? all : [1];
    if (slots.length > 4) slots = slots.slice(0, 4);
    var md = mode();
    if (md !== 'party' && slots.length < 2) md = 'party';
    // v13.12.1: Battle used to keep only the first 2 live mics (slots.slice(0, 2)), so a 3rd/4th
    // singer got no pitch lane and no HUD. Trade-lines now rotate among everyone; same-parts, everyone sings.
    var g = { slots: slots, mode: md, multi: slots.length > 1, scorers: {}, idx: {}, prev: {}, lat: {}, best: [], owner: null, late: {}, told: {} };
    if (md === 'battle-alt') g.owner = song.lines.map(function (l, i) { return slots[i % slots.length]; });
    slots.forEach(function (s) {
      var ids = [];
      song.notes.forEach(function (n, k) { if (!g.owner || g.owner[lineOfNote(n)] === s) ids.push(k); });
      g.idx[s] = ids; g.scorers[s] = new S.LiveScorer(ids.map(function (k) { return song.notes[k]; }));
      g.lat[s] = PLAYERS[s] ? PLAYERS[s].lat || 0 : 0;
    });
    return g;
  }

  // ---------- v13.13 join QR on screen + mid-song late join ----------
  // The QR is the same join link as the home screen (cloud room when the relay is up, the local one when it is down).
  // A phone that joins mid-song and taps Start mic gets a lane/HUD/colour at once and is scored only on the notes from ~0.8 s after it joined (percent of those notes).
  var JQ = { svg: '', cloud: false, drawn: '' }, LATE_LEAD = 0.8;
  function joinQrOn() { try { return localStorage.getItem('karaoke.joinQr') !== '0'; } catch (e) { return true; } }
  function renderJoinQr() {
    var g = $('game'), el = $('gQr'); if (!g || !el) return;
    if ($('pmJoinQr')) $('pmJoinQr').textContent = joinQrOn() ? 'On' : 'Off';
    var show = screen === 'game' && !!G && G.kind === 'sing' && !finished && joinQrOn() && !!JQ.svg && Object.keys(PLAYERS).length < 4 && !(window.KBA_ON && KBA_ON.active);
    if (show && JQ.drawn !== JQ.svg) { $('gQrSvg').innerHTML = JQ.svg; JQ.drawn = JQ.svg; }
    g.classList.toggle('qron', !!show);
  }
  function lateTell(slot, how) { if (!G || !song) return; wsSend({ type: 'state', state: 'playing', song: song.id, mode: G.mode, to: slot, late: how }); }
  function lateCheck() {
    if (screen !== 'game' || !G || finished || G.kind !== 'sing' || soloBeat() || (window.KBA_ON && KBA_ON.active)) return;
    Object.keys(PLAYERS).forEach(function (k) {
      k = +k; var p = PLAYERS[k]; if (G.scorers[k]) return;
      if (p.mic === 'live') addLatePlayer(k);
      else if (!G.told[k]) { G.told[k] = 1; lateTell(k, 'wait'); }
    });
  }
  function lateOwners(all, cut) {   // Battle · trade lines: hand the not-yet-started lines round-robin to everyone, newcomer included
    var N = song.notes, k, fl = -1, early = false;
    for (k = 0; k < N.length; k++) if (N[k].t >= cut) { fl = lineOfNote(N[k]); break; }
    if (fl < 0) return -1;
    for (k = 0; k < N.length && N[k].t < cut; k++) if (lineOfNote(N[k]) === fl) { early = true; break; }
    var start = fl + (early ? 1 : 0);
    for (var i = start; i < G.owner.length; i++) G.owner[i] = all[i % all.length];
    return start;
  }
  function addLatePlayer(slot) {
    if (G.scorers[slot] || G.slots.length >= 4) return;
    var t = clock(), cut = t + LATE_LEAD, N = song.notes, all = G.slots.concat(slot), ids = [], start = -1;
    if (G.mode === 'battle-alt') {
      start = lateOwners(all, cut);
      if (start >= 0) N.forEach(function (n, k) { var li = lineOfNote(n); if (li >= start && G.owner[li] === slot) ids.push(k); });
    } else N.forEach(function (n, k) { if (n.t >= cut) ids.push(k); });
    if (!ids.length) { G.told[slot] = 1; lateTell(slot, 'over'); return; }
    if (G.mode === 'battle-alt') G.slots.forEach(function (s) {   // existing singers keep what they have sung and the lines they still own
      var keep = G.idx[s].filter(function (id) { return lineOfNote(N[id]) < start; }), fut = [];
      N.forEach(function (n, k) { var li = lineOfNote(n); if (li >= start && G.owner[li] === s) fut.push(k); });
      G.idx[s] = keep.concat(fut); G.scorers[s].replaceNotes(G.idx[s].map(function (k) { return N[k]; }));
    });
    G.idx[slot] = ids; G.scorers[slot] = new S.LiveScorer(ids.map(function (k) { return N[k]; }));
    G.lat[slot] = PLAYERS[slot] ? PLAYERS[slot].lat || 0 : 0;
    G.late[slot] = { at: +t.toFixed(2), from: +cut.toFixed(2), notes: ids.length };
    G.slots.push(slot); G.multi = G.slots.length > 1;
    buildScoreboard(); G.slots.forEach(updateScore);
    // HUD card: grows in beside the others (flex-grow + opacity only); the first time, solo -> multi switches the whole layout (css transitions)
    $('game').classList.add('cards');
    if (!PC.rows.length) {
      PC.rows = G.slots.map(function (x) { return { slot: x, name: pname(x), sing: true, enter: true }; });
      $('pCards').innerHTML = PC.rows.map(pcHtml).join('');
    } else {
      var row = { slot: slot, name: pname(slot), sing: true, enter: true }; PC.rows.push(row);
      var d = document.createElement('div'); d.innerHTML = pcHtml(row); $('pCards').appendChild(d.firstChild);
      var gh = $('pCards').querySelector('.pc.ghost'); if (gh) gh.parentNode.removeChild(gh);
    }
    requestAnimationFrame(function () { requestAnimationFrame(function () { var es = $('pCards').querySelectorAll('.pc.enter'); for (var i = 0; i < es.length; i++) es[i].classList.remove('enter'); }); });
    renderJoinQr(); lateTell(slot, 'in');
    toastAny('\ud83c\udfa4 ' + pname(slot) + ' joined the song', 3500);
    wsSend({ type: 'perf', screen: 'latejoin', build: BUILD, src: window.tizen ? 'tv' : 'browser', song: song.id, slot: slot, at: G.late[slot].at, notes: ids.length, mode: G.mode, singers: G.slots.length });
  }
  function pname(s) { return PLAYERS[s] ? PLAYERS[s].name : 'Player ' + s; }
  function pcolor(s) { return slotColor(s); }
  function buildScoreboard() {
    $('game').classList.toggle('multi', G.multi);
    $('game').classList.toggle('battle', G.mode !== 'party');
    $('game').classList.toggle('battle-alt', G.mode === 'battle-alt');
    $('game').classList.toggle('pn3', G.slots.length === 3);
    $('game').classList.toggle('pn4', G.slots.length >= 4);
    $('scoreboard').innerHTML = G.multi ? G.slots.map(function (s, i) {
      return (G.mode !== 'party' && G.slots.length === 2 && i === 1 ? '<div class="sb-vs">VS</div>' : '') +
        '<div class="sb" id="sb' + s + '" style="--c:' + pcolor(s) + '"><div class="sb-top"><span class="sb-name">' + esc(pname(s)) + '</span><span class="sb-fb" id="sbfb' + s + '"></span><span class="sb-score" id="sbs' + s + '">0</span></div><div class="sb-bar"><i id="sbb' + s + '"></i></div></div>';
    }).join('') : '';
  }
  function updateScore(s) {
    if (soloBeat()) return;
    var sc = G.scorers[s];
    if (!G.multi) {
      if (DEV.hud) $('score').textContent = sc.liveScore();
      $('combo').textContent = sc.combo > 1 ? sc.combo + ' note combo' + (G.savedAt && performance.now() - G.savedAt < 1500 ? ' \u00b7 on time' : '') : '';
      return;
    }
    var v = sc.liveScore();
    $('sbs' + s).textContent = v;
    $('sbb' + s).style.transform = 'scaleX(' + (v / 100).toFixed(3) + ')';
  }
  function flashPlayer(s, rating, cls) { var el = $('sbfb' + s); if (el) { el.textContent = rating; el.className = 'sb-fb ' + (cls || rating); } }
  var lane = null, prevPt = null; // prevPt kept for older debug hooks
  function accColor(c) { return c <= 35 ? '#3ff2ff' : c <= 100 ? '#59ffa8' : c <= 170 ? '#ffd75e' : '#ff3fa4'; }

  // ---------- guide vocals (original vocal stem quietly under the instrumental) ----------
  var guideEl = $('guide');
  var GUIDE = { off: 0, low: 0.25, medium: 0.5, full: 1 }, GUIDE_ORDER = ['off', 'low', 'medium', 'full'];
  var GUIDE_NAME = { off: 'Off', low: 'Low', medium: 'Medium', full: 'Full' };
  // v13.8.1: guide vocals default to FULL (one-time reset of the old Low default; later choices persist)
  try { if (localStorage.getItem('karaoke.guideFullMigrated') !== '1') { localStorage.setItem('karaoke.guideLevel', 'full'); localStorage.setItem('karaoke.guideFullMigrated', '1'); } } catch (e) {}
  function guideLevel() { var v = localStorage.getItem('karaoke.guideLevel'); return GUIDE[v] != null ? v : 'full'; } // default Full
  // v11.1 hotfix: on the Tizen TV a 2nd <audio> element (guide) starves the main track's decoder (songs stuck at 0:00/0:01).
  // Guide vocals stay off on the TV until the single-AudioContext engine ships; browsers keep the element path.
  var GUIDE_ELEMENT_OK = !TVLIKE;
  function hasGuide() { return !!(song && song.guideUrl) && (audio.mode === 'webaudio' || GUIDE_ELEMENT_OK); } // v12: Web Audio guide = no 2nd element
  function guideText() {
    if (!hasGuide()) return '';
    var lv = guideLevel();
    return '<b>YELLOW</b>Guide vocals: ' + GUIDE_NAME[lv] + (lv !== 'off' ? ' · may raise your score if the mic hears it' : '');
  }
  function showGuide() {
    var gv = hasGuide() ? GUIDE_NAME[guideLevel()] : !GUIDE_ELEMENT_OK && song && song.guideUrl ? 'next update' : 'not for this song';
    $('guideBtnVal').textContent = gv; $('pmGuide').textContent = gv;
    $('hudGuide').textContent = hasGuide() ? 'Guide vocals: ' + GUIDE_NAME[guideLevel()] + ' · OK = menu' : 'OK = menu';
    wsSend({ type: 'guide', level: guideLevel(), available: hasGuide() });
  }
  function setGuide(lv, persist) {
    if (GUIDE[lv] == null) return;
    if (persist !== false) localStorage.setItem('karaoke.guideLevel', lv);
    applyGuide(); showGuide();
  }
  function applyGuide() {
    var v = GUIDE[guideLevel()];
    if (audio.mode === 'webaudio') {   // sample-locked with the backing track: nothing to sync
      if (hasGuide() && screen === 'game') audio.setGuide(song.guideUrl);   // v13.11: never decode the guide stem from the song list
      audio.setGuideGain(screen === 'game' && !finished && hasGuide() ? v : 0);
      if (!guideEl.paused) guideEl.pause();
      return;
    }
    guideEl.volume = v;
    if (screen === 'game' && !finished && hasGuide() && v > 0 && !audio.paused) {
      if (guideEl.getAttribute('src') !== song.guideUrl) guideEl.src = song.guideUrl;
      guideEl.currentTime = audio.currentTime;
      var p = guideEl.play(); if (p && p.catch) p.catch(function () {});
    } else if (!guideEl.paused) guideEl.pause();
  }
  // Keep the stem locked to the instrumental. TV media clocks are coarse and mp3 seeks land on frame boundaries,
  // so: median of the last 5 drift samples (every 200 ms); small drift -> nudge playbackRate (+-4%, pitch-preserved),
  // only a large drift (> 0.5 s, e.g. after a stall) re-seeks.
  var lastGuideSync = 0, guideDrifts = [], guideMedian = 0;
  function syncGuide() {
    var now = performance.now(); if (now - lastGuideSync < 200) return; lastGuideSync = now;
    if (audio.mode === 'webaudio') { guideMedian = 0; return; }
    if (guideEl.paused || audio.paused) return;
    guideDrifts.push(guideEl.currentTime - audio.currentTime); if (guideDrifts.length > 5) guideDrifts.shift();
    var srt = guideDrifts.slice().sort(function (a, b) { return a - b; }), med = srt[srt.length >> 1];
    guideMedian = med;
    if (Math.abs(med) > 0.5) { guideEl.currentTime = audio.currentTime; guideEl.playbackRate = 1; guideDrifts = []; return; }
    var rate = Math.abs(med) < 0.02 ? 1 : 1 - Math.max(-0.04, Math.min(0.04, med * 0.4));
    if (Math.abs(guideEl.playbackRate - rate) > 0.004) guideEl.playbackRate = rate;
  }
  function stopGuide() { if (audio.mode === 'webaudio') audio.setGuideGain(0); if (!guideEl.paused) guideEl.pause(); guideEl.playbackRate = 1; guideDrifts = []; }

  // ---------- game flow ----------
  function startGame() {
    if (!song) return;
    if (BUSY.on && !BUSY.err) return;                       // already loading: ignore repeat presses
    if (audio.mode === 'webaudio' && !audio.ready(song.audioUrl)) {
      var sg = song; busyShow('Loading \u201c' + sg.title + '\u201d\u2026', 'Back = cancel'); busyWatch(sg);
      requestAnimationFrame(function () { setTimeout(function () { if (BUSY.on && !BUSY.err && song === sg) startGameNow(); }, 0); });   // let the overlay paint first
    } else { busyHide(); startGameNow(); }
  }
  function startGameNow() {
    if (!song) return;
    if (song.provider === 'stingray' && !song.audioUrl) return;
    paused = false; $('game').classList.remove('paused');
    G = setupRound(); scorer = G.scorers[G.slots[0]]; trail = []; finished = false; startConfirmed = false;
    buildScoreboard();
    $('score').textContent = '0'; $('combo').textContent = ''; resetFeedback();
    var kind = REC.active ? 'rec' : REC.preview ? 'beat' : playKind();
    if (kind === 'rec' && !REC.active) kind = 'beat';
    if (kind !== 'sing' && !(song.beats && song.beats.t && song.beats.t.length) && !song.chart) { kind = 'sing'; setTimeout(function () { toastAny('Beat mode: this song has no beat map yet — singing instead', 4000); }, 50); }
    G.kind = kind;
    LYRIC_W = kind === 'duet' ? 664 : 1600;   // v13.9: lyric pill padding (sing / beat) + duet singer panel
    lane = new KaraokeLane($('laneWrap'), song, { width: kind === 'duet' ? 600 : kind === 'sing' ? 1380 : 1700, height: kind === 'duet' ? DUET_LANE_H : 470, behind: kind === 'duet' ? 1.6 : 2.2, ahead: kind === 'duet' ? 3.6 : 4.5, nowX: kind === 'duet' ? 0.3 : 0.27 });
    if (beat) { beat.destroy(); beat = null; }
    if (kit) kit.padOff();
    if (kind === 'beat' || kind === 'jam') { G.multi = false; G.mode = 'party'; G.slots = [G.slots[0]]; G.owner = null; buildScoreboard(); }
    var input = padList().length ? 'pad' : 'remote';
    if (kind !== 'sing') {
      if (REC.preview) { song.__draft = REC.draft; song.__range = [REC.preview.a - 0.01, REC.preview.b + 0.01]; }
      beat = new KaraokeBeat($('beatTrack'), song, { diff: REC.preview ? 'hard' : playDiff(), input: input, jam: kind === 'jam', rec: kind === 'rec' ? { notes: REC.active.notes, ghost: REC.active.ghost } : null, width: kind === 'duet' ? 600 : 1000, height: kind === 'duet' ? 750 : 760, offsetMs: beatOffsetMs(), onJudge: onBeatJudge });
    }
    delete song.__draft; delete song.__range;
    G.beatName = input === 'pad' ? '\ud83c\udfae ' + (padName() || 'Controller') : '\ud83d\udcfa Remote';
    ['beatonly', 'duet', 'jam', 'beatboth'].forEach(function (c) { $('game').classList.remove(c); });
    if (kind === 'beat' || kind === 'rec') $('game').classList.add('beatonly'); else if (kind === 'jam') $('game').classList.add('beatonly', 'jam'); else if (kind === 'duet') $('game').classList.add('duet');
    $('jamHelp').innerHTML = kind === 'jam' ? jamHelp(input) : kind === 'rec' ? recHelp(input) : REC.preview ? '<b>Preview</b> \u2014 your map, ' + fmt(REC.preview.a) + '\u2013' + fmt(REC.preview.b) + '. Options = stop' : '';
    $('game').classList.toggle('recording', kind === 'rec'); $('game').classList.toggle('sing', kind === 'sing'); $('game').classList.toggle('flat', localStorage.getItem('karaoke.flat') === '1'); gameHud(kind); hudStart(kind);
    prevPt = null; lastLine = -1; lastTimeTxt = ''; lastNoteTxt = '';
    show('game'); renderJoinQr(); guardKeys(1200); audio.abortTest();   // a silent engine check must never mute/pause a real song
    if (audio.getAttribute('src') !== song.audioUrl) audio.src = song.audioUrl;
    audio.setRate && audio.setRate(REC.active ? REC.active.rate : 1);
    audio.currentTime = REC.active ? REC.active.from : REC.preview ? REC.preview.from : 0;
    // v13.8.1 fix: listeners go on BEFORE play(). With the song already decoded (the song list preloads it) the engine starts
    // synchronously inside play() and fires 'playing' at once, so a listener added afterwards never ran: the guide stayed
    // silent until Guide was toggled off/on. Also set the guide stem before play and apply its level right away.
    if (audio.mode === 'webaudio' && !audio.ready(song.audioUrl)) {
      $('hudGuide').textContent = 'Loading song…';
      audio.addEventListener('playing', function () { showGuide(); }, { once: true });
    }
    audio.addEventListener('playing', function () { if (audio.lastStart) wsSend({ type: 'perf', screen: 'songstart', build: BUILD, src: window.tizen ? 'tv' : 'browser', engine: audio.mode, song: song.id, startMs: audio.lastStart.ms, preloaded: audio.lastStart.preloaded, slice: audio.lastSlice || null, sliceOff: audio.sliceWhy || null, mode: G && G.mode, slots: G && G.slots, nJoined: Object.keys(PLAYERS).length }); }, { once: true });
    audio.addEventListener('playing', applyGuide, { once: true });
    audio.addEventListener('playing', busyHide, { once: true });
    if (hasGuide()) { if (audio.mode === 'webaudio') audio.setGuide(song.guideUrl); else { guideEl.src = song.guideUrl; guideEl.currentTime = 0; } }
    var p = audio.play();
    if (p && p.catch) p.catch(function (e) { $('lyricCur').textContent = 'Audio blocked: ' + e.message; if (BUSY.on) busyError('Couldn\u2019t start \u201c' + song.title + '\u201d', function () { startGame(); }); });
    applyGuide();
    showGuide();
    wsSend({ type: 'state', state: 'playing', song: song.id, mode: G.mode, players: G.slots.map(function (s) { return { slot: s, name: pname(s), color: pcolor(s) }; }) });
    requestAnimationFrame(loop);
  }
  // ---------- v13.11: warm-up + first-open telemetry ----------
  // Behind the first paint (home idle): decode the logo / avatars / blurred search backdrop, pre-decode the art around the highlighted card,
  // and render each hidden screen once at ~1% opacity for two frames so styles, layout and layers exist before the first real open.
  // Everything is skipped while a key was pressed in the last 0.7 s or the screen is not the song list. Memory: ~10 MB of small images.
  var WARM = { imgs: [], ran: false, tries: 0, lastKey: 0, art: 0 };
  function warmOK() { return screen === 'home' && !REC.ui && !imeLock && performance.now() - WARM.lastKey > 700; }
  function warmImages() {
    var us = ['img/logo.webp', 'img/stage-blur.jpg']; for (var k = 0; k < 8; k++) us.push('img/av' + k + '.webp');
    us.forEach(function (u, k) { setTimeout(function () { try { var im = new Image(); im.src = u; WARM.imgs.push(im); if (im.decode) im.decode().catch(function () {}); } catch (e) {} }, k * 90); });
  }
  function warmArt() {   // art of the cards around the highlighted one (cards off-screen skip paint, so their images are not decoded until scrolled to)
    clearTimeout(WARM.art); WARM.art = setTimeout(function () {
      if (!warmOK() || !song) return;
      var cards = $('songList').children, base = visList ? visList.indexOf(selected) : selected, list = visList || null;
      for (var d = -3; d <= 9; d++) {
        var p = base + d, ci = list ? list[p] : p; if (ci == null || ci < 0 || ci >= cards.length) continue;
        var im = cards[ci].querySelector('.art-img'); if (im && im.decode && im.complete) im.decode().catch(function () {});
      }
    }, 350);
  }
  function warmScreens() {
    if (WARM.ran) return;
    if (!warmOK()) { if (++WARM.tries < 40) setTimeout(warmScreens, 800); return; }
    WARM.ran = true;
    var els = ['game', 'results', 'calib', 'sync', 'searchOverlay'].map($).filter(Boolean), i = 0;
    (function one() {
      if (i >= els.length || screen !== 'home') { els.forEach(function (e) { e.classList.remove('warm'); }); return; }
      var el = els[i++]; el.classList.add('warm');
      requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.remove('warm'); setTimeout(one, 60); }); });
    })();
  }
  function warmStart() { if (/[?&]nowarm=1/.test(location.search)) return; setTimeout(warmImages, 1200); setTimeout(warmScreens, 2600); }
  // first-open telemetry: frame gaps for 1.5 s after the first and second open of each screen -> perf.log {screen:'open'} (on-device before/after)
  var FO = { seen: {}, cur: null };
  function foBegin(name) {
    if (!FO) return;
    var n = FO.seen[name] = (FO.seen[name] || 0) + 1; if (n > 2) return;
    FO.cur = { name: name, n: n, t0: performance.now(), prev: 0, over50: 0, max: 0, frames: 0 };
  }
  function foTick(now) {
    var c = FO.cur; if (!c) return;
    if (c.prev) { var g = now - c.prev; c.frames++; if (g > 50) c.over50++; if (g > c.max) c.max = g; }
    c.prev = now;
    if (now - c.t0 > 1500) { FO.cur = null; wsSend({ type: 'perf', screen: 'open', name: c.name, n: c.n, over50: c.over50, maxFrameMs: Math.round(c.max), frames: c.frames, build: BUILD, src: window.tizen ? 'tv' : 'browser' }); }
  }
  // ---------- v13.11: loading feedback ("Loading <song>…" within one frame) + stall watchdog ----------
  // Cheap on the TV: only opacity/transform animations, no blur. Repeat OK presses are ignored while loading; Back cancels; a start that makes no
  // progress for 20 s is aborted and retried by itself (twice), then a friendly "try again" prompt (OK = retry, Back = leave).
  var STALL_MS = +(localStorage.getItem('karaoke.busyStallMs') || 20000);   // test hook
  var BUSY = { on: false, err: false, timer: 0, lastProg: -1, lastChange: 0, tries: 0, retry: null, t0: 0 };
  function busyShow(label, hint) {
    var el = $('busy'); if (!el) return; BUSY.on = true; BUSY.err = false; BUSY.t0 = performance.now(); BUSY.lastProg = -1; BUSY.lastChange = BUSY.t0;
    $('busyTxt').textContent = label; $('busyHint').textContent = hint || ''; $('busyBar').style.transform = 'scaleX(0)'; el.className = 'busy show ind';
  }
  function busyProgress(f) { if (!BUSY.on || BUSY.err || !(f > 0.02)) return; $('busy').classList.remove('ind'); $('busyBar').style.transform = 'scaleX(' + Math.min(1, f).toFixed(3) + ')'; }
  function busyHide() { BUSY.on = false; BUSY.err = false; BUSY.retry = null; clearInterval(BUSY.timer); BUSY.timer = 0; var el = $('busy'); if (el) el.className = 'busy'; }
  function busyError(label, retry) {
    clearInterval(BUSY.timer); BUSY.timer = 0; BUSY.on = true; BUSY.err = true; BUSY.retry = retry; var el = $('busy'); if (!el) return;
    $('busyTxt').textContent = label; $('busyHint').textContent = (retry ? 'OK = try again' : '') + ' \u00b7 Back = leave'; $('busyBar').style.transform = 'scaleX(0)'; el.className = 'busy show err';
  }
  function busyWatch(sg) {   // while a song loads: progress bar, stall detection, automatic retry
    clearInterval(BUSY.timer); BUSY.tries = 0;
    BUSY.timer = setInterval(function () {
      if (!BUSY.on || BUSY.err || song !== sg) return clearInterval(BUSY.timer);
      var now = performance.now(), f = audio.mode === 'webaudio' ? audio.progress([sg.audioUrl]) : -1;
      if (f >= 0) { busyProgress(f); if (f !== BUSY.lastProg) { BUSY.lastProg = f; BUSY.lastChange = now; } }
      if ((f >= 0 && now - BUSY.lastChange > STALL_MS) || now - BUSY.t0 > STALL_MS * 6) {
        if (BUSY.tries < 2 && f >= 0) {
          BUSY.tries++; BUSY.lastChange = now; BUSY.t0 = now; $('busyHint').textContent = 'Taking long \u2014 trying again\u2026';
          audio.reset(sg.audioUrl); var p = audio.play(); if (p && p.catch) p.catch(function () {});
        } else {
          audio.reset(sg.audioUrl); audio.pause();
          busyError('Couldn\u2019t load \u201c' + sg.title + '\u201d', function () { startGame(); });
        }
      }
    }, 150);
  }
  function pressFx() {   // pressed state on the focused item, within the same frame as the key
    var el = document.querySelector('.screen.active .focused, #game.paused .pm-item.focused'); if (!el) return;
    el.classList.add('pressed'); setTimeout(function () { el.classList.remove('pressed'); }, 260);
  }
  // ---------- Beat mode glue ----------
  var beat = null, INPUT_LAG = { remote: 30, pad: 10, test: 0 };
  // ---------- Beat sync (Rock Band-style two-part calibration, saved per TV + backed up on the Mac server) ----------
  // tapA = audio+input: press to clicks you HEAR. tapV = video+input: press to flashes you SEE (silent).
  // Picture lead av = tapA - tapV (how much later the sound reaches you than the picture); presses are judged against tapA.
  // nudge (pause menu ◀ ▶) moves the audio side: + = sound comes later (notes drawn later, presses judged later).
  // Per OUTPUT DEVICE (auto-detected: Bluetooth / HDMI-ARC / jack / TV speaker). A tap test is stored for the device it was done on;
  // untested devices use type defaults. Bluetooth adds ~150-300 ms of audio delay the Web Audio API does NOT report on Tizen.
  var DEV_EXTRA = { bluetooth: 200, hdmi: 40, usb: 60, jack: 0, speaker: 0, unknown: 0 };
  var SYNC = (function () { try { var o = JSON.parse(localStorage.getItem('karaoke.sync') || '{}') || {}; return o.byDev ? o : { byDev: {} }; } catch (e) { return { byDev: {} }; } })();
  var AOUT = { type: 'unknown', name: '', src: 'none', raw: null };
  function prof() { return SYNC.byDev[AOUT.type] || {}; }
  function saveSync(s, push) { SYNC = s; try { localStorage.setItem('karaoke.sync', JSON.stringify(s)); } catch (e) {} if (push !== false) wsSend({ type: 'sync', sync: s }); renderSync(); }
  function syncNudge() { return +prof().nudge || 0; }
  function devExtra() { return DEV_EXTRA[AOUT.type] || 0; }
  function avMs() { var P = prof(); return Math.max(-200, Math.min(450, (P.tapA != null && P.tapV != null ? P.tapA - P.tapV : devExtra()) + syncNudge())); }
  // what the singer/player hears vs the song clock (TV pipeline + output device); mic sync overrides when measured on this device
  function outLat() {
    var micDev = localStorage.getItem('karaoke.outputLatencyDev');
    if (localStorage.getItem('karaoke.outputLatencyMs') !== null && (micDev || 'unknown') === AOUT.type) return CFG.outputLatencyMs + syncNudge();
    return 120 + devExtra() + syncNudge();
  }
  function judgeLagMs(src) {   // song-clock -> press: audio out + input lag (+ human bias when measured)
    var P = prof();
    if (P.tapA != null) return P.tapA + (INPUT_LAG[src] || 0) - (INPUT_LAG[P.src] || 0) + syncNudge();
    return outLat() + (INPUT_LAG[src] || 0);
  }
  // v13.6: gems are drawn where the SOUND is. The TV renders the picture ~40 ms after the song clock but the speaker plays ~120 ms after it, so with no tap test
  // (measured picture-vs-sound delay) the gems crossed the line ~90 ms before the hit was heard (from v13.3, when the picture lead stopped being applied to gems).
  var BEAT_AV_DEFAULT = 90;
  function beatSeenT(t) { var P = prof(); return t - (avMs() + (P.tapA != null && P.tapV != null ? 0 : BEAT_AV_DEFAULT)) / 1000; }
  var soloShown = '';
  function soloTag(t) {   // v13.6: "SOLO" tag while the chart is playing a lead-melody section
    var f = song && song.chart && song.chart.feat, el = $('soloTag'), want = '';
    if (f && G.kind !== 'jam') for (var i = 0; i < f.length; i++) if (f[i][2] === 'solo' && t >= f[i][0] - 0.5 && t < f[i][1]) { want = t < f[i][0] ? 'SOLO \u2192' : 'SOLO'; break; }
    if (want !== soloShown) { soloShown = want; el.textContent = want; el.classList.toggle('on', !!want); }
  }
  function seenT(t) { return t - avMs() / 1000; }   // song time to DRAW now so notes cross the line as you hear them
  function devLabel(t) { return { bluetooth: 'Bluetooth', hdmi: 'HDMI/ARC', usb: 'USB audio', jack: 'headphone jack', speaker: 'TV speakers', unknown: 'audio' }[t] || t; }
  function renderSync() {
    var n = syncNudge(), tx = (n > 0 ? '+' : '') + n + ' ms', P = prof();
    if ($('pmSync')) $('pmSync').textContent = devLabel(AOUT.type) + ' \u00b7 ' + (P.tapA != null ? 'tested' : 'auto') + (n ? ' ' + tx : '');
    if ($('syncBtnVal')) $('syncBtnVal').textContent = devLabel(AOUT.type) + (P.tapA != null ? ' \u00b7 tested' : ' \u00b7 auto');
  }
  function nudgeSync(d) { var s = JSON.parse(JSON.stringify(SYNC)), P = s.byDev[AOUT.type] || (s.byDev[AOUT.type] = {}); P.nudge = Math.max(-300, Math.min(300, (+P.nudge || 0) + d)); saveSync(s); toastAny('Sync ' + (P.nudge > 0 ? '+' : '') + P.nudge + ' ms ' + (d > 0 ? '(notes later)' : '(notes earlier)'), 1500); }
  // ---- output device detection (tizen.sound where the TV exposes it; reported to perf.log so we know what this TV says) ----
  function classify(dev) { dev = String(dev || '').toUpperCase(); return /BLUETOOTH|BT_|A2DP/.test(dev) ? 'bluetooth' : /HDMI|ARC|OPTICAL|SPDIF/.test(dev) ? 'hdmi' : /USB/.test(dev) ? 'usb' : /JACK|HEADPHONE|HEADSET/.test(dev) ? 'jack' : /SPEAKER|RECEIVER|BUILTIN|INTERNAL/.test(dev) ? 'speaker' : null; }
  function detectAudioOut(why) {
    var r = { why: why, apis: {} }, type = null, name = '';
    function pick(list, tag) {
      r.apis[tag] = (list || []).map(function (d) { return { device: d.device, type: d.type, name: d.name, dir: d.direction, conn: d.isConnected, act: d.isActivated, run: d.isRunning, id: d.id }; });
      var outs = (list || []).filter(function (d) { return !d.direction || /OUT|BOTH/i.test(d.direction); });
      ['bluetooth', 'hdmi', 'usb', 'jack', 'speaker'].some(function (want) { return outs.some(function (d) { if (classify(d.device || d.type) === want && !type) { type = want; name = d.name || d.device; return true; } }); });
    }
    var SND = (window.tizen && tizen.sound) || window.__testSound;   // __testSound: TEST-ONLY hook used by tools/check-sync.mjs (headless)
    try { if (SND) { r.apis.sound = Object.keys(Object.getPrototypeOf(SND) || {}).concat(Object.keys(SND)).slice(0, 30);
      if (SND.getActivatedDeviceList) pick(SND.getActivatedDeviceList(), 'activated');
      if (!type && SND.getConnectedDeviceList) pick(SND.getConnectedDeviceList(), 'connected'); } else r.apis.sound = 'absent'; } catch (e) { r.apis.soundErr = (e.name || '') + ': ' + (e.message || e); }
    try { if (window.tizen && tizen.tvaudiocontrol) r.apis.outputMode = tizen.tvaudiocontrol.getOutputMode(); } catch (e) { r.apis.tvaudioErr = (e.name || '') + ': ' + (e.message || e); }
    try { if (window.webapis && webapis.productinfo) r.apis.model = webapis.productinfo.getRealModel ? webapis.productinfo.getRealModel() : webapis.productinfo.getModel(); } catch (e) {}
    try { var c = audio.ctx; if (c) r.apis.webaudio = { base: c.baseLatency != null ? Math.round(c.baseLatency * 1000) : null, out: c.outputLatency != null ? Math.round(c.outputLatency * 1000) : null, sinkId: c.sinkId != null ? String(c.sinkId) : undefined }; } catch (e) {}
    var src = type ? 'tizen.sound' : 'none';
    if (!type) { var forced = localStorage.getItem('karaoke.audioOut'); if (forced) { type = forced; src = 'saved'; } }   // optional manual override (pause menu)
    var prev = AOUT.type; AOUT = { type: type || 'unknown', name: name, src: src, raw: r };
    wsSend({ type: 'perf', screen: 'audioout', build: BUILD, src: window.tizen ? 'tv' : 'browser', out: AOUT.type, from: src, name: name, apis: r.apis, why: why, avMs: avMs(), judgeMs: judgeLagMs('pad'), outLat: outLat() });
    renderSync();
    if (AOUT.type !== prev && AOUT.type !== 'unknown') toastAny((AOUT.type === 'bluetooth' ? '\ud83d\udd0a Bluetooth audio detected \u2014 synced (' : '\ud83d\udd0a ' + devLabel(AOUT.type) + ' \u2014 synced (') + (prof().tapA != null ? 'tested' : '+' + devExtra() + ' ms') + ')', 4000);
    return AOUT;
  }
  function watchAudioOut() {
    var SND = (window.tizen && tizen.sound) || window.__testSound;
    try { if (SND && SND.addDeviceStateChangeListener) SND.addDeviceStateChangeListener(function () { setTimeout(function () { detectAudioOut('device-change'); }, 400); }); } catch (e) {}
    try { if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', function () { detectAudioOut('mediadevices'); }); } catch (e) {}
    document.addEventListener('visibilitychange', function () { if (!document.hidden) detectAudioOut('visible'); });
  }
  var SY = null;
  function startSync() {
    var ctx = audio.ctx; if (!ctx) { toast('Beat sync needs Web Audio on this TV'); return; }
    if (ctx.state !== 'running' && ctx.resume) ctx.resume();
    if (!startSync.buf) { var sr = ctx.sampleRate, n = Math.round(sr * 0.03), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0); for (var i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * 1500 * i / sr) * Math.exp(-i / sr * 160) * 0.9; startSync.buf = b; }
    SY = { phase: 'audio', N: 14, period: 0.6, events: [], taps: [], res: {} };
    show('sync'); $('syncMsg').textContent = ''; guardKeys(500); syncPhase();
  }
  function syncPhase() {
    var ctx = audio.ctx, s = SY; s.events = []; s.taps = []; s.k = 0;
    $('syncTitle').textContent = s.phase === 'audio' ? 'Listen — press ✕ on every click (eyes closed is fine)' : 'Watch — press ✕ every time the circle flashes (no sound)';
    $('syncDots').textContent = ''; $('syncFlash').style.visibility = s.phase === 'audio' ? 'hidden' : 'visible';
    var t0 = performance.now() + 1500;
    for (var k = 0; k < s.N; k++) s.events.push(t0 + k * s.period * 1000);
    if (s.phase === 'audio') {   // schedule on the audio clock; map to performance.now at schedule time (same reference as the game clock)
      var c0 = ctx.currentTime, p0 = performance.now();
      s.events.forEach(function (pt) { var src = ctx.createBufferSource(); src.buffer = startSync.buf; src.connect(ctx.destination); src.start(c0 + (pt - p0) / 1000); });
    }
    s.drawn = []; requestAnimationFrame(syncTick);
  }
  function syncTick(now) {
    var s = SY; if (!s || screen !== 'sync') return;
    var i = s.events.length - 1; while (i >= 0 && s.events[i] > now) i--;
    if (s.phase === 'video') {
      var on = i >= 0 && now - s.events[i] < 90; if (on && s.drawn[i] == null) s.drawn[i] = now;   // when the flash frame was actually drawn
      $('syncFlash').className = 'sync-flash' + (on ? ' on' : '');
    }
    var dots = ''; for (var k = 0; k < s.N; k++) dots += k <= i ? '●' : '○'; if ($('syncDots').textContent !== dots) $('syncDots').textContent = dots;
    if (now > s.events[s.N - 1] + 700) return syncDone();
    requestAnimationFrame(syncTick);
  }
  function syncPress(src, ageMs) {
    var s = SY; if (!s || screen !== 'sync') return; var t = performance.now() - (ageMs || 0);
    s.taps.push(t); s.src = src;
  }
  function syncMedian(s) {   // pair each tap with its nearest event (skip the first 2 warm-up beats), robust median
    var ref = s.phase === 'video' ? s.drawn : s.events, e = [];
    s.taps.forEach(function (t) { var best = null; for (var k = 2; k < s.N; k++) { var r = ref[k] != null ? ref[k] : s.events[k]; if (best == null || Math.abs(t - r) < Math.abs(best)) best = t - r; } if (best != null && best > -250 && best < 450) e.push(best); });
    e.sort(function (a, b) { return a - b; }); if (e.length < 6) return null;
    var med = e[e.length >> 1], dev = e.map(function (x) { return Math.abs(x - med); }).sort(function (a, b) { return a - b; });
    return { ms: Math.round(med), n: e.length, spread: Math.round(dev[dev.length >> 1]) };
  }
  function syncDone() {
    var s = SY, r = syncMedian(s);
    if (!r) { $('syncMsg').textContent = 'Not enough taps (' + s.taps.length + ') — press OK to try again, BACK to leave.'; s.phase = 'retry-' + s.phase; return; }
    s.res[s.phase] = r;
    if (s.phase === 'audio') { s.phase = 'video'; $('syncMsg').textContent = 'Sound: ' + r.ms + ' ms. Now the picture…'; setTimeout(function () { if (SY === s && screen === 'sync') syncPhase(); }, 1200); return; }
    var a = s.res.audio.ms, v = r.ms;
    var ns = JSON.parse(JSON.stringify(SYNC)); ns.byDev[AOUT.type] = { tapA: a, tapV: v, src: s.src || 'pad', nudge: 0, at: new Date().toISOString(), spreadA: s.res.audio.spread, spreadV: r.spread }; saveSync(ns);
    try { localStorage.setItem('karaoke.beatOffsetMs', '0'); } catch (e) {}
    wsSend({ type: 'perf', screen: 'sync', build: BUILD, src: window.tizen ? 'tv' : 'browser', out: AOUT.type, tapA: a, tapV: v, av: a - v, spreadA: s.res.audio.spread, spreadV: r.spread, input: s.src, nA: s.res.audio.n, nV: r.n });
    $('syncTitle').textContent = 'Synced ✔';
    $('syncMsg').textContent = 'Sound reaches you ' + a + ' ms after the clock, picture ' + v + ' ms (incl. your controller). Notes are now drawn ' + Math.abs(a - v) + ' ms ' + (a >= v ? 'later' : 'earlier') + '. Press OK.';
    s.phase = 'done';
  }
  function syncKey(k, src, age) {   // returns true if handled
    if (screen !== 'sync') return false;
    if (k === 10009 || k === 8 || k === 27) { SY = null; goHome(); return true; }
    if (SY && SY.phase === 'done' && k === 13) { SY = null; goHome(); return true; }
    if (SY && /^retry-/.test(SY.phase) && k === 13) { SY.phase = SY.phase.slice(6); syncPhase(); $('syncMsg').textContent = ''; return true; }
    if (SY && (SY.phase === 'audio' || SY.phase === 'video')) { syncPress(src || 'remote', age); return true; }
    return true;
  }
  window.KaraokeSync = { get: function () { return { sync: SYNC, out: AOUT, avMs: avMs(), judgeMs: judgeLagMs('pad'), outLat: outLat() }; }, set: function (s) { saveSync(s, false); }, state: function () { return SY; }, detect: detectAudioOut, start: function () { startSync(); }, setOut: function (t) { AOUT.type = t; renderSync(); } };
  function beatOffsetMs() {
    try { if (localStorage.getItem('karaoke.beatOffsetFix') !== '13.6') { localStorage.setItem('karaoke.beatOffsetFix', '13.6'); localStorage.setItem('karaoke.beatOffsetMs', '0'); } } catch (e) {}   // v13.6: drop the -150 ms the old (early) gems taught it
    var v = +localStorage.getItem('karaoke.beatOffsetMs'); return isFinite(v) ? v : 0;
  }
  function beatPress(lane, src, ageMs) {
    if (REC.active) return recPress(lane, src, ageMs);
    if (!beat || screen !== 'game' || finished || paused) return null;
    var h = clock() - (judgeLagMs(src) + (ageMs || 0)) / 1000;
    var r = beat.press(lane, h, src);
    if (G.kind === 'jam') rumble(lane, 'Good');
    return r;
  }
  function beatRelease(lane, src, ageMs) {
    if (REC.active) return recRelease(lane, src, ageMs);
    if (lane === 8 && kit) kit.padOff();
    if (!beat || screen !== 'game' || finished || paused) return;
    beat.release(lane, clock() - (judgeLagMs(src) + (ageMs || 0)) / 1000);
  }
  function onBeatJudge(r, b, laneId) {
    if (r !== 'Miss') rumble(laneId, r);
    if (G.kind === 'duet') bigCombo(b.combo);
    if (G.kind !== 'beat') return;
    hudPanels(b);
    $('score').textContent = b.score();
    $('combo').textContent = '';
  }
  // ---------- instrument feedback: DualSense rumble only (no hit sounds, by request) ----------
  var kit = null, RUMBLE_ORDER = ['normal', 'strong', 'off'], RUMBLE_GAIN = { normal: 1, strong: 1.4, off: 0 }, RUMBLE_NAME = { normal: 'Normal', strong: 'Strong', off: 'Off' };
  function rumbleLevel() { var v = localStorage.getItem('karaoke.rumble'); return RUMBLE_GAIN[v] != null ? v : 'normal'; }
  function cycleRumble() {
    localStorage.setItem('karaoke.rumble', RUMBLE_ORDER[(RUMBLE_ORDER.indexOf(rumbleLevel()) + 1) % 3]);
    if ($('pmHit')) $('pmHit').textContent = RUMBLE_NAME[rumbleLevel()];
    toastAny('Rumble: ' + RUMBLE_NAME[rumbleLevel()], 2500);
  }
  var lastPadIdx = -1;
  rumble.at = -1e9; rumble.mag = 0;
  function rumble(lane, r) {
    var p = lastPadIdx >= 0 ? padList().filter(function (x) { return x.index === lastPadIdx; })[0] : null;
    var va = p && p.vibrationActuator, g = RUMBLE_GAIN[rumbleLevel()]; if (!va || !va.playEffect || !g) return;
    window.__rumbles2 = (window.__rumbles2 || 0) + 1;
    var strong = lane === 0 || lane === 9 ? 0.9 : lane === 3 ? 0.6 : lane >= 4 && lane <= 7 ? 0.5 : 0.2;
    var nowMs = performance.now(), mag = strong * (r === 'Perfect' ? 1 : r === 'Good' ? 0.5 : 0.8);   // coalesce: chords / dense runs -> one effect per 45 ms (strongest wins)
    if (nowMs - rumble.at < 45 && mag <= rumble.mag) { window.__rumbleSkipped = (window.__rumbleSkipped || 0) + 1; return; }
    rumble.at = nowMs; rumble.mag = mag;
    try { va.playEffect('dual-rumble', { startDelay: 0, duration: r === 'Perfect' ? 70 : 40, strongMagnitude: Math.min(1, g * strong * (r === 'Good' ? 0.5 : 1)), weakMagnitude: Math.min(1, g * (r === 'Perfect' ? 0.8 : 0.4)) }); } catch (e) {}
  }
  function padName() { var p = padList()[0]; if (!p) return ''; var m = /"?([^"(]+)"?\s*\(/.exec(p.id); return (m ? m[1] : p.id).trim().replace('Wireless Controller', '').trim() || 'Controller'; }
  function jamHelp(input) {
    var L = KaraokeBeat.LANES;
    if (input !== 'pad') return '<b>Jam · free play</b> — play along with the song: \u25bc kick \u00b7 \u25b6 snare \u00b7 \u25c0 hi-hat \u00b7 \u25b2 crash. Connect a controller for bass, pads and accents. BACK = menu';
    return '<b>Jam · free play</b> — play along with the song (no sounds, feel it in the rumble): <span style="color:' + L[0].col + '">\u2715 kick</span> \u00b7 <span style="color:' + L[1].col + '">\u25cb snare</span> \u00b7 <span style="color:' + L[2].col + '">\u25a1 hi-hat</span> \u00b7 <span style="color:' + L[3].col + '">\u25b3 crash</span> \u00b7 <span style="color:' + L[4].col + '">D-pad bass (\u2191 higher \u2193 lower \u2190 root \u2192 octave)</span> \u00b7 <span style="color:' + L[8].col + '">hold L1 pad</span> \u00b7 <span style="color:' + L[9].col + '">R1 accent</span> \u00b7 Options = menu';
  }
  function learnBeatOffset(br) {   // self-calibration: nudge toward the player's median timing error (remote/controller/TV lag)
    if (br.hits < 12) return null;
    var nv = Math.max(-60, Math.min(60, Math.round(beatOffsetMs() + 0.6 * br.medianErrMs)));   // v13.6: human residual only (+-60 ms); device latency belongs to the A/V sync
    localStorage.setItem('karaoke.beatOffsetMs', String(nv)); return nv;
  }
  var BEAT_MSG = { S: 'Rhythm master!', A: 'Right on the beat!', B: 'Nice groove!', C: 'Getting there!', D: 'Feel the beat and try again!' };
  function finishBeat(br, learned) {
    var g = grade(br.score);
    rsShowSolo({ score: br.score, combo: br.maxCombo, pitch: null, rhythm: accPct(br.counts), msg: String(BEAT_MSG[g] || '').toUpperCase(), sub: 'SOLO MODE \u2022 BEAT \u2022 ' + PLAY_NAME['beat-' + br.diff].split(' \u00b7 ')[1].toUpperCase() });
    addPoints(br.score * 10);
    ['Perfect', 'Great', 'Good', 'Miss'].forEach(function (k) { $('c' + k).textContent = br.counts[k]; });
    var colors = { Perfect: '#3ff2ff', Great: '#59ffa8', Good: '#ffd75e', Miss: '#ff6b86' }, val = { Perfect: 1, Great: 0.75, Good: 0.45, Miss: 0.03 };
    var R = br.ratings, per = Math.max(1, Math.ceil(R.length / 150)), bars = [];
    for (var i = 0; i < R.length; i += per) {
      var sl = R.slice(i, i + per), v = sl.reduce(function (a, r) { return a + val[r]; }, 0) / sl.length;
      var c = v >= 0.9 ? colors.Perfect : v >= 0.65 ? colors.Great : v >= 0.35 ? colors.Good : colors.Miss;
      bars.push('<i style="height:' + Math.max(3, Math.round(v * 100)) + '%;background:' + c + '"></i>');
    }
    $('noteBars').innerHTML = bars.join('');
    $('resMeta').textContent = '\ud83e\udd41 Beat mode · ' + PLAY_NAME['beat-' + br.diff].split(' · ')[1] + ' · ' + Math.round(br.bpm) + ' bpm · best combo ' + br.maxCombo + ' · ' + br.total + ' beats' + timingText(br, learned);
    show('results');
    wsSend({ type: 'state', state: 'results', score: br.score });
  }
  function timingText(br, learned) {
    if (br.hits < 12) return '';
    var e = br.medianErrMs;
    return ' · timing: ' + (Math.abs(e) < 15 ? 'spot on' : Math.abs(e) + ' ms ' + (e > 0 ? 'late' : 'early')) + (learned != null && Math.abs(e) >= 15 ? ' (auto-adjusted)' : '');
  }
  function logPlay() {
    if (song && song.provider === 'stingray' && stingray && audio.currentTime > 0) stingray.logPlay(song.id, audio.currentTime); // royalty log (required)
  }
  function finish() {
    if (REC.active) return recEnd(); if (REC.preview) return previewEnd();
    if (finished) return; finished = true;
    audio.pause(); stopGuide(); logPlay();
    var r = scorer.finish();
    var br = beat ? beat.result() : null, learned = br ? learnBeatOffset(br) : null;
    if (br) wsSend({ type: 'perf', screen: 'beat', build: BUILD, src: window.tizen ? 'tv' : 'browser', song: song.id, kind: G.kind, diff: br.diff, score: br.score, counts: br.counts, total: br.total, medianErrMs: br.medianErrMs, hits: br.hits, wrong: br.wrong, presses: br.presses, offsetMs: beatOffsetMs(), pads: padList().length });
    if (kit) kit.padOff();
    if (G.kind === 'jam') { goHome(); return; }
    $('results').classList.toggle('multi', (G.multi && G.kind !== 'beat') || G.kind === 'duet');
    if (G.kind === 'beat') return finishBeat(br, learned);
    if (G.kind === 'duet') return finishDuet(br, learned);
    if (G.multi) { finishMulti(); return; }
    var g = grade(r.score);
    rsShowSolo({ score: r.score, combo: r.maxCombo, pitch: accPct(r.counts), rhythm: null, msg: { S: 'SUPERSTAR!', A: 'GREAT PERFORMANCE!', B: 'NICE SINGING!', C: 'GETTING THERE!', D: 'WARM UP AND TRY AGAIN!' }[g], sub: 'SOLO MODE \u2022 SING \u2022 ' + song.title.toUpperCase() });
    addPoints(r.score * 10);
    ['Perfect', 'Great', 'Good', 'Miss'].forEach(function (k) { $('c' + k).textContent = r.counts[k]; });
    var colors = { Perfect: '#3ff2ff', Great: '#59ffa8', Good: '#ffd75e', Miss: '#ff6b86' };
    $('noteBars').innerHTML = r.notes.map(function (n) {
      return '<i style="height:' + Math.max(3, Math.round(n.score * 100)) + '%;background:' + colors[n.rating] + '"></i>';
    }).join('');
    var voiced = scorer.frames.filter(function (x) { return x.f > 0; }).length;
    $('resMeta').textContent = 'Best combo ' + r.maxCombo + ' · ' + scorer.frames.length + ' pitch frames received from the phone (' + voiced + ' voiced)' + (br ? ' · \ud83e\udd41 Beat ' + br.score + ' (' + br.diff + ', ' + br.counts.Perfect + ' perfect)' + timingText(br, learned) : '');
    show('results');
    wsSend({ type: 'state', state: 'results', score: r.score });
  }
  // ---------- v13.9 RESULTS: winner reveal -> multiplayer table, solo grade card. Real scorer data only (no invented numbers). ----------
  var SLOT_COLOR = ['#ff3fa4', '#3ff2ff', '#ffd75e', '#59ffa8'] /* = server/phone COLORS by slot */, RS = { btns: [], idx: 0, phase: '', timer: 0, kind: '' };
  // v13.11.1: ONE source of truth for a player's colour = their slot (the server/phone hand out COLORS[slot-1]); HUD cards, scoreboard, pitch lane, lyrics owner, results and the phone all use it
  function slotColor(sl) { if (window.KBA_ON && KBA_ON.active) return SLOT_COLOR[0]; var p = PLAYERS[sl]; return (p && p.color) || SLOT_COLOR[(((sl || 1) - 1) % 4 + 4) % 4]; }
  window.KBA_PCOL = function (n) { return SLOT_COLOR[(((n || 1) - 1) % 4 + 4) % 4]; };   // v13.15: one colour source for online duels (you = player 1, opponent / ghost = player 2)
  function rgba(hex, a) { var n = parseInt(hex.slice(1), 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; }
  function avatarFor(sl) { return 'img/av' + (((sl || 1) - 1) % 8) + '.webp'; }
  function accPct(c) { if (!c) return null; var t = (c.Perfect || 0) + (c.Great || 0) + (c.Good || 0) + (c.Miss || 0); return t ? Math.round(100 * ((c.Perfect || 0) + 0.75 * (c.Great || 0) + 0.45 * (c.Good || 0)) / t) : null; }
  function pctTxt(v) { return v == null ? '\u2013' : v + '%'; }
  function laurelSvg(id, w) {   // two gold branches (generated, no image files)
    var o = '<svg viewBox="0 0 200 200" width="' + w + '" height="' + w + '"><defs><linearGradient id="lg' + id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff3b0"/><stop offset=".5" stop-color="#ffc94a"/><stop offset="1" stop-color="#e07b10"/></linearGradient></defs><g fill="url(#lg' + id + ')">';
    for (var side = -1; side <= 1; side += 2) for (var k = 0; k < 10; k++) {
      var ph = (28 + k * 14.5) * Math.PI / 180, rr = k % 2 ? 90 : 76, x = 100 + side * Math.sin(ph) * rr, y = 100 + Math.cos(ph) * rr;
      var rot = Math.atan2(-Math.sin(ph), side * Math.cos(ph)) * 180 / Math.PI + side * (k % 2 ? -28 : 28), sz = 1 - k * 0.035;
      o += '<ellipse cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" rx="' + (16 * sz).toFixed(1) + '" ry="' + (6.5 * sz).toFixed(1) + '" transform="rotate(' + rot.toFixed(1) + ' ' + x.toFixed(1) + ' ' + y.toFixed(1) + ')"/>';
    }
    o += '<path d="M' + (100 - 70) + ' 160 Q100 205 ' + (100 + 70) + ' 160" fill="none" stroke="url(#lg' + id + ')" stroke-width="4"/>';
    return o + '</g></svg>';
  }
  function crownSvg() { return '<svg viewBox="0 0 120 80" width="150" height="100"><defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6c0"/><stop offset=".55" stop-color="#ffc94a"/><stop offset="1" stop-color="#d9780c"/></linearGradient></defs><path d="M8 70 L4 18 L32 42 L60 6 L88 42 L116 18 L112 70 Z" fill="url(#cg)" stroke="#fff3b0" stroke-width="2"/><rect x="8" y="64" width="104" height="10" rx="3" fill="#e9a020"/><circle cx="60" cy="48" r="7" fill="#ff3fa4"/><circle cx="32" cy="54" r="5" fill="#3ff2ff"/><circle cx="88" cy="54" r="5" fill="#3ff2ff"/><circle cx="4" cy="18" r="5" fill="#fff3b0"/><circle cx="60" cy="6" r="5" fill="#fff3b0"/><circle cx="116" cy="18" r="5" fill="#fff3b0"/></svg>'; }
  function medalHtml(rank) {
    if (rank > 3) return '<div class="mr-rank n">' + rank + '</div>';
    return '<div class="mr-rank m' + rank + '">' + laurelSvg('m' + rank, 92) + '<b>' + rank + '</b></div>';
  }
  function countUp(el, to, ms, suf) {
    var t0 = performance.now(), tok = el._cu = (el._cu || 0) + 1; suf = suf || ''; el.setAttribute('data-v', to == null ? '' : to); if (to == null) { el.textContent = '\u2013'; return; }
    (function step() { if (el._cu !== tok) return; var k = Math.min(1, (performance.now() - t0) / ms), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(to * e) + suf; if (k < 1) requestAnimationFrame(step); })();
  }
  var rsFxBuilt = false;
  function rsBuildFx() {
    if (rsFxBuilt) return; rsFxBuilt = true;
    var c = '', cols = ['#ffd75e', '#ff3fa4', '#3ff2ff', '#59ffa8', '#a66bff', '#fff'];
    for (var i = 0; i < 46; i++) c += '<i style="left:' + (Math.random() * 100).toFixed(1) + '%;background:' + cols[i % cols.length] + ';animation-delay:-' + (Math.random() * 4).toFixed(2) + 's;animation-duration:' + (3 + Math.random() * 2.5).toFixed(2) + 's;width:' + (10 + (i % 3) * 4) + 'px"></i>';
    $('rsConfetti').innerHTML = c;
    var d = '', x = -20, seed = 7; function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
    while (x < 1960) { var y = 120 + rnd() * 60, r = 24 + rnd() * 8; d += 'M' + (x - 46) + ' 260 Q' + (x - 44) + ' ' + (y + 46) + ' ' + x + ' ' + (y + 40) + ' Q' + (x + 44) + ' ' + (y + 46) + ' ' + (x + 46) + ' 260 Z ';
      d += 'M' + (x - r) + ' ' + y + ' a' + r + ' ' + r + ' 0 1 0 ' + 2 * r + ' 0 a' + r + ' ' + r + ' 0 1 0 ' + -2 * r + ' 0 Z ';
      if (rnd() < 0.35) { var s2 = rnd() < 0.5 ? -1 : 1; d += 'M' + (x + s2 * 30) + ' ' + (y + 60) + ' L' + (x + s2 * 70) + ' ' + (y - 70) + ' L' + (x + s2 * 84) + ' ' + (y - 64) + ' L' + (x + s2 * 46) + ' ' + (y + 70) + ' Z '; }
      x += 70 + rnd() * 40; }
    $('rsCrowdPath').setAttribute('d', d);
    $('winLaurel').innerHTML = laurelSvg('w', 520); $('winCrown').innerHTML = crownSvg(); $('gradeLaurel').innerHTML = laurelSvg('g', 380);
  }
  var RS_BTN = { multi: [['home', 'HOME', '\u2302'], ['list', 'SONG LIST', '\u2630'], ['again', 'PLAY AGAIN', '\u21bb'], ['teams', 'SAME TEAMS', '\u21c4']], solo: [['home', 'HOME', '\u2302'], ['list', 'SONG LIST', '\u2630'], ['again', 'RETRY', '\u21bb'], ['next', 'NEXT SONG', '\u25b6']] };
  function rsButtons(kind) {
    RS.btns = RS_BTN[kind]; RS.idx = kind === 'multi' ? 2 : 3;
    $('rsBtns').innerHTML = RS.btns.map(function (b, i) { return '<div class="rs-btn' + (i === (kind === 'multi' ? 2 : 3) ? ' gold' : '') + '" data-a="' + b[0] + '"><span>' + b[2] + '</span>' + b[1] + '</div>'; }).join('');
    rsFocus(RS.idx);
  }
  function rsFocus(i) { RS.idx = Math.max(0, Math.min(RS.btns.length - 1, i)); var b = $('rsBtns').children; for (var k = 0; k < b.length; k++) b[k].classList.toggle('focused', k === RS.idx); }
  function rsAction(a) {
    clearTimeout(RS.timer);
    if (a === 'again') { startGame(); return; }
    goHome();
    if (a === 'home') { if (catIdx) setCat(0, true); if (searchQ) applySearch('', 'back'); selectSong(0); return; }
    if (a === 'next' || a === 'teams') {
      var order = visList || songs.map(function (x, i) { return i; }), j = order.indexOf(selected);
      selectSong(order[(j + 1) % order.length]); setTimeout(function () { if (screen === 'home') startGame(); }, 60);
    }
  }
  function rsKey(k) {   // results screen keys: ◀▶ buttons, OK = press (or skip the winner reveal)
    if (RS.phase === 'win' && (k === 13 || k === 37 || k === 39)) { rsTable(); return true; }
    if (k === 37 || k === 39) { rsFocus(RS.idx + (k === 39 ? 1 : -1)); return true; }
    if (k === 13) { rsAction(RS.btns[RS.idx][0]); return true; }
    return false;
  }
  function rsHead(title, sub) { $('rsTitle').textContent = title; $('mrSub').textContent = sub; }
  function rsShowMulti(rows, sub, winner) {   // rows: {slot,name,color,av,score,pitch,rhythm,combo}
    rsBuildFx(); var R = $('results'); R.classList.add('multi'); R.classList.remove('solo');
    rsHead('RESULTS', sub); rsButtons('multi');
    $('mrRows').innerHTML = rows.map(function (x, i) {
      return '<div class="mr-row" style="--c:' + x.color + ';--cb:' + rgba(x.color, 0.22) + ';--cg:' + rgba(x.color, 0.5) + ';animation-delay:' + (0.15 + i * 0.12) + 's">' + medalHtml(i + 1) +
        '<div class="mr-player"><img src="' + x.av + '" alt=""><span class="mr-p">P' + x.slot + '</span><span class="mr-name">' + esc(x.name) + '</span>' + (x.late ? '<em class="mr-late">joined late \u00b7 from ' + fmt(x.late.from) + ' \u00b7 % of notes since</em>' : '') + (i === 0 && winner ? '<span class="mr-crown">\u265b</span>' : '') + '</div>' +
        '<div class="mr-score" data-v="' + x.score + '">0</div><div class="mr-pct">' + pctTxt(x.pitch) + '</div><div class="mr-pct">' + pctTxt(x.rhythm) + '</div><div class="mr-combo">' + (x.combo != null ? x.combo + 'x' : '\u2013') + '</div></div>';
    }).join('');
    if (winner) {
      var w = rows[0]; R.classList.add('win'); RS.phase = 'win';
      $('winAv').src = w.av; $('winTag').textContent = 'P' + w.slot; $('winTag').style.background = w.color; $('winName').textContent = w.name;
      $('rsWin').style.setProperty('--c', w.color);
      countUp($('winScore'), w.score, 1600); $('winPitch').textContent = pctTxt(w.pitch); $('winRhythm').textContent = pctTxt(w.rhythm); $('winCombo').textContent = w.combo != null ? w.combo + 'x' : '\u2013';
      clearTimeout(RS.timer); RS.timer = setTimeout(rsTable, 6500);
    } else rsTable();
  }
  function rsTable() {
    clearTimeout(RS.timer); RS.phase = 'table'; var R = $('results'); R.classList.remove('win'); R.classList.add('table');
    var sc = $('mrRows').querySelectorAll('.mr-score'); for (var i = 0; i < sc.length; i++) countUp(sc[i], +sc[i].getAttribute('data-v'), 1200 + i * 150);
  }
  function rsShowSolo(o) {   // o: {score, counts, combo, pitch, rhythm, msg, sub}
    rsBuildFx(); var R = $('results'); R.classList.remove('multi', 'win', 'table'); R.classList.add('solo'); RS.phase = 'solo';
    rsHead('SONG RESULTS', o.sub); rsButtons('solo');
    var g = grade(o.score), st = o.score >= 90 ? 5 : o.score >= 75 ? 4 : o.score >= 60 ? 3 : o.score >= 40 ? 2 : 1;
    $('grade').textContent = g; $('grade').className = 'grade g' + g; $('gradeMsg').textContent = o.msg;
    var stars = $('resStars').children; for (var i = 0; i < 5; i++) stars[i].className = i < st ? 'on' : '';
    countUp($('finalScore'), o.score, 1400);
    $('sPitch').textContent = pctTxt(o.pitch); $('sRhythm').textContent = pctTxt(o.rhythm); $('sCombo').textContent = o.combo != null ? o.combo + 'x' : '\u2013';
    $('sPitchBar').style.transform = 'scaleX(' + ((o.pitch || 0) / 100) + ')'; $('sRhythmBar').style.transform = 'scaleX(' + ((o.rhythm || 0) / 100) + ')';
    R.classList.remove('rev'); void R.offsetWidth; R.classList.add('rev');
  }
  function grade(v) { return v >= 90 ? 'S' : v >= 75 ? 'A' : v >= 60 ? 'B' : v >= 40 ? 'C' : 'D'; }
  // Duet: singer(s) on the phone(s) + the controller/remote player on the beat highway, one combined results screen
  function finishDuet(br, learned) {
    var rows = G.slots.map(function (sl) { var r = G.scorers[sl].finish(); return { slot: sl, name: pname(sl), color: slotColor(sl), av: avatarFor(sl), score: r.score, pitch: accPct(r.counts), rhythm: null, combo: r.maxCombo }; });
    var bs = G.slots.length + 1; rows.push({ slot: bs, name: G.beatName.replace(/^\S+\s/, ''), color: slotColor(bs), av: avatarFor(bs), score: br.score, pitch: null, rhythm: accPct(br.counts), combo: br.maxCombo });
    var team = Math.round(rows.reduce(function (a, x) { return a + x.score; }, 0) / rows.length);
    rows.sort(function (a, b) { return b.score - a.score; });
    $('mrTitle').textContent = 'Duet results \u00b7 team score ' + team;
    rsShowMulti(rows, 'DUET \u2022 SING + BEAT \u2022 TEAM ' + team + timingText(br, learned).replace(' \u00b7 ', ' \u2022 ').toUpperCase(), rows.length > 1 && rows[0].score > rows[1].score);
    addPoints(team * 10);
    show('results');
    wsSend({ type: 'state', state: 'results', score: team });
  }
  function finishMulti() {
    var rows = G.slots.map(function (sl) { var r = G.scorers[sl].finish(); return { slot: sl, score: r.score, counts: r.counts, combo: r.maxCombo, late: G.late && G.late[sl] ? G.late[sl] : null }; });
    rows.sort(function (a, b) { return b.score - a.score; });
    var battle = G.mode !== 'party', tie = rows.length > 1 && rows[0].score === rows[1].score;
    $('mrTitle').textContent = battle ? (tie ? 'It\u2019s a tie!' : pname(rows[0].slot) + ' wins!') : 'Party results';
    rsShowMulti(rows.map(function (x) { return { slot: x.slot, name: pname(x.slot), color: slotColor(x.slot), av: avatarFor(x.slot), score: x.score, pitch: accPct(x.counts), rhythm: null, combo: x.combo, late: x.late }; }),
      'MULTIPLAYER \u2022 ' + String(MODE_NAME[G.mode] || '').toUpperCase() + (tie ? ' \u2022 TIE!' : ''), rows.length > 1 && !tie);   // v13.9: top scorer gets the winner reveal in every mode
    addPoints(rows[0].score * 10);
    show('results');
    var scores = {}; rows.forEach(function (x) { scores[x.slot] = x.score; });
    wsSend({ type: 'state', state: 'results', score: rows[0].score, scores: scores, winner: battle && !tie ? rows[0].slot : 0, winnerName: battle && !tie ? pname(rows[0].slot) : '' });
  }
  function goHome() { if (REC.active) return recEnd(); if (REC.preview) return previewEnd(); if (beat) { beat.destroy(); beat = null; } if (audio.release) audio.release(); paused = false; $('game').classList.remove('paused'); if (screen === 'game' && !finished) logPlay(); audio.pause(); stopGuide(); show('home'); wsSend({ type: 'state', state: 'home' }); }
  audio.addEventListener('ended', function () { if (screen === 'game') finish(); else if (screen === 'calib') endCalibration(); });

  // ---------- latency calibration: TV beeps -> phone mic -> measured speaker+air delay ----------
  var calFrames = null, calDone = false, cal = null;
  function showCalInfo() { $('calInfo').textContent = CFG.outputLatencyMs + ' ms' + (localStorage.getItem('karaoke.outputLatencyMs') !== null ? ' (measured)' : ' (default)'); }
  function startCalibration() {
    if (!(phone.connected && phone.mic === 'live')) { toast('Connect the phone and tap “Start mic” first, then run Sync.', 4000); return; }
    busyShow('Loading sync test\u2026', '');
    KaraokeSongs.getJson('songs/calibration/calibration.json', function (err, c) {
      if (err) return busyError('Couldn\u2019t load the sync test', function () { startCalibration(); });
      busyHide();
      cal = c; calFrames = []; calDone = false;
      $('calBeeps').innerHTML = c.beeps.map(function () { return '<i></i>'; }).join('');
      $('calTitle').textContent = 'Hold your iPhone where you’ll sing — stay quiet';
      $('calMsg').textContent = 'Listening for the beeps from your TV…'; $('calPress').innerHTML = '';
      show('calib');
      audio.src = 'songs/calibration/beeps.wav'; audio.currentTime = 0; audio.play();
      requestAnimationFrame(calLoop);
    });
  }
  function calLoop() {
    if (screen !== 'calib' || calDone) return;
    var t = clock(), dots = $('calBeeps').children;
    if (performance.now() - lastClockSent > 250) { lastClockSent = performance.now(); wsSend({ type: 'clock', t: +t.toFixed(3), lyric: 'Mic sync — stay quiet', score: 0 }); }
    cal.beeps.forEach(function (b, i) {
      dots[i].classList.toggle('play', t >= b && t < b + 0.3);
      if (!dots[i].classList.contains('hit')) {
        var r = KaraokeScoring.calibrate(calFrames, [b], cal.freq);
        if (r.found) dots[i].classList.add('hit');
      }
    });
    requestAnimationFrame(calLoop);
  }
  function endCalibration() {
    calDone = true;
    var r = KaraokeScoring.calibrate(calFrames, cal.beeps, cal.freq);
    var dots = $('calBeeps').children;
    for (var i = 0; i < dots.length; i++) if (!dots[i].classList.contains('hit')) dots[i].classList.add('miss');
    if (r.ok) {
      CFG.outputLatencyMs = r.latencyMs;
      try { localStorage.setItem('karaoke.outputLatencyMs', String(r.latencyMs)); localStorage.setItem('karaoke.outputLatencyDev', AOUT.type); } catch (e) {}
      $('calTitle').textContent = 'Mic synced ✓';
      $('calMsg').innerHTML = 'TV speaker + room delay<b>' + r.latencyMs + ' ms</b>';
    } else {
      $('calTitle').textContent = 'Couldn’t sync';
      $('calMsg').textContent = r.reason + '. Turn the TV volume up, keep the phone screen on, and try again.';
    }
    $('calPress').innerHTML = 'Press <b>OK</b> to continue';
    selectSongAudio(); showCalInfo();
  }
  function selectSongAudio() { if (song && audio.mode === 'webaudio') audio.src = song.audioUrl; }
  audio.addEventListener('fallback', function () { wsSend({ type: 'perf', screen: 'engine', build: BUILD, src: window.tizen ? 'tv' : 'browser', fallback: audio.err }); });

  // ---------- render loop ----------
  var lastLine = -1, lastCount = '';
  function loop() {
    if (screen !== 'game' || finished || paused) return;
    if (BUSY.on && !BUSY.err) { setTimeout(loop, 150); return; }   // v13.11.1: while the song is still loading, don't draw the (empty) game at 30-60 fps - that starved the sliced decode on the TV (first start 19.9 s)
    var w0 = performance.now();
    loopBody();
    window.KaraokePerfWork(performance.now() - w0);
    if (screen === 'game' && !finished && !paused) requestAnimationFrame(loop);
  }
  function loopBody() {
    var t = clock();
    var dur = song.duration;
    if (!song.scorable) $('hudPhone').textContent = 'Sing-along mode — this song has no reference melody yet';
    if (soloBeat() && !G.hudSet) { G.hudSet = true; var hp = $('hudPhone'); hp.className = 'hud-sub ok'; hp.textContent = (G.kind === 'jam' ? '\ud83c\udfb6 Jam' : '\ud83e\udd41 Beat mode') + ' \u00b7 ' + G.beatName; }
    progressBar.style.transform = 'scaleX(' + Math.min(1, Math.max(0, t / dur)).toFixed(4) + ')';
    syncGuide();
    var tt = fmt(t); if (tt !== lastTimeTxt) { lastTimeTxt = tt; $('tNow').textContent = tt; }
    hudTick(t);

    // count-in (audio has 4 clicks before the first note)
    var ci = Math.min(song.leadIn, 2.4), toGo = song.leadIn - t;
    var cd = REC.active || REC.preview ? recCount(t) : toGo > 0 && toGo <= ci ? (toGo > ci * 0.75 ? '3' : toGo > ci * 0.5 ? '2' : toGo > ci * 0.25 ? '1' : 'Sing!') : '';
    if (REC.active && t >= REC.active.b + 0.25) return recEnd();
    if (REC.preview && t >= REC.preview.b + 1.0) return previewEnd();
    if (cd !== lastCount) { lastCount = cd; var c = $('countdown'); c.textContent = cd; c.classList.remove('tick'); void c.offsetWidth; if (cd) c.classList.add('tick'); }

    // scoring — notes finalise once their timing window has passed
    // Finalise in 'heard' time, after the slowest phone frame for the note can have arrived.
    if (!soloBeat()) G.slots.forEach(function (sl) {
      var sc = G.scorers[sl];
      var done = sc.update(t - (outLat() + (G.lat[sl] || 0) + tvLegMs) / 1000 - 0.05);
      done.forEach(function (d) {
        var gi = G.idx[sl][d.index], pb = G.best[gi];
        if (!pb || RANK[d.rating] > RANK[pb.rating]) { G.best[gi] = d; if (DEV.tiles) lane.markScored(gi, d); }
        if (!DEV.feedback) return;
        if (d.saved) G.savedAt = performance.now();   // v13.15.1: scored Miss (wrong pitch) but sung on time: the streak continues, the rating stays as scored
        if (G.multi) flashPlayer(sl, d.rating); else { showFeedback(d.rating); singerTag(d.rating); if (G.kind === 'sing') singPanels(G.scorers[sl]); }
        wsSend({ type: 'feedback', to: sl, rating: d.rating, saved: !!d.saved, score: sc.liveScore() });
      });
      if (done.length) updateScore(sl);
    });

    var heard = t - outLat() / 1000; // lane shows the timeline the singer hears, same as the phone frames
    if (DEV.lyrics && !(G.kind === 'jam')) renderLyrics(seenT(t));   // lyric wipe follows what you HEAR (TV audio output delay), same clock as the lane; Beat shows a lyric strip too
    if (!soloBeat()) { lane.draw(heard, DEV); updateNoteName(heard); }
    if (beat) { beat.draw(beatSeenT(t), t - judgeLagMs('remote') / 1000); soloTag(t); }   // gems cross the line when you HEAR the hit (v13.6: untested devices get BEAT_AV_DEFAULT; before, only the picture lead was missing)
    if (performance.now() - lastClockSent > 250) {
      lastClockSent = performance.now();
      var li = lineAt(seenT(t));
      var scores = {}; G.slots.forEach(function (sl) { scores[sl] = G.scorers[sl].liveScore(); });
      wsSend({ type: 'clock', t: +t.toFixed(3), h: +(t - outLat() / 1000).toFixed(3), score: soloBeat() && beat ? beat.score() : scorer.liveScore(), scores: scores, owner: G.owner && li >= 0 ? G.owner[li] : 0, lyric: li >= 0 ? lineText(song.lines[li]) : '' });
    }
    if (t >= dur - 0.05) return finish();
  }

  // pre-rendered feedback words; restart the animation by alternating two identical keyframes (no forced reflow)
  var fbFlip = false, fbEls = null;
  function showFeedback(rating) {
    if (!fbEls) { fbEls = {}; var c = $('feedback').children; for (var i = 0; i < c.length; i++) fbEls[c[i].className.split(' ')[1]] = c[i]; }
    fbFlip = !fbFlip;
    for (var k in fbEls) fbEls[k].className = 'feedback ' + k + (k === rating ? (fbFlip ? ' show' : ' show2') : '');
  }
  function resetFeedback() { if (fbEls) for (var k in fbEls) fbEls[k].className = 'feedback ' + k; }
  // background drawn ONCE into a half-res canvas (radial gradients are expensive to re-raster on the TV)
  (function drawBg() {
    var c = $('bgCanvas'); if (!c || !c.getContext) return;
    var g = c.getContext('2d'); g.scale(0.5, 0.5);
    g.fillStyle = '#0a0320'; g.fillRect(0, 0, 1920, 1080);
    [[150, 0, 1000, '61,15,143'], [1920, 1080, 1000, '138,16,82'], [1056, 486, 750, '22,38,122']].forEach(function (b) {
      var r = g.createRadialGradient(b[0], b[1], 0, b[0], b[1], b[2]);
      r.addColorStop(0, 'rgba(' + b[3] + ',1)'); r.addColorStop(1, 'rgba(' + b[3] + ',0)');
      g.fillStyle = r; g.fillRect(0, 0, 1920, 1080);
    });
  })();
  // Auto-fit a lyric line inside the title-safe width: shrink the font, and for very long lines (current line only)
  // break into two balanced lines at a word boundary. Runs once per line change, never per frame.
  var LYRIC_W = 1700, DUET_LANE_H = 270;   // Duet: thinner pitch lane so 5 lyric lines fit under it
  function fitLyric(el, base, min, allowSplit) {
    el.style.fontSize = base + 'px'; el.classList.remove('two');
    var w = el.scrollWidth;
    if (w <= LYRIC_W) return;
    if (allowSplit && LYRIC_W / w < 0.8 && el.children.length >= 4) {
      var spans = el.children, total = 0, k, acc = 0, best = 1, bestD = 1e9;
      for (k = 0; k < spans.length; k++) total += spans[k].textContent.length;
      for (k = 0; k < spans.length - 1; k++) { acc += spans[k].textContent.length; var d = Math.abs(total / 2 - acc); if (d < bestD) { bestD = d; best = k + 1; } }
      el.insertBefore(document.createElement('br'), spans[best]);
      el.classList.add('two');
      var two = Math.round(base * 0.78); el.style.fontSize = two + 'px';
      w = el.scrollWidth;
      if (w > LYRIC_W) el.style.fontSize = Math.max(min * 0.8, Math.floor(two * LYRIC_W / w)) + 'px';
      return;
    }
    var fs = Math.max(min, Math.floor(base * LYRIC_W / w)); el.style.fontSize = fs + 'px';
    var w2 = el.scrollWidth; if (w2 > LYRIC_W && fs > min) { fs = Math.max(min, Math.floor(fs * LYRIC_W / w2) - 1); el.style.fontSize = fs + 'px'; }   // v13.9: second pass (narrow duet panel)
    if (el.scrollWidth > LYRIC_W) { el.style.textOverflow = 'ellipsis'; el.style.overflow = 'hidden'; }
  }
  // ---------- lyrics: classic karaoke (full phrase + next-line preview + smooth word-timed wipe) ----------
  function lineEndOf(l) { var w = l.words; return l.end != null ? l.end : (w.length ? w[w.length - 1].t + w[w.length - 1].d : l.t); }
  function wordsText(ws) { return ws.map(sylText).join('').trim(); }
  // Merge short LRC lines into fuller phrases (natural gap <= 1 s, <= 52 chars, <= 9 s). Done once per song.
  function prepLines(sg) {
    if (!sg || sg._prepped || !sg.lines || !sg.lines.length) return;
    var src = sg.lines, out = [], cur = null;
    for (var i = 0; i < src.length; i++) {
      var l = { t: src[i].t, end: lineEndOf(src[i]), words: src[i].words.slice() };
      if (cur) {
        var a = wordsText(cur.words).length, b = wordsText(l.words).length;
        if (l.t - cur.end <= 1.0 && a + 1 + b <= 52 && l.end - cur.t <= 9 && (a < 34 || b < 14)) { cur.words = cur.words.concat(l.words); cur.end = l.end; continue; }
        out.push(cur);
      }
      cur = l;
    }
    out.push(cur);
    // when each line appears: after the previous line's wipe ends (+0.15 s), at most 1.2 s early, at least 0.3 s early
    for (i = 0; i < out.length; i++) out[i].show = i === 0 ? out[i].t - 1.2 : Math.min(out[i].t - 0.3, Math.max(out[i - 1].end + 0.15, out[i].t - 1.2));
    sg.rawLines = src; sg.lines = out; sg._prepped = true;
  }
  function lineAt(t) {
    var L = song.lines, idx = -1, h = t;   // t = display time (seenT)
    for (var i = 0; i < L.length; i++) if (h >= (L[i].show != null ? L[i].show : L[i].t - 1.2)) idx = i;
    return idx;
  }
  function sylText(w) { return w.text.replace(/-$/, '') + (/-$/.test(w.text) ? '' : ' '); }
  function lineText(l) { return wordsText(l.words); }
  function lineHtml(l) { return l.words.map(function (w) { return '<span class="syl">' + esc(sylText(w)) + '</span>'; }).join(''); }
  // A wipe row: base text + a highlight copy inside a clip box. Progress x moves the clip box right (translateX(x - W))
  // and the copy back left (translateX(W - x)): two compositor-only transforms per frame, no layout or repaint.
  var wipe = { rows: [], lastX: [] };
  function rowHtml(ws) { var t = esc(wordsText(ws)); return '<div class="lrow"><div class="lbase">' + ws.map(function (w) { return '<span>' + esc(sylText(w)) + '</span>'; }).join('') + '</div><div class="lclip"><div class="lhi">' + t + '</div></div></div>'; }
  function buildCurrent(el, words, base, min) {
    el.className = 'lyric cur'; el.style.fontSize = base + 'px';
    el.innerHTML = rowHtml(words);
    var w = el.firstChild.offsetWidth, rows = [words];
    if (w > LYRIC_W) {
      var fs = Math.floor(base * LYRIC_W / w);
      if (fs >= min) { el.style.fontSize = fs + 'px'; var w2 = el.firstChild.offsetWidth; if (w2 > LYRIC_W) el.style.fontSize = Math.floor(fs * LYRIC_W / w2 * 0.99) + 'px'; }
      else {                                   // too long even small: two balanced rows
        var total = wordsText(words).length, acc = 0, best = 1, bestD = 1e9;
        for (var k = 0; k < words.length - 1; k++) { acc += sylText(words[k]).length; var d = Math.abs(total / 2 - acc); if (d < bestD && !/-$/.test(words[k].text)) { bestD = d; best = k + 1; } }
        rows = [words.slice(0, best), words.slice(best)];
        el.classList.add('two'); el.innerHTML = rowHtml(rows[0]) + rowHtml(rows[1]);
        var two = Math.round(base * 0.8); el.style.fontSize = two + 'px';
        var mw = Math.max(el.children[0].offsetWidth, el.children[1].offsetWidth);
        for (var pass = 0, f2 = two; pass < 3 && mw > LYRIC_W; pass++) { f2 = Math.floor(f2 * LYRIC_W / mw * 0.99); el.style.fontSize = f2 + 'px'; mw = Math.max(el.children[0].offsetWidth, el.children[1].offsetWidth); }
      }
    }
    // measure word edges once per line (layout reads only here)
    wipe.rows = []; wipe.lastX = [];
    for (var r = 0; r < rows.length; r++) {
      var row = el.children[r], spans = row.firstChild.children, W = row.offsetWidth, edges = [];
      var sw = 0.27 * parseFloat(el.style.fontSize);   // trailing space: the wipe ends on the word's last letter
      for (k = 0; k < spans.length; k++) edges.push({ l: spans[k].offsetLeft, r: spans[k].offsetLeft + spans[k].offsetWidth - (/ $/.test(spans[k].textContent) ? sw : 0) });
      var clip = row.children[1], hi = clip.firstChild;
      wipe.rows.push({ words: rows[r], edges: edges, W: W, clip: clip, hi: hi });
      wipe.lastX.push(-1);
      setWipe(r, 0);
    }
  }
  function setWipe(r, x) {
    var row = wipe.rows[r]; x = Math.round(x * 2) / 2; if (x === wipe.lastX[r]) return; wipe.lastX[r] = x;
    row.clip.style.transform = 'translate3d(' + (x - row.W) + 'px,0,0)';
    row.hi.style.transform = 'translate3d(' + (row.W - x) + 'px,0,0)';
  }
  function wipeX(row, h) {
    var ws = row.words, e = row.edges, n = ws.length;
    if (!n || h <= ws[0].t) return 0;
    for (var k = n - 1; k >= 0; k--) {
      if (h >= ws[k].t) {
        var d = ws[k].d > 0.05 ? ws[k].d : 0.3, f = Math.min(1, (h - ws[k].t) / d);
        return e[k].l + f * (e[k].r - e[k].l);
      }
    }
    return 0;
  }
  // Duet lyric list: previous (dimmed) / current (wipe) / next 3. The current line only advances when the next line
  // actually starts (0.15 s lead), so a fast/slow-timed line is never scrolled away early; long lines shrink or wrap.
  // DOM is rebuilt only on a line change; per frame only the wipe transforms move.
  function duetIndex(h) {
    var L = song.lines, idx = 0;
    for (var i = 1; i < L.length; i++) if (h >= L[i].t - 0.15) idx = i;
    return idx;
  }
  function setLine(id, l, base, min, cls) {
    var el = $(id); el.className = 'lyric ' + cls; el.style.overflow = ''; el.style.textOverflow = '';
    el.textContent = l ? lineText(l) : '';
    if (l) fitLyric(el, base, min, false); else el.style.fontSize = base + 'px';
  }
  function renderDuetLyrics(t) {
    var L = song.lines, h = t, i = duetIndex(h), ln = L[i];
    var before = i === 0 && L[0].t - h > 3;
    var gap = before || (h > lineEndOf(ln) + 1.5 && (!L[i + 1] || L[i + 1].t - h > 3));
    var key = (gap ? 'dgap' : 'd') + i + (before ? 'b' : '');
    if (key !== lastLine) {
      lastLine = key;
      var first = before ? 0 : gap ? i + 1 : i + 1;   // first upcoming line
      setLine('lyricPrev', before ? null : gap ? ln : L[i - 1], 40, 18, 'prev');
      if (gap) {
        wipe.rows = [];
        var c = $('lyricCur'); c.className = 'lyric cur gapline'; c.style.fontSize = '50px'; c.innerHTML = '<span class="syl">\u266a instrumental \u266a</span>';
      } else buildCurrent($('lyricCur'), ln.words, 62, 36);   // v13.9 narrower singer panel
      setLine('lyricNext', L[first], 44, 16, 'next');
      setLine('lyricNext2', L[first + 1], 40, 16, 'next n2');
      setLine('lyricNext3', L[first + 2], 38, 16, 'next n3');
      $('lyricOwner').textContent = '';
    }
    if (gap) return;
    for (var r = 0; r < wipe.rows.length; r++) setWipe(r, wipeX(wipe.rows[r], h));
  }
  function renderLyrics(t) {
    if (G && G.kind === 'duet') return renderDuetLyrics(t);
    var i = Math.max(0, lineAt(t)), L = song.lines;
    var ln = L[i], lineEnd = lineEndOf(ln), h = t;   // t = display time (seenT); was double-subtracting the latency in v13.2
    var gap = (h > lineEnd + 1.5 && (!L[i + 1] || L[i + 1].t - h > 3)) || (i === 0 && L[0].t - h > 3);
    var key = gap ? 'gap' + i : i;
    if (key !== lastLine) {
      lastLine = key;
      if (gap) {
        wipe.rows = [];
        $('lyricCur').className = 'lyric cur'; $('lyricCur').innerHTML = '<span class="syl">\u266a instrumental \u266a</span>'; $('lyricCur').style.fontSize = '80px';
        var nx = i === 0 && L[0].t - h > 3 ? L[0] : L[i + 1];
        $('lyricNext').textContent = nx ? lineText(nx) : '';
      } else {
        buildCurrent($('lyricCur'), L[i].words, 88, 60);
        $('lyricNext').textContent = L[i + 1] ? lineText(L[i + 1]) : '';
      }
      fitLyric($('lyricNext'), 54, 34, false);
      if (G && G.owner) { // battle: each line is marked with the colour + name of the player who sings it
        var own = G.owner[gap ? Math.min(i + 1, L.length - 1) : i], nxo = G.owner[i + 1];
        $('lyrics').style.setProperty('--own', pcolor(own));
        $('lyricOwner').textContent = '\u25b6 ' + pname(own) + (gap ? ' is next' : '\u2019s line');
        $('lyricOwner').style.color = pcolor(own);
        $('lyricNext').style.color = nxo ? pcolor(nxo) : '';
      } else { $('lyricOwner').textContent = ''; $('lyricNext').style.color = ''; }
    }
    if (gap) return;
    for (var r = 0; r < wipe.rows.length; r++) setWipe(r, wipeX(wipe.rows[r], h));
  }

  // ---------- pitch lane (tv/lane.js) ----------
  var NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  var progressBar = $('progressBar'), lastTimeTxt = '', lastNoteTxt = '', lastNoteAt = 0;
  function updateNoteName(t) {
    var now = performance.now(); if (now - lastNoteAt < 120) return; lastNoteAt = now;
    var d = lane.dot, txt;
    if (d && t - d.t < 0.35) {
      var n = Math.round(S.hzToMidi(d.hz));
      txt = '🎤 ' + NAMES[(n % 12 + 12) % 12] + (Math.floor(n / 12) - 1) + ' · ' + Math.round(d.hz) + ' Hz' +
        (d.note && d.c > 35 ? (d.m < d.note.midi ? '  ▲ a little higher' : '  ▼ a little lower') : '');
    } else txt = phone.mic === 'live' ? '🎤 listening…' : '';
    if (txt !== lastNoteTxt) { lastNoteTxt = txt; $('noteName').textContent = txt; }
  }
  function noteAt(tt) {
    for (var i = 0; i < song.notes.length; i++) { var n = song.notes[i]; if (tt >= n.t - 0.05 && tt < n.t + n.d + 0.05) return n; }
    return null;
  }
  function refMidiAt(tt) {
    var best = song.notes[0], bd = Infinity;
    for (var i = 0; i < song.notes.length; i++) {
      var n = song.notes[i], d = tt < n.t ? n.t - tt : tt > n.t + n.d ? tt - n.t - n.d : 0;
      if (d < bd) { bd = d; best = n; }
    }
    return best.midi;
  }
  function foldTo(m, ref) { while (m - ref > 6) m -= 12; while (ref - m > 6) m += 12; return m; }
  function fmt(s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + ('0' + s % 60).slice(-2); }
  function esc(s) { return s.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  var toastTimer = 0;
  function toast(msg, ms) { var el = $('homeToast'); el.textContent = msg || ''; el.classList.toggle('show', !!msg); clearTimeout(toastTimer); if (msg && ms) toastTimer = setTimeout(function () { toast(''); }, ms); }
  // ---------- home settings row + in-game pause menu (arrows + OK + Back only; colour keys optional) ----------
  var rowIdx = -1;
  function rowBtns() { return $('homeRow').children; }
  function focusRow(i) {
    var b = rowBtns(); rowIdx = Math.max(0, Math.min(b.length - 1, i));
    var cs = document.querySelectorAll('.song-card'); for (var q = 0; q < cs.length; q++) cs[q].classList.remove('focused');
    for (q = 0; q < b.length; q++) b[q].classList.toggle('focused', q === rowIdx);
    focusCal = true;
  }
  function rowAction(act) {
    if (act === 'cal') startCalibration();
    else if (act === 'guide') { setGuide(GUIDE_ORDER[(GUIDE_ORDER.indexOf(guideLevel()) + 1) % 4]); toast(hasGuide() ? 'Guide vocals: ' + GUIDE_NAME[guideLevel()] + (guideLevel() !== 'off' ? ' — if the mic hears it, it can nudge your score' : '') : 'Guide vocals (' + GUIDE_NAME[guideLevel()] + ') — this song has no vocal track', 3500); }
    else if (act === 'mode') { cycleMode(1); toast('Mode: ' + MODE_NAME[mode()], 2500); }
    else if (act === 'phone') { setupShown = !setupShown; renderHomePlayers(); }
    else if (act === 'voice' && window.toggleVoiceMaster) toggleVoiceMaster();
    else if (act === 'sync') startSync();
    else if (act === 'search') searchOpen();
    else if (act === 'play') { cyclePlay(); announcePlay(); }
  }
  var paused = false, pmIdx = 0;
  function pmItems() { return $('pauseMenu').querySelectorAll('.pm-item'); }
  function pmFocus(i) { var it = pmItems(); pmIdx = (i + it.length) % it.length; for (var q = 0; q < it.length; q++) it[q].classList.toggle('focused', q === pmIdx); }
  function pauseGame() {
    if (screen !== 'game' || finished || paused) return;
    foBegin('pause'); paused = true; audio.pause(); stopGuide(); $('game').classList.add('paused'); pmFocus(0); showGuide(); guardKeys(450);
    wsSend({ type: 'state', state: 'paused' });
  }
  function resumeGame() {
    if (!paused) return;
    paused = false; $('game').classList.remove('paused'); guardKeys(450);
    var p = audio.play(); if (p && p.catch) p.catch(function () {});
    audio.addEventListener('playing', applyGuide, { once: true });
    wsSend({ type: 'state', state: 'playing', song: song.id });
    requestAnimationFrame(loop);
  }
  function pmAction(act) {
    if (act === 'resume') resumeGame();
    else if (act === 'guide') { setGuide(GUIDE_ORDER[(GUIDE_ORDER.indexOf(guideLevel()) + 1) % 4]); }
    else if (act === 'restart') { paused = false; $('game').classList.remove('paused'); startGame(); }
    else if (act === 'quit') { paused = false; $('game').classList.remove('paused'); goHome(); }
    else if (act === 'fps') toggleFps();
    else if (act === 'hit') cycleRumble();
    else if (act === 'joinqr') { try { localStorage.setItem('karaoke.joinQr', joinQrOn() ? '0' : '1'); } catch (e) {} renderJoinQr(); toastAny('Join QR on screen: ' + (joinQrOn() ? 'On' : 'Off'), 2200); }
    else if (act === 'sync') {   // backup only: if the TV doesn't report the output device, OK picks it (speakers / Bluetooth / HDMI)
      if (AOUT.src === 'tizen.sound') toastAny('Audio: ' + devLabel(AOUT.type) + ' (detected). \u25c0 \u25b6 nudges notes 10 ms; tap test: Beat sync on the song list.', 3500);
      else { var ord = ['speaker', 'bluetooth', 'hdmi'], nx = ord[(ord.indexOf(AOUT.type) + 1) % ord.length]; localStorage.setItem('karaoke.audioOut', nx); detectAudioOut('manual'); toastAny('Audio output: ' + devLabel(nx) + ' (+' + devExtra() + ' ms)', 2500); }
    }
    else if (act === 'voice' && window.toggleVoiceMaster) toggleVoiceMaster();
  }

  // ---------- remote / keyboard ----------
  var armedNoPhone = false;
  // Samsung remotes auto-repeat a held OK: the press that starts a song must not also pause it (v11 bug).
  var keyGuardUntil = 0;
  function guardKeys(ms) { keyGuardUntil = performance.now() + ms; }
  var ARROW_LANE = { 38: 3, 39: 1, 37: 2, 40: 0 };   // remote: ▲ = △ crash, ▶ = ○ snare, ◀ = □ hi-hat, ▼ = ✕ kick (same spots as the face buttons)
  function onKey(e) {
    var k = e.keyCode; WARM.lastKey = performance.now(); PV.armed = true; if (audio.touch) audio.touch();
    if (k === 13 && !e.repeat) pressFx();
    if (window.KTVQueue && KTVQueue.key(e)) return;   // v13.12: phone song queue (YELLOW / Q opens it; any key cancels the up-next countdown)
    if (BUSY.on && (screen === 'game' || screen === 'home')) {   // loading: ignore everything but Back (cancel) / OK on the retry prompt
      if (e.preventDefault) e.preventDefault();
      var back = k === 10009 || k === 8 || k === 27;
      if (BUSY.err) { if (k === 13 && !e.repeat) { var rt = BUSY.retry; busyHide(); if (rt) rt(); } else if (back) { busyHide(); if (screen === 'game') goHome(); } return; }
      if (back && !e.repeat) { busyHide(); audio.pause(); if (song) audio.reset(song.audioUrl); if (screen === 'game') goHome(); }
      return;
    }
    if (REC.ui) { if (e.preventDefault) e.preventDefault(); if (!e.repeat || k === 37 || k === 39 || k === 38 || k === 40) recKey(k); return; }   // v13.7 Record map panel
    if (screen === 'home' && (imeLock || document.activeElement === $('searchInput')) && searchKey(e)) return;   // v13.6: typing into the search field (v13.9.3: also while the overlay is up but the TV keyboard has dropped focus)
    if (screen === 'sync') { if (e.preventDefault) e.preventDefault(); if (!e.repeat) syncKey(k, e.src || 'remote', e.ageMs || 0); return; }
    var PLAYPAUSE = k === 10252 || k === 415 || k === 19 || k === 32;
    if (screen === 'game' && !finished && !paused && beat && ARROW_LANE[k] != null) { if (e.preventDefault) e.preventDefault(); if (!e.repeat) beatPress(ARROW_LANE[k], e.src || 'remote', e.ageMs || 0); return; }
    if (screen === 'game' && !finished) {
      if ((k === 13 || PLAYPAUSE || k === 10009 || k === 8 || k === 27) && (e.repeat || performance.now() < keyGuardUntil)) { e.preventDefault(); return; }
      if (paused) {
        if (k === 38 || k === 40) { pmFocus(pmIdx + (k === 40 ? 1 : -1)); return; }
        if ((k === 37 || k === 39) && pmItems()[pmIdx].getAttribute('data-act') === 'sync') { nudgeSync(k === 39 ? 10 : -10); return; }
        if (k === 13) { pmAction(pmItems()[pmIdx].getAttribute('data-act')); return; }
        if (k === 10009 || k === 8 || k === 27 || PLAYPAUSE) { e.preventDefault(); resumeGame(); return; }
      } else if (k === 13 || k === 10009 || k === 8 || k === 27 || PLAYPAUSE) { e.preventDefault(); pauseGame(); return; }
    }
    if ((k === 404 || k === 191) && screen === 'home' && !REC.ui) { if (e.preventDefault) e.preventDefault(); searchOpen(); return; }   // v13.11: GREEN (or '/') = search, on purpose
    if (screen === 'home' && mtKey(k)) { if (e.preventDefault) e.preventDefault(); return; }   // v13.13: focus is on the play-style tabs
    if ((k === 38 || k === 40) && screen === 'home') {
      if (catKey(k)) return;
      var vl = visList, n = vl ? vl.length : songs.length, pos = vl ? Math.max(0, vl.indexOf(selected)) : selected, to = function (q) { return vl ? vl[Math.max(0, Math.min(n - 1, q))] : Math.max(0, Math.min(n - 1, q)); };
      if (k === 40 && (pos >= n - 1 || !n) && !focusCal) focusRow(rowIdx < 0 ? 0 : rowIdx);
      else if (k === 38 && focusCal) { if (!n) return; $('homeRow').querySelector('.focused') && $('homeRow').querySelector('.focused').classList.remove('focused'); selectSong(to(n - 1)); }
      else if (k === 38 && !focusCal && pos <= 0) { mtFocusSet(true); }   // v13.13: ▲ at the first song focuses the play-style tabs (never search: GREEN / R3 / '/' or the Search button in the bottom row)
      else if (!focusCal) selectSong(to(k === 40 ? pos + 1 : pos - 1));
      return;
    }
    // v13.13: ◀ from the song list goes to the category rail; ▶ on the rail goes back to the song list (first song of the category highlighted, nothing plays).
    // ◀ ▶ no longer change category (▲ ▼ on the rail, L1/R1, or the pointer do).
    if ((k === 37 || k === 39) && screen === 'home') {
      if (focusCal) focusRow(rowIdx + (k === 39 ? 1 : -1));
      else if (k === 37) catFocusSet(true);
      else if (CATZ) { catFocusSet(false); if (visList && visList.length) selectSong(visList[0]); }
      return;
    }
    if ((k === 406 || k === 66) && screen === 'home') { rowAction('phone'); return; } // optional BLUE shortcut
    if (k === 13 && screen === 'home' && focusCal) { rowAction(rowBtns()[rowIdx].getAttribute('data-act')); return; }
    if (k === 13 && screen === 'calib' && calDone) { show('home'); selectSong(selected); return; }
    if (screen === 'results' && rsKey(k)) return;   // v13.9 results buttons
    // v13.13: OK on the category rail only selects that category and hands focus to the song list (first song highlighted). It never starts a song, and the same press
    // (key repeat / the remote's double OK) can't carry into the list: Enter is ignored for 700 ms afterwards and while held.
    if (k === 13 && screen === 'home' && !focusCal && CATZ) { catFocusSet(false); homeEnterBlock = performance.now() + 700; if (visList && visList.length) selectSong(visList[0]); return; }
    if (k === 13 && screen === 'home' && !focusCal && (e.repeat || performance.now() < homeEnterBlock)) return;
    if (k === 13) { // OK / Enter
      catFocusSet(false);
      if (screen === 'home' && playKind() === 'rec') { recOpen(); return; }
      if (screen === 'home') {
        if (song.scorable && playKind() !== 'beat' && !(phone.connected && phone.mic === 'live') && !armedNoPhone) {
          armedNoPhone = true; toast('Phone mic isn’t live yet — scan the QR and tap “Start mic”. Press OK again to sing without scoring.');
          return;
        }
        armedNoPhone = false; toast(''); startGame();
      } else if (screen === 'results') startGame();
    } else if (k === 10009 || k === 8 || k === 27) { // Back
      e.preventDefault();
      if (screen === 'home' && searchQ) { applySearch('', 'back'); toast('Search cleared', 1500); return; }   // v13.6: Back clears the search first
      if (screen === 'game' || screen === 'results' || screen === 'calib') goHome();
      else if (window.tizen && tizen.application) tizen.application.getCurrentApplication().exit();
    }
  }
  document.addEventListener('keydown', onKey);

  // ---------- game controllers (Gamepad API: PS5 DualSense / any standard pad, paired to the TV over Bluetooth) ----------
  // Menus: D-pad or left stick = arrows, ✕ = OK, ○ = Back, Options = pause, △ (home) = Play style.
  // Beat mode: △ ○ □ ✕ (or the matching D-pad direction) hit the lanes.
  var pads = {}, padLoopOn = false, padEvents = [], padPresses = 0;
  var PAD_KEY = { 12: 38, 13: 40, 14: 37, 15: 39, 0: 13, 1: 10009, 9: 10252, 16: 10252 };
  // Beat mode: face = kit, D-pad = bass, L1/L2 = held pad, R1/R2 = accent (KaraokeBeat.padLane)
  function padList() { var g = []; try { g = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) {} var out = []; for (var i = 0; g && i < g.length; i++) if (g[i] && g[i].connected !== false) out.push(g[i]); return out; }
  function padInfo() { return { api: !!navigator.getGamepads, pads: padList().map(function (p) { return { index: p.index, id: String(p.id).slice(0, 90), mapping: p.mapping, buttons: p.buttons.length, axes: p.axes.length }; }), events: padEvents.slice(-10), presses: padPresses }; }
  function padEvent(o) { o.at = new Date().toISOString().slice(11, 19); padEvents.push(o); if (padEvents.length > 30) padEvents.shift(); wsSend({ type: 'perf', screen: 'gamepad', build: BUILD, src: window.tizen ? 'tv' : 'browser', ev: o, info: padInfo() }); }
  function fakeKey(k, src, age) { return { keyCode: k, repeat: false, src: src, ageMs: age, preventDefault: function () {} }; }
  function padButton(i, p, now) {
    padPresses++;
    if (padPresses <= 25) padEvent({ type: 'press', button: i, pad: p.index, mapping: p.mapping });
    var age = Math.max(0, Math.min(50, now - (p.timestamp || now)));
    lastPadIdx = p.index;
    if (screen === 'sync') { syncKey(i === 1 ? 10009 : 13, 'pad', age); return; }   // any button taps; ○ = back
    if (i === 8) { cycleRumble(); return; }                         // Create button: rumble Normal / Strong / Off
    if (screen === 'game' && !finished && !paused && beat && KaraokeBeat.padLane(i) >= 0) { beatPress(KaraokeBeat.padLane(i), 'pad', age); return; }
    if (REC.ui) { if (i === 0) onKey(fakeKey(13, 'pad', 0)); else if (i === 1) onKey(fakeKey(10009, 'pad', 0)); else if (PAD_KEY[i] != null && i >= 12) onKey(fakeKey(PAD_KEY[i], 'pad', 0)); return; }
    if ((i === 4 || i === 5) && screen === 'home') { setCat(catIdx + (i === 5 ? 1 : -1)); catFocusSet(true); return; }   // v13.9: L1 / R1 = category
    if (i === 2 && screen === 'home') { toggleFav(); return; }                // v13.9: □ = favorite (saved on the Mac)
    if (i === 11 && screen === 'home') { searchOpen(); return; }              // R3 = search (▲ at the top of the list too)
    if (i === 3 && screen === 'home') { cycleDiff(); return; }                // v13.9: △ = difficulty (Easy/Normal/Hard/My map)
    if ((i === 6 || i === 7) && screen === 'home') { cyclePlayKind(i === 7 ? 1 : -1); announcePlay(); return; }   // L2 left, R2 right: Beat → Duet → Jam → Sing
    if (PAD_KEY[i] != null) onKey(fakeKey(PAD_KEY[i], 'pad', age));
  }
  function pollPads() {
    var list = padList(), now = performance.now();
    list.forEach(function (p) {
      var st = pads[p.index] || (pads[p.index] = { b: [], ax: 0, axAt: 0, rep: false });
      for (var i = 0; i < p.buttons.length; i++) {
        var b = p.buttons[i], on = typeof b === 'object' ? (b.pressed || b.value > 0.5) : b > 0.5;
        if (on && !st.b[i]) padButton(i, p, now);
        else if (!on && st.b[i] && beat && KaraokeBeat.padLane(i) >= 0) beatRelease(KaraokeBeat.padLane(i), 'pad', 0);
        st.b[i] = on;
      }
      var x = p.axes[0] || 0, y = p.axes[1] || 0;
      var dir = Math.abs(x) > Math.abs(y) ? (x > 0.6 ? 39 : x < -0.6 ? 37 : 0) : (y > 0.6 ? 40 : y < -0.6 ? 38 : 0);
      if (!dir) { st.ax = 0; st.rep = false; }
      else if (dir !== st.ax || now - st.axAt > (st.rep ? 150 : 420)) {
        st.rep = dir === st.ax; st.ax = dir; st.axAt = now;
        if (!(screen === 'game' && !finished && !paused && beat)) onKey(fakeKey(dir, 'pad', 0));
      }
    });
    if (list.length) requestAnimationFrame(pollPads); else { padLoopOn = false; pads = {}; }
  }
  function startPads() { if (!padLoopOn && padList().length) { padLoopOn = true; requestAnimationFrame(pollPads); } }
  window.addEventListener('gamepadconnected', function (e) {
    var p = e.gamepad; padEvent({ type: 'connected', id: String(p.id).slice(0, 90), mapping: p.mapping, buttons: p.buttons.length });
    if (screen === 'home') toast('\ud83c\udfae Controller connected — D-pad/stick to move, \u2715 = OK, \u25cb = Back, L2/R2 = mode, L1/R1 = category, \u25b3 = difficulty, \u25a1 = favorite', 6000);
    startPads();
  });
  window.addEventListener('gamepaddisconnected', function (e) { padEvent({ type: 'disconnected', id: String(e.gamepad.id).slice(0, 90) }); if (screen === 'game' && beat && !paused && !finished) pauseGame(); });
  setInterval(startPads, 1000);   // some TVs only expose a pad after its first button press, without an event

  // v13.12: small bridge for tv/queue.js (phone song queue). Everything the queue needs from the TV app, nothing more.
  window.KaraokeTVHost = {
    songs: function () { return songs; }, screen: function () { return screen; }, lastKey: function () { return WARM.lastKey; },
    typing: function () { return !!(imeLock || document.activeElement === $('searchInput') || ($('searchOverlay') && $('searchOverlay').classList.contains('open'))); },
    busy: function () { return !!(REC.ui || REC.active || REC.preview || paused || BUSY.on); },
    players: function () { return PLAYERS; }, toast: function (m, ms) { toast(m, ms); }, send: function (o) { wsSend(o); },
    startSong: function (id) {   // start this song for singing, from the song list only (never over a song that is playing)
      if (screen !== 'home' || REC.ui || REC.active || REC.preview) return false;
      var i = -1, k; for (k = 0; k < songs.length; k++) if (songs[k] && songs[k].id === id) { i = k; break; }
      if (i < 0) return false;
      try { if (searchQ) applySearch('', 'queue'); if (catId() !== 'all') setCat(0, true); } catch (e) {}
      QFORCE = true; var t0 = performance.now(), iv = setInterval(function () { if (!QFORCE) return clearInterval(iv); if (screen === 'home' && !BUSY.on && performance.now() - t0 > 2000) { QFORCE = false; clearInterval(iv); renderPlay(); } }, 500);   // start cancelled / never began: back to the TV's own Play setting
      selectSong(i); armedNoPhone = false; startGame();
      return screen === 'game' || BUSY.on;
    }
  };
  window.KaraokeTVDebug = { quit: function () { goHome(); }, finish: function () { finish(); },
    // TEST-ONLY layout preview for headless screenshots: renders caller-supplied rows (labelled test data). Never called by the app itself.
    resultsPreview: function (kind, d) { if (kind === 'solo') rsShowSolo(d); else { $('results').classList.toggle('multi', true); rsShowMulti(d.rows, d.sub, d.winner); } show('results'); if (kind === 'table') rsTable(); },
    results: function () { return { phase: RS.phase, btn: RS.btns[RS.idx] && RS.btns[RS.idx][0], rows: $('mrRows').children.length }; }, guideGain: function () { return audio.guide ? +audio.guide.gain.value.toFixed(3) : null; }, toast: function (m, ms) { toast(m, ms); }, paused: function () { return paused; }, mode: function (m) { if (m) localStorage.setItem('karaoke.mode', m); renderHomePlayers(); return mode(); }, round: function () { return G && { mode: G.mode, slots: G.slots, scores: G.slots.map(function (s) { return G.scorers[s].liveScore(); }), notes: G.slots.map(function (s) { return G.idx[s].length; }) }; }, jitter: function (reset) { var r = { n: JS.n, avg: JS.n ? +(JS.sum / JS.n).toFixed(1) : 0, max: Math.round(JS.max), over50: JS.over50, on: dejitterOn, P: Object.keys(DJ).map(function (k) { return [+k, +(DJ[k].P || 0).toFixed(3)]; }) }; if (reset) JS = { n: 0, sum: 0, max: 0, over50: 0 }; return r; }, home: function () { return { certOk: certOk, caVisible: $('caBox').style.display !== 'none', players: $('playersHome').textContent, mode: $('modeHome').textContent }; }, guide: function (lv) { if (lv) setGuide(lv); if (audio.mode === 'webaudio') return { level: guideLevel(), vol: audio.guide.gain.value > 0.001 || audio.guide.gain.value === 0 ? GUIDE[guideLevel()] * (screen === 'game' && !finished ? 1 : 0) : 0, playing: audio.guideLocked() && GUIDE[guideLevel()] > 0, drift: 0, median: 0, rate: 1, src: audio.guideUrl, engine: 'webaudio', locked: audio.guideLocked() }; return { level: guideLevel(), vol: guideEl.volume, playing: !guideEl.paused, drift: guideEl.currentTime - audio.currentTime, median: guideMedian, rate: guideEl.playbackRate, src: guideEl.getAttribute('src'), engine: 'element' }; }, voice: function () { return voiceReport(); }, engineCache: function () { return audio.cacheInfo ? audio.cacheInfo() : null; }, engine: function () { return { mode: audio.mode, err: audio.err || null, out: audio.outputInfo() }; }, select: function (i) { selectSong(i); }, showLine: function (i, frac) { DEV.lyrics = false; prepLines(song); buildCurrent($('lyricCur'), song.lines[i].words, 88, 60); $('lyricNext').textContent = song.lines[i + 1] ? lineText(song.lines[i + 1]) : ''; fitLyric($('lyricNext'), 54, 34, false); if (frac != null) { var l = song.lines[i]; for (var r = 0; r < wipe.rows.length; r++) setWipe(r, wipeX(wipe.rows[r], l.t + frac * (lineEndOf(l) - l.t))); } return { rows: wipe.rows.length, size: $('lyricCur').style.fontSize, text: lineText(song.lines[i]) }; }, duetAt: function (h) { DEV.lyrics = false; prepLines(song); lastLine = -1; renderDuetLyrics(h); var ids = ['lyricPrev', 'lyricCur', 'lyricNext', 'lyricNext2', 'lyricNext3']; return { idx: duetIndex(h), n: song.lines.length, W: LYRIC_W, box: $('lyrics').getBoundingClientRect().toJSON(), slots: ids.map(function (id) { var e = $(id), r = e.getBoundingClientRect(); return { id: id, text: e.textContent, fs: parseFloat(e.style.fontSize), clip: e.style.textOverflow === 'ellipsis', sw: id === 'lyricCur' ? Math.max.apply(null, [].map.call(e.children, function (c) { return c.offsetWidth; }).concat([0])) : e.scrollWidth, top: r.top, bottom: r.bottom, rows: id === 'lyricCur' ? e.children.length : 0 }; }) }; }, lineT: function (i) { return song.lines[i].t; }, lyricsOn: function () { DEV.lyrics = true; lastLine = -1; }, songs: function () { return songs.map(function (s) { prepLines(s); return { id: s.id, lines: s.lines.map(function (l) { return lineText(l).length; }), raw: (s.rawLines || s.lines).length }; }); }, calibrate: startCalibration, cal: function () { return { done: calDone, latency: CFG.outputLatencyMs, title: $('calTitle').textContent }; }, start: startGame, pads: padInfo, play: function (v) { if (PLAYS.indexOf(v) >= 0) { localStorage.setItem('karaoke.play', v); renderPlay(); } return play(); }, beat: function () { return beat && { kind: G.kind, diff: beat.diff, input: beat.input, jam: beat.jam, units: beat.units, holds: beat.holds, pts: beat.pts, total: beat.prompts.length, next: beat.next, score: beat.score(), combo: beat.combo, counts: beat.counts, tier: beat.tier, anchors: beat.anch ? beat.anch.filter(function (x) { return x.ok; }).map(function (x) { return x.t; }) : null, lastH: beat.lastH, offset: beat.offset, upcoming: beat.prompts.slice(beat.next, beat.next + 12).filter(function (p) { return !p.r; }).map(function (p) { return { t: p.t, lane: p.lane, dur: p.dur }; }), h: clock() - outLat() / 1000 }; }, beatPress: function (lane, h) { if (!beat) return null; var r = beat.press(lane, h, 'test'); return r; }, key: function (k) { onKey(fakeKey(k, 'remote', 0)); }, hit: function () { return { level: 'none', kit: !!kit, rumble: rumbleLevel() }; }, padButton: function (i) { padButton(i, { index: 0, mapping: 'standard', timestamp: performance.now() }, performance.now()); }, beatOffset: beatOffsetMs, state: function () { return { screen: screen, t: clock(), score: scorer && scorer.liveScore(), frames: scorer && scorer.frames.length }; } };
  window.KaraokeTVDebug.joinQr = function () { var e = $('gQr'), r = e.getBoundingClientRect(), g = $('game').classList.contains('qron'); function rc(id) { var q = $(id).getBoundingClientRect(); return { x: Math.round(q.left), y: Math.round(q.top), r: Math.round(q.right), b: Math.round(q.bottom) }; } return { on: g, vis: g && getComputedStyle(e).display !== 'none', rect: { x: Math.round(r.left), y: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) }, lyrics: rc('lyrics'), lane: rc('laneWrap'), cards: rc('pCards'), label: e.textContent.trim(), hasSvg: !!e.querySelector('svg'), setting: joinQrOn() }; };
  window.KaraokeTVDebug.late = function () { return G && { slots: G.slots.slice(), late: JSON.parse(JSON.stringify(G.late)), owner: G.owner && G.owner.slice(), mode: G.mode, multi: G.multi, cards: $('pCards').querySelectorAll('.pc').length, cls: $('game').className }; };


  // ---------- v13.11.1 pointer support: remote pointer / mouse (hover + click) on every screen ----------
  // Hover moves the highlight (song cards, bottom-row buttons); click acts: card = play (select first if it isn't selected yet),
  // category = switch, bottom-row button = its action, mode tabs, search box, pause menu, results buttons, loading Cancel / Try again,
  // wheel or the \u25b2 \u25bc tabs scroll the list. Everything routes through the same functions the remote keys use.
  var PTR = { x: -9, y: -9, t: 0, wheelT: 0 };
  function ptrIndex(el) { var c = el && el.closest ? el.closest('.song-card') : null; if (!c || c.parentNode !== $('songList') || c.classList.contains('nomatch')) return -1; return Array.prototype.indexOf.call(c.parentNode.children, c); }
  function ptrKey(k) { onKey(fakeKey(k, 'remote', 0)); }
  function ptrStep(dir) {   // move the highlight through the visible list
    var vl = visList, n = vl ? vl.length : songs.length; if (!n) return;
    var pos = vl ? Math.max(0, vl.indexOf(selected)) : selected, np = Math.max(0, Math.min(n - 1, pos + dir)); selectSong(vl ? vl[np] : np);
  }
  document.addEventListener('mousemove', function (e) {
    var b = document.body; if (!b.classList.contains('ptr')) b.classList.add('ptr');
    var now = performance.now(); if (Math.abs(e.clientX - PTR.x) + Math.abs(e.clientY - PTR.y) < 4 || now - PTR.t < 40) return; PTR.x = e.clientX; PTR.y = e.clientY; PTR.t = now;
    if (screen !== 'home' || BUSY.on || REC.ui || imeLock || ($('searchOverlay') && $('searchOverlay').classList.contains('open'))) return;
    var i = ptrIndex(e.target);
    if (i >= 0) { if (i !== selected || focusCal || MTZ) { catFocusSet(false); mtFocusSet(false); selectSong(i); } return; }
    var hb = e.target.closest ? e.target.closest('#homeRow .hbtn') : null;
    if (hb) { var idx = Array.prototype.indexOf.call(rowBtns(), hb); if (idx !== rowIdx || !focusCal) focusRow(idx); }
  }, true);
  document.addEventListener('keydown', function () { document.body.classList.remove('ptr'); }, true);
  document.addEventListener('wheel', function (e) {
    if (screen !== 'home' || BUSY.on || !e.target.closest || !e.target.closest('#songViewport, .cat-rail')) return;
    var now = performance.now(); if (now - PTR.wheelT < 70) return; PTR.wheelT = now;
    if (e.target.closest('.cat-rail')) { var n = LIB.cats.length, ni = Math.max(0, Math.min(n - 1, catIdx + (e.deltaY > 0 ? 1 : -1))); if (ni !== catIdx) { setCat(ni, true); catFocusSet(true); } return; }
    ptrStep(e.deltaY > 0 ? 1 : -1);
  }, { passive: true });
  document.addEventListener('click', function (e) {
    var t = e.target; if (!t || !t.closest) return; var el;
    if (BUSY.on) {
      if (t.closest('#busyCancel')) ptrKey(10009); else if (BUSY.err && t.closest('#busy')) ptrKey(13);
      return;
    }
    if (screen === 'home') {
      var so = $('searchOverlay');
      if (so && so.classList.contains('open')) { if (t === so || t.classList.contains('so-dim')) searchClose(true); return; }
      if (REC.ui) return;
      if ((el = t.closest('.cat-rail .cr-i'))) {
        var cid = el.getAttribute('data-c'), ci = -1; for (var q = 0; q < LIB.cats.length; q++) if (LIB.cats[q].id === cid) ci = q;
        if (ci >= 0) { setCat(ci, true); catFocusSet(true); } return;
      }
      if ((el = t.closest('#homeRow .hbtn'))) { var bi = Array.prototype.indexOf.call(rowBtns(), el); focusRow(bi); rowAction(el.getAttribute('data-act')); return; }
      if ((el = t.closest('#modeSwitch [data-k]'))) { var kk = el.getAttribute('data-k'); localStorage.setItem('karaoke.play', (kk === 'beat' || kk === 'duet') ? kk + '-' + playDiff() : kk); renderPlay(); return; }
      if (t.closest('#searchSlot')) { searchOpen(); return; }
      if (t.closest('#ptrUp')) { ptrStep(-4); return; }
      if (t.closest('#ptrDown')) { ptrStep(4); return; }
      var ix = ptrIndex(t);
      if (ix >= 0) {
        catFocusSet(false);
        if (t.closest('.fav-h')) { if (ix !== selected) selectSong(ix); toggleFav(); return; }
        if (ix !== selected || focusCal) { selectSong(ix); if (!t.closest('.play')) return; }
        ptrKey(13); return;
      }
      if (t.closest('#playNow')) { rowAction('play'); return; }
      return;
    }
    if (screen === 'game') {
      if (paused) { if ((el = t.closest('#pauseMenu .pm-item'))) { var pi = Array.prototype.indexOf.call(pmItems(), el); pmFocus(pi); pmAction(el.getAttribute('data-act')); } else if (!t.closest('#pauseMenu')) resumeGame(); return; }
      if (!finished) ptrKey(13);   // tap the screen = pause (same as OK)
      return;
    }
    if (screen === 'results') {
      if ((el = t.closest('#rsBtns .rs-btn'))) { rsFocus(Array.prototype.indexOf.call($('rsBtns').children, el)); ptrKey(13); } else if (RS.phase === 'win' && t.closest('#results')) ptrKey(13);
    }
  }, true);

  // ---------- perf telemetry + dev FPS overlay (toggle: RED key on the remote, or F) ----------
  var perf = { frames: 0, last: performance.now(), prevFrame: 0, gaps: [], work: [] }, fpsEl = null;
  function toggleFps() {
    if (!fpsEl) { fpsEl = document.createElement('div'); fpsEl.style.cssText = 'position:absolute;right:16px;bottom:16px;z-index:99;font:600 22px monospace;color:#0f0;background:rgba(0,0,0,.7);padding:6px 12px;border-radius:8px;pointer-events:none'; document.body.appendChild(fpsEl); }
    else fpsEl.style.display = fpsEl.style.display === 'none' ? '' : 'none';
  }
  window.KaraokePerfWork = function (ms) { perf.work.push(ms); };
  function perfTick(now) {
    foTick(now);
    if (perf.prevFrame) perf.gaps.push(now - perf.prevFrame);
    perf.prevFrame = now; perf.frames++;
    if (now - perf.last >= 2000) {
      var g = perf.gaps.slice().sort(function (a, b) { return a - b; }), w = perf.work.slice().sort(function (a, b) { return a - b; });
      var rep = { type: 'perf', screen: screen, fps: Math.round(perf.frames * 10000 / (now - perf.last)) / 10,
        p95FrameMs: g.length ? Math.round(g[Math.floor(g.length * 0.95)] * 10) / 10 : 0,
        avgWorkMs: w.length ? Math.round(w.reduce(function (a, b) { return a + b; }, 0) / w.length * 10) / 10 : 0,
        maxWorkMs: w.length ? Math.round(w[w.length - 1] * 10) / 10 : 0, build: BUILD, src: window.tizen ? 'tv' : 'browser' };
      try {
        var gEl = document.getElementById('guide'); rep.guide = guideLevel(); rep.engine = audio.mode;
        if (audio.mode === 'webaudio') { rep.guidePlaying = audio.guideLocked(); rep.guideDriftMs = rep.guidePlaying ? 0 : null; rep.guideRate = 1; rep.guideSync = 'sample-locked'; }
        else { rep.guidePlaying = !gEl.paused; rep.guideDriftMs = gEl.paused ? null : Math.round(guideMedian * 1000); rep.guideRate = gEl.playbackRate; }
        var vr = voiceReport(); if (Object.keys(vr.voices).length) rep.voice = vr;
        rep.pads = padList().length; if (screen === 'game' && G) { rep.play = G.kind; if (beat) rep.beat = { score: beat.score(), judged: beat.judged, combo: beat.combo }; }
      } catch (e) {}
      if (screen === 'game' && beat) {   // v13.8: the 3D highway falls back to flat (still themed) if the TV can't hold ~55 fps
        var gm = $('game'), flat = gm.classList.contains('flat'); rep.look = flat ? 'flat' : '3d';
        perf.low = !flat && rep.fps < 52 && audio.currentTime > 8 ? (perf.low || 0) + 1 : 0;
        if (perf.low >= 3) { gm.classList.add('flat'); localStorage.setItem('karaoke.flat', '1'); rep.lookChange = '3d->flat (low fps)'; perf.low = 0; }
      }
      if (screen === 'game' || screen === 'calib' || rep.voice) wsSend(rep);
      if (fpsEl && fpsEl.style.display !== 'none') fpsEl.textContent = rep.fps + ' fps · p95 ' + rep.p95FrameMs + 'ms · work ' + rep.avgWorkMs + '/' + rep.maxWorkMs + 'ms';
      perf.frames = 0; perf.last = now; perf.gaps = []; perf.work = [];
    }
    requestAnimationFrame(perfTick);
  }
  requestAnimationFrame(perfTick);
  applyVoice(); renderPlay(); renderSync(); detectAudioOut('start'); watchAudioOut();
  try { tizen.tvinputdevice.registerKey('ColorF0Red'); } catch (e) {}
  try { tizen.tvinputdevice.registerKey('ColorF2Yellow'); } catch (e) {}
  try { tizen.tvinputdevice.registerKey('ColorF3Blue'); } catch (e) {}
  try { tizen.tvinputdevice.registerKey('ColorF1Green'); } catch (e) {}
  ['MediaPlayPause', 'MediaPlay', 'MediaPause'].forEach(function (kn) { try { tizen.tvinputdevice.registerKey(kn); } catch (e) {} });
  document.addEventListener('keydown', function (e) { // YELLOW (or G): cycle guide vocals Off/Low/Medium/Full
    if ((e.keyCode === 405 || e.keyCode === 71) && (screen === 'home' || screen === 'game')) setGuide(GUIDE_ORDER[(GUIDE_ORDER.indexOf(guideLevel()) + 1) % 4]);
  });
  document.addEventListener('keydown', function (e) { if (e.keyCode === 403 || e.keyCode === 70) toggleFps(); });

  loadSession();
})();
