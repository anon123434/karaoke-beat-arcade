/* iPhone microphone: real pitch detection (YIN) on-device, pitch frames sent over wss. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var code = params.get('s') || '';
  var NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  var ws = null, seq = 0, rtts = [], latMs = 0, analysisDelayMs = 0;
  var micState = 'off';
  var cid = localStorage.getItem('karaoke.cid'); if (!cid) { cid = 'c' + Math.random().toString(36).slice(2, 12); localStorage.setItem('karaoke.cid', cid); }
  var mySlot = 0, myColor = '#fff', names = {};
  $('pName').value = localStorage.getItem('karaoke.name') || '';
  $('pName').addEventListener('change', function () { var n = $('pName').value.trim(); localStorage.setItem('karaoke.name', n); send({ type: 'name', name: n }); });

  function pill(el, text, cls) { el.textContent = text; el.className = 'pill' + (cls ? ' ' + cls : ''); }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function sendStatus() { send({ type: 'status', mic: micState, lat: latMs }); }
  // v13.12: bridge for the Songs tab (phone/songs-tab.js): send frames, and get the few message types it needs
  var QMSG = { hello: 1, queue: 1, qres: 1, state: 1, players: 1 };
  window.KTVPhone = { send: send, slot: function () { return mySlot; }, mic: function () { return micState; }, connected: function () { return !!(ws && ws.readyState === 1); } };
  try { document.dispatchEvent(new Event('ktv-phone')); } catch (e) {}

  // ---------- voice monitoring + auto-tune settings (remembered on this phone) ----------
  var V = {
    on: false /* v13.8.1: voice through the TV removed — always off, saved value ignored */, vol: +(localStorage.getItem('karaoke.voiceVol') || 80) / 100,
    at: localStorage.getItem('karaoke.autotune') === '1', atStr: +(localStorage.getItem('karaoke.autotuneStrength') || 60) / 100,
    tvMaster: false, halfRtt: 0, notes: null, songId: '', h: null, hAt: 0, playing: false, sent: 0, vseq: 0
  };
  function sendVoice() { send({ type: 'voice', on: V.on, vol: V.vol }); }
  function renderVoice() {
    $('vOn').textContent = V.on ? 'On' : 'Off'; $('vOn').classList.toggle('on', V.on);
    $('atOn').textContent = V.at ? 'On' : 'Off'; $('atOn').classList.toggle('on', V.at);
    $('vVol').value = Math.round(V.vol * 100); $('atStr').value = Math.round(V.atStr * 100);
    var st = !V.tvMaster ? 'Voice on TV is off — turn it on with the TV remote (home row or pause menu).'
      : !V.on ? 'Your voice is muted on the TV (others can still be heard).'
      : !started ? 'Start the mic to be heard on the TV.'
      : 'Live on the TV speakers' + (V.at ? ' · auto-tune ' + Math.round(V.atStr * 100) + '%' : '') + '. Keep the phone away from the speakers to avoid feedback.';
    $('vStatus').textContent = st;
  }
  $('vOn').onclick = function () { V.on = !V.on; localStorage.setItem('karaoke.voiceOn', V.on ? '1' : '0'); sendVoice(); renderVoice(); };
  $('vVol').oninput = function () { V.vol = +this.value / 100; localStorage.setItem('karaoke.voiceVol', this.value); sendVoice(); };
  $('atOn').onclick = function () { V.at = !V.at; localStorage.setItem('karaoke.autotune', V.at ? '1' : '0'); renderVoice(); };
  $('atStr').oninput = function () { V.atStr = +this.value / 100; localStorage.setItem('karaoke.autotuneStrength', this.value); renderVoice(); };
  function heardNow() { return V.h == null ? -1 : V.h + (performance.now() - V.hAt) / 1000; }
  function loadNotes(id) {
    if (!id || id === V.songId) return; V.songId = id; V.notes = null;
    var x = new XMLHttpRequest(); x.open('GET', '/songs/' + encodeURIComponent(id) + '/song.json');
    x.onload = function () { try { if (V.songId === id) V.notes = JSON.parse(x.responseText).notes || null; } catch (e) {} }; x.send();
  }
  renderVoice();

  // v13.13 mid-song join: the TV tells a phone that joined during a song; show it and go straight to the singing view
  function lateBanner(how) {
    var el = $('lateMsg');
    if (!how) { if (el) el.style.display = 'none'; return; }
    if (!el) { el = document.createElement('div'); el.id = 'lateMsg'; el.style.cssText = 'width:100%;max-width:420px;box-sizing:border-box;margin:8px 0;padding:11px 14px;border-radius:16px;border:2px solid #3ff2ff;background:rgba(63,242,255,.14);color:#fff;font-weight:800;font-size:18px;text-align:center'; var t = $('turn'); t.parentNode.insertBefore(el, t); }
    el.textContent = how === 'in' ? '\ud83c\udfb6 Song in progress, you\u2019re in!' : how === 'over' ? '\ud83c\udfb6 Song\u2019s nearly over \u2014 you\u2019ll be in for the next one' : '\ud83c\udfb6 Song in progress \u2014 tap Start mic to join in';
    el.style.display = 'block';
    var sb = document.querySelector('#tabs button[data-t="sing"]'); if (sb) sb.click();   // Songs tab -> singing view
  }
  function connect() {
    if (!code) { pill($('pConn'), 'No pairing code — scan the TV QR', 'bad'); return; }
    ws = new WebSocket('wss://' + location.host + '/ws?role=phone&s=' + encodeURIComponent(code) + '&cid=' + cid + '&name=' + encodeURIComponent(localStorage.getItem('karaoke.name') || ''));
    ws.onopen = function () { pill($('pConn'), 'Connected', 'ok'); sendStatus(); ping(); try { document.dispatchEvent(new CustomEvent('ktv-msg', { detail: { type: 'open' } })); } catch (e) {} };
    ws.onclose = function (e) {
      pill($('pConn'), e.code === 4001 ? 'Old QR — rescan the TV' : e.code === 4003 ? 'Game full (4 players)' : 'Reconnecting…', 'bad');
      if (e.code !== 4001) setTimeout(connect, 1500);
    };
    ws.onmessage = function (ev) {
      var m = JSON.parse(ev.data);
      if (QMSG[m.type]) try { document.dispatchEvent(new CustomEvent('ktv-msg', { detail: m })); } catch (e) {}
      if (m.type === 'pong') {
        var rtt = performance.now() - m.id;
        rtts.push(rtt); if (rtts.length > 9) rtts.shift();
        var sorted = rtts.slice().sort(function (a, b) { return a - b; });
        latMs = sorted[Math.floor(sorted.length / 2)] / 2 + analysisDelayMs; V.halfRtt = sorted[Math.floor(sorted.length / 2)] / 2;
      } else if (m.type === 'hello') {
        pill($('pTv'), m.tv ? 'TV online' : 'TV offline', m.tv ? 'ok' : 'bad');
        mySlot = m.slot || 0; myColor = m.color || '#fff';
        $('pBadge').textContent = 'Player ' + mySlot; $('pBadge').style.background = myColor;
        if (!$('pName').value) $('pName').placeholder = m.name;
        var mine = localStorage.getItem('karaoke.guideLevel'); if (mine) send({ type: 'guide', level: mine }); // this phone's remembered choice
        sendVoice();
      }
      else if (m.type === 'state') {
        V.playing = m.state === 'playing'; if (m.state === 'playing' && m.song) loadNotes(m.song);
        if (m.state !== 'playing' && m.state !== 'paused') V.h = null;
        if (m.state === 'tv-offline') pill($('pTv'), 'TV offline', 'bad');
        else pill($('pTv'), m.state === 'playing' ? 'Singing!' : m.state === 'results' ? 'Results on TV' : 'TV online', 'ok');
        if (m.late) lateBanner(m.late); else if (m.state !== 'playing' && m.state !== 'paused') lateBanner('');
        if (m.state === 'results') {
          var fin = m.scores && m.scores[mySlot] != null ? m.scores[mySlot] : m.score;
          $('score').textContent = 'Final score: ' + fin; $('lyric').textContent = '';
          $('turn').textContent = m.winner ? (m.winner === mySlot ? '🏆 You win!' : '🏆 ' + m.winnerName + ' wins') : '';
        }
      } else if (m.type === 'players') {
        (m.players || []).forEach(function (p) { names[p.slot] = p.name; });
      } else if (m.type === 'voice') {
        V.tvMaster = !!m.master; renderVoice();
      } else if (m.type === 'clock') {
        if (m.h != null) { V.h = m.h; V.hAt = performance.now(); }
        $('lyric').textContent = m.lyric || '';
        var mine = m.scores && m.scores[mySlot] != null ? m.scores[mySlot] : m.score;
        $('score').textContent = 'Score ' + (mine || 0);
        $('turn').textContent = m.owner ? (m.owner === mySlot ? '🎤 Your line!' : '👂 ' + (names[m.owner] || 'Player ' + m.owner) + '’s line') : '';
        $('turn').style.color = m.owner === mySlot ? myColor : '#ffffff90';
        pill($('pTv'), 'Singing!', 'ok');
      } else if (m.type === 'guide') {
        var bs = $('guideSeg').children; for (var gi = 0; gi < bs.length; gi++) bs[gi].classList.toggle('on', bs[gi].getAttribute('data-l') === m.level);
        $('guideSeg').classList.toggle('na', m.available === false);
      } else if (m.type === 'searchres') {
        if (m.busy) $('qStatus').textContent = 'The TV isn\u2019t on the song list right now.';
        else {
          $('qStatus').textContent = !m.q ? 'Search cleared.' : m.n ? '\u201c' + m.q + '\u201d \u2192 ' + m.n + ' song' + (m.n === 1 ? '' : 's') + ' on the TV' : 'No song matches \u201c' + m.q + '\u201d \u2014 try part of a word.';
          $('qList').innerHTML = (m.list || []).map(function (t) { return '\u266a ' + String(t).replace(/[<>&]/g, ''); }).join('<br>');
        }
      } else if (m.type === 'feedback') {
        $('fb').textContent = m.rating; $('fb').style.color = { Perfect: '#3ff2ff', Great: '#7dffb8', Good: '#ffd75e', Miss: '#ff7b93' }[m.rating];
      }
    };
  }
  (function () {
    var bs = $('guideSeg').children;
    for (var i = 0; i < bs.length; i++) bs[i].addEventListener('click', function () {
      var l = this.getAttribute('data-l'); localStorage.setItem('karaoke.guideLevel', l); send({ type: 'guide', level: l });
    });
  })();
  // ---- find a song: typed text or speech -> the TV song list (v13.6) ----
  (function () {
    var qIn = $('qIn'), qMic = $('qMic'), qT = 0, rec = null, mr = null, busy = false;
    function sendQ(q, src, fin) { send({ type: 'search', q: q, src: src, final: !!fin }); }
    qIn.addEventListener('input', function () { clearTimeout(qT); qT = setTimeout(function () { sendQ(qIn.value, 'phone', true); }, 160); });
    function done() { busy = false; qMic.classList.remove('on'); }
    function say(t) { $('qStatus').textContent = t; }
    function fallbackRecord(why) {
      if (!navigator.mediaDevices || !window.MediaRecorder) { say('Voice search isn\u2019t available here (' + why + ') \u2014 type instead.'); return done(); }
      navigator.mediaDevices.getUserMedia({ audio: true }).then(function (st) {
        var type = window.MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
        var chunks = []; mr = new MediaRecorder(st, type ? { mimeType: type } : {});
        mr.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        mr.onstop = function () {
          st.getTracks().forEach(function (t) { t.stop(); }); say('Working out what you said\u2026');
          var blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' }), x = new XMLHttpRequest();
          x.open('POST', '/api/stt'); x.setRequestHeader('Content-Type', blob.type || 'audio/webm');
          x.onload = function () { done(); try { var r = JSON.parse(x.responseText); if (r.text) { qIn.value = r.text.replace(/[.!?]+$/, ''); sendQ(qIn.value, 'voice', true); } else say('Didn\u2019t catch that \u2014 try again.'); } catch (e) { say('Didn\u2019t catch that \u2014 try again.'); } };
          x.onerror = function () { done(); say('Couldn\u2019t reach the server for speech recognition.'); };
          x.send(blob);
        };
        mr.start(); say('Listening\u2026 say a title or artist (tap again to stop).'); qMic.classList.add('on'); busy = true;
        setTimeout(function () { if (mr && mr.state === 'recording') mr.stop(); }, 4500);
      }).catch(function () { say('Allow the microphone for voice search (or type instead).'); done(); });
    }
    qMic.onclick = function () {
      if (mr && mr.state === 'recording') { mr.stop(); return; }
      if (rec) { try { rec.stop(); } catch (e) {} return; }
      if (busy) return;
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      busy = true; qMic.classList.add('on');
      if (!SR) return fallbackRecord('no browser speech recognition');
      rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false;
      var got = false, failed = false;
      rec.onresult = function (e) {
        var t = ''; for (var i = e.resultIndex; i < e.results.length; i++) t += e.results[i][0].transcript; var fin = e.results[e.results.length - 1].isFinal;
        if (t) { got = true; qIn.value = t.replace(/[.!?]+$/, ''); sendQ(qIn.value, 'voice', fin); }
      };
      rec.onerror = function (e) { failed = true; rec = null; var er = e && e.error; if (er === 'no-speech' || er === 'aborted') { done(); say('Didn\u2019t hear anything \u2014 tap the mic and try again.'); } else fallbackRecord(er || 'error'); };
      rec.onend = function () { var was = rec; rec = null; if (!failed) { done(); if (!got && was) say('Didn\u2019t hear anything \u2014 tap the mic and try again.'); } };
      say('Listening\u2026 say a title or artist.');
      try { rec.start(); } catch (e) { rec = null; fallbackRecord('start failed'); }
    };
  })();
  function ping() { send({ type: 'ping', id: performance.now() }); }
  setInterval(function () { ping(); sendStatus(); }, 2000);

  var started = false, wakeLock = null;
  $('mic').onclick = function () { if (!started) startMic(); };

  function startMic() {
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('err').textContent = 'Microphone needs HTTPS. Trust the NOW! Karaoke Beat Arcade certificate on this iPhone (see TV), then reopen this page.';
      micState = 'insecure'; sendStatus(); pill($('pMic'), 'Mic blocked', 'bad'); return;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx = new AC();
    micState = 'requesting'; sendStatus(); pill($('pMic'), 'Allow mic…');
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } })
      .then(function (stream) {
        started = true;
        ctx.resume();
        var src = ctx.createMediaStreamSource(stream);
        // Band-limit to the singing range: drops rumble and hiss before pitch detection.
        var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 65;
        var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
        // Low-latency pipeline: 512-sample hop (~10.7 ms @48k) -> decimate x2 (signal is already
        // low-passed at 1.4 kHz) -> YIN on a 1024-sample window at ~24 kHz (~42 ms, covers 70 Hz).
        var HOP = 512, DEC = 2, WIN = 1024;
        var proc = ctx.createScriptProcessor(HOP, 2, 1);
        var mute = ctx.createGain(); mute.gain.value = 0;     // iOS only runs processors connected to output
        var merge = ctx.createChannelMerger(2);               // ch0 = band-limited (pitch), ch1 = raw mic (voice stream)
        src.connect(hp); hp.connect(lp); lp.connect(merge, 0, 0); src.connect(merge, 0, 1);
        merge.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
        var tuner = new KaraokeAutoTune.AutoTune(dsr), prevRaw = 0, sampleIdx = 0;
        meas.sr = ctx.sampleRate;
        var ring = new Float32Array(WIN), hopDec = HOP / DEC, dsr = ctx.sampleRate / DEC;
        var tracker = new KaraokeYin.Tracker({ gateRatio: 2.5 });
        analysisDelayMs = (WIN / 2) / dsr * 1000 + HOP / ctx.sampleRate * 1000;  // window centre + buffer
        proc.onaudioprocess = function (e) {
          var input = e.inputBuffer.getChannelData(0);
          ring.copyWithin(0, hopDec);
          for (var i = 0, j = WIN - hopDec; i < hopDec; i++, j++) ring[j] = 0.5 * (input[2 * i] + input[2 * i + 1]);
          var r = KaraokeYin.detect(ring, dsr, { minRms: 0.004 });
          var f = tracker.push(r);
          send({ type: 'pitch', f: f ? +f.toFixed(2) : 0, c: +r.clarity.toFixed(2), rms: +r.rms.toFixed(4), seq: seq++ });
          draw(f, r.rms);
          // ---- voice to the TV speakers (raw mic; auto-tune only shapes this sound, never the pitch sent for scoring) ----
          var raw = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : input;
          measDetect(raw, sampleIdx);
          if (V.on && V.tvMaster && ws && ws.readyState === 1 && ws.bufferedAmount < 16384) {
            var dec = new Float32Array(hopDec);
            for (var q = 0; q < hopDec; q++) { var a0 = raw[2 * q], a1 = raw[2 * q + 1]; dec[q] = 0.25 * prevRaw + 0.5 * a0 + 0.25 * a1; prevRaw = a1; } // half-band-ish x2 decimation
            var out = V.at ? tuner.process(dec, f || 0, V.atStr, V.notes, heardNow()) : dec;
            measInject(out, sampleIdx);
            var pkt = new ArrayBuffer(8 + hopDec * 2), dv = new DataView(pkt), pcm = new Int16Array(pkt, 8);
            dv.setUint8(0, 1); dv.setUint8(1, V.at ? 1 : 0); dv.setUint16(2, V.vseq++ & 65535, true); dv.setUint16(6, 0, true);
            dv.setUint16(4, Math.min(65535, Math.round(V.halfRtt + (V.at ? tuner.shifter.latencyMs() : 0))), true);
            for (q = 0; q < hopDec; q++) { var v = out[q] * 32767; pcm[q] = v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
            ws.send(pkt); V.sent++;
          } else meas.injecting = 0;
          sampleIdx += HOP;
        };
        micState = 'live'; sendStatus(); pill($('pMic'), 'Mic live', 'ok'); renderVoice();
        $('mic').classList.add('live'); $('mic').textContent = 'Listening';
        if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
      })
      .catch(function (err) {
        micState = 'denied'; sendStatus(); pill($('pMic'), 'Mic denied', 'bad');
        $('err').textContent = 'Microphone permission was denied (' + err.name + '). Settings → Safari → Microphone → Allow, then reload.';
      });
  }

  // ---------- acoustic delay measurement (mouth -> TV speaker), run by the singer on the phone ----------
  // Five short, quiet 1.5 kHz beeps are mixed into the outgoing voice stream (not played by the phone). The phone mic
  // hears them come back from the TV; the time between "sent at mic-sample N" and "heard at mic-sample M" is the true
  // end-to-end voice delay (plus ~3 ms per metre of air).
  var meas = { active: false, sr: 48000, runs: [], injAt: -1, injecting: 0, phase: 0, energies: [], waitFrom: -1, n: 0 };
  function goertzel(x, from, n, f, sr) {
    var w = 2 * Math.PI * f / sr, c = 2 * Math.cos(w), s1 = 0, s2 = 0;
    for (var i = from; i < from + n; i++) { var s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
    return (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n);
  }
  function measInject(out, idx) {
    if (!meas.active) return;
    if (meas.injecting > 0) {
      var amp = 0.22, f = 1500, sr = 24000;
      for (var i = 0; i < out.length && meas.injecting > 0; i++, meas.injecting--) { out[i] += amp * Math.sin(meas.phase); meas.phase += 2 * Math.PI * f / sr; }
    } else if (meas.waitFrom < 0 && idx >= meas.nextAt) {
      meas.injAt = idx; meas.waitFrom = idx; meas.injecting = 960; meas.phase = 0;   // 40 ms beep, starts at this block's first mic sample
      measInject(out, idx);
    }
  }
  function measDetect(raw, idx) {
    if (!meas.active) return;
    if (meas.nextAt < 0) meas.nextAt = idx + 0.5 * meas.sr;   // first 0.5 s: learn the background level
    var SUB = 128;
    for (var o = 0; o + SUB <= raw.length; o += SUB) {
      var e = goertzel(raw, o, SUB, 1500, meas.sr), at = idx + o;
      if (meas.waitFrom >= 0) {
        var dt = (at - meas.injAt) / meas.sr;
        var base = meas.energies.slice().sort(function (a, b) { return a - b; })[meas.energies.length >> 1] || 1e-9;
        if (dt > 0.02 && e > Math.max(base * 30, 2e-6)) { meas.runs.push(Math.round(dt * 1000)); meas.waitFrom = -1; meas.nextAt = at + 0.7 * meas.sr; measProgress(); }
        else if (dt > 0.8) { meas.runs.push(null); meas.waitFrom = -1; meas.nextAt = at + 0.7 * meas.sr; measProgress(); }
      } else { meas.energies.push(e); if (meas.energies.length > 60) meas.energies.shift(); }
    }
  }
  function measProgress() {
    var got = meas.runs.filter(function (x) { return x != null; });
    $('vDelay').textContent = 'Measuring… ' + meas.runs.length + '/5';
    if (meas.runs.length < 5) return;
    meas.active = false;
    if (got.length < 3) { $('vDelay').textContent = 'Could not hear the beeps back (' + got.length + '/5). Raise the TV volume a little or move closer, then retry.'; return; }
    var srt = got.slice().sort(function (a, b) { return a - b; }), med = srt[srt.length >> 1];
    $('vDelay').textContent = 'Voice delay (mouth → TV speaker): ' + med + ' ms' + (V.at ? ' (auto-tune on)' : '') + ' · runs ' + got.join(', ') + ' ms';
    send({ type: 'vdelay', ms: med, runs: meas.runs, autotune: V.at });
  }
  $('vMeasure').onclick = function () {
    if (!started) { $('vDelay').textContent = 'Start the mic first.'; return; }
    if (!V.tvMaster || !V.on) { $('vDelay').textContent = 'Turn on Voice on TV (TV remote) and “Hear my voice” first.'; return; }
    meas.active = true; meas.runs = []; meas.waitFrom = -1; meas.injecting = 0; meas.nextAt = -1; meas.energies = [];
    $('vDelay').textContent = 'Measuring… stay quiet for 4 seconds (you will hear 5 soft beeps from the TV).';
  };

  var lastDraw = 0;
  function draw(f, level) {
    var now = performance.now(); if (now - lastDraw < 60) return; lastDraw = now;
    $('meter').firstChild.style.width = Math.min(100, level * 400) + '%';
    $('mic').style.setProperty('--ring', Math.min(22, level * 160) + 'px');
    if (f > 0) {
      var midi = 69 + 12 * Math.log2(f / 440), n = Math.round(midi);
      $('note').textContent = NAMES[(n % 12 + 12) % 12] + (Math.floor(n / 12) - 1);
      $('hz').textContent = f.toFixed(1) + ' Hz · ' + (midi - n >= 0 ? '+' : '') + Math.round((midi - n) * 100) + '¢';
    } else { $('note').textContent = '–'; $('hz').textContent = ''; }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && started && navigator.wakeLock && !wakeLock) navigator.wakeLock.request('screen').catch(function () {});
  });
  connect();
})();
