/* Phone "Songs" tab (v13.12): search every song by title or artist (instant, filtered on the phone from a ~7 KB index, no audio),
   browse by category, and either "Play now" (TV idle) or "Add to queue". The TV owns the queue (tv/queue.js); this page only
   sends a song id and shows what the TV reports. Works on the local server and on the hosted /kba build (same frames). */
(function () {
  'use strict';
  var d = document, $ = function (id) { return d.getElementById(id); };
  var IDX = null, S = [], CATS = [], FUZ = null, cat = -1, q = '', mySlot = 0, tvOn = true;
  var QS = { idle: false, q: [], cd: 0, known: false }, pending = null, pendT = 0, toastT = 0, sheetI = -1, raf = 0;
  var main = d.querySelector('main'), pills = d.querySelector('.pills');
  if (!main || !pills) return;

  var css = d.createElement('style');
  css.textContent =
    '#tabs{display:flex;gap:8px;width:100%;max-width:420px}#tabs button{flex:1;font-size:17px;font-weight:700;padding:11px 0;border-radius:14px;border:2px solid #ffffff30;background:#ffffff10;color:#fff}' +
    '#tabs button.on{background:linear-gradient(180deg,#ffe27a,#ffb52e);border-color:#ffd75e;color:#111;box-shadow:0 0 14px rgba(255,180,46,.5)}#tabs i{font-style:normal;display:inline-block;min-width:20px;margin-left:6px;padding:0 6px;border-radius:10px;background:#ff3fa4;color:#fff;font-size:13px;line-height:20px}#tabs i:empty{display:none}' +
    '#songsTab{display:none;width:100%;max-width:420px;flex-direction:column;gap:10px}body.t-songs #songsTab{display:flex}' +
    'body.t-songs .sing-only{display:none!important}' +
    '#tvState{font-size:14px;text-align:center;padding:9px 12px;border-radius:12px;background:#ffffff12;border:1px solid #ffffff22}#tvState.free{background:#1fd17a22;border-color:#1fd17a;color:#7dffb8}#tvState.off{background:#ff3b5c22;border-color:#ff3b5c;color:#ff9bab}' +
    '#upNext{font-size:14px;border-radius:14px;background:rgba(18,7,44,.62);border:1px solid #ffffff22;padding:4px 12px}#upNext:empty{display:none}#upNext .qh{font-size:12px;letter-spacing:1px;color:#c9b8ff;font-weight:700;padding:6px 0 2px}' +
    '.qr{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid #ffffff14}.qr:first-of-type{border-top:0}.qr b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.qr span{opacity:.65;font-size:12px;max-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.qr button{border:0;background:#ffffff1a;color:#fff;border-radius:8px;width:30px;height:30px;font-size:15px}.qr.me b{color:#7dffb8}' +
    '#sIn{width:100%;font-size:18px;padding:13px 14px;border-radius:14px;border:2px solid #ffffff30;background:#ffffff10;color:#fff;-webkit-appearance:none}#sIn:focus{outline:0;border-color:#3ff2ff;box-shadow:0 0 16px rgba(63,242,255,.4)}' +
    '#sCats{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch;scrollbar-width:none}#sCats::-webkit-scrollbar{display:none}#sCats button{flex:none;font-size:14px;padding:7px 12px;border-radius:999px;border:1.5px solid #ffffff30;background:#ffffff10;color:#fff;white-space:nowrap}#sCats button.on{background:#3ff2ff;border-color:#3ff2ff;color:#111;font-weight:700}' +
    '#sList{display:flex;flex-direction:column;gap:6px}.srow{display:block;width:100%;text-align:left;padding:11px 14px;border-radius:14px;border:1.5px solid #ffffff1c;background:rgba(18,7,44,.62);color:#fff;font-size:16px;position:relative}.srow b{display:block;font-weight:700;padding-right:70px}.srow span{display:block;font-size:13px;opacity:.65;margin-top:2px}.srow em{position:absolute;right:12px;top:12px;font-style:normal;font-size:12px;color:#7dffb8;font-weight:700}' +
    '#sCount{font-size:12px;opacity:.55;text-align:center}#sEmpty{text-align:center;opacity:.7;padding:18px 6px;font-size:15px;line-height:1.4}' +
    '#sSheet{position:fixed;left:0;right:0;bottom:0;z-index:90;display:none;padding:18px 20px calc(22px + env(safe-area-inset-bottom));background:#1a0a40;border-top:2px solid #ff3fa4;border-radius:22px 22px 0 0;box-shadow:0 -10px 40px rgba(0,0,0,.6)}#sSheet.on{display:block}#sShade{position:fixed;inset:0;z-index:89;background:rgba(0,0,0,.5);display:none}#sShade.on{display:block}' +
    '#sSheet h3{margin:0;font-size:20px}#sSheet p{margin:2px 0 12px;opacity:.7;font-size:14px}#sSheet button{display:block;width:100%;font-size:18px;font-weight:700;padding:14px;margin-top:8px;border-radius:14px;border:2px solid #ffffff30;background:#ffffff14;color:#fff}#sSheet button.go{background:linear-gradient(180deg,#ff6cc0,#b4127a);border-color:#ff3fa4}#sSheet button[disabled]{opacity:.4}#sNote{font-size:13px;opacity:.75;line-height:1.35;margin-top:8px;min-height:16px}' +
    '#sToast{position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:99;max-width:92%;padding:11px 18px;border-radius:14px;background:#12062e;border:2px solid #3ff2ff;font-size:15px;font-weight:700;text-align:center;display:none;box-shadow:0 8px 30px rgba(0,0,0,.6)}#sToast.on{display:block}#sToast.bad{border-color:#ff3b5c}';
  d.head.appendChild(css);

  // tabs
  var tabs = d.createElement('div'); tabs.id = 'tabs';
  tabs.innerHTML = '<button data-t="sing" class="on">\ud83c\udfa4 Sing</button><button data-t="songs">\ud83c\udfb5 Songs<i id="qBadge"></i></button>';
  pills.parentNode.insertBefore(tabs, pills.nextSibling);
  ['mic', 'note', 'hz', 'meter', 'fb', 'turn', 'lyric', 'score', 'findBox', 'guideBox', 'err'].forEach(function (id) { var e = $(id); if (e) e.classList.add('sing-only'); });
  var hint = d.querySelector('.hint'); if (hint) hint.classList.add('sing-only');
  var panel = d.createElement('div'); panel.id = 'songsTab';
  panel.innerHTML = '<div id="tvState">Loading\u2026</div><div id="upNext"></div>' +
    '<input id="sIn" type="search" placeholder="Search title or artist" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="search">' +
    '<div id="sCats"></div><div id="sCount"></div><div id="sList"></div><div id="sEmpty" style="display:none"></div>';
  tabs.parentNode.insertBefore(panel, tabs.nextSibling);
  var shade = d.createElement('div'); shade.id = 'sShade'; var sheet = d.createElement('div'); sheet.id = 'sSheet';
  var toastEl = d.createElement('div'); toastEl.id = 'sToast';
  d.body.appendChild(shade); d.body.appendChild(sheet); d.body.appendChild(toastEl);

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function say(msg, bad) { toastEl.textContent = msg; toastEl.className = 'on' + (bad ? ' bad' : ''); clearTimeout(toastT); toastT = setTimeout(function () { toastEl.className = ''; }, 3800); }
  function setTab(t) {
    d.body.classList.toggle('t-songs', t === 'songs');
    [].forEach.call(tabs.children, function (b) { b.classList.toggle('on', b.getAttribute('data-t') === t); });
    if (t === 'songs') { window.scrollTo(0, 0); ensureIndex(); render(); send({ type: 'q-get' }); }
  }
  tabs.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('button') : null; if (b) setTab(b.getAttribute('data-t')); });

  function send(o) { return window.KTVPhone ? (window.KTVPhone.send(o), true) : false; }
  var loading = false;
  function ensureIndex() {
    if (IDX || loading) return; loading = true;
    fetch('songs-index.json', { cache: 'no-cache' }).then(function (r) { if (!r.ok) throw 0; return r.json(); }).then(function (j) {
      IDX = j; S = j.songs.map(function (a) { return { id: a[0], t: a[1], a: a[2], c: a[3], added: a[4] || '' }; }); CATS = j.cats;
      if (window.KaraokeSearch) FUZ = KaraokeSearch.index(S.map(function (s) { return { title: s.t, artist: s.a }; }));
      renderCats(); render();
    }).catch(function () { $('sEmpty').style.display = ''; $('sEmpty').innerHTML = 'Couldn\u2019t load the song list. <button id="sRetry" style="margin-top:8px;padding:8px 16px;border-radius:10px;border:2px solid #fff3;background:#fff1;color:#fff;font-size:15px">Try again</button>'; $('sRetry').onclick = function () { ensureIndex(); }; }).then(function () { loading = false; });
  }
  function renderCats() {
    $('sCats').innerHTML = '<button data-c="-1" class="on">All</button>' + CATS.map(function (c, i) { return '<button data-c="' + i + '">' + esc(c[1]) + '</button>'; }).join('');
  }
  $('sCats').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null; if (!b) return; cat = +b.getAttribute('data-c');
    [].forEach.call($('sCats').children, function (x) { x.classList.toggle('on', x === b); }); render();
  });
  $('sIn').addEventListener('input', function () { q = this.value; if (!raf) raf = requestAnimationFrame(function () { raf = 0; render(); }); });
  $('sIn').addEventListener('keydown', function (e) { if (e.key === 'Enter') this.blur(); });

  function mineCount() { var n = 0; QS.q.forEach(function (x) { if (x.s === mySlot) n++; }); return n; }
  function inQueue(id) { for (var i = 0; i < QS.q.length; i++) if (QS.q[i].id === id && QS.q[i].s === mySlot) return true; return false; }
  var shown = [];
  function render() {
    renderState();
    if (!IDX) return;
    var list = [], i, r;
    if (q.trim()) {
      r = FUZ ? KaraokeSearch.rank(FUZ, q) : [];
      if (!FUZ) { var qq = q.trim().toLowerCase(); S.forEach(function (s, k) { if ((s.t + ' ' + s.a).toLowerCase().indexOf(qq) >= 0) r.push({ i: k }); }); }
      for (i = 0; i < r.length; i++) if (cat < 0 || S[r[i].i].c.indexOf(cat) >= 0) list.push(r[i].i);
    } else for (i = 0; i < S.length; i++) if (cat < 0 || S[i].c.indexOf(cat) >= 0) list.push(i);
    if (!q.trim() && cat >= 0 && CATS[cat] && CATS[cat][0] === 'new') list.sort(function (a, b) { var da = S[a].added || '', db = S[b].added || ''; return da < db ? 1 : da > db ? -1 : 0; });   // v13.14 Newly Added, newest first
    shown = list.slice(0, 80);
    var h = '';
    for (i = 0; i < shown.length; i++) { var s = S[shown[i]]; h += '<button class="srow" data-i="' + shown[i] + '"><b>' + esc(s.t) + '</b><span>' + esc(s.a) + '</span>' + (inQueue(s.id) ? '<em>\u2713 queued</em>' : '') + '</button>'; }
    $('sList').innerHTML = h;
    $('sCount').textContent = q.trim() || cat >= 0 ? list.length + (list.length === 1 ? ' song' : ' songs') + (list.length > 80 ? ' \u00b7 showing 80, type more to narrow' : '') : S.length + ' songs';
    $('sEmpty').style.display = list.length ? 'none' : ''; $('sEmpty').textContent = list.length ? '' : 'No song matches \u201c' + q.trim() + '\u201d. Try part of the title or the artist.';
  }
  function renderState() {
    var st = $('tvState'), badge = $('qBadge');
    badge.textContent = QS.q.length ? String(QS.q.length) : '';
    if (!tvOn) { st.className = 'off'; st.textContent = '\ud83d\udcfa The TV is off \u2014 turn it on to play songs.'; }
    else if (!QS.known) { st.className = ''; st.textContent = '\ud83d\udcfa Checking the TV\u2026'; }
    else if (QS.cd) { st.className = 'free'; st.textContent = '\u25b6 Starting the next song on the TV\u2026'; }
    else if (QS.idle) { st.className = 'free'; st.textContent = '\ud83d\udcfa The TV is free \u2014 tap a song, then Play now.'; }
    else { st.className = ''; st.textContent = '\ud83d\udcfa The TV is busy \u2014 songs you add play after the current one.'; }
    var h = '';
    if (QS.q.length) {
      h = '<div class="qh">UP NEXT</div>';
      QS.q.slice(0, 8).forEach(function (x, i) { h += '<div class="qr' + (x.s === mySlot ? ' me' : '') + '"><b>' + (i + 1) + '. ' + esc(x.t) + '</b><span>' + esc(x.n) + '</span>' + (x.s === mySlot ? '<button data-del="' + x.qid + '" aria-label="Remove">\u2715</button>' : '') + '</div>'; });
      if (QS.q.length > 8) h += '<div class="qh">+ ' + (QS.q.length - 8) + ' more</div>';
    }
    $('upNext').innerHTML = h;
  }
  $('upNext').addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('button') : null; if (b && b.getAttribute('data-del')) send({ type: 'q-del', qid: +b.getAttribute('data-del') }); });

  // song sheet
  function openSheet(i) {
    sheetI = i; var s = S[i], mine = mineCount(), dup = inQueue(s.id), full = mine >= 3;
    var canPlay = tvOn && QS.known && QS.idle && !QS.cd && !full && !dup;
    sheet.innerHTML = '<h3>' + esc(s.t) + '</h3><p>' + esc(s.a) + '</p>' +
      (canPlay ? '<button class="go" data-a="play">\u25b6 Play now</button>' : '') +
      '<button data-a="queue"' + (!tvOn || full || dup ? ' disabled' : '') + '>\uff0b Add to queue</button><button data-a="x" style="background:none;border-color:transparent;font-weight:600;opacity:.8">Cancel</button>' +
      '<div id="sNote">' + (!tvOn ? 'The TV is off.' : dup ? 'This song is already in your queue.' : full ? 'You have 3 songs queued. Remove one to add another.' : QS.idle ? 'Play now starts on the TV in a few seconds.' : 'The TV won\u2019t be interrupted \u2014 your song starts after the current one.') + '</div>';
    sheet.className = 'on'; shade.className = 'on';
  }
  function closeSheet() { sheet.className = ''; shade.className = ''; sheetI = -1; }
  shade.addEventListener('click', closeSheet);
  $('sList').addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('.srow') : null; if (b) { if (d.activeElement && d.activeElement.blur) d.activeElement.blur(); openSheet(+b.getAttribute('data-i')); } });
  sheet.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('button') : null; if (!b || b.disabled) return; var a = b.getAttribute('data-a'), s = S[sheetI];
    if (a === 'x' || !s) return closeSheet();
    if (pending) return;
    pending = s.id; clearTimeout(pendT);
    if (!send({ type: 'q-add', id: s.id, mode: a === 'play' ? 'play' : 'queue' })) { pending = null; say('Not connected yet \u2014 try again in a second', true); return; }
    pendT = setTimeout(function () { if (pending) { pending = null; say('No answer from the TV \u2014 is it on and updated?', true); } }, 4500);
    closeSheet();
  });

  function onRes(m) {
    if (m.id && pending && m.id !== pending && m.act !== 'removed' && m.act !== 'skipped' && m.act !== 'started') return;
    if (m.act === 'started') { say('\ud83c\udfa4 You\u2019re up: ' + (m.title || 'your song') + '! Tap the mic to sing'); setTab('sing'); return; }
    if (m.act === 'removed') return say('Removed' + (m.title ? ': ' + m.title : ''));
    if (m.act === 'skipped') return say('Moved to the end of the queue' + (m.title ? ': ' + m.title : ''));
    clearTimeout(pendT); pending = null;
    if (m.ok) say(m.act === 'play' ? '\u25b6 Starting ' + (m.title || 'your song') + ' on the TV\u2026' : '\u2713 Added \u2014 you\u2019re #' + (m.pos || '?') + ' in the queue');
    else say({ rate: 'Slow down a second, then try again', full: 'You already have ' + (m.max || 3) + ' songs queued', dup: 'That song is already in your queue', busy: 'The queue is full right now', nosong: 'The TV doesn\u2019t have that song', failed: 'The TV couldn\u2019t start that song' }[m.act] || 'That didn\u2019t go through', true);
    render();
  }
  d.addEventListener('ktv-msg', function (ev) {
    var m = ev.detail || {};
    if (m.type === 'hello') { mySlot = m.slot || 0; tvOn = !!m.tv; if (!tvOn) QS.known = false; render(); }
    else if (m.type === 'open') { send({ type: 'q-get' }); }
    else if (m.type === 'state') { if (m.state === 'tv-offline') { tvOn = false; QS.known = false; } else { tvOn = true; if (m.state === 'playing' || m.state === 'paused' || m.state === 'results') { QS.idle = false; } } render(); }
    else if (m.type === 'queue') { tvOn = true; QS = { idle: !!m.idle, q: Array.isArray(m.q) ? m.q : [], cd: m.cd || 0, known: true }; render(); if (sheetI >= 0) openSheet(sheetI); }
    else if (m.type === 'qres') onRes(m);
  });
  // phone.js may load after this file (the hosted /kba build loads it after the name page)
  if (window.KTVPhone) send({ type: 'q-get' });
  setTimeout(ensureIndex, 400);   // tiny file: have it ready before the first tap on the tab
})();
