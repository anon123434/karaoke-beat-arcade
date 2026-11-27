/* v13.16 world leaderboard moments, shared by the Samsung TV app and the hosted web build (ES5, no polling):
 *  - rank-up animation after a new personal best (row flies in, climbs past its neighbours, "#7 WORLDWIDE" ticks into place)
 *  - "#N to beat: X pts" nudge when the score does not place
 *  - song select "WORLD TOP 3" (TV; the web build has its own Top 5 panel) + a link to the full leaderboard
 *  - "beat the world #1" banner while a song starts
 * Data: the Worker answers every submit with the player's standing (web-hs message). Top lists come from one cached
 * snapshot (/api/lb/top) that is fetched at most once per 10 minutes, on song select. Nothing here repeats on a timer. */
(function () {
  'use strict';
  var CFG = window.KARAOKE_CONFIG || {}, WEB = !!CFG.web, LB_URL = WEB ? location.host + '/kba/leaderboard' : 'the web leaderboard';
  var tops = {}, loading = {}, failed = {}, cur = { id: '', kind: 'sing' }, link = null, linkTried = false, panel = null, pre = null, nudgeEl = null, ov = null, ovState = null;
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function api(p) { return (CFG.server || '') + p; }
  function avIdx(n) { var h = 2166136261, s = String(n).toLowerCase().replace(/\s+/g, ' ').trim(); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 8; }
  function resultsOn() { var r = $('results'); return !!(r && r.classList.contains('active')); }
  function boardKind(k) { return k === 'beat' || k === 'duet' || k === 'sing' ? k : ''; }

  // ---------- CSS ----------
  var css = [
    '#kbaRk{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;font-family:"SamsungOne","Helvetica Neue",Arial,sans-serif;color:#fff;opacity:0;transition:opacity .25s}',
    '#kbaRk.on{opacity:1}#kbaRk.off{opacity:0}',
    '#kbaRk .rk-dim{position:absolute;inset:0;background:radial-gradient(90% 80% at 50% 45%,rgba(60,14,120,.97),rgba(6,2,22,.99))}',
    '#kbaRk .rk-rays{position:absolute;left:50%;top:50%;width:230vmax;height:230vmax;margin:-115vmax 0 0 -115vmax;opacity:.0;background:repeating-conic-gradient(rgba(255,215,94,.16) 0 7deg,transparent 7deg 20deg);animation:rkspin 14s linear infinite;-webkit-mask:radial-gradient(circle,#000 0,transparent 42%);mask:radial-gradient(circle,#000 0,transparent 42%);transition:opacity .5s}',
    '#kbaRk.fin .rk-rays{opacity:1}',
    '#kbaRk .rk-wrap{position:relative;display:flex;gap:4vw;align-items:center;width:88vw;max-width:1700px}',
    '#kbaRk .rk-left{flex:0 0 38%;display:flex;flex-direction:column;align-items:flex-start;gap:1.2vh}',
    '#kbaRk .rk-tag{font-size:3.6vh;font-weight:900;letter-spacing:.5vh;padding:.8vh 2.2vh;border-radius:99px;color:#1a0026;background:linear-gradient(180deg,#ffe27a,#ffb52e);box-shadow:0 0 40px rgba(255,181,46,.7);transform:scale(.2) rotate(-8deg);opacity:0}',
    '#kbaRk.on .rk-tag{animation:rkslam .55s cubic-bezier(.2,1.6,.4,1) .05s forwards}',
    '#kbaRk.t1 .rk-tag{background:linear-gradient(180deg,#fffbe6,#ffe27a 40%,#ff9f1c);box-shadow:0 0 70px rgba(255,215,94,.95)}',
    '#kbaRk .rk-name{font-size:5.4vh;font-weight:900;line-height:1.05;max-width:36vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#kbaRk .rk-sc{font-size:3.2vh;font-weight:800;color:#ffffffc0}#kbaRk .rk-sc b{font-size:7.4vh;color:#fff;margin-right:1vh;text-shadow:0 0 30px rgba(63,242,255,.8)}',
    '#kbaRk .rk-song{font-size:2.6vh;font-weight:700;color:#c9b8ff;max-width:36vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#kbaRk .rk-rank{margin-top:1.6vh;display:flex;align-items:baseline;gap:1.6vh;white-space:nowrap}',
    '#kbaRk .rk-n{font-size:15vh;font-weight:900;line-height:.95;font-variant-numeric:tabular-nums;color:#fff;text-shadow:0 0 40px rgba(63,242,255,.9),0 .6vh 0 rgba(0,0,0,.4)}',
    '#kbaRk .rk-rank small{font-size:3.4vh;font-weight:900;letter-spacing:.6vh;color:#ffd75e}',
    '#kbaRk.fin .rk-n{animation:rkpop .6s cubic-bezier(.2,1.8,.4,1);color:#ffe27a;text-shadow:0 0 60px rgba(255,215,94,.95),0 .6vh 0 rgba(0,0,0,.4)}',
    '#kbaRk .rk-pass{font-size:3vh;font-weight:800;color:#59ffa8;min-height:3.6vh;opacity:0;transition:opacity .4s}#kbaRk.fin .rk-pass{opacity:1}',
    '#kbaRk .rk-also{font-size:2.3vh;font-weight:700;color:#ffffffb8}',
    '#kbaRk .rk-right{flex:1;min-width:0}',
    '#kbaRk .rk-h{font-size:2.5vh;font-weight:900;letter-spacing:.4vh;color:#ffd75e;margin-bottom:1.2vh;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#kbaRk .rk-list{position:relative;width:100%}',
    '#kbaRk .rk-row{position:absolute;left:0;right:0;height:8vh;display:flex;align-items:center;gap:1.6vh;padding:0 2vh;border-radius:2vh;background:rgba(255,255,255,.08);border:.25vh solid rgba(255,255,255,.14);transition:transform .3s cubic-bezier(.3,1.3,.5,1),background .3s,box-shadow .3s;transform:translateX(120vw);will-change:transform}',
    '#kbaRk .rk-row.in{transition:transform .5s cubic-bezier(.2,1.2,.4,1)}',
    '#kbaRk .rk-row b{width:8vh;font-size:3.6vh;font-weight:900;text-align:center;font-variant-numeric:tabular-nums;color:#ffd75e}',
    '#kbaRk .rk-row img{width:5.6vh;height:5.6vh;border-radius:50%;border:.3vh solid rgba(255,255,255,.3);background:#1a0a3a}',
    '#kbaRk .rk-row span{flex:1;min-width:0;font-size:3.2vh;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '#kbaRk .rk-row i{font-style:normal;font-size:3.8vh;font-weight:900}',
    '#kbaRk .rk-row.me{z-index:3;background:linear-gradient(90deg,rgba(63,242,255,.38),rgba(139,92,255,.38));border-color:#3ff2ff;box-shadow:0 0 5vh rgba(63,242,255,.75)}',
    '#kbaRk .rk-row.me b{color:#fff}',
    '#kbaRk.fin .rk-row.me{animation:rkglow 1s ease-in-out infinite;border-color:#ffe27a}',
    '#kbaRk .rk-row.hit{box-shadow:0 0 3vh rgba(255,107,134,.8)}',
    '#kbaRk .rk-foot{position:absolute;left:0;right:0;bottom:3vh;display:flex;align-items:center;justify-content:center;gap:2vh;font-size:2.4vh;font-weight:700;color:#ffffffc8}',
    '#kbaRk .rk-foot b{color:#fff}#kbaRk .rk-qr{width:9vh;height:9vh;background:#fff;border-radius:1vh;padding:.6vh;display:none}#kbaRk .rk-qr svg{width:100%;height:100%;display:block}',
    '#kbaRk .rk-conf{position:absolute;left:50%;top:46%;width:0;height:0;pointer-events:none}',
    '#kbaRk .rk-conf i{position:absolute;left:0;top:0;width:1.4vh;height:2.2vh;border-radius:.3vh;opacity:0;animation:rkconf 2.4s cubic-bezier(.15,.7,.3,1) forwards}',
    '@keyframes rkspin{to{transform:rotate(360deg)}}',
    '@keyframes rkslam{0%{transform:scale(.2) rotate(-8deg);opacity:0}100%{transform:scale(1) rotate(-2deg);opacity:1}}',
    '@keyframes rkpop{0%{transform:scale(1.9)}100%{transform:scale(1)}}',
    '@keyframes rkglow{50%{box-shadow:0 0 8vh rgba(255,226,122,.95)}}',
    '@keyframes rkconf{0%{opacity:1;transform:translate(0,0) rotate(0)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) rotate(var(--rot))}}',
    /* nudge toast on the results screen */
    '#kbaRkNudge{position:fixed;left:50%;bottom:14vh;z-index:9100;transform:translate(-50%,160%);transition:transform .45s cubic-bezier(.2,1.4,.4,1);padding:1.4vh 3vh;border-radius:3vh;font-family:"SamsungOne","Helvetica Neue",Arial,sans-serif;color:#fff;text-align:center;background:linear-gradient(160deg,rgba(255,255,255,.14),rgba(255,255,255,.04)),rgba(18,7,44,.92);border:.3vh solid #3ff2ff;box-shadow:0 0 5vh rgba(63,242,255,.55)}',
    '#kbaRkNudge.on{transform:translate(-50%,0)}',
    '#kbaRkNudge div{font-size:3.4vh;font-weight:900;white-space:nowrap}#kbaRkNudge div b{color:#ffd75e}#kbaRkNudge small{display:block;font-size:2vh;font-weight:700;color:#ffffffb0;margin-top:.3vh}',
    /* song select world top 3 (TV) */
    '#kbaRkBox{width:100%;margin-top:12px;text-align:left}',
    '.rkb-h{display:flex;justify-content:space-between;align-items:center;font-size:16px;letter-spacing:4px;font-weight:900;color:#ffd75e;margin-bottom:6px}',
    '.rkb-h small{letter-spacing:1px;font-size:13px;color:#fff;padding:2px 10px;border-radius:99px;border:1px solid rgba(255,255,255,.3)}',
    '.rkb-r{display:flex;align-items:center;gap:10px;height:34px;padding:0 10px;margin-bottom:4px;border-radius:10px;background:rgba(255,255,255,.07)}',
    '.rkb-r.g{height:44px;background:linear-gradient(90deg,rgba(255,215,94,.28),rgba(255,215,94,.08));box-shadow:inset 0 0 0 2px rgba(255,215,94,.5)}',
    '.rkb-r b{width:26px;font-size:19px;font-weight:900;text-align:center}.rkb-r.g b{color:#ffd75e;font-size:24px}',
    '.rkb-r img{width:28px;height:28px;border-radius:50%;border:2px solid rgba(255,255,255,.25);background:#1a0a3a}.rkb-r.g img{width:34px;height:34px}',
    '.rkb-r span{flex:1;min-width:0;font-size:18px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.rkb-r.g span{font-size:22px;font-weight:900}',
    '.rkb-r i{font-style:normal;font-size:21px;font-weight:900}.rkb-r.g i{color:#ffd75e;font-size:26px}',
    '.rkb-e{font-size:17px;color:#ffffffa8;padding:6px 4px}',
    '.rkb-l{font-size:14px;color:#ffffff90;margin-top:2px;text-align:center;letter-spacing:.5px}.rkb-l b{color:#fff}',
    '#kbaRkLink{grid-column:1/-1;width:100%;margin-top:6px;text-align:center;font-size:15px;letter-spacing:.5px;color:#ffffffa0}#kbaRkLink a{color:#ffd75e;font-weight:800;text-decoration:none;border-bottom:1px dashed rgba(255,215,94,.6)}',
    /* before-song banner */
    '#kbaRkPre{position:fixed;left:50%;top:11vh;z-index:9050;transform:translate(-50%,-220%);opacity:0;padding:1vh 3vh;border-radius:3vh;font-family:"SamsungOne","Helvetica Neue",Arial,sans-serif;color:#fff;white-space:nowrap;background:rgba(18,7,44,.9);border:.3vh solid #ffd75e;box-shadow:0 0 4vh rgba(255,215,94,.5);font-size:2.6vh;font-weight:800;pointer-events:none}',
    '#kbaRkPre b{color:#ffd75e}#kbaRkPre.on{animation:rkpre 7s ease-in-out forwards}',
    '@keyframes rkpre{0%{transform:translate(-50%,-220%);opacity:0}7%{transform:translate(-50%,0);opacity:1}88%{transform:translate(-50%,0);opacity:1}100%{transform:translate(-50%,-220%);opacity:0}}',
    '#kbaRkRes{position:fixed;left:50%;bottom:1.4vh;z-index:5;transform:translateX(-50%);font-family:"SamsungOne","Helvetica Neue",Arial,sans-serif;font-size:2vh;font-weight:700;color:#ffffffa8;white-space:nowrap;pointer-events:none;display:none}#kbaRkRes b{color:#ffd75e}#results.active~#kbaRkRes{display:block}'
  ].join('\n');
  (function () { var s = document.createElement('style'); s.id = 'kbaRkCss'; s.textContent = css; (document.head || document.documentElement).appendChild(s); })();

  // ---------- sound (no SFX system exists, so a few synthesized arcade blips; never blocks anything) ----------
  var actx = null;
  function ac() { try { var AC = window.AudioContext || window.webkitAudioContext; if (!AC || window.KBA_RANK_MUTE) return null; if (!actx) actx = new AC(); if (actx.state === 'suspended' && actx.resume) actx.resume(); return actx; } catch (e) { return null; } }
  function tone(f, at, dur, type, vol, f2) {
    var c = ac(); if (!c) return;
    try {
      var o = c.createOscillator(), g = c.createGain(), t = c.currentTime + at;
      o.type = type || 'square'; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.08, t + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  }
  var SFX = {
    whoosh: function () { tone(180, 0, 0.35, 'sawtooth', 0.05, 900); },
    tick: function (k) { tone(520 + k * 70, 0, 0.07, 'square', 0.06); },
    land: function (top) { var n = top ? [523, 659, 784, 1047, 1319] : [523, 659, 784, 1047]; for (var i = 0; i < n.length; i++) tone(n[i], i * 0.09, 0.22, 'square', 0.07); tone(n[0] / 2, 0, 0.5, 'triangle', 0.1); },
    nudge: function () { tone(440, 0, 0.1, 'triangle', 0.06); tone(660, 0.1, 0.16, 'triangle', 0.06); }
  };

  // ---------- data ----------
  function note(kind, id, rows) {   // keep the cached snapshot current from every submit answer: no extra request
    if (!tops[kind]) return; tops[kind].songs[id] = rows;
  }
  function loadTop(kind, fresh) {
    if (!kind) return; var t = tops[kind];
    if (!fresh && t && Date.now() - t.at < 600000) return;
    if (loading[kind] || (failed[kind] && Date.now() - failed[kind] < 120000)) return; loading[kind] = 1;
    var x = new XMLHttpRequest(); x.open('GET', api('/api/lb/top?kind=' + kind + (fresh ? '&fresh=1' : '')));
    x.timeout = 8000;
    x.onload = function () { loading[kind] = 0; try { var d = JSON.parse(x.responseText); if (d && d.songs) { failed[kind] = 0; tops[kind] = { songs: d.songs, at: Date.now() }; renderPanel(); renderPre(); return; } } catch (e) {} failed[kind] = Date.now(); renderPanel(); };
    x.onerror = x.ontimeout = function () { loading[kind] = 0; failed[kind] = Date.now(); renderPanel(); };
    x.send();
  }
  function loadLink() {   // TV only: QR of the leaderboard address (the Mac server draws it)
    if (WEB || linkTried) return; linkTried = true;
    var x = new XMLHttpRequest(); x.open('GET', api('/api/lb/link')); x.timeout = 6000;
    x.onload = function () { try { var d = JSON.parse(x.responseText); if (d && d.qrSvg) link = d; } catch (e) {} };
    x.send();
  }
  function listFor(kind, id) { var t = tops[kind]; return (t && t.songs && t.songs[id]) || null; }

  // ---------- song select: world top 3 (TV) + link ----------
  function ensurePanel() {
    var card = $('pvCard'), play = $('pvPlay'); if (!card || !play) return false;
    if (!WEB && !panel) {
      panel = document.createElement('div'); panel.id = 'kbaRkBox';
      card.insertBefore(panel, play);
    }
    if (WEB && !$('kbaRkLink')) {
      var l = document.createElement('div'); l.id = 'kbaRkLink'; l.innerHTML = '\ud83c\udfc6 <a href="/kba/leaderboard" target="_blank" rel="noopener">Full world leaderboard \u203a ' + LB_URL + '</a>';
      card.insertBefore(l, play);
    }
    return true;
  }
  function renderPanel() {
    if (WEB || !panel) return;
    var k = boardKind(cur.kind);
    if (!k) { panel.style.display = 'none'; return; }
    if (!tops[k] && failed[k]) { panel.style.display = 'none'; return; }   // leaderboard unreachable: no half-empty box
    panel.style.display = '';
    var list = listFor(k, cur.id), h = '<div class="rkb-h"><span>\ud83c\udfc6 WORLD TOP 3</span><small>' + { sing: 'Sing', beat: 'Beat', duet: 'Duet' }[k] + '</small></div>';
    if (!tops[k]) h += '<div class="rkb-e">Loading world scores\u2026</div>';
    else if (!list || !list.length) h += '<div class="rkb-e">No world score yet \u2014 be the first!</div>';
    else for (var i = 0; i < Math.min(3, list.length); i++) h += '<div class="rkb-r' + (i ? '' : ' g') + '"><b>' + (i ? i + 1 : '\ud83d\udc51') + '</b><img alt="" src="img/av' + (list[i][2] != null ? list[i][2] : avIdx(list[i][0])) + '.webp"><span>' + esc(list[i][0]) + '</span><i>' + list[i][1] + '</i></div>';
    h += '<div class="rkb-l">Full leaderboard: <b>' + LB_URL + '</b></div>';
    panel.innerHTML = h;
  }

  // ---------- before the song: beat the world #1 ----------
  function renderPre() {
    if (!pre || !pre._on) return;
    var k = boardKind(pre._kind), list = k && listFor(k, pre._id);
    if (!k) { pre.className = ''; return; }
    var html = list && list.length ? '\ud83c\udfc6 World #1: <b>' + esc(list[0][0]) + '</b> \u00b7 <b>' + list[0][1] + '</b> pts \u2014 can you beat it?' : '\ud83c\udfc6 Nobody has a world score here yet \u2014 claim <b>#1</b>!';
    if (pre.innerHTML !== html) pre.innerHTML = html;
  }
  function showPre(id, kind) {
    if (!boardKind(kind)) return;
    if (!pre) { pre = document.createElement('div'); pre.id = 'kbaRkPre'; document.body.appendChild(pre); }
    pre.className = ''; void pre.offsetWidth; pre._on = true; pre._id = id; pre._kind = kind;
    loadTop(kind, false);
    if (!tops[kind]) return;   // first load still running: skip rather than flash an empty banner
    renderPre(); pre.className = 'on';
    clearTimeout(pre._t); pre._t = setTimeout(function () { pre._on = false; pre.className = ''; }, 7200);
  }

  // ---------- nudge ----------
  function nudgeLines(list, multi) {
    var out = [];
    for (var i = 0; i < list.length && out.length < 2; i++) {
      var r = list[i], who = multi ? '<b>' + esc(r.name) + '</b> \u00b7 ' : '';
      if (!r.up) out.push('<div>' + who + '\ud83d\udc51 You hold <b>#1</b> \u2014 defend it!</div>');
      else out.push('<div>' + who + '\ud83c\udfaf <b>#' + r.up.rank + '</b> to beat: <b>' + r.up.score + '</b> pts</div><small>you\u2019re #' + r.pos + ' \u00b7 ' + (function (g) { return g + ' pt' + (g === 1 ? '' : 's'); })(Math.max(1, r.up.score - r.bestScore + 1)) + ' to climb a spot</small>');
    }
    return out.join('');
  }
  function showNudge(list, multi) {
    if (!list.length || !resultsOn()) return;
    if (!nudgeEl) { nudgeEl = document.createElement('div'); nudgeEl.id = 'kbaRkNudge'; document.body.appendChild(nudgeEl); }
    nudgeEl.innerHTML = nudgeLines(list, multi); nudgeEl.className = ''; void nudgeEl.offsetWidth; nudgeEl.className = 'on';
    SFX.nudge();
    clearTimeout(nudgeEl._t); nudgeEl._t = setTimeout(hideNudge, 6500);
  }
  function hideNudge() { if (nudgeEl) nudgeEl.className = ''; }

  // ---------- rank-up animation ----------
  var ROW_H = 0; function rowH() { return ROW_H || (ROW_H = Math.round(window.innerHeight * 0.08) + Math.round(window.innerHeight * 0.012)); }
  function place(row, idx, ms) { row.style.transform = 'translateY(' + idx * rowH() + 'px)'; }
  function rankUp(m, r, others) {
    if (ov) closeOv(true);
    var near = (r.near || []).slice(), mi = 0, i;
    for (i = 0; i < near.length; i++) if (near[i].me) mi = i;
    var steps = Math.min(Math.max(0, r.passed || 0), near.length - 1 - mi), pos = r.pos, start = r.prevPos || r.total || pos;
    var t1 = pos === 1, top3 = pos <= 3, top10 = pos <= 10;
    var tag = t1 ? '\ud83d\udc51 NEW WORLD #1!' : r.prevPos ? (top3 ? '\ud83d\udd25 TOP 3 \u2014 NEW BEST!' : top10 ? '\u2b50 TOP 10 \u2014 NEW BEST!' : '\u2b50 NEW PERSONAL BEST!') : '\ud83c\udf89 YOU\u2019RE ON THE BOARD!';
    ov = document.createElement('div'); ov.id = 'kbaRk'; ov.className = t1 ? 't1' : '';
    ov.innerHTML = '<div class="rk-dim"></div><div class="rk-rays"></div><div class="rk-wrap"><div class="rk-left"><div class="rk-tag">' + tag + '</div><div class="rk-name">' + esc(r.name) + '</div>' +
      '<div class="rk-sc"><b>0</b>pts</div><div class="rk-song">' + { sing: '\ud83c\udfa4', beat: '\ud83e\udd41', duet: '\ud83c\udfa4\ud83e\udd41' }[m.kind || 'sing'] + ' ' + esc(m.title || '') + '</div>' +
      '<div class="rk-rank"><b class="rk-n">#' + start + '</b><small>WORLDWIDE</small></div><div class="rk-pass"></div>' +
      (others.length ? '<div class="rk-also">Also ranked: ' + others.map(function (o) { return esc(o.name) + ' #' + o.pos; }).join(' \u00b7 ') + '</div>' : '') +
      '</div><div class="rk-right"><div class="rk-h">\ud83c\udfc6 WORLD LEADERBOARD</div><div class="rk-list"></div></div></div>' +
      '<div class="rk-foot"><span class="rk-qr"></span><span><b>OK</b> skip \u00b7 full leaderboard: <b>' + LB_URL + '</b></span></div><div class="rk-conf"></div>';
    document.body.appendChild(ov);
    var list = ov.querySelector('.rk-list'), rows = [], disp = [];   // disp: row indices in display order
    list.style.height = near.length * rowH() + 'px';
    for (i = 0; i < near.length; i++) {
      var d = document.createElement('div'); d.className = 'rk-row' + (near[i].me ? ' me' : '');
      d.innerHTML = '<b></b><img alt="" src="img/av' + (near[i].av != null ? near[i].av : avIdx(near[i].name)) + '.webp"><span>' + esc(near[i].name) + '</span><i>' + near[i].score + '</i>';
      list.appendChild(d); rows.push(d);
    }
    for (i = 0; i < near.length; i++) if (i !== mi) disp.push(i);
    var s = Math.min(near.length - 1, mi + steps); disp.splice(s, 0, mi);
    var firstRank = near[0].rank;
    function layout(labelsOnly) { for (var k = 0; k < disp.length; k++) { if (!labelsOnly) place(rows[disp[k]], k); if (disp[k] !== mi) rows[disp[k]].children[0].textContent = firstRank + k; } }
    function setMe(v) { rows[mi].children[0].textContent = Math.round(v); ov.querySelector('.rk-n').textContent = '#' + Math.round(v); }
    layout(true); setMe(start);
    var timers = [], st = { done: false, born: Date.now(), rafs: 0 };
    ovState = st;
    function at(ms, fn) { timers.push(setTimeout(function () { if (!st.done) fn(); }, ms)); }
    function countScore() { var el = ov.querySelector('.rk-sc b'), t0 = Date.now(); (function stp() { if (st.done) return; var k = Math.min(1, (Date.now() - t0) / 700); el.textContent = Math.round(r.score * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(stp); })(); }
    var stepMs = steps ? Math.max(240, Math.min(380, Math.round(2200 / steps))) : 0, climbAt = 1100, finAt = climbAt + steps * stepMs + 250;
    // phase 1: card slams in, score counts up
    requestAnimationFrame(function () { if (ov && !/ on\b/.test(' ' + ov.className)) ov.className += ' on'; });
    at(60, countScore); at(80, SFX.whoosh);
    // phase 2: rows fly in
    at(380, function () { for (var k = 0; k < rows.length; k++) (function (k) { setTimeout(function () { if (st.done) return; rows[k].className += ' in'; place(rows[k], disp.indexOf(k)); }, k * 60); })(k); });
    // phase 3: climb past the neighbours, one row at a time; the counter ticks down in step
    var ci = s;
    for (i = 0; i < steps; i++) (function (n) {
      at(climbAt + n * stepMs, function () {
        var c = ci - 1, other = disp[c]; disp[ci] = other; disp[c] = mi; ci = c;
        rows[other].className += ' hit'; setTimeout(function () { rows[other].className = rows[other].className.replace(' hit', ''); }, 260);
        layout();
        var frac = (n + 1) / steps; setMe(start - (start - pos) * frac);
        SFX.tick(n);
      });
    })(i);
    // phase 4: final slam, glow, confetti
    at(finAt, function () {
      layout(); setMe(pos); ov.className += ' fin';
      SFX.land(t1 || top3);
      var p = ov.querySelector('.rk-pass'); p.textContent = r.passed > 0 ? (r.passed === 1 ? '\ud83d\ude80 You passed 1 singer!' : '\ud83d\ude80 You passed ' + r.passed + ' singers!') : (r.prevPos ? 'Up from #' + r.prevPos : 'Welcome to the world board!');
      confetti(t1 ? 90 : top3 ? 70 : 48);
    });
    if (link && link.qrSvg) { var q = ov.querySelector('.rk-qr'); q.innerHTML = link.qrSvg; q.style.display = 'block'; }
    var end = Math.max(finAt + 1700, 4300); st.endAt = end;
    at(end, function () { closeOv(false); });
    st.timers = timers;
    // watch the screen: if the app left the results screen (e.g. a controller press), end quietly
    at(900, function watch() { if (!resultsOn()) return closeOv(true); timers.push(setTimeout(function () { if (!st.done) watch(); }, 500)); });
  }
  function confetti(n) {
    if (!ov) return; var c = ov.querySelector('.rk-conf'), cols = ['#ffd75e', '#ff3fa4', '#3ff2ff', '#59ffa8', '#a66bff', '#fff'], h = '';
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, d = 20 + Math.random() * 55, dx = Math.cos(a) * d * 1.6, dy = Math.sin(a) * d * 0.9 + 22 + Math.random() * 12;
      h += '<i style="background:' + cols[i % cols.length] + ';--dx:' + dx.toFixed(1) + 'vw;--dy:' + dy.toFixed(1) + 'vh;--rot:' + Math.round(Math.random() * 900 - 450) + 'deg;animation-delay:' + (Math.random() * 0.25).toFixed(2) + 's"></i>';
    }
    c.innerHTML = h;
  }
  function closeOv(quiet) {
    if (!ov) return; var el = ov, st = ovState; ov = null; ovState = null;
    if (st) { st.done = true; (st.timers || []).forEach(clearTimeout); }
    el.className = el.className.replace(/\s*\bon\b/g, '') + ' off';
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    if (!quiet && pendingNudge) { var p = pendingNudge; pendingNudge = null; setTimeout(function () { showNudge(p.list, p.multi); }, 350); } else pendingNudge = null;
  }
  var pendingNudge = null;
  // any key or click skips (a short grace period stops the last button mash of the song from dismissing it)
  window.addEventListener('keydown', function (e) {
    if (!ov || !ovState) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (Date.now() - ovState.born < 600 || e.repeat) return;
    closeOv(false);
  }, true);
  window.addEventListener('pointerdown', function (e) { if (ov && ovState && Date.now() - ovState.born > 600) { e.preventDefault(); e.stopPropagation(); closeOv(false); } }, true);
  window.addEventListener('click', function (e) { if (ov) { e.preventDefault(); e.stopPropagation(); } }, true);

  // ---------- the Worker's answer to a submit ----------
  function onHs(m) {
    if (!m || !m.ok || !m.results || !m.results.length) return;
    var kind = m.kind || 'sing';
    if (m.top) note(kind, m.song, m.top.map(function (t) { return [t.name, t.score, avIdx(t.name)]; }));
    renderPanel();
    var win = [], rest = [];
    m.results.forEach(function (r) {
      if (!r || r.pos == null) return;
      if (r.personalBest && r.score > 0 && r.pos <= 100) win.push(r); else rest.push(r);
    });
    win.sort(function (a, b) { return a.pos - b.pos; });
    var multi = m.results.length > 1;
    setTimeout(function () {
      if (!resultsOn()) return;
      if (win.length) {
        pendingNudge = rest.length ? { list: rest, multi: multi } : null;
        rankUp(m, win[0], win.slice(1));
      } else showNudge(rest, multi);
    }, 1300);
  }
  var NativeWS = window.WebSocket;
  if (NativeWS && !NativeWS.__kbaRk) {
    var W = function (u, p) {
      var ws = p ? new NativeWS(u, p) : new NativeWS(u);
      ws.addEventListener('message', function (ev) {
        if (typeof ev.data === 'string' && ev.data.indexOf('"type":"web-hs"') > 0) { try { onHs(JSON.parse(ev.data)); } catch (e) {} }
      });
      return ws;
    };
    W.prototype = NativeWS.prototype; W.CONNECTING = 0; W.OPEN = 1; W.CLOSING = 2; W.CLOSED = 3; W.__kbaRk = true; window.WebSocket = W;
  }

  // ---------- results screen: always-visible path to the full board ----------
  function addResLink() {
    if ($('kbaRkRes') || !$('results')) return;
    var d = document.createElement('div'); d.id = 'kbaRkRes'; d.innerHTML = '\ud83c\udfc6 World leaderboard: <b>' + LB_URL + '</b>';
    $('results').parentNode.insertBefore(d, $('results').nextSibling);
  }

  window.KBA_RANK = {
    select: function (id, kind) { cur.id = id; cur.kind = kind || 'sing'; if (!ensurePanel()) return; var k = boardKind(cur.kind); if (k) loadTop(k, false); loadLink(); renderPanel(); },
    pre: function (id, kind) { try { showPre(id, kind); } catch (e) {} },
    onHs: onHs,
    skip: function () { closeOv(false); },
    active: function () { return !!ov; },
    state: function () { return { tops: Object.keys(tops), cur: cur, ov: !!ov, link: !!link }; },
    _test: { rankUp: rankUp, showNudge: showNudge }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addResLink); else addResLink();
})();
