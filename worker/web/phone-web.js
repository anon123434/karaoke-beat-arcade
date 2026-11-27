/* hosted /kba phone: name gate, then mic; after a song, a shareable results card. */
(function () {
  'use strict';
  var BASE = '/kba';
  var FUN = ['Disco Llama', 'Captain Banana', 'Rockin Robin', 'Pop Star Pug', 'Mic Drop', 'Funky Monkey', 'Sparkle Shark', 'Groovy Grandma', 'DJ Pancake', 'Lil Taco', 'Banjo Bear', 'Jazz Hands', 'Super Nova', 'Bubble Pop', 'Elvis Penguin', 'Karaoke Kitty'];
  var saved = ''; try { saved = localStorage.getItem('karaoke.name') || ''; } catch (e) {}
  var mySlot = 0, myName = saved, lastCard = null, lastHs = null, ov = null;

  var NativeWS = window.WebSocket;
  function WS(u, p) {
    var ws = p ? new NativeWS(u, p) : new NativeWS(u);
    ws.addEventListener('message', function (ev) {
      if (typeof ev.data !== 'string') return;
      if (ev.data.indexOf('"type":"hello"') > 0 || ev.data.indexOf('"type":"state"') > 0 || ev.data.indexOf('"web-hs"') > 0 || ev.data.indexOf('"type":"online"') > 0) {
        try {
          var m = JSON.parse(ev.data);
          if (m.type === 'hello' && m.slot) mySlot = m.slot;
          else if (m.type === 'state') onState(m);
          else if (m.type === 'web-hs') onHs(m);
          else if (m.type === 'online') onOnline(m);
        } catch (e) {}
      }
    });
    return ws;
  }
  WS.prototype = NativeWS.prototype; WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3; window.WebSocket = WS;

  // online 1v1: you vs opponent strip at the top of the phone while the song plays
  var vs = null;
  function onOnline(m) {
    if (!m.on) { if (vs && vs.style.display !== 'none') { vs.style.display = 'none'; document.body.style.paddingTop = ''; } return; }
    if (!vs) { vs = document.createElement('div'); vs.id = 'kbaVs'; vs.style.cssText = 'position:fixed;left:10px;right:10px;top:8px;z-index:50;display:flex;flex-direction:column;gap:6px;font:700 14px system-ui,sans-serif;color:#fff;pointer-events:none'; document.body.appendChild(vs); }
    function row(p, c, you) { var s = Math.max(0, Math.min(100, +p.score || 0)); return '<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:14px;background:rgba(18,7,44,.88);border:1px solid ' + c + '"><img src="' + BASE + '/tv/img/av' + ((p.av | 0) % 8) + '.webp" style="width:30px;height:30px;border-radius:50%;border:2px solid ' + c + '"><div style="flex:1;min-width:0"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (you ? 'You' : esc(p.name)) + '</div><div style="height:7px;border-radius:4px;background:#ffffff22;margin-top:3px"><div style="height:100%;width:' + s + '%;border-radius:4px;background:' + c + '"></div></div></div><b style="font-size:20px;color:' + c + '">' + s + '</b></div>'; }
    vs.innerHTML = row(m.me || {}, '#ff3fa4', true) + row(m.opp || {}, '#3ff2ff', false); vs.style.display = 'flex'; document.body.style.paddingTop = '112px';
  }
  function onState(m) {
    if (m.state === 'results') {
      var card = pickCard(m.cards);
      if (card) showCard(card, lastHs && lastHs.song === card.song ? lastHs : null);
    } else if (m.state === 'playing' || m.state === 'home' || m.state === 'tv-offline') {
      hideCard(); lastHs = null; lastCard = null;
    }
  }
  function pickCard(cards) {
    if (!cards || !cards.length) return null;
    var n = (myName || localStorage.getItem('karaoke.name') || '').toLowerCase();
    var hit = cards.filter(function (c) { return mySlot && c.slot === mySlot; })[0]
      || cards.filter(function (c) { return n && String(c.name || '').toLowerCase() === n; })[0];
    return hit || null;   // real scores only: don't show someone else's card
  }
  function onHs(m) {
    if (!m.ok || !m.results) return;
    lastHs = m;
    if (lastCard && lastCard.song === m.song) {
      var me = m.results.filter(function (x) { return String(x.name).toLowerCase() === String(lastCard.name).toLowerCase(); })[0];
      if (me) { lastCard._hs = me; renderCard(lastCard); }
    }
    var t = document.getElementById('turn');
    if (t && lastCard && lastCard._hs) {
      var r = lastCard._hs;
      t.textContent = r.songRecord ? '🏆 NEW HIGH SCORE! ' + r.score : r.personalBest ? '⭐ Personal best! ' + r.score : '';
    }
  }

  function showCard(card, hs) {
    lastCard = card;
    if (hs && hs.results) {
      var me = hs.results.filter(function (x) { return String(x.name).toLowerCase() === String(card.name).toLowerCase(); })[0];
      if (me) card._hs = me;
    }
    document.body.classList.add('pr-on');
    if (!ov) {
      ov = document.createElement('div'); ov.className = 'pr'; ov.setAttribute('role', 'dialog');
      ov.innerHTML = '<div class="pr-stage" id="prStage"></div><button type="button" class="pr-save" id="prSave">📷 Save image</button><div class="pr-msg" id="prMsg"></div>';
      document.body.appendChild(ov);
      ov.querySelector('#prSave').onclick = saveImage;
    }
    ov.style.display = 'flex';
    renderCard(card);
  }
  function hideCard() {
    document.body.classList.remove('pr-on');
    if (ov) ov.style.display = 'none';
  }
  function pct(v) { return v == null ? '—' : v + '%'; }
  function place(c) {
    if (c.won) return '<div class="pr-place win">👑 1st PLACE</div>';
    if (c.rank && (c.rank > 1 || (c.rank === 1 && !c.won))) return '<div class="pr-place">#' + c.rank + '</div>';
    return '';
  }
  function badge(c) {
    if (!c._hs) return '';
    if (c._hs.songRecord) return '<div class="pr-badge rec">🏆 NEW HIGH SCORE</div>';
    if (c._hs.personalBest) return '<div class="pr-badge pb">⭐ Personal best</div>';
    return '';
  }
  function avUrl(c) { return c.av ? (c.av.indexOf('/') === 0 ? c.av : BASE + '/tv/' + c.av) : BASE + '/tv/img/av0.webp'; }
  function renderCard(c) {
    lastCard = c;
    var stars = '';
    for (var i = 1; i <= 5; i++) stars += '<i class="' + (i <= c.stars ? 'on' : '') + '">★</i>';
    var art = c.art || (BASE + '/songs/' + c.song + '/art.webp');
    ov.querySelector('#prStage').innerHTML =
      '<img class="pr-logo" src="' + BASE + '/web/m/logo.webp" alt="COOLEST! Karaoke Beat Arcade">' +
      '<div class="pr-player"><img class="pr-av" src="' + avUrl(c) + '" alt=""><div class="pr-name">' + esc(c.name) + '</div></div>' +
      '<div class="pr-song"><img class="pr-art" src="' + art + '" alt=""><div><b>' + esc(c.title || '') + '</b><span>' + esc(c.artist || '') + '</span></div></div>' +
      '<div class="pr-score">' + c.score + '</div>' +
      '<div class="pr-grade-row"><div class="pr-stars">' + stars + '</div><div class="pr-grade g' + c.grade + '">' + c.grade + '</div></div>' +
      place(c) +
      '<div class="pr-stats"><div><small>Pitch</small><b>' + pct(c.pitch) + '</b></div><div><small>Rhythm</small><b>' + pct(c.rhythm) + '</b></div><div><small>Max combo</small><b>' + (c.combo != null ? c.combo + 'x' : '—') + '</b></div></div>' +
      badge(c) +
      '<div class="pr-url">' + location.host + '/kba</div>';
    ov.querySelector('#prMsg').textContent = '';
  }
  function esc(s) { return String(s || '').replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }

  function loadImg(src) {
    return new Promise(function (res) {
      if (!src) return res(null);
      var im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = function () { res(im); }; im.onerror = function () { res(null); }; im.src = src;
    });
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function goldFill(ctx) {
    var g = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height * 0.2);
    g.addColorStop(0, '#fffbe6'); g.addColorStop(0.4, '#ffe27a'); g.addColorStop(0.75, '#ffb52e'); g.addColorStop(1, '#ff8a1c');
    return g;
  }
  async function drawCard(c) {
    var W = 1080, H = 1920, ctx, cv = document.createElement('canvas'); cv.width = W; cv.height = H; ctx = cv.getContext('2d');
    var bg = await loadImg(BASE + '/web/m/bg.webp'), logo = await loadImg(BASE + '/web/m/logo.webp'), av = await loadImg(avUrl(c)), art = await loadImg(c.art || (BASE + '/songs/' + c.song + '/art.webp'));
    if (bg) ctx.drawImage(bg, 0, 0, W, H);
    else { var g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#3a0f7a'); g.addColorStop(0.55, '#12052e'); g.addColorStop(1, '#07021a'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); }
    ctx.fillStyle = 'rgba(10,3,32,0.28)'; ctx.fillRect(0, 0, W, H);
    var y = 70;
    if (logo) { var lw = 820, lh = logo.height * (lw / logo.width); ctx.drawImage(logo, (W - lw) / 2, y, lw, lh); y += lh + 36; }
    // avatar + name
    var ax = W / 2, ar = 110;
    if (av) { ctx.save(); ctx.beginPath(); ctx.arc(ax, y + ar, ar, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(av, ax - ar, y, ar * 2, ar * 2); ctx.restore(); }
    ctx.strokeStyle = '#ffd75e'; ctx.lineWidth = 8; ctx.beginPath(); ctx.arc(ax, y + ar, ar + 4, 0, Math.PI * 2); ctx.stroke();
    y += ar * 2 + 36;
    ctx.font = '800 64px system-ui, sans-serif'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(String(c.name || ''), W / 2, y);
    y += 50;
    // song
    var aw = 160, ah = 160, sx = 160;
    if (art) { ctx.save(); roundRect(ctx, sx, y, aw, ah, 28); ctx.clip(); ctx.drawImage(art, sx, y, aw, ah); ctx.restore(); }
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.font = '800 48px system-ui, sans-serif';
    ctx.fillText(String(c.title || '').slice(0, 28), sx + aw + 28, y + 70, 700);
    ctx.fillStyle = '#c9b8ff'; ctx.font = '600 34px system-ui, sans-serif';
    ctx.fillText(String(c.artist || '').slice(0, 32), sx + aw + 28, y + 120, 700);
    y += ah + 70;
    // score
    ctx.textAlign = 'center'; ctx.font = '900 280px system-ui, sans-serif'; ctx.fillStyle = goldFill(ctx);
    ctx.fillText(String(c.score), W / 2, y + 220);
    y += 280;
    // stars + grade
    var stars = c.stars || 1;
    ctx.font = '900 72px system-ui, sans-serif';
    var starStr = ''; for (var i = 1; i <= 5; i++) starStr += i <= stars ? '★' : '☆';
    ctx.fillStyle = '#ffd75e'; ctx.fillText(starStr, W / 2 - 120, y + 20);
    ctx.beginPath(); ctx.arc(W / 2 + 280, y - 20, 70, 0, Math.PI * 2);
    ctx.fillStyle = '#7a2ad6'; ctx.fill(); ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.stroke();
    ctx.fillStyle = '#ffd75e'; ctx.font = '900 80px system-ui, sans-serif'; ctx.fillText(c.grade || '', W / 2 + 280, y + 10);
    y += 90;
    if (c.won) {
      y += 20; ctx.fillStyle = '#ffd75e'; ctx.font = '900 52px system-ui, sans-serif'; ctx.fillText('👑  1st PLACE', W / 2, y + 20); y += 70;
    } else if (c.rank) {
      y += 16; ctx.fillStyle = '#fff'; ctx.font = '800 44px system-ui, sans-serif'; ctx.fillText('#' + c.rank, W / 2, y + 16); y += 56;
    }
    // stats
    y += 20;
    var stats = [['Pitch', c.pitch == null ? '—' : c.pitch + '%'], ['Rhythm', c.rhythm == null ? '—' : c.rhythm + '%'], ['Max combo', c.combo != null ? c.combo + 'x' : '—']];
    stats.forEach(function (s, i) {
      var x = 180 + i * 360;
      ctx.fillStyle = '#c9b8ff'; ctx.font = '700 28px system-ui, sans-serif'; ctx.fillText(s[0].toUpperCase(), x, y);
      ctx.fillStyle = '#fff'; ctx.font = '900 56px system-ui, sans-serif'; ctx.fillText(s[1], x, y + 66);
    });
    y += 150;
    if (c._hs && (c._hs.songRecord || c._hs.personalBest)) {
      ctx.fillStyle = c._hs.songRecord ? '#ffd75e' : '#3ff2ff';
      ctx.font = '900 48px system-ui, sans-serif';
      ctx.fillText(c._hs.songRecord ? '🏆  NEW HIGH SCORE' : '⭐  Personal best', W / 2, y);
      y += 70;
    }
    ctx.fillStyle = '#fff'; ctx.font = '900 56px system-ui, sans-serif';
    ctx.fillText(location.host + '/kba', W / 2, H - 90);
    return cv;
  }
  function saveImage() {
    if (!lastCard) return;
    var btn = ov.querySelector('#prSave'), msg = ov.querySelector('#prMsg');
    btn.disabled = true; msg.textContent = '…';
    drawCard(lastCard).then(function (cv) {
      return new Promise(function (res) { cv.toBlob(res, 'image/png'); });
    }).then(function (blob) {
      if (!blob) throw new Error('empty');
      var file = new File([blob], 'kba-score.png', { type: 'image/png' });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        return navigator.share({ files: [file], title: lastCard.name + ' · ' + (lastCard.title || 'Karaoke Beat Arcade'), text: lastCard.name + ' scored ' + lastCard.score + ' on ' + (lastCard.title || 'a song') + ' — hosted /kba' }).then(function () { msg.textContent = '✅ Shared!'; }).catch(function (e) { if (e && e.name === 'AbortError') { msg.textContent = ''; return; } download(blob); });
      }
      download(blob); msg.textContent = '✅ Saved!';
    }).catch(function () { msg.textContent = 'Ask to try again'; }).then(function () { btn.disabled = false; setTimeout(function () { if (msg.textContent.indexOf('Ask') < 0) msg.textContent = ''; }, 2500); });
  }
  function download(blob) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'kba-score.png';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    if (ov) ov.querySelector('#prMsg').textContent = '✅ Saved!';
  }

  window.KTV_SHOW_CARD = showCard; // used by the live walkthrough to screenshot a finished song

  function go() {
    var gate = document.createElement('div'); gate.className = 'kj';
    gate.innerHTML = '<img class="kj-logo" src="' + BASE + '/web/m/logo.webp" alt="COOLEST! Karaoke Beat Arcade"><div class="kj-q">What\u2019s your name?</div>' +
      '<input id="kjName" maxlength="14" autocomplete="off" autocapitalize="words" enterkeyhint="go" placeholder="Your name">' +
      '<button id="kjFun" class="kj-fun">🎲 Fun name</button><button id="kjGo" class="kj-go">I\u2019m ready! ▶</button><div id="kjMsg" class="kj-msg"></div>';
    document.body.appendChild(gate);
    var inp = gate.querySelector('#kjName'); inp.value = saved;
    gate.querySelector('#kjFun').onclick = function () { var n; do { n = FUN[Math.floor(Math.random() * FUN.length)]; } while (n === inp.value && FUN.length > 1); inp.value = n; };
    inp.addEventListener('keydown', function (e) { if (e.keyCode === 13) ready(); });
    gate.querySelector('#kjGo').onclick = ready;
    function ready() {
      var n = inp.value.replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 14);
      if (!n) { gate.querySelector('#kjMsg').textContent = '👆 Type a name or tap 🎲'; inp.focus(); return; }
      try { localStorage.setItem('karaoke.name', n); } catch (e) {}
      myName = n;
      var pn = document.getElementById('pName'); if (pn) pn.value = n;
      window.KTV_NAME_READY = true; if (window.KTV_PHONE_CONNECT) window.KTV_PHONE_CONNECT();
      document.body.classList.add('kj-done'); gate.remove();
      var mic = document.getElementById('mic'); if (mic) mic.click();
    }
    document.body.classList.add('ktv-simple');
    var bar = document.createElement('div'); bar.className = 'kj-bar';
    bar.innerHTML = '<button data-t="find">🔎 Find a song</button><button data-t="gear" aria-label="Settings">⚙️</button>';
    bar.onclick = function (e) { var t = e.target.getAttribute('data-t'); if (t) document.body.classList.toggle('show-' + t); };
    var main = document.querySelector('main'); if (main) main.insertBefore(bar, main.children[1] || null);
    var s = document.createElement('script'); s.src = BASE + '/phone/phone.js'; document.body.appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
})();
