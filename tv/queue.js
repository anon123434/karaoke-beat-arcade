/*
 * Phone song queue (v13.12). Singers search the song list on their phone (Songs tab) and either "Play now" (TV idle) or
 * "Add to queue". This file is the TV side: the queue itself, the small "Up next" toast, the up-next strip, the auto-advance
 * countdown, and the host controls (YELLOW / Q on the remote opens the queue: Play now, Skip, Remove).
 *
 * Rules: a song that is playing is NEVER interrupted. The next song only starts from the song list (screen "home"), after the
 * remote has been quiet for IDLE_MS, with a visible countdown that any button press cancels. Max 3 queued per phone slot,
 * 12 in all, 1 add per ~0.8 s per phone (the relays rate-limit too). Phones only ever send a song id; the TV looks the title up.
 * ES5 (Tizen). Talks to app.js only through window.KaraokeTVHost.
 */
(function () {
  'use strict';
  var H = window.KaraokeTVHost; if (!H) return;
  var MAX_PER = 3, MAX_ALL = 12, IDLE_MS = 8000, CD_ADV = 5, CD_NOW = 3, HOLD_MS = 30000, GAP_MS = 800;
  var Q = [], seq = 1, cd = null, holdUntil = 0, lastSig = '', lastAdd = {}, ov = null, toastT = 0;
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage') || document.body;

  var css = document.createElement('style');
  css.textContent =
    '#qToast{position:absolute;right:44px;top:132px;max-width:620px;z-index:60;padding:14px 22px;border-radius:18px;font:700 28px/1.25 system-ui,sans-serif;color:#fff;background:rgba(20,6,52,.88);border:2px solid #3ff2ff;box-shadow:0 8px 30px rgba(0,0,0,.5),0 0 22px rgba(63,242,255,.35);opacity:0;transform:translateY(-8px);transition:opacity .25s,transform .25s;pointer-events:none}' +
    '#qToast.on{opacity:1;transform:none}#qToast small{display:block;font-weight:600;font-size:21px;opacity:.75}' +
    '#qPill{position:absolute;left:292px;top:36px;width:350px;z-index:30;display:none;align-items:center;gap:8px;padding:7px 16px;border-radius:999px;font:700 21px/1.2 system-ui,sans-serif;color:#fff;background:rgba(20,6,52,.82);border:2px solid #ff3fa4;white-space:nowrap;overflow:hidden}' +
    '#qPill.on{display:flex}#qPill b{color:#ffd75e;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}#qPill u{text-decoration:none;color:#3ff2ff;flex:none}' +
    '#qCd{position:absolute;left:50%;bottom:120px;transform:translateX(-50%);z-index:70;display:none;min-width:760px;max-width:1300px;text-align:center;padding:22px 34px;border-radius:26px;font:800 40px/1.25 system-ui,sans-serif;color:#fff;background:rgba(20,6,52,.94);border:3px solid #ffd75e;box-shadow:0 10px 50px rgba(0,0,0,.6)}' +
    '#qCd.on{display:block}#qCd small{display:block;font:600 24px system-ui,sans-serif;opacity:.8;margin-top:6px}#qCd i{font-style:normal;color:#ffd75e}' +
    '#qOv{position:absolute;inset:0;z-index:80;display:none;background:rgba(6,1,20,.82);align-items:center;justify-content:center}#qOv.on{display:flex}' +
    '#qBox{width:1280px;max-height:880px;overflow:hidden;padding:30px 38px;border-radius:30px;background:rgba(24,8,60,.97);border:3px solid #ff3fa4;box-shadow:0 0 60px rgba(255,63,164,.35);color:#fff;font-family:system-ui,sans-serif}' +
    '#qBox h2{margin:0 0 4px;font-size:46px;letter-spacing:2px}#qBox .qs{font-size:24px;opacity:.7;margin-bottom:16px}' +
    '.qrow{display:flex;align-items:center;gap:18px;padding:12px 18px;margin:8px 0;border-radius:18px;background:rgba(255,255,255,.07);border:2px solid transparent;font-size:32px}' +
    '.qrow.f{border-color:#ffd75e;background:rgba(255,215,94,.12)}.qrow .qn{width:44px;font-weight:800;color:#ffd75e}.qrow .qt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.qrow .qt small{font-size:24px;opacity:.65}' +
    '.qrow .qw{font-size:26px;color:#3ff2ff;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.qb{padding:6px 16px;border-radius:12px;font-size:25px;font-weight:700;background:rgba(255,255,255,.1);border:2px solid rgba(255,255,255,.2)}.qb.on{background:#ffd75e;color:#111;border-color:#ffd75e}' +
    '#qBox .qh{margin-top:14px;font-size:24px;opacity:.7;text-align:center}';
  document.head.appendChild(css);
  function mk(id) { var d = document.createElement('div'); d.id = id; stage.appendChild(d); return d; }
  var eToast = mk('qToast'), ePill = mk('qPill'), eCd = mk('qCd'), eOv = mk('qOv');
  eOv.innerHTML = '<div id="qBox"></div>';

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function now() { return Date.now(); }
  function pname(slot) { var p = H.players()[slot]; return (p && p.name) || 'Player ' + slot; }
  function find(id) { var a = H.songs(); for (var i = 0; i < a.length; i++) if (a[i] && a[i].id === id) return a[i]; return null; }
  function countOf(slot) { var n = 0; for (var i = 0; i < Q.length; i++) if (Q[i].s === slot) n++; return n; }
  function idle() { return H.screen() === 'home' && !H.typing() && !H.busy() && !ov && performance.now() - H.lastKey() >= IDLE_MS; }
  function say(msg, sub) {
    eToast.innerHTML = esc(msg) + (sub ? '<small>' + esc(sub) + '</small>' : ''); eToast.className = 'on';
    clearTimeout(toastT); toastT = setTimeout(function () { eToast.className = ''; }, 4500);
  }
  function res(slot, o) { o.type = 'qres'; o.to = slot; H.send(o); }
  function publish(force) {
    var o = { type: 'queue', idle: idle(), cd: cd ? cd.item.qid : 0, q: Q.map(function (x) { return { qid: x.qid, id: x.id, t: x.t, n: x.n, s: x.s }; }) };
    var sig = JSON.stringify(o); if (!force && sig === lastSig) return; lastSig = sig; H.send(o);
  }

  // ---------- countdown / auto-advance ----------
  function startCd(item, secs) { cd = { item: item, left: secs }; renderCd(); publish(); }
  function renderCd() {
    if (!cd) { eCd.className = ''; return; }
    eCd.innerHTML = '\u25b6 Up next: <i>' + esc(cd.item.t) + '</i> (' + esc(cd.item.n) + ')<br>Starting in ' + cd.left + '\u2026<small>Press any button to hold it</small>';
    eCd.className = 'on';
  }
  function cancelCd(hold) { if (!cd) return; cd = null; renderCd(); if (hold) holdUntil = now() + HOLD_MS; publish(); }
  function fire() {
    var item = cd.item; cd = null; renderCd();
    var i = Q.indexOf(item); if (i < 0) { publish(); return; }
    if (H.screen() !== 'home' || H.typing() || H.busy()) { holdUntil = now() + 5000; publish(); return; }   // somebody started something: wait
    Q.splice(i, 1);
    if (H.startSong(item.id)) res(item.s, { ok: true, act: 'started', id: item.id, title: item.t });
    else { say('Couldn\u2019t start ' + item.t, 'It stays out of the queue \u2014 ask for it again'); res(item.s, { ok: false, act: 'failed', id: item.id, title: item.t }); }
    publish(true);
  }
  function tick() {
    if (cd) { cd.left--; if (cd.left <= 0) fire(); else { if (!(H.screen() === 'home')) { cancelCd(false); } else renderCd(); } }
    else if (Q.length && idle() && now() >= holdUntil) startCd(Q[0], CD_ADV);
    // strip on the song list
    var show = Q.length && H.screen() === 'home' && !ov && !cd;
    if (show) { var x = Q[0]; ePill.innerHTML = '\ud83c\udfa4 <b>' + esc(x.t) + '</b><u>' + esc(x.n) + (Q.length > 1 ? ' +' + (Q.length - 1) : '') + '</u>'; }
    ePill.className = show ? 'on' : '';
    publish();
  }
  setInterval(tick, 1000);

  // ---------- phone messages ----------
  function add(m) {
    var slot = m.p | 0; if (slot < 1 || slot > 4) return;
    var id = String(m.id || '').slice(0, 80), sg = find(id), t = now();
    if (!sg) return res(slot, { ok: false, act: 'nosong', id: id });
    if (t - (lastAdd[slot] || 0) < GAP_MS) return res(slot, { ok: false, act: 'rate', id: id });
    lastAdd[slot] = t;
    if (countOf(slot) >= MAX_PER) return res(slot, { ok: false, act: 'full', id: id, title: sg.title, max: MAX_PER });
    for (var i = 0; i < Q.length; i++) if (Q[i].s === slot && Q[i].id === id) return res(slot, { ok: false, act: 'dup', id: id, title: sg.title });
    if (Q.length >= MAX_ALL) return res(slot, { ok: false, act: 'busy', id: id, title: sg.title });
    var item = { qid: seq++, id: id, t: sg.title, a: sg.artist || '', n: pname(slot), s: slot };
    var now1 = m.mode === 'play' && !cd && idle();
    if (now1) { Q.unshift(item); startCd(item, CD_NOW); say('Up next: ' + item.t + ' (' + item.n + ')', 'Starting in ' + CD_NOW + ' seconds'); }
    else { Q.push(item); say(Q.length === 1 ? 'Up next: ' + item.t + ' (' + item.n + ')' : 'In the queue (#' + Q.length + '): ' + item.t + ' (' + item.n + ')', Q.length === 1 && !idle() ? 'Starts when the current song is done' : ''); }
    res(slot, { ok: true, act: now1 ? 'play' : 'queued', pos: Q.indexOf(item) + 1, id: id, title: item.t });
    publish(true);
  }
  function remove(i, why) {
    var it = Q.splice(i, 1)[0]; if (!it) return;
    if (cd && cd.item === it) cancelCd(false);
    if (why) res(it.s, { ok: true, act: why, id: it.id, title: it.t });
    publish(true);
  }
  function onMsg(m) {
    if (m.type === 'q-add') return add(m);
    if (m.type === 'q-del') { for (var i = 0; i < Q.length; i++) if (Q[i].qid === (m.qid | 0) && Q[i].s === (m.p | 0)) return remove(i, 'removed'); return; }
    if (m.type === 'q-get') return publish(true);
  }

  // ---------- host controls: YELLOW (405) or Q opens the queue ----------
  var ACTS = ['\u25b6 Play now', '\u21e3 Skip', '\u2715 Remove'];
  function open() { ov = { i: 0, a: 0 }; holdUntil = now() + 3600e3; if (cd) cancelCd(false); render(); eOv.className = 'on'; ePill.className = ''; }
  function close() { ov = null; holdUntil = now() + 3000; eOv.className = ''; publish(true); }
  function render() {
    var box = $('qBox'), h = '<h2>\ud83c\udfa4 SONG QUEUE</h2><div class="qs">' + (Q.length ? Q.length + ' waiting \u00b7 singers add songs from the Songs tab on their phone' : 'Nothing queued yet \u2014 singers add songs from the Songs tab on their phone') + '</div>';
    for (var i = 0; i < Q.length && i < 7; i++) {
      var x = Q[i], f = ov && ov.i === i;
      h += '<div class="qrow' + (f ? ' f' : '') + '"><span class="qn">' + (i + 1) + '</span><span class="qt">' + esc(x.t) + ' <small>' + esc(x.a) + '</small></span><span class="qw">' + esc(x.n) + '</span>' +
        (f ? ACTS.map(function (a, k) { return '<span class="qb' + (ov.a === k ? ' on' : '') + '">' + a + '</span>'; }).join('') : '') + '</div>';
    }
    if (Q.length > 7) h += '<div class="qs">+ ' + (Q.length - 7) + ' more</div>';
    box.innerHTML = h + '<div class="qh">\u25b2\u25bc choose \u00b7 \u25c0\u25b6 action \u00b7 OK do it \u00b7 BACK close</div>';
  }
  function key(e) {
    var k = e.keyCode, stop = function () { if (e.preventDefault) e.preventDefault(); };
    if (cd) { stop(); cancelCd(true); say('Queue on hold', 'Press YELLOW to manage it'); return true; }
    if (ov) {
      stop();
      if (k === 38) ov.i = Math.max(0, ov.i - 1); else if (k === 40) ov.i = Math.min(Math.max(0, Math.min(Q.length, 7) - 1), ov.i + 1);
      else if (k === 37) ov.a = Math.max(0, ov.a - 1); else if (k === 39) ov.a = Math.min(2, ov.a + 1);
      else if (k === 13) {
        var it = Q[ov.i];
        if (it) {
          if (ov.a === 0) { Q.splice(ov.i, 1); Q.unshift(it); var go = it; close(); holdUntil = 0; ov = null; startCd(go, CD_NOW); return true; }
          if (ov.a === 1) { if (Q.length > 1) { Q.splice(ov.i, 1); Q.push(it); res(it.s, { ok: true, act: 'skipped', id: it.id, title: it.t }); publish(true); } }
          else remove(ov.i, 'removed');
          if (ov.i >= Q.length) ov.i = Math.max(0, Q.length - 1);
        }
      }
      else if (k === 10009 || k === 8 || k === 27 || k === 405 || k === 81) { close(); return true; }
      else return true;
      render(); return true;
    }
    if ((k === 405 || k === 81) && H.screen() === 'home' && !H.typing() && !H.busy()) { stop(); open(); return true; }
    return false;
  }
  document.addEventListener('mousedown', function () { if (cd) { cancelCd(true); say('Queue on hold', 'Press YELLOW to manage it'); } }, true);   // remote pointer / mouse also holds the countdown
  window.KTVQueue = { onMsg: onMsg, key: key, state: function () { return { q: Q.slice(), cd: cd && { qid: cd.item.qid, left: cd.left }, ov: !!ov, idle: idle(), hold: Math.max(0, holdUntil - now()) }; } };
})();
