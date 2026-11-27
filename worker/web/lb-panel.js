/* hosted /kba song select: World Top 5 + "your best" for the highlighted song (flag LB_PANEL_ENABLED).
   No network per highlight: one cached snapshot of every song's top 5 + one call for the players' own bests. */
(function () {
  'use strict';
  var BASE = '/kba', on = false, top = {}, mine = {}, kind = 'sing', cur = '', timer = 0, names = '', box, rows = [], meRows = [], meHead, head, empty;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function get(u, cb) { var x = new XMLHttpRequest(); x.open('GET', u); x.onload = function () { try { cb(JSON.parse(x.responseText)); } catch (e) {} }; x.send(); }
  function avIdx(n) { var h = 2166136261, s = String(n).toLowerCase().replace(/\s+/g, ' ').trim(); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 8; }
  function players() { try { var P = window.KaraokeTVOnline && KaraokeTVOnline.players() || {}; return Object.keys(P).sort().map(function (k) { return P[k].name; }).filter(Boolean).slice(0, 2); } catch (e) { return []; } }
  function loadTop(fresh) { get(BASE + '/api/lb/top?kind=' + kind + (fresh ? '&fresh=1' : ''), function (d) { if (d && d.songs) { top[d.kind] = d.songs; schedule(); } }); }
  function loadMine() {
    var n = players(); names = n.join('|') + '#' + kind;
    if (!n.length) { mine = {}; schedule(); return; }
    get(BASE + '/api/lb/mine?kind=' + kind + '&names=' + encodeURIComponent(n.join('|')), function (d) { if (d && d.players) { mine = d.players; schedule(); } });
  }
  function build() {
    var card = document.getElementById('pvCard'), play = document.getElementById('pvPlay'); if (!card || !play) return false;
    box = document.createElement('div'); box.id = 'kbaLb'; box.className = 'kba-lb-box';
    var h = '<div class="kba-lb-h"><span>🏆 WORLD TOP 5</span><small id="kbaLbKind">Sing</small></div><div class="kba-lb-empty" id="kbaLbEmpty">No scores yet. Be the first!</div>';
    for (var i = 0; i < 5; i++) h += '<div class="kba-lb-r" id="kbaLbR' + i + '"><b></b><img alt=""><span></span><i></i></div>';
    h += '<div class="kba-lb-me-h" id="kbaLbMeH">YOUR BEST</div>';
    for (i = 0; i < 2; i++) h += '<div class="kba-lb-r me" id="kbaLbM' + i + '"><b></b><img alt=""><span></span><i></i></div>';
    box.innerHTML = h; card.insertBefore(box, play); card.classList.add('kba-lb');
    for (i = 0; i < 5; i++) rows.push(document.getElementById('kbaLbR' + i));
    for (i = 0; i < 2; i++) meRows.push(document.getElementById('kbaLbM' + i));
    meHead = document.getElementById('kbaLbMeH'); head = document.getElementById('kbaLbKind'); empty = document.getElementById('kbaLbEmpty');
    return true;
  }
  function setRow(el, rank, name, score, av) {
    if (!name) { if (el.style.display !== 'none') el.style.display = 'none'; return; }
    el.style.display = ''; var c = el.children;
    if (c[0].textContent !== String(rank)) c[0].textContent = rank;
    var src = 'img/av' + av + '.webp'; if (c[1].getAttribute('src') !== src) c[1].setAttribute('src', src);
    if (c[2].textContent !== name) c[2].textContent = name;
    if (c[3].textContent !== String(score)) c[3].textContent = score;
    el.classList.toggle('gold', rank === 1);
  }
  function render() {
    timer = 0; if (!on || !box) return;
    var list = (top[kind] || {})[cur] || [];
    empty.style.display = list.length ? 'none' : '';
    for (var i = 0; i < 5; i++) { var r = list[i]; setRow(rows[i], i + 1, r && r[0], r && r[1], r && r[2]); }
    var ps = Object.keys(mine), shown = 0;
    for (i = 0; i < 2; i++) {
      var n = ps[i], b = n && mine[n].songs[cur];
      if (b) { setRow(meRows[i], b[1], n, b[0], mine[n].av); shown++; } else setRow(meRows[i], 0, '', 0, 0);
    }
    meHead.style.display = shown ? '' : 'none';
  }
  function schedule() { if (!timer) timer = setTimeout(render, 120); }
  // called by app.js renderPreviewCard (patched in build.mjs) on every highlight: memory lookup only, debounced
  window.KBA_LB = {
    song: function (id, k) {
      if (!on) return; cur = id;
      var nk = (k === 'beat' || k === 'duet') ? k : 'sing';
      box && box.classList.toggle('off', k === 'jam');
      if (nk !== kind) { kind = nk; head.textContent = { sing: 'Sing', beat: 'Beat', duet: 'Duet' }[kind]; if (!top[kind]) loadTop(); loadMine(); }
      if (players().join('|') + '#' + kind !== names) loadMine();
      clearTimeout(timer); timer = setTimeout(render, 120);
    },
    refresh: function () { if (on) { loadTop(true); loadMine(); } },
    state: function () { return { on: on, cur: cur, kind: kind, rows: rows.filter(function (r) { return r.style.display !== 'none'; }).map(function (r) { return r.textContent; }), mine: mine }; }
  };
  function init() {
    get(BASE + '/api/flags', function (f) {
      if (!f || !f.lbpanel) return;
      if (!build()) return; on = true; loadTop(); loadMine();
      setInterval(function () { var h = document.getElementById('home'); if (h && h.classList.contains('active')) loadTop(); }, 120000);
      setInterval(function () { if (players().join('|') + '#' + kind !== names) loadMine(); }, 3000);
      try { var s = KaraokeTVSelect.state().selected; if (s) KBA_LB.song(s, 'sing'); } catch (e) {}
    });
  }
  // a finished song may have changed the board: refresh after the results message
  var NativeWS = window.WebSocket;
  if (NativeWS && !NativeWS.__kbaLb) {
    var W = function (u, p) { var ws = p ? new NativeWS(u, p) : new NativeWS(u); ws.addEventListener('message', function (ev) { if (typeof ev.data === 'string' && ev.data.indexOf('"type":"web-hs"') > 0) setTimeout(function () { KBA_LB.refresh(); }, 500); }); return ws; };
    W.prototype = NativeWS.prototype; W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3; W.__kbaLb = true; window.WebSocket = W;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
