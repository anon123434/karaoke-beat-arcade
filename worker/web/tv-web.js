/* hosted /kba web shell for the TV app: big START screen with the phone QR, high-score moments, leaderboard link. */
(function () {
  'use strict';
  var BASE = '/kba', ROOM = window.KTV_ROOM;
  var players = [], hsData = null, started = false;
  // --- see the TV socket's messages (player list + leaderboard results) without touching app.js ---
  var NativeWS = window.WebSocket;
  function WS(u, p) {
    var ws = p ? new NativeWS(u, p) : new NativeWS(u);
    if (/[?&]role=tv/.test(String(u))) window.KBA_TVWS = ws;   // online 1v1 sends the head-to-head strip to the phones through this socket
    ws.addEventListener('message', function (ev) {
      if (typeof ev.data !== 'string') return;
      if (ev.data.indexOf('"type":"phone"') > 0 || ev.data.indexOf('"type":"web-hs"') > 0) {
        try { var m = JSON.parse(ev.data); if (m.type === 'phone') { players = m.players || []; renderPlayers(); } else if (m.type === 'web-hs') showHs(m); } catch (e) {}
      }
    });
    return ws;
  }
  WS.prototype = NativeWS.prototype; WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
  window.WebSocket = WS;

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var ov, qrBox, startBtn, lbBtn, pl, focusIdx = 0;
  function build() {
    ov = el('div', 'ktv-start');
    ov.innerHTML =
      '<div class="ks-left"><div class="ks-phone"><div class="ks-notch"></div><div class="ks-qr" id="ksQr"><div class="ks-wait">…</div></div></div>' +
      '<div class="ks-scan"><span class="ks-hand">👆</span> Scan me with your phone camera</div><div class="ks-players" id="ksPl"></div></div>' +
      '<div class="ks-right"><div class="ks-logo"><img src="' + BASE + '/web/m/logo.webp" alt="COOLEST! Karaoke Beat Arcade"></div><button class="ks-go" id="ksGo">▶&nbsp;START</button>' +
      '<button class="ks-online" id="ksOn" style="display:none">🌎 PLAY ONLINE 1v1</button>' +
      '<button class="ks-small ks-lbbtn" id="ksLb">🏆 WORLD LEADERBOARD</button><div class="ks-tip">Use ◀ ▶ and <b>OK</b></div>' +
      '<p class="ks-legal">A private, non-commercial fan project for family and friends. Not for sale, no ads or fees. <a href="' + BASE + '/about" id="ksLegal">Full disclaimer</a></p></div>';
    document.body.appendChild(ov);
    qrBox = ov.querySelector('#ksQr'); startBtn = ov.querySelector('#ksGo'); lbBtn = ov.querySelector('#ksLb'); legal = ov.querySelector('#ksLegal'); pl = ov.querySelector('#ksPl');
    startBtn.onclick = start; lbBtn.onclick = function () { location.href = BASE + '/leaderboard'; };
    onBtn = ov.querySelector('#ksOn'); onBtn.onclick = function () { start(); if (window.KBA_ON) KBA_ON.open(); };
    window.KBA_ONLINE_READY = function (on) { onBtn.style.display = on ? '' : 'none'; };
    if (window.KBA_ON && KBA_ON.enabled()) onBtn.style.display = '';
    window.KBA_START_SHOW = function () { started = false; ov.style.display = ''; ov.classList.remove('gone'); startBtn.classList.remove('ready'); renderPlayers(); setFocus(0); };
    setFocus(0); loadQr(); renderPlayers();
  }
  var legal, onBtn; function focusEls() { return [startBtn, onBtn, lbBtn, legal].filter(function (e) { return e && e.style.display !== 'none'; }); }
  function setFocus(i) { var els = focusEls(); focusIdx = (i + els.length) % els.length; (els[focusIdx] || startBtn).focus(); }
  function loadQr() {
    var x = new XMLHttpRequest(); x.open('GET', BASE + '/api/session?s=' + ROOM);
    x.onload = function () { try { var s = JSON.parse(x.responseText); qrBox.innerHTML = s.qrSvg; } catch (e) { qrBox.innerHTML = '<div class="ks-wait">😕<br>Ask to try again</div>'; } };
    x.onerror = function () { qrBox.innerHTML = '<div class="ks-wait">📶<br>No internet?<br>Ask to try again</div>'; setTimeout(loadQr, 4000); };
    x.send();
  }
  function renderPlayers() {
    if (!pl) return;
    pl.innerHTML = players.length ? players.map(function (p) { return '<span class="ks-chip" style="--c:' + p.color + '">' + (p.mic === 'live' ? '🎤' : '📱') + ' ' + esc(p.name) + '</span>'; }).join('') : '';
    if (started) return;
    startBtn.classList.toggle('ready', players.length > 0);
  }
  var spoke = false;
  function speakHint() {
    if (spoke || players.length || !window.speechSynthesis) return; spoke = true;
    try { var u = new SpeechSynthesisUtterance('Scan me with your phone camera'); u.rate = 0.95; speechSynthesis.speak(u); } catch (e) {}
  }
  function start() {
    if (started) return; started = true;
    try { var AC = window.AudioContext || window.webkitAudioContext; if (AC) { var c = new AC(); c.resume(); var o = c.createOscillator(), g = c.createGain(); g.gain.value = 0; o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.05); } } catch (e) {}
    try { var d = document.documentElement; (d.requestFullscreen || d.webkitRequestFullscreen || function () {}).call(d); } catch (e) {}
    ov.classList.add('gone'); setTimeout(function () { ov.style.display = 'none'; }, 400);
    try { document.activeElement && document.activeElement.blur(); } catch (e) {}
  }
  // keys go to the START screen while it is up (capture phase, before app.js)
  window.addEventListener('keydown', function (e) {
    if (started) return;
    var k = e.keyCode; speakHint();
    if (k === 37 || k === 38) { setFocus(focusIdx - 1); } else if (k === 39 || k === 40) { setFocus(focusIdx + 1); }
    else if (k === 13 || k === 32) { (focusEls()[focusIdx] || startBtn).click(); }
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  window.addEventListener('pointerdown', function () { if (!started) speakHint(); }, true);

  // --- high-score moment on the results screen ---
  var hs;
  function showHs(m) {
    if (window.KBA_RANK) return;   // v13.16: tv/rank.js shows the rank-up animation / nudge instead of this side card (it listens to the same message)
    if (!m.ok || !m.results) return;
    if (!hs) { hs = el('div', 'ktv-hs'); document.body.appendChild(hs); }
    var best = m.results.filter(function (r) { return r.songRecord; })[0], pb = m.results.filter(function (r) { return r.personalBest && !r.songRecord; })[0];
    var icon = { sing: '🎤', beat: '🥁', duet: '🎤🥁' }[m.kind] || '🎤';
    var head = best ? '<div class="hs-burst">🏆 NEW HIGH SCORE!</div><div class="hs-who">' + esc(best.name) + ' · ' + best.score + '</div>'
      : pb ? '<div class="hs-burst pb">⭐ Personal best!</div><div class="hs-who">' + esc(pb.name) + ' · ' + pb.score + '</div>'
      : '<div class="hs-burst small">' + icon + ' Top scores</div>';
    var rows = (m.top || []).map(function (t, i) { var me = m.results.some(function (r) { return r.name.toLowerCase() === String(t.name).toLowerCase(); }); return '<li class="' + (me ? 'me' : '') + '"><b>' + (i + 1) + '</b><span>' + esc(t.name) + '</span><i>' + t.score + '</i></li>'; }).join('');
    hs.innerHTML = head + '<div class="hs-song">' + icon + ' ' + esc(m.title || '') + '</div><ol>' + rows + '</ol>';
    hs.className = 'ktv-hs on' + (best ? ' record' : '');
    if (best || pb) { try { var u = new SpeechSynthesisUtterance(best ? 'New high score!' : 'Personal best!'); speechSynthesis.speak(u); } catch (e) {} }
  }
  setInterval(function () { var r = document.getElementById('results'); if (hs && r && !r.classList.contains('active')) hs.className = 'ktv-hs'; }, 500);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
