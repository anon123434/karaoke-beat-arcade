/* hosted /kba ONLINE 1v1 (flag ONLINE_ENABLED): lobby of open challenges, quick match, waiting, VS countdown,
   live score bars, winner reveal, rematch, 15 s reconnect or forfeit. Scoring stays local (phone pitch -> this screen);
   only start time and scores travel. Talks to app.js through window.KaraokeTVOnline (build.mjs patch). */
(function () {
  'use strict';
  var BASE = '/kba', A = '/kba/tv/img/', enabled = false;
  var S = { v: 'off' }, root, st, hud, hudSt, lws = null, mws = null, lobby = { items: [], online: 0, resting: false }, me = { name: '', av: 0 }, rec = null;
  var cid = ''; try { cid = localStorage.getItem('kba.cid') || ''; if (!/^[a-z0-9]{16}$/.test(cid)) { cid = ''; var b = new Uint8Array(8); crypto.getRandomValues(b); for (var i = 0; i < 8; i++) cid += ('0' + b[i].toString(16)).slice(-2); localStorage.setItem('kba.cid', cid); } } catch (e) { cid = 'c' + Math.random().toString(36).slice(2, 17); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function av(n, s, extra) { return '<img class="av" src="' + A + 'av' + ((n | 0) % 8) + '.webp" style="width:' + s + 'px;height:' + s + 'px;' + (extra || '') + '">'; }
  function art(id, s) { return '<img class="art" src="' + BASE + '/songs/' + id + '/art.webp" style="width:' + s + 'px;height:' + s + 'px" onerror="this.style.visibility=\'hidden\'">'; }
  function fmt(d) { d = Math.round(d || 0); return Math.floor(d / 60) + ':' + ('0' + d % 60).slice(-2); }
  function avIdx(n) { var h = 2166136261, s = String(n).toLowerCase().replace(/\s+/g, ' ').trim(); for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % 8; }
  function T() { return window.KaraokeTVOnline; }
  var LOGO = '<img class="logo" src="' + BASE + '/web/m/logo.webp" alt="">';
  var DISC = '<div class="tag">Private, non-commercial fan project for family and friends · entertainment only · not for sale</div>';
  function btn(c, l) { return '<i style="font-style:normal;display:inline-block;width:34px;height:34px;border-radius:50%;text-align:center;line-height:30px;border:2px solid ' + c + ';color:' + c + ';margin-right:8px;font-size:18px">' + l + '</i>'; }
  function foot(items) { return '<div class="foot glass">' + items.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div>'; }

  // ---------- layout + focus ----------
  function fit() { var k = Math.min(innerWidth / 1920, innerHeight / 1080); [st, hudSt].forEach(function (e) { if (!e) return; e.style.transform = 'scale(' + k + ')'; e.style.left = ((innerWidth - 1920 * k) / 2) + 'px'; }); if (st) st.style.top = ((innerHeight - 1080 * k) / 2) + 'px'; }
  function mount() {
    root = document.createElement('div'); root.className = 'kon hide'; root.innerHTML = '<div class="kon-st"></div>'; document.body.appendChild(root); st = root.firstChild;
    hud = document.createElement('div'); hud.className = 'kon-hud'; hud.style.display = 'none'; hud.innerHTML = '<div class="kon-st"></div>'; document.body.appendChild(hud); hudSt = hud.firstChild;
    st.addEventListener('click', function (e) { var t = e.target.closest('[data-f]'); if (t) { focus(t); act(t.getAttribute('data-f')); } });
    addEventListener('resize', fit); fit();
  }
  function paint(html) { st.innerHTML = '<div class="kon-bg"></div>' + html; root.classList.remove('hide'); if (busyEl && S && S.busy) st.appendChild(busyEl); var f = st.querySelector('[data-f].auto') || st.querySelector('[data-f]'); if (f) focus(f); }
  function focus(el) { var o = st.querySelectorAll('.foc'); for (var i = 0; i < o.length; i++) o[i].classList.remove('foc'); if (el) el.classList.add('foc'); }
  function cur() { return st.querySelector('.foc'); }
  function move(dx, dy) {
    var c = cur(), all = st.querySelectorAll('[data-f]'); if (!c) { if (all[0]) focus(all[0]); return; }
    var r = c.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, best = null, bd = 1e9;
    for (var i = 0; i < all.length; i++) { var e = all[i]; if (e === c) continue; var q = e.getBoundingClientRect(), x = q.left + q.width / 2 - cx, y = q.top + q.height / 2 - cy;
      if ((dx && x * dx <= 4) || (dy && y * dy <= 4)) continue; var d = (dx ? Math.abs(x) + 2.5 * Math.abs(y) : Math.abs(y) + 2.5 * Math.abs(x)); if (d < bd) { bd = d; best = e; } }
    if (best) { focus(best); var lst = st.querySelector('#konList'); if (lst && lst.contains(best)) scrollRow(best); }
  }
  function scrollRow(el) { var l = st.querySelector('#konList'); var top = el.offsetTop, h = l.clientHeight, y = l.scrollTop; if (top < y) l.scrollTop = top; else if (top + el.offsetHeight > y + h) l.scrollTop = top + el.offsetHeight - h; }
  function toast(t, ms) { var e = document.createElement('div'); e.className = 'toast'; e.textContent = t; st.appendChild(e); setTimeout(function () { e.remove(); }, ms || 2600); }
  function hide() { root.classList.add('hide'); }

  // ---------- who is playing from this screen: the first phone ----------
  function player() {
    var P = (T() && T().players()) || {}, ks = Object.keys(P).map(Number).sort(function (a, b) { return a - b; });
    var live = ks.filter(function (k) { return P[k].mic === 'live'; }), k = live[0] || ks[0];
    return k ? { slot: k, name: P[k].name } : null;
  }

  // ---------- entry (START screen "Play Online" button) ----------
  function open() {
    if (!enabled) return;
    if (!T()) { setTimeout(open, 300); return; }
    var p = player();
    if (!p) return needPhone();
    me.name = p.name; me.av = avIdx(p.name); me.slot = p.slot;
    connectLobby(); showLobby();
  }
  function needPhone() {
    S = { v: 'needphone' };
    paint(LOGO + '<h1>GRAB YOUR PHONE<small>Your phone is the microphone</small></h1>' +
      '<div style="position:absolute;left:0;right:0;top:250px;display:flex;justify-content:center;gap:80px;align-items:center"><div class="qrbox qr" id="konQr"></div>' +
      '<div style="width:640px"><div style="font-size:48px;font-weight:800">👆 Scan with your phone camera</div><div style="font-size:30px;color:#fffc;margin-top:20px;line-height:1.4">Type your name on the phone. Online play starts as soon as your phone is connected.</div>' +
      '<div class="pill cyanb" data-f="back" style="margin-top:40px;font-size:30px;padding:14px 40px">◀ Back</div></div></div>' + foot([btn('#ff3fa4', '○') + 'Back']) + DISC);
    var x = new XMLHttpRequest(); x.open('GET', BASE + '/api/session?s=' + window.KTV_ROOM); x.onload = function () { try { var q = st.querySelector('#konQr'); if (q) q.innerHTML = JSON.parse(x.responseText).qrSvg; } catch (e) {} }; x.send();
    var iv = setInterval(function () { if (S.v !== 'needphone') return clearInterval(iv); if (player()) { clearInterval(iv); open(); } }, 500);
  }

  // ---------- lobby socket ----------
  var lbeat = 0, lretry = 0;
  function wsUrl(p) { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + BASE + p; }
  function connectLobby() {
    if (lws && lws.readyState <= 1) return;
    lws = new WebSocket(wsUrl('/ws/lobby?cid=' + cid + '&name=' + encodeURIComponent(me.name)));
    lws.onopen = function () { lretry = 0; clearInterval(lbeat); lbeat = setInterval(function () { lsend({ type: 'beat' }); }, 5000); if (S.v === 'waiting' && S.song) lsend({ type: S.quick ? 'quick' : 'create', song: S.song }); if (pendingSend) { var ps = pendingSend; pendingSend = null; lsend(ps); } };
    lws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } onLobby(m); };
    lws.onclose = function () { clearInterval(lbeat); lws = null; if (S.v === 'lobby' || S.v === 'waiting' || S.v === 'picking' || S.v === 'spin') setTimeout(connectLobby, Math.min(8000, 800 * Math.pow(2, lretry++))); };
  }
  function lsend(o) { if (lws && lws.readyState === 1) { lws.send(JSON.stringify(o)); return true; } return false; }
  // v13.11.1 immediate press feedback for quick match / join: pressed state + "Connecting" spinner within one frame (transform/opacity only),
  // repeat presses ignored while pending, cleared by the server's answer, friendly error + retry if nothing comes back.
  var busyT = 0, busyEl = null, pendingMsg = null;
  function busyOff() { clearTimeout(busyT); busyT = 0; pendingMsg = null; if (busyEl) { busyEl.remove(); busyEl = null; } if (S) S.busy = 0; }
  function busyOn(label, msg) {
    if (S.busy) return false; S.busy = 1; var f = cur(); if (f) { f.classList.add('kon-press'); setTimeout(function () { f.classList.remove('kon-press'); }, 260); }
    busyEl = document.createElement('div'); busyEl.className = 'kon-busy'; busyEl.innerHTML = '<div class="kon-spin"></div><div class="kon-busy-t">' + esc(label) + '</div>'; st.appendChild(busyEl);
    pendingMsg = msg; busyT = setTimeout(function () { busyFail(); }, 9000); return true;
  }
  function busyFail() {
    var m = pendingMsg; busyOff(); toast('Couldn\u2019t reach the lobby. Check your connection, then press OK to try again.', 4200);
    if (!lws || lws.readyState > 1) connectLobby(); void m;
  }
  function busySend(label, msg) {   // send now, or as soon as the lobby socket is open
    if (!busyOn(label, msg)) return;
    if (!lsend(msg)) { pendingSend = msg; connectLobby(); }
  }
  var pendingSend = null;
  function closeLobby() { clearInterval(lbeat); if (lws) { var w = lws; lws = null; w.onclose = null; try { w.close(); } catch (e) {} } }
  function onLobby(m) {
    if (m.type === 'created' || m.type === 'matched' || m.type === 'error' || m.type === 'taken' || m.type === 'expired') busyOff();
    if (m.type === 'welcome') { if (m.spin && m.spin.length) spinList = m.spin; me.name = m.you.name; me.av = m.you.av; if (m.you.banned) toast('Online play is off for this name.', 4000); loadRecord(); }
    else if (m.type === 'list') { lobby = m; if (S.v === 'lobby') renderLobby(true); else if (S.v === 'waiting') { var e = st.querySelector('#konOnline'); if (e) e.textContent = '🌎 ' + m.online + ' online'; } }
    else if (m.type === 'created') { S = { v: 'waiting', id: m.id, song: m.song, title: m.title, artist: m.artist, d: m.d, quick: m.quick, since: Date.now() }; showWaiting(); }
    else if (m.type === 'matched') { closeLobby(); startMatch(m); }
    else if (m.type === 'expired') { toast('Nobody joined in 10 minutes. Try Quick Match!', 3500); showLobby(); }
    else if (m.type === 'taken') { if (S.v === 'lobby') toast('Someone just joined that one. Pick another!'); }
    else if (m.type === 'error') { toast(m.msg, 3200); if (S.v === 'waiting') showLobby(); }
  }
  function loadRecord() { var x = new XMLHttpRequest(); x.open('GET', BASE + '/api/online/record?name=' + encodeURIComponent(me.name)); x.onload = function () { try { rec = JSON.parse(x.responseText); var e = st.querySelector('#konRec'); if (e) e.innerHTML = recHtml(); } catch (e) {} }; x.send(); }
  function recHtml() { return rec ? '<span class="gr">' + rec.w + ' W</span> · <span class="pk">' + rec.l + ' L</span>' + (rec.d ? ' · <span class="dim">' + rec.d + ' D</span>' : '') : '<span class="dim">–</span>'; }

  // ---------- lobby screen ----------
  function showLobby() { S = { v: 'lobby' }; renderLobby(false); lsend({ type: 'list' }); }
  function renderLobby(keep) {
    var fid = keep && cur() ? cur().getAttribute('data-f') : null;
    var items = (lobby.items || []).filter(function (c) { return c.name !== me.name || true; });
    var rows = items.map(function (c) {
      return '<div class="row glass" data-f="join:' + c.id + '">' + art(c.song, 112) +
        '<div style="flex:1;min-width:0"><div class="t">' + esc(c.title) + '</div><div class="dim" style="font-size:22px;margin-top:4px">' + esc(c.artist) + ' · ' + fmt(c.d) + (c.quick ? ' · ⚡ Quick match' : '') + '</div></div>' +
        '<div style="display:flex;align-items:center;gap:18px;width:400px">' + av(c.av, 84) + '<div style="min-width:0"><div style="font-size:28px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px">' + esc(c.name) + '</div><div class="dim" style="font-size:20px">waiting ' + ago(c.at) + '</div></div></div>' +
        '<div style="width:330px;text-align:right"><div class="gd" style="font-size:23px;font-weight:700;margin-bottom:8px">● waiting for 1 opponent</div><div style="display:inline-flex;gap:10px;align-items:center">' + av(c.av, 44) + '<span class="slot"></span><span class="gold" style="font-size:26px;padding:10px 30px;margin-left:12px">Join</span></div></div></div>';
    }).join('');
    paint(LOGO + '<h1>OPEN CHALLENGES<small>Pick a song to sing against someone</small></h1>' +
      '<div style="position:absolute;right:60px;top:60px"><span class="pill">🌎 ' + (lobby.online || 1) + ' online</span></div>' +
      '<div style="position:absolute;left:60px;top:190px;width:1330px"><div class="lbl" style="margin:0 0 14px 10px">' + (items.length ? 'WAITING FOR A SINGER · NEWEST FIRST' : 'NOBODY IS WAITING RIGHT NOW') + '</div>' +
      '<div id="konList" style="height:690px;overflow:hidden;padding:6px">' + (rows || '<div class="glass" style="padding:60px;text-align:center;font-size:34px;line-height:1.5">No open challenges yet.<br><span class="dim" style="font-size:28px">Press <b>Join any game</b> and the next person to arrive plays you,<br>or make a challenge with your favorite song.</span></div>') + '</div></div>' +
      '<div style="position:absolute;left:1430px;top:190px;width:430px;display:flex;flex-direction:column;gap:22px">' +
      '<div class="glass" style="padding:30px;border-color:#ff3fa4"><div style="font-size:30px;font-weight:800">⚡ Quick Match</div><div style="font-size:21px;color:#fffc;margin:10px 0 22px;line-height:1.35">Jump into the next game. We pick a song for you both.</div><div class="gold' + (items.length ? '' : ' auto') + '" data-f="quick" style="font-size:32px;padding:18px">JOIN ANY GAME</div></div>' +
      '<div class="glass" style="padding:30px"><div style="font-size:30px;font-weight:800">⚔ Make a Challenge</div><div style="font-size:21px;color:#fffc;margin:10px 0 22px;line-height:1.35">Pick any song and wait for an opponent.</div><div class="cyanb" data-f="pick" style="font-size:28px;padding:16px">CHOOSE A SONG</div><div class="pill kon-spinbtn" data-f="spin" style="display:block;text-align:center;margin-top:16px;font-size:26px;padding:13px;border-color:#ffd75e;color:#ffd75e">🎰 SPIN RANDOM</div></div>' +
      '<div class="glass" style="padding:24px 30px;display:flex;align-items:center;gap:18px">' + av(me.av, 70) + '<div><div style="font-size:26px;font-weight:800">' + esc(me.name) + '</div><div style="font-size:30px;font-weight:800" id="konRec">' + recHtml() + '</div></div></div>' +
      (lobby.resting ? '<div class="glass" style="padding:20px 26px;font-size:22px;border-color:#ff6b86">😴 Online is resting for today. Play Here still works!</div>' : '') +
      '</div>' + foot([btn('#6aa0ff', '✕') + 'Join', btn('#ff3fa4', '○') + 'Back', '▲▼ choose', '◀▶ switch']) + DISC);
    if (fid) { var e = st.querySelector('[data-f="' + fid + '"]'); if (e) { focus(e); scrollRow(e); } }
  }
  function ago(t) { var s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm'; }

  // ---------- pick a song for a challenge: the normal song select ----------
  var banner;
  function startPick() {
    S = { v: 'picking' }; hide(); try { T().home(); } catch (e) {}
    if (!banner) { banner = document.createElement('div'); banner.style.cssText = 'position:fixed;left:50%;top:1.2vh;transform:translateX(-50%);z-index:9450;white-space:nowrap;padding:.9vh 2.6vh;border-radius:99px;background:rgba(18,7,44,.92);border:3px solid #3ff2ff;color:#fff;font:800 2.2vh Montserrat,system-ui,sans-serif;box-shadow:0 0 40px rgba(63,242,255,.6)'; document.body.appendChild(banner); }
    banner.innerHTML = '⚔ Pick a song for your challenge, then press <b style="color:#ffd75e">PLAY</b> · BACK = cancel'; banner.style.display = '';
  }
  function endPick() { if (banner) banner.style.display = 'none'; }

  // ---------- Spin random: a slot reel that lands on a random singable song (pitch notes), then posts the challenge ----------
  var spinList = [], SP_H = 150;
  function tile(x, cls) { return '<div class="kon-tile' + (cls || '') + '">' + art(x[0], 118) + '<div style="min-width:0;flex:1"><div class="t">' + esc(x[1]) + '</div><div class="dim" style="font-size:24px;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(x[2]) + '</div></div></div>'; }
  function showSpin() {
    if (!spinList.length) { lsend({ type: 'list' }); return toast('Loading songs… try again in a second.'); }
    S = { v: 'spin', spinning: false, landed: null, last: S.landed || null };
    var seed = []; for (var i = 0; i < 3; i++) seed.push(spinList[Math.floor(Math.random() * spinList.length)]);
    paint(LOGO + '<h1>SPIN RANDOM<small>Let the reel pick your challenge song</small></h1>' +
      '<div class="kon-reelwrap glass" data-f="spin-go" id="konReelWrap"><div class="kon-reel" id="konReel">' + seed.map(function (x) { return tile(x); }).join('') + '</div><div class="kon-reelmark"></div></div>' +
      '<div id="konSpinBtns" style="position:absolute;left:0;right:0;top:820px;display:flex;gap:28px;justify-content:center"><span class="gold auto" data-f="spin-go" style="font-size:34px;padding:16px 60px">🎰 SPIN</span><span class="pill" data-f="spin-back" style="font-size:28px;padding:14px 40px">◀ Back</span></div>' +
      foot([btn('#6aa0ff', '✕') + 'Spin', btn('#ff3fa4', '○') + 'Back', '◀▶ choose']) + DISC);
    var w = st.querySelector('#konReelWrap'); if (w) w.classList.remove('foc');
  }
  function spinGo() {
    if (S.v !== 'spin' || S.spinning) return; S.spinning = true; S.landed = null;
    var pool = spinList.length > 1 && S.last ? spinList.filter(function (x) { return x[0] !== S.last[0]; }) : spinList;
    var pick = pool[Math.floor(Math.random() * pool.length)], N = 34, strip = [];
    for (var i = 0; i < N; i++) strip.push(spinList[Math.floor(Math.random() * spinList.length)]);
    strip[N - 2] = pick;
    var reel = st.querySelector('#konReel'), btns = st.querySelector('#konSpinBtns'); if (!reel) return;
    btns.innerHTML = '<span class="dim" style="font-size:30px;font-weight:700">Spinning…</span>';
    reel.style.transition = 'none'; reel.style.transform = 'translate3d(0,0,0)';
    reel.innerHTML = strip.map(function (x, k) { return tile(x, k === N - 2 ? ' win' : ''); }).join('');
    void reel.offsetHeight;
    var y = -((N - 2) * SP_H - SP_H);
    reel.style.transition = 'transform 3.4s cubic-bezier(.12,.72,.18,1)'; reel.style.transform = 'translate3d(0,' + y + 'px,0)';
    setTimeout(function () {
      if (S.v !== 'spin') return; S.spinning = false; S.landed = pick; S.last = pick;
      var wt = reel.querySelector('.kon-tile.win'); if (wt) wt.classList.add('lit');
      btns.innerHTML = '<span class="gold auto" data-f="spin-use" style="font-size:32px;padding:16px 48px">⚔ Challenge with this song</span><span class="pill" data-f="spin-go" style="font-size:28px;padding:14px 36px;border-color:#ffd75e;color:#ffd75e">🎰 Spin again</span><span class="pill" data-f="spin-back" style="font-size:28px;padding:14px 36px">◀ Back</span>';
      focus(btns.querySelector('.auto'));
      try { T().pick(pick[0]); } catch (e) {}   // starts loading the song now
    }, 3500);
  }
  function spinUse() {
    if (S.v !== 'spin' || !S.landed) return;
    var id = S.landed[0]; busySend('Posting your challenge\u2026', { type: 'create', song: id });
  }

  // ---------- waiting for an opponent ----------
  function showWaiting() {
    endPick();
    paint(LOGO + '<h1>WAITING FOR AN OPPONENT<small>' + (S.quick ? 'Quick match · anyone can join' : 'Your challenge is on the list') + '</small></h1>' +
      '<div style="position:absolute;right:60px;top:60px"><span class="pill" id="konOnline">🌎 ' + (lobby.online || 1) + ' online</span></div>' +
      '<div class="glass" style="position:absolute;left:260px;right:260px;top:210px;height:680px">' +
      '<div style="position:absolute;left:60px;top:40px">' + art(S.song, 250) + '</div>' +
      '<div style="position:absolute;left:350px;top:56px;right:40px"><div style="font-size:54px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(S.title) + '</div><div style="font-size:30px;color:#fffc;margin-top:6px">' + esc(S.artist) + ' · ' + fmt(S.d) + ' · Live pitch</div><div class="gd" style="font-size:26px;margin-top:24px">1 vs 1 · highest score wins</div></div>' +
      '<div style="position:absolute;left:0;right:0;top:330px;display:flex;justify-content:center;align-items:center;gap:60px">' +
      '<div style="text-align:center">' + av(me.av, 150, 'border-color:#ff3fa4;box-shadow:0 0 40px #ff3fa488') + '<div style="font-size:30px;font-weight:700;margin-top:10px">' + esc(me.name) + '</div><div class="gr" style="font-size:20px">🎤 mic ready</div></div>' +
      '<div style="font-size:60px;font-weight:800;color:#ffd75e">VS</div>' +
      '<div style="text-align:center"><div class="pulse" style="width:150px;height:150px;border-radius:50%;border:5px dashed #ffffff80;display:flex;align-items:center;justify-content:center;font-size:70px;color:#fff8;margin:0 auto">?</div><div class="dim" style="font-size:30px;font-weight:700;margin-top:10px">needs 1 more</div><div style="font-size:20px;color:#fff9" id="konWait">searching… 0:00</div></div></div>' +
      '<div style="position:absolute;left:0;right:0;bottom:24px;text-align:center;font-size:24px;color:#fffc">The game starts by itself as soon as someone joins.</div></div>' +
      '<div style="position:absolute;left:260px;right:260px;top:920px;display:flex;gap:24px;justify-content:center">' +
      (S.quick ? '' : '<span class="pill" data-f="pick">🎵 Change song</span>') + '<span class="pill auto" data-f="cancel" style="border-color:#ff6b86;color:#ff6b86">✖ Cancel</span></div>' +
      foot([btn('#ff3fa4', '○') + 'Cancel', 'Closes after 10 min with no one']) + DISC);
    var since = S.since, iv = setInterval(function () { var e = st.querySelector('#konWait'); if (S.v !== 'waiting' || !e) return clearInterval(iv); e.textContent = 'searching… ' + fmt((Date.now() - since) / 1000); }, 1000);
  }

  // ---------- match ----------
  var M = null;
  function startMatch(info) {
    M = { id: info.match, song: info.song, title: info.title, artist: info.artist, d: info.d, role: info.role, opp: info.opp, offset: 0, rtt: 9e9, state: 'loading', oppReady: false, myLive: 0, oppLive: 0, retries: 0, oppName: info.opp.name, oppAv: info.opp.av };
    if (info.you) me.av = info.you.av;
    S = { v: 'match' }; endPick();
    try { T().pick(M.song); } catch (e) {}
    showVs(); connectMatch();
  }
  function connectMatch() {
    var ws = mws = new WebSocket(wsUrl('/ws/match/' + M.id + '?cid=' + cid));
    ws.onopen = function () { M.retries = 0; for (var i = 0; i < 6; i++) setTimeout(function () { msend({ type: 'ping', id: Date.now() }); }, i * 120); if (M.state === 'loading') waitLoaded(); };
    ws.onmessage = function (ev) { var m; try { m = JSON.parse(ev.data); } catch (e) { return; } onMatch(m); };
    ws.onclose = function (e) {
      if (mws !== ws || !M) return; mws = null;
      if (M.state === 'done' || M.state === 'cancelled' || M.state === 'left') return;
      if (M.retries++ < 15) { note('📶 Reconnecting…'); setTimeout(function () { if (M && !mws) connectMatch(); }, 1000); }
      else { note(''); M.state = 'cancelled'; message('📶 Lost the connection', 'Back to the lobby…'); setTimeout(backToLobby, 3000); }
    };
  }
  function msend(o) { if (mws && mws.readyState === 1) mws.send(JSON.stringify(o)); }
  function waitLoaded() {
    var t0 = Date.now(), iv = setInterval(function () {
      if (!M || M.state !== 'loading') return clearInterval(iv);
      var ok = false; try { ok = T().song() === M.song && T().ready(); } catch (e) {}
      if (ok) { clearInterval(iv); M.state = 'ready'; msend({ type: 'ready' }); vsStatus(); }
      else if (Date.now() - t0 > 22000) { clearInterval(iv); }
    }, 200);
  }
  function onMatch(m) {
    if (!M) return;
    if (m.type === 'pong') { var now = Date.now(), rtt = now - m.id; if (rtt < M.rtt) { M.rtt = rtt; M.offset = m.server - (m.id + rtt / 2); } return; }
    if (m.type === 'match') { if (m.oppLive) M.oppLive = m.oppLive.score; var o = (m.players || []).filter(function (p) { return p.cid !== cid; })[0], mm = (m.players || []).filter(function (p) { return p.cid === cid; })[0]; if (o && o.av !== M.oppAv) { M.oppAv = o.av; } if (mm) me.av = mm.av; return; }
    if (m.type === 'opp-ready') { M.oppReady = true; return vsStatus(); }
    if (m.type === 'start') { M.state = 'countdown'; M.oppReady = true; vsStatus(); scheduleStart(m.t0); return; }
    if (m.type === 'opp') { M.oppLive = m.score; return drawHud(); }
    if (m.type === 'opp-gone') { note('📶 ' + M.oppName + '\u2019s connection dropped… waiting 15 s'); return; }
    if (m.type === 'opp-back') { note(''); return; }
    if (m.type === 'opp-forfeit') { M.oppForfeit = true; note(M.oppName + ' left. Finish the song to win!'); return; }
    if (m.type === 'opp-final') { M.oppFinal = m.score; if (M.state === 'final') finalWait(); return; }
    if (m.type === 'results') { M.state = 'done'; hudOff(); return showResults(m); }
    if (m.type === 'opp-rematch') { M.oppRematch = true; var e = st.querySelector('#konRm'); if (e) e.textContent = M.oppName + ' wants a rematch!'; return; }
    if (m.type === 'opp-left') { M.oppLeft = true; var r = st.querySelector('#konRm'); if (r) r.textContent = M.oppName + ' left.'; var b = st.querySelector('[data-f="rematch"]'); if (b) b.style.opacity = .4; return; }
    if (m.type === 'rematch-go') { M.state = 'loading'; M.oppReady = false; M.oppFinal = null; M.oppForfeit = false; M.myLive = 0; M.oppLive = 0; M.rematch = false; M.oppRematch = false; try { T().pick(M.song); } catch (e) {} showVs(); waitLoaded(); return; }
    if (m.type === 'cancel') {
      var why = m.reason === 'load' ? 'The song didn\u2019t load in time.' : m.reason === 'left' ? M.oppName + ' left before the start.' : 'This game ended.';
      var reopen = M.role === 'host' && m.reason === 'left' && M.state !== 'playing', song = M.song;
      stopPlay(); M.state = 'cancelled'; closeMatch(); message('😕 ' + why, reopen ? 'Your challenge is back on the list…' : 'Back to the lobby…');
      setTimeout(function () { M = null; connectLobby(); if (reopen) { S = { v: 'waiting', song: song, since: Date.now() }; var go = function () { if (lws && lws.readyState === 1) lsend({ type: 'create', song: song }); else setTimeout(go, 300); }; go(); } else showLobby(); }, 2600);
      return;
    }
    if (m.type === 'error') { toast(m.msg, 3000); }
  }
  function vsStatus() {
    var a = st.querySelector('#konMeSt'), b = st.querySelector('#konOppSt'); if (!a || !b) return;
    var mine = M.state === 'loading' ? 'loading song…' : 'ready'; a.innerHTML = '● ' + mine; a.className = M.state === 'loading' ? 'dim' : 'gr';
    b.innerHTML = '● ' + (M.oppReady ? 'ready' : 'loading song…'); b.className = M.oppReady ? 'gr' : 'dim';
  }
  function showVs() {
    paint('<div style="position:absolute;left:0;right:0;top:50px;text-align:center"><img src="' + BASE + '/web/m/logo.webp" style="height:90px"></div>' +
      '<div style="position:absolute;left:100px;top:200px;width:620px;text-align:center">' + av(me.av, 400, 'border-color:#ff3fa4;box-shadow:0 0 90px #ff3fa4aa;border-width:8px') + '<div style="font-size:60px;font-weight:800;margin-top:26px">' + esc(me.name) + '</div><div style="font-size:26px;font-weight:700;margin-top:6px" id="konMeSt" class="dim">● loading song…</div></div>' +
      '<div style="position:absolute;right:100px;top:200px;width:620px;text-align:center">' + av(M.oppAv, 400, 'border-color:#3ff2ff;box-shadow:0 0 90px #3ff2ffaa;border-width:8px') + '<div style="font-size:60px;font-weight:800;margin-top:26px">' + esc(M.oppName) + '</div><div style="font-size:26px;font-weight:700;margin-top:6px" id="konOppSt" class="dim">● loading song…</div></div>' +
      '<div style="position:absolute;left:760px;width:400px;top:240px;text-align:center"><div class="vsword">VS</div><div class="big" id="konCd" style="margin-top:10px">&nbsp;</div></div>' +
      '<div style="position:absolute;left:0;right:0;top:820px;text-align:center"><div class="glass" style="display:inline-flex;align-items:center;gap:30px;padding:18px 36px">' + art(M.song, 90) + '<div style="text-align:left"><div style="font-size:38px;font-weight:800">' + esc(M.title) + '</div><div style="font-size:22px;color:#fffc">' + esc(M.artist) + ' · starts together on both screens</div></div></div></div>' +
      '<div style="position:absolute;left:0;right:0;top:985px;text-align:center;font-size:24px;color:#ffffffb0">Grab your phone and get ready to sing 🎤</div>' + DISC);
    vsStatus();
  }
  function scheduleStart(t0) {
    var at = t0 - M.offset;   // server time -> this screen's clock
    (function tick() {
      if (!M || M.state !== 'countdown') return;
      var left = at - Date.now(), e = st.querySelector('#konCd');
      if (left <= 0) return go();
      if (e) e.textContent = left > 3000 ? '' : String(Math.ceil(left / 1000));
      setTimeout(tick, Math.min(50, left));
    })();
    function go() {
      M.state = 'playing'; window.KBA_ON.active = true; hide();
      try { T().start(); } catch (e) {}
      hudOn(); M.iv = setInterval(sendLive, 500);
    }
  }
  function sendLive() {
    if (!M || M.state !== 'playing') return clearInterval(M && M.iv);
    var l = null; try { l = T().live(); } catch (e) {}
    if (!l) return; M.myLive = l.score; msend({ type: 'score', score: l.score, combo: l.combo, t: l.t }); drawHud(); toPhones();
  }
  function toPhones() { try { if (window.KBA_TVWS && KBA_TVWS.readyState === 1) KBA_TVWS.send(JSON.stringify({ type: 'online', match: M ? M.id : '', on: !!(M && (M.state === 'playing' || M.state === 'final')), me: { name: me.name, av: me.av, score: M ? M.myLive : 0 }, opp: { name: M ? M.oppName : '', av: M ? M.oppAv : 0, score: M ? M.oppLive : 0 } })); } catch (e) {} }

  // ---------- in-song HUD ----------
  function hudOn() {
    hud.style.display = ''; fit();
    hudSt.innerHTML = '<div class="note" id="konNote"></div>' +
      '<div class="hb" style="left:30px;border-color:#ff3fa4;box-shadow:0 0 40px #ff3fa455">' + av(me.av, 84, 'border-color:#ff3fa4') + '<div style="flex:1;min-width:0"><div style="display:flex;justify-content:space-between;align-items:center"><div class="n">' + esc(me.name) + ' <span class="dim" style="font-size:18px">(you)</span></div><div class="s pk" id="konMyS">0</div></div><div class="bar"><i id="konMyB" style="width:0;background:linear-gradient(90deg,#8b5cff,#ff3fa4);box-shadow:0 0 20px #ff3fa4"></i></div></div></div>' +
      '<div class="vs">VS</div>' +
      '<div class="hb" style="left:1030px;border-color:#3ff2ff;box-shadow:0 0 40px #3ff2ff44"><div style="flex:1;min-width:0"><div style="display:flex;justify-content:space-between;align-items:center"><div class="s cy" id="konOpS">0</div><div class="n">' + esc(M.oppName) + '</div></div><div class="bar" style="transform:scaleX(-1)"><i id="konOpB" style="width:0;background:linear-gradient(90deg,#8b5cff,#3ff2ff);box-shadow:0 0 20px #3ff2ff"></i></div></div>' + av(M.oppAv, 84, 'border-color:#3ff2ff') + '</div>';
    drawHud();
  }
  function hudOff() { hud.style.display = 'none'; window.KBA_ON.active = false; if (M) clearInterval(M.iv); toPhones(); }
  function drawHud() {
    if (!M || hud.style.display === 'none') return;
    var a = hudSt.querySelector('#konMyS'), b = hudSt.querySelector('#konOpS'); if (!a) return;
    a.textContent = M.myLive; b.textContent = M.oppFinal != null ? M.oppFinal : M.oppLive;
    hudSt.querySelector('#konMyB').style.width = M.myLive + '%'; hudSt.querySelector('#konOpB').style.width = (M.oppFinal != null ? M.oppFinal : M.oppLive) + '%';
  }
  function note(t) { var e = hudSt && hudSt.querySelector('#konNote'); if (e) e.innerHTML = t ? '<span>' + esc(t) + '</span>' : ''; if (S.v === 'match' && M && M.state !== 'playing' && t) toast(t, 2500); }

  // ---------- song finished (app.js hook) ----------
  function finished(r) {
    if (!M || M.state !== 'playing') return;
    M.state = 'final'; M.myFinal = r; clearInterval(M.iv); M.myLive = r.score;
    msend({ type: 'final', score: r.score, combo: r.combo, acc: r.acc }); hudOff(); finalWait();
  }
  function finalWait() {
    paint(LOGO + '<h1>NICE SINGING!<small>' + esc(M.title) + '</small></h1><div class="msg" style="top:360px"><div style="font-size:150px;font-weight:900;color:#ff3fa4">' + (M.myFinal ? M.myFinal.score : '') + '</div>' +
      '<div style="font-size:40px;margin-top:20px">' + (M.oppFinal != null ? M.oppName + ' scored ' + M.oppFinal + '…' : 'Waiting for ' + esc(M.oppName) + ' to finish…') + '</div></div>' + DISC);
  }
  function stopPlay() { if (window.KBA_ON.active) { window.KBA_ON.active = false; try { T().home(); } catch (e) {} } hudOff(); }
  function message(a, b) { paint(LOGO + '<div class="msg"><div>' + esc(a) + '</div><div class="dim" style="font-size:30px;margin-top:20px">' + esc(b || '') + '</div></div>' + DISC); }

  // ---------- results ----------
  function grade(v) { return v >= 90 ? 'S' : v >= 75 ? 'A' : v >= 60 ? 'B' : v >= 40 ? 'C' : 'D'; }
  function stars(v) { var n = v >= 90 ? 5 : v >= 75 ? 4 : v >= 60 ? 3 : v >= 40 ? 2 : 1; return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n); }
  function showResults(r) {
    M.result = r;
    var mine = r.players.filter(function (p) { return p.cid === cid; })[0] || r.players[0], opp = r.players.filter(function (p) { return p.cid !== cid; })[0] || r.players[1];
    var won = r.winner === cid, draw = !r.winner, W = draw ? mine : r.players.filter(function (p) { return p.cid === r.winner; })[0], L = draw ? opp : r.players.filter(function (p) { return p.cid !== r.winner; })[0];
    var rc = r.record || {}, hA = rc.h2h || { a: 0, b: 0, d: 0 }, meIsA = r.players[0].cid === cid;
    var myRec = meIsA ? rc.a : rc.b, opRec = meIsA ? rc.b : rc.a, myH = meIsA ? hA.a : hA.b, opH = meIsA ? hA.b : hA.a;
    function card(p, big, crown) {
      var sc = p.forfeit ? '–' : p.score == null ? '–' : p.score, col = crown ? '#ffd75e' : '#ffffffcc';
      return '<div class="glass" style="position:absolute;' + (big ? 'left:150px;top:230px;width:760px;height:700px' : 'left:960px;top:290px;width:600px;height:640px') + ';text-align:center">' +
        (crown ? '<div style="position:absolute;left:0;right:0;top:-34px"><span class="gold" style="display:inline-block;font-size:34px;padding:12px 40px;box-shadow:0 0 0 5px #fff,0 0 50px #ffb52e">👑 WINNER</span></div>' : '') +
        '<div style="margin-top:' + (big ? 80 : 50) + 'px">' + av(p.av, big ? 250 : 190, crown ? 'border-color:#ffd75e;border-width:8px;box-shadow:0 0 80px #ffd75eaa' : 'border-color:#ffffff55') + '</div>' +
        '<div style="font-size:' + (big ? 54 : 42) + 'px;font-weight:800;margin-top:16px">' + esc(p.name) + (p.cid === cid ? ' <span class="dim" style="font-size:24px">(you)</span>' : '') + '</div>' +
        '<div style="font-size:' + (big ? 150 : 110) + 'px;font-weight:900;line-height:1.05;color:' + col + ';text-shadow:0 0 40px ' + (crown ? '#ffd75e88' : 'transparent') + '">' + sc + '</div>' +
        (p.forfeit ? '<div class="pk" style="font-size:30px;font-weight:800">left the game</div>' : p.score != null ? '<div style="font-size:' + (big ? 34 : 30) + 'px;font-weight:800;color:' + col + '">' + stars(p.score) + ' · Grade ' + grade(p.score) + '</div>' : '') +
        (p.acc != null && !p.forfeit ? '<div class="dim" style="font-size:22px;margin-top:12px">Pitch ' + p.acc + '% · best streak ×' + (p.combo || 0) + '</div>' : '') + '</div>';
    }
    var title = draw ? 'IT\u2019S A DRAW!' : won ? 'YOU WIN!' : 'WINNER!';
    var sub = esc(r.title || M.title) + (r.forfeit ? ' · won by forfeit' : '');
    var myRank = myRec && myRec.rank, side = '<div class="glass" style="position:absolute;left:1600px;top:290px;width:290px;height:640px;padding:26px 22px"><div class="lbl" style="font-size:16px;text-align:center">HEAD TO HEAD</div>' +
      '<div style="font-size:26px;font-weight:800;margin-top:26px" class="cy">You ' + (myH || 0) + ' – ' + (opH || 0) + ' ' + esc(opp.name) + '</div><div class="dim" style="font-size:18px;margin-top:8px">All time vs each other' + (hA.d ? ' · ' + hA.d + ' draw' + (hA.d > 1 ? 's' : '') : '') + '</div>' +
      '<div style="margin-top:30px;font-size:20px;line-height:1.8"><b>Online record</b><br>' + (myRec ? '<span class="gr">' + myRec.w + ' W</span> · <span class="pk">' + myRec.l + ' L</span>' : '–') + '</div>' +
      (myRank ? '<div style="margin-top:20px;font-size:20px;line-height:1.6"><b>Song rank</b><br>#' + myRank + ' world</div>' : '') +
      '<div class="pill" data-f="report" style="margin-top:30px;font-size:17px;padding:6px 16px;border-color:#ff6b8688;color:#ff9fb0">⚑ Report</div></div>';
    paint(LOGO + '<h1>' + title + '<small>' + sub + '</small></h1>' + card(W, true, !draw) + card(L, false, false) + side +
      '<div style="position:absolute;left:150px;right:150px;top:955px;display:flex;gap:26px;justify-content:center;align-items:center">' + (r.forfeit ? '' : '<span class="gold auto" data-f="rematch" style="font-size:30px;padding:12px 44px">🔁 REMATCH</span>') + '<span class="pill' + (r.forfeit ? ' auto' : '') + '" data-f="lobby" style="font-size:28px;padding:12px 36px">⚔ New game</span><span class="pill" data-f="home" style="font-size:28px;padding:12px 36px">🏠 Home</span><span id="konRm" class="gd" style="font-size:24px;font-weight:700;min-width:300px"></span></div>' + DISC);
    try { if (window.KBA_LB) KBA_LB.refresh(); } catch (e) {}
    loadRecord();
  }
  function closeMatch() { if (mws) { var w = mws; mws = null; try { w.close(); } catch (e) {} } }
  function backToLobby() { stopPlay(); closeMatch(); M = null; connectLobby(); showLobby(); }
  function goHomeAll() { stopPlay(); closeMatch(); closeLobby(); M = null; S = { v: 'off' }; hide(); endPick(); try { T().home(); } catch (e) {} if (window.KBA_START_SHOW) KBA_START_SHOW(); }

  // ---------- actions ----------
  function act(a) {
    if (a === 'back') { busyOff(); return goHomeAll(); }
    if (a === 'quick') { if (lobby.resting) return toast('Online is resting for today.'); return busySend('Finding a game\u2026', { type: 'quick' }); }
    if (a === 'pick') { if (S.v === 'waiting') lsend({ type: 'cancel' }); return startPick(); }
    if (a === 'spin') { if (lobby.resting) return toast('Online is resting for today.'); return showSpin(); }
    if (a === 'spin-go') return spinGo();
    if (a === 'spin-use') return spinUse();
    if (a === 'spin-back') { if (S.spinning) return; return showLobby(); }
    if (a === 'cancel') { lsend({ type: 'cancel' }); return showLobby(); }
    if (a.indexOf('join:') === 0) return busySend('Joining\u2026', { type: 'join', id: a.slice(5) });
    if (a === 'rematch') { if (M && M.oppLeft) return toast(M.oppName + ' already left.'); if (M) { msend({ type: 'rematch' }); var e = st.querySelector('#konRm'); if (e) e.textContent = M.oppRematch ? 'Starting…' : 'Waiting for ' + M.oppName + '…'; } return; }
    if (a === 'lobby') { msend({ type: 'leave' }); return backToLobby(); }
    if (a === 'home') { msend({ type: 'leave' }); return goHomeAll(); }
    if (a === 'report') {
      if (!M) return; var x = new XMLHttpRequest(); x.open('POST', BASE + '/api/online/report'); x.setRequestHeader('Content-Type', 'application/json');
      x.send(JSON.stringify({ reporter: me.name, target: M.oppName, match: M.id, reason: 'results-screen' })); toast('Thanks. We\u2019ll take a look.'); var r = st.querySelector('[data-f="report"]'); if (r) r.remove(); return;
    }
    if (a === 'leave-yes') { msend({ type: 'leave' }); return backToLobby(); }
    if (a === 'leave-no') { root.classList.add('hide'); S.confirm = false; return; }
  }
  function back() {
    if (S.v === 'needphone' || S.v === 'lobby') return goHomeAll();
    if (S.v === 'waiting') { lsend({ type: 'cancel' }); return showLobby(); }
    if (S.v === 'spin') { if (S.spinning) return; return showLobby(); }
    if (S.v === 'picking') { endPick(); return showLobby(); }
    if (S.v === 'match' && M) {
      if (M.state === 'playing') { S.confirm = true; paint('<div style="position:absolute;left:560px;top:340px;width:800px;padding:50px;text-align:center" class="glass"><div style="font-size:44px;font-weight:800">Leave this game?</div><div class="dim" style="font-size:26px;margin:16px 0 36px">' + esc(M.oppName) + ' wins if you leave.</div><div style="display:flex;gap:30px;justify-content:center"><span class="gold auto" data-f="leave-no" style="font-size:30px;padding:14px 40px">Keep singing</span><span class="pill" data-f="leave-yes" style="font-size:30px;padding:14px 40px;border-color:#ff6b86;color:#ff6b86">Leave</span></div></div>'); st.querySelector('.kon-bg').style.background = 'rgba(0,0,0,.5)'; return; }
      if (M.state === 'done') return act('lobby');
      if (M.state === 'loading' || M.state === 'ready' || M.state === 'countdown') { msend({ type: 'leave' }); return backToLobby(); }
    }
  }
  var BACK = { 27: 1, 8: 1, 10009: 1, 461: 1 };
  addEventListener('keydown', function (e) {
    if (!enabled || S.v === 'off') return;
    var k = e.keyCode;
    if (S.v === 'picking') { if (BACK[k] && !(document.activeElement && document.activeElement.id === 'searchInput')) { e.preventDefault(); e.stopImmediatePropagation(); back(); } return; }
    if (M && M.state === 'playing' && !S.confirm) { e.preventDefault(); e.stopImmediatePropagation(); if (BACK[k] || k === 13) back(); return; }   // no pause in online games
    e.preventDefault(); e.stopImmediatePropagation();
    if (BACK[k]) { if (S.confirm) return act('leave-no'); return back(); }
    if (k === 37) move(-1, 0); else if (k === 39) move(1, 0); else if (k === 38) move(0, -1); else if (k === 40) move(0, 1);
    else if (k === 13 || k === 32) { var c = cur(); if (c) act(c.getAttribute('data-f')); }
  }, true);

  // ---------- hooks for app.js / tv-web.js ----------
  window.KBA_ON = {
    active: false,
    open: open,
    enabled: function () { return enabled; },
    slot: function (all) { return me.slot && all.indexOf(me.slot) >= 0 ? me.slot : all[0] || 1; },
    pickStart: function (id) { if (S.v !== 'picking') return false; endPick(); S = { v: 'lobby' }; connectLobby(); var go = function () { if (lws && lws.readyState === 1) lsend({ type: 'create', song: id }); else setTimeout(go, 200); }; go(); paint(LOGO + '<div class="msg">Posting your challenge…</div>'); return true; },
    finished: finished,
    state: function () { return { v: S.v, match: M && { id: M.id, state: M.state, my: M.myLive, opp: M.oppLive, oppFinal: M.oppFinal, offset: M.offset, rtt: M.rtt, result: M.result && { winner: M.result.winner, draw: M.result.draw, forfeit: M.result.forfeit, players: M.result.players.map(function (p) { return { name: p.name, score: p.score, forfeit: p.forfeit }; }) } }, lobby: lobby, me: me, cid: cid }; },
    act: act
  };
  function init() {
    mount();
    var x = new XMLHttpRequest(); x.open('GET', BASE + '/api/flags');
    x.onload = function () { try { enabled = !!JSON.parse(x.responseText).online; } catch (e) {} if (enabled) document.documentElement.classList.add('kba-online'); if (window.KBA_ONLINE_READY) KBA_ONLINE_READY(enabled); };
    x.send();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
