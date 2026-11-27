/* TV audio engine: backing track + guide vocal + live phone voices on ONE AudioContext.
 * - Backing and guide are decoded AudioBuffers started at the same context time, so they are sample-locked
 *   (no drift to correct). Falls back to the <audio> element if Web Audio or decoding is unavailable.
 * - Voice monitoring: each phone streams 24 kHz PCM; every packet is scheduled back-to-back on the context
 *   timeline behind a small adaptive jitter buffer (30–100 ms), per-player gain -> voice master -> dry + reverb.
 * Exposes a media-element-like object (play/pause/currentTime/paused/src/ended) so app.js keeps its logic. */
(function () {
  'use strict';
  var AC = window.AudioContext || window.webkitAudioContext;

  function xhrBuffer(url, ok, fail, onprog, hold) {
    var x = new XMLHttpRequest(); x.open('GET', url); x.responseType = 'arraybuffer'; x.timeout = 45000;   // v13.11: a stalled LAN fetch fails (and is retried) instead of hanging the start forever
    x.onload = function () { (x.status === 200 || x.status === 0) && x.response ? ok(x.response) : fail(new Error('HTTP ' + x.status)); };
    x.onerror = function () { fail(new Error('network')); }; x.ontimeout = function () { fail(new Error('timeout')); }; x.onabort = function () { fail(new Error('aborted')); };
    if (onprog) x.onprogress = function (e) { if (e.lengthComputable && e.total) onprog(e.loaded / e.total); };
    if (hold) hold(x); x.send();
  }
  function reverbIR(ctx, secs) {
    var n = Math.round(ctx.sampleRate * secs), ir = ctx.createBuffer(2, n, ctx.sampleRate);
    for (var c = 0; c < 2; c++) {
      var d = ir.getChannelData(c), seed = c ? 7 : 3;
      for (var i = 0; i < n; i++) {
        seed = (seed * 16807) % 2147483647;                     // deterministic noise
        var t = i / n, pre = i < ctx.sampleRate * 0.012 ? 0 : 1;
        d[i] = pre * ((seed / 2147483647) * 2 - 1) * Math.pow(1 - t, 3.2) * 0.6;
      }
    }
    return ir;
  }

  function Engine(el, opts) {
    opts = opts || {};
    this.el = el; this.mode = 'element'; this.listeners = {};
    this._src = ''; this.offset = 0; this.t0 = 0; this.playing = false; this.pending = false;
    this.buf = null; this.bufUrl = ''; this.gbuf = null; this.gbufUrl = ''; this.guideUrl = ''; this.loading = {}; this.cache = {}; this.want = { url: '', gurl: '' }; this.busy = false; this.lastStart = null; this.bytes = {}; this.byteOrder = []; this.prog = {}; this.xhrs = {}; this.resetGen = 0; this.nearUrls = []; this.slice = !!opts.slice && !(function () { try { return localStorage.getItem('karaoke.slice') === 'off'; } catch (e) { return false; } })();
    this.voices = {}; this.voiceOn = false; this.voiceVol = 0.8;
    var self = this;
    try {
      if (!AC || (window.KaraokeDev && window.KaraokeDev.noWebAudio)) throw new Error('no AudioContext');
      var ctx = this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = ctx.createGain(); this.master.connect(ctx.destination);
      this.music = ctx.createGain(); this.music.connect(this.master);
      this.guide = ctx.createGain(); this.guide.gain.value = 0; this.guide.connect(this.master);
      this.vbus = ctx.createGain(); this.vbus.gain.value = 0; this.vbus.connect(this.master);
      this.rev = ctx.createConvolver(); this.rev.buffer = reverbIR(ctx, 0.8);
      this.wet = ctx.createGain(); this.wet.gain.value = 0.18;
      this.vbus.connect(this.rev); this.rev.connect(this.wet); this.wet.connect(this.master);
      // The context always exists (voice monitoring); music runs through it only when preferred (TV: after the engine check).
      this.mode = opts.prefer === 'element' ? 'element' : 'webaudio';
    } catch (e) { this.mode = 'element'; this.ctx = null; this.err = e.message; }
    el.addEventListener('ended', function () { if (self.mode === 'element') self.emit('ended'); });
    el.addEventListener('playing', function () { if (self.mode === 'element') self.emit('playing'); });
  }
  var P = Engine.prototype;
  P.addEventListener = function (ev, fn, opt) { (this.listeners[ev] = this.listeners[ev] || []).push({ fn: fn, once: opt && opt.once }); };
  P.emit = function (ev) { var l = this.listeners[ev] || []; this.listeners[ev] = l.filter(function (x) { return !x.once; }); l.forEach(function (x) { try { x.fn(); } catch (e) { setTimeout(function () { throw e; }); } }); };
  P.getAttribute = function (n) { return n === 'src' ? this._src : null; };
  Object.defineProperty(P, 'src', { get: function () { return this._src; }, set: function (u) {
    if (u === this._src) return;
    this.stopSources(); this.playing = false; this.offset = 0; this._src = u;
    if (this.mode === 'element') this.el.src = u;
  } });
  Object.defineProperty(P, 'paused', { get: function () { return this.mode === 'element' ? this.el.paused : !this.playing; } });
  Object.defineProperty(P, 'currentTime', {
    get: function () { if (this.mode === 'element') return this.el.currentTime; return this.playing ? this.offset + (this.ctx.currentTime - this.t0) * (this.rate || 1) : this.offset; },
    set: function (v) { if (this.mode === 'element') { this.el.currentTime = v; return; } var was = this.playing; if (was) this.stopSources(); this.offset = Math.max(0, v); if (was) this.startSources(); }
  });
  Object.defineProperty(P, 'volume', { get: function () { return this.mode === 'element' ? this.el.volume : this.music.gain.value; }, set: function (v) { if (this.mode === 'element') this.el.volume = v; else this.music.gain.value = v; } });
  Object.defineProperty(P, 'duration', { get: function () { return this.mode === 'element' ? this.el.duration : this.buf ? this.buf.duration : NaN; } });

  // decode (one song at a time: previous buffers are released)
  // ---------- v13.11: sliced decode (TV) ----------
  // decodeAudioData on the TV decodes a whole 5 min song (~115 MB of PCM) in ONE blocking call: the UI froze for 5-13 s on the first
  // song start and every time browsing dwelt on a new song (perf.log: 0.6 fps / 3 s frames). MP3 frames are self-contained, so the file is
  // cut at frame boundaries into ~100 ms slices (8 warm-up frames in front for the bit reservoir, 4 spare frames behind), each decoded on
  // its own into a preallocated AudioBuffer with a yield in between (input-aware). Every seam is self-verified (exact length + the spare
  // frames must equal the next slice's decoded copy); anything unexpected falls back to the old one-shot decode, so audio is bit-identical.
  var MP3_BR = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0], MP3_SR = [44100, 48000, 32000, 0];
  var PRE = 8, OV = 4, SPF = 1152, SLICE_MS = 110;
  function mp3Index(u8) {
    var n = u8.length, p = 0;
    if (n > 10 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) p = 10 + (((u8[6] & 127) << 21) | ((u8[7] & 127) << 14) | ((u8[8] & 127) << 7) | (u8[9] & 127)) + ((u8[5] & 16) ? 10 : 0);
    var offs = [], sr = 0, ch = 0;
    while (p + 4 <= n) {
      if (u8[p] !== 0xFF || (u8[p + 1] & 0xFE) !== 0xFA) break;                 // MPEG-1 Layer III only
      var b2 = u8[p + 2], br = MP3_BR[b2 >> 4], s = MP3_SR[(b2 >> 2) & 3]; if (!br || !s) break;
      var len = Math.floor(144000 * br / s) + ((b2 >> 1) & 1), c = (u8[p + 3] >> 6) === 3 ? 1 : 2;
      if (!sr) { sr = s; ch = c; } else if (s !== sr || c !== ch) return null;
      if (p + len > n) break; offs.push(p); p += len;
    }
    if (offs.length < 150 || n - p > 600) return null;                          // not a clean MP3 stream: caller decodes in one go
    offs.push(p);
    var q = offs[0] + (ch === 1 ? 21 : 36), tag = (u8[q] === 0x58 && u8[q + 1] === 0x69 && u8[q + 2] === 0x6E && u8[q + 3] === 0x67) || (u8[q] === 0x49 && u8[q + 1] === 0x6E && u8[q + 2] === 0x66 && u8[q + 3] === 0x6F);
    return { offs: offs, n: offs.length - 1, sr: sr, ch: ch, tag: tag ? 1 : 0 };
  }
  P.wanted = function (url) { return url === this._src || url === this.guideUrl || url === this.want.url || url === this.want.gurl; };
  P.touch = function () { this.lastTouch = Date.now(); };
  P.decodeSliced = function (url, ab, cb, live) {
    var self = this, ctx = this.ctx, u8 = new Uint8Array(ab), idx;
    try { idx = mp3Index(u8); } catch (e) { idx = null; }
    if (!idx || idx.sr !== ctx.sampleRate) return cb(null, new Error('noslice'));
    var tagF = idx.tag, a = 0, step = 130, j = 0, skip = 0, out = null, T = 0, prev = null, slices = 0, t00 = performance.now(), maxMs = 0, nch = idx.ch;
    var fail = function (why) { cb(null, new Error('slice:' + why)); };
    var next = function () {
      if ((live && !live()) || (!self.wanted(url) && url !== self.sliceKeep)) return cb(null, new Error('cancelled'));
      var b = Math.min(idx.n, a + step), last = b >= idx.n; if (!last && idx.n - b < 40) { b = idx.n; last = true; }
      var s = j === 0 ? 0 : Math.max(0, a - PRE), e = last ? idx.n : Math.min(idx.n, b + OV);
      var bytes = ab.slice(s === 0 ? 0 : idx.offs[s], idx.offs[e]), t0 = performance.now(), got = false;
      var ok = function (buf) {
        if (got) return; got = true;
        var dt = performance.now() - t0; maxMs = Math.max(maxMs, dt); slices++;
        try {
          if (!buf || buf.numberOfChannels !== nch || buf.sampleRate !== idx.sr) return fail('fmt');
          var L = buf.length, full = (e - s - (s === 0 ? tagF : 0)) * SPF, k0 = 0, keep, dest, c, i;
          if (j === 0) {
            skip = full - L; if (skip < 0 || skip > 2000) return fail('skip' + skip);
            T = (idx.n - tagF) * SPF - skip; out = ctx.createBuffer(nch, T, idx.sr);
            keep = (b - tagF) * SPF - skip; dest = 0; k0 = 0;
          } else {
            if (last ? (L > full || L < full - 2400) : L !== full) return fail('len' + (L - full));
            k0 = (a - s) * SPF; dest = (a - tagF) * SPF - skip; keep = last ? Math.min(L - k0, T - dest) : (b - a) * SPF;
            // seam check: the spare frames the previous slice decoded past its end must equal this slice's copy of them
            if (prev) for (c = 0; c < nch; c++) { var x = buf.getChannelData(c), pv = prev[c], mx = 0, en = 0; for (i = 0; i < pv.length; i++) { var d = Math.abs(x[k0 + i] - pv[i]); if (d > mx) mx = d; en += pv[i] * pv[i]; } if (mx > 0.002 && en > 1e-6) return fail('seam' + mx.toFixed(4)); }
          }
          if (keep < 0 || dest + keep > T || k0 + keep > L) return fail('range');
          for (c = 0; c < nch; c++) out.copyToChannel(buf.getChannelData(c).subarray(k0, k0 + keep), c, dest);
          if (!last) {                                    // spare frames for the next seam check
            var from = j === 0 ? keep : k0 + keep; prev = []; for (c = 0; c < nch; c++) prev.push(new Float32Array(buf.getChannelData(c).subarray(from, from + OV * SPF)));
            if (prev[0].length !== OV * SPF) return fail('tail');
          }
        } catch (er) { return fail('exc:' + String(er && er.message || er).slice(0, 60)); }
        if (last) { self.lastSlice = { url: url, slices: slices, ms: Math.round(performance.now() - t00), maxSliceMs: Math.round(maxMs), skip: skip }; return cb(out); }
        a = b; j++; if (self.prog[url]) self.prog[url].dec = Math.min(0.99, a / idx.n);
        step = Math.max(40, Math.min(900, Math.round(step * 0.5 + step * SLICE_MS / Math.max(dt, 6) * 0.5)));
        var urgent = self.pending && url === self._src, busyKeys = Date.now() - (self.lastTouch || 0) < 700;
        var gap = urgent ? 0 : self.playing ? Math.max(150, dt * 2) : busyKeys ? 250 : Math.max(30, dt * 0.6);
        setTimeout(next, gap);
      };
      try {
        var pr = ctx.decodeAudioData(bytes, ok, function () { if (!got) { got = true; fail('decode'); } });
        if (pr && pr.catch) pr.catch(function () {});
      } catch (er) { fail('throw'); }
    };
    next();
  };

  // raw compressed bytes of the neighbours (+/-1) of the highlighted song, fetched while idle (a few MB each, max 3 kept)
  P.near = function (urls) { this.nearUrls = (urls || []).filter(Boolean); clearTimeout(this.nearT); var self = this; this.nearT = setTimeout(function () { self.pumpBytes(); }, 1500); };
  P.pumpBytes = function () {
    var self = this; if (this.mode !== 'webaudio' || this.busy || this.playing || this.pending || this.byteBusy || Date.now() - (this.lastTouch || 0) < 1200) { if (this.nearUrls && this.nearUrls.length) { clearTimeout(this.nearT); this.nearT = setTimeout(function () { self.pumpBytes(); }, 1500); } return; }
    var u = (this.nearUrls || []).filter(function (x) { return !self.cache[x] && !self.bytes[x] && !self.loading[x]; })[0]; if (!u) return;
    this.byteBusy = true;
    xhrBuffer(u, function (ab) { self.byteBusy = false; if ((self.nearUrls || []).indexOf(u) >= 0) { self.bytes[u] = ab; self.byteOrder.push(u); while (self.byteOrder.length > 2) delete self.bytes[self.byteOrder.shift()]; } self.nearT = setTimeout(function () { self.pumpBytes(); }, 400); }, function () { self.byteBusy = false; });
  };
  P.decode = function (url, cb) {
    var self = this;
    if (this.cache[url]) return cb(this.cache[url]);
    if (this.loading[url]) { this.loading[url].push(cb); return; }
    var mine = this.loading[url] = [cb], gen = this.resetGen || 0;
    var live = function () { return self.loading[url] === mine && (self.resetGen || 0) === gen; };
    this.prog[url] = { dl: 0, dec: 0 };
    var gotBytes = function (ab) {
      if (!live()) return;
      var done = function (b, err) {
        if (!live()) return;                                   // reset/retried while this was running: stale result
        if (b) { self.cache[url] = b; self.evict(); }
        delete self.prog[url]; delete self.loading[url]; delete self.xhrs[url]; mine.forEach(function (f) { f(b, err); });
      };
      var whole = function () {
        try {
          var pr = self.ctx.decodeAudioData(ab, function (b) { done(b); }, function (e) { done(null, e || new Error('decode')); });
          if (pr && pr.catch) pr.catch(function () {});
        } catch (e) { done(null, e); }
      };
      if (self.slice && !self.sliceOff) {
        self.decodeSliced(url, ab, function (b, err) {
          if (b) return done(b);
          var m = String(err && err.message || '');
          if (m === 'cancelled') return done(null, err);
          if (m !== 'noslice') { self.sliceOff = true; self.sliceWhy = m; }   // this TV decodes slices differently: stay on the one-shot decode from now on
          whole();
        }, live);
      } else whole();
    };
    if (this.bytes[url]) { var ab0 = this.bytes[url]; delete this.bytes[url]; this.byteOrder = this.byteOrder.filter(function (x) { return x !== url; }); this.prog[url].dl = 1; return gotBytes(ab0); }
    xhrBuffer(url, gotBytes, function (e) { if (!live()) return; delete self.prog[url]; delete self.xhrs[url]; delete self.loading[url]; mine.forEach(function (f) { f(null, e); }); },
      function (f) { if (self.prog[url]) self.prog[url].dl = f; }, function (x) { self.xhrs[url] = x; });
  };
  // 0..1 load progress of the given urls (download 25 %, decode 75 %); 1 when cached
  P.progress = function (urls) {
    var t = 0, n = 0; (urls || []).forEach(function (u) { if (!u) return; n++; if (this.cache[u]) t += 1; else if (this.prog[u]) t += 0.25 * this.prog[u].dl + 0.75 * this.prog[u].dec; }, this);
    return n ? t / n : 0;
  };
  // drop a stalled/failed load of this url (abort the fetch, stop slicing, forget callbacks) so play() can start it again from scratch
  P.reset = function (url) {
    this.resetGen = (this.resetGen || 0) + 1; var x = this.xhrs[url]; delete this.xhrs[url];
    delete this.loading[url]; delete this.prog[url]; delete this.cache[url]; this.busy = false; this.retried = false;
    if (x) try { x.abort(); } catch (e) {}
    if (this.bufUrl === url) { this.buf = null; this.bufUrl = ''; }
    this.pending = false;
  };
  P.load = function () {
    if (this.mode === 'element') { this.el.load(); return; }
    this.preload(this._src, this.want.url === this._src ? this.want.gurl : '');
  };
  // ---- preloading while browsing: keep only the focused song (backing + guide) decoded (~110 MB on the TV) ----
  P.evict = function () {
    var keep = {}; [this._src, this.guideUrl, this.want.url, this.want.gurl, this.bufUrl, this.gbufUrl].forEach(function (u) { if (u) keep[u] = 1; });
    for (var u in this.cache) if (!keep[u]) delete this.cache[u];
  };
  P.preload = function (url, gurl) {
    if (!this.ctx || this.mode !== 'webaudio') return;
    this.want = { url: url || '', gurl: gurl || '' }; this.evict();
    var self = this; clearTimeout(this.preT);
    this.preT = setTimeout(function () { self.pump(); }, 600);   // debounce list scrolling
  };
  P.pump = function () {
    if (this.busy || this.playing || this.pending) return;        // never decode on top of a running song
    var w = this.want, next = w.url && !this.cache[w.url] ? w.url : w.gurl && !this.cache[w.gurl] ? w.gurl : '';
    if (!next) return;
    var self = this, t0 = performance.now(); this.busy = true;
    this.decode(next, function (b) {
      self.busy = false; self.lastDecode = { url: next, ms: Math.round(performance.now() - t0), ok: !!b };
      setTimeout(function () { self.pump(); }, 50);               // then the guide, or the newest focused song
    });
  };
  /** Back on the song list: drop the played song's buffers so only the focused song stays decoded. */
  P.release = function () {
    if (this.mode === 'element' && this.tempElement) { this.tempElement = false; try { this.el.pause(); } catch (e) {} this.mode = 'webaudio'; this.err = null; this.emit('restored'); return; }
    if (this.mode !== 'webaudio') return;
    this.pause(); this.stopSources(); this.buf = null; this.bufUrl = ''; this.gbuf = null; this.gbufUrl = ''; this.guideUrl = ''; this.offset = 0;
    this.evict();
  };
  P.ready = function (url, gurl) { return !!this.cache[url] && (!gurl || !!this.cache[gurl]); };
  P.cacheInfo = function () { var mb = 0, n = 0; for (var u in this.cache) { var b = this.cache[u]; mb += b.length * b.numberOfChannels * 4 / 1e6; n++; } return { buffers: n, mb: Math.round(mb), want: this.want.url, ready: this.ready(this.want.url, this.want.gurl), lastDecode: this.lastDecode || null, lastStart: this.lastStart }; };
  P.ensure = function (cb) {
    var self = this, url = this._src;
    if (this.bufUrl === url && this.buf) return cb(true);
    if (this.cache[url]) { this.buf = this.cache[url]; this.bufUrl = url; cb(true); if (this.afterMain) { var f = this.afterMain; this.afterMain = null; f(); } return; }
    if (this.bufUrl !== url) { this.buf = null; }
    this.decode(url, function (b, err) {
      if (self._src !== url) return;            // superseded
      if (!b && !self.retried) {                 // usually the TV running short of memory: free every cached buffer, try once more
        self.retried = true; self.cache = {}; self.gbuf = null; self.gbufUrl = ''; self.lastRetry = { url: url, err: String(err && err.message || err) };
        return self.ensure(cb);
      }
      self.retried = false;
      if (!b) { self.fallback('decode failed: ' + (err && err.message || err)); return cb(false); }
      self.buf = b; self.bufUrl = url; cb(true);
      if (self.afterMain) { var f = self.afterMain; self.afterMain = null; f(); }
    });
  };
  P.fallback = function (why) {
    // Web Audio could not decode this file: hand playback to the <audio> element (guide then uses its own element).
    // just this song: tempElement puts Web Audio back on the song list (release)
    this.err = why; this.mode = 'element'; this.tempElement = true; this.el.src = this._src; this.stopSources(); this.playing = false;
    if (this.pending) { this.pending = false; this.el.currentTime = this.offset; this.el.play(); }
    this.emit('fallback');
  };
  P.setGuide = function (url) {
    if (this.mode !== 'webaudio') return;
    if (this.ctx.state !== 'running' && this.ctx.resume) this.ctx.resume();
    if (url === this.guideUrl && (this.gbuf || this.loading[url])) return; this.guideUrl = url || ''; this.gbuf = null; this.gbufUrl = '';
    var self = this; if (!url) return;
    var go = function () {
      self.decode(url, function (b) {
        if (self.guideUrl !== url || !b) return;
        self.gbuf = b; self.gbufUrl = url;
        if (self.playing) self.startGuideAt(self.ctx.currentTime + 0.03);   // joins sample-locked mid-song
      });
    };
    // cold start: decode the backing first (TV decodes are slow; two at once doubled the wait), guide right after
    if (this.cache[url] || this.cache[this._src] || (this.bufUrl === this._src && this.buf)) go(); else this.afterMain = go;
  };
  P.setRate = function (r) {   // v13.7: playback speed (Record map 75%); song time keeps counting in song seconds
    r = r > 0 ? r : 1; if (r === (this.rate || 1)) return;
    if (this.mode === 'element') { this.rate = r; this.el.playbackRate = r; return; }
    var was = this.playing; if (was) { this.offset = this.currentTime; this.stopSources(); } this.rate = r; if (was) this.startSources();
  };
  P.setGuideGain = function (v) { if (this.mode === 'webaudio') this.guide.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03); };
  P.play = function () {
    if (this.mode === 'element') return this.el.play();
    var self = this; this.pending = true;
    if (this.ctx.state !== 'running' && this.ctx.resume) this.ctx.resume();
    var t0 = performance.now(), pre = !!this.cache[this._src] || (this.bufUrl === this._src && !!this.buf);
    return new Promise(function (resolve) {
      self.ensure(function (ok) {
        if (!ok || !self.pending || self.mode !== 'webaudio') return resolve();
        self.pending = false; self.startSources(); resolve();
        self.lastStart = { ms: Math.round(performance.now() - t0), preloaded: pre, url: self._src };
        self.emit('playing');
      });
    });
  };
  P.pause = function () {
    if (this.mode === 'element') { this.el.pause(); return; }
    this.pending = false; if (!this.playing) return;
    this.offset = this.currentTime; this.stopSources(); this.playing = false;
  };
  P.startSources = function () {
    var ctx = this.ctx, self = this, at = ctx.currentTime + 0.03;
    var s = this.srcNode = ctx.createBufferSource(); s.buffer = this.buf; s.connect(this.music);
    s.onended = function () { if (self.srcNode === s && self.playing) { self.playing = false; self.offset = self.buf.duration; self.emit('ended'); } };
    s.playbackRate.value = this.rate || 1;   // v13.7: Record map can play at 75%
    s.start(at, Math.min(this.offset, this.buf.duration));
    this.t0 = at; this.playing = true;
    this.startGuideAt(at);
  };
  P.startGuideAt = function (at) {
    if (!this.gbuf || !this.playing) return;
    if (this.gNode) try { this.gNode.stop(); } catch (e) {}
    var off = this.offset + (at - this.t0) * (this.rate || 1);
    if (off >= this.gbuf.duration) return;
    var g = this.gNode = this.ctx.createBufferSource(); g.buffer = this.gbuf; g.connect(this.guide); g.playbackRate.value = this.rate || 1; g.start(at, Math.max(0, off));
  };
  P.stopSources = function () {
    var n = this.srcNode; this.srcNode = null; if (n) { n.onended = null; try { n.stop(); } catch (e) {} }
    var g = this.gNode; this.gNode = null; if (g) try { g.stop(); } catch (e) {}
  };
  P.abortTest = function () { if (!this.testing) return; this.testAbort = true; if (this.testRestore) { this.testRestore(); this.testRestore = null; } };
  P.guideLocked = function () { return this.mode === 'webaudio' && !!this.gNode && this.playing; };

  // ---------- voice monitoring ----------
  P.setVoiceMaster = function (on, vol) {
    if (!this.ctx) return;
    this.voiceOn = !!on; if (vol != null) this.voiceVol = vol;
    this.vbus.gain.setTargetAtTime(this.voiceOn ? this.voiceVol : 0, this.ctx.currentTime, 0.02);
    if (on && this.ctx.state !== 'running' && this.ctx.resume) this.ctx.resume();
  };
  P.voice = function (slot) {
    var v = this.voices[slot];
    if (!v) {
      v = this.voices[slot] = { gain: this.ctx.createGain(), next: 0, target: 0.04, under: 0, drops: 0, rx: 0, lastUnder: 0, depth: [], net: [] };
      v.gain.connect(this.vbus);
    }
    return v;
  };
  P.setVoiceGain = function (slot, on, vol) { if (!this.ctx) return; var v = this.voice(slot); v.on = on; v.gain.gain.setTargetAtTime(on ? vol : 0, this.ctx.currentTime, 0.02); };
  /** Schedule one PCM packet (Int16 mono). Returns the queue depth (s) at the moment it was scheduled. */
  P.pushVoice = function (slot, pcm, sr) {
    if (!this.ctx || !this.voiceOn) return -1;
    var ctx = this.ctx, v = this.voice(slot), n = pcm.length, now = ctx.currentTime;
    v.rx++;
    var b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = pcm[i] / 32768;
    if (v.next < now + 0.004) {                                   // first packet or underrun: (re)start behind the jitter buffer
      if (v.next) { v.under++; if (now - v.lastUnder < 3) v.target = Math.min(0.1, v.target + 0.01); v.lastUnder = now; }
      v.next = now + v.target;
    } else if (v.next - now > v.target + 0.07) { v.drops++; return v.next - now; }  // too far behind: drop to stay low-latency
    else if (v.next - now > v.target + 0.025) {                     // backlog after a burst: shed one packet every 0.5 s until back on target
      if (!v.highSince) v.highSince = now; else if (now - v.highSince > 0.5) { v.highSince = 0; v.drops++; return v.next - now; }
    } else v.highSince = 0;
    if (now - v.lastUnder > 8 && v.target > 0.03) v.target -= 0.0005;          // slowly tighten when the network is clean
    var s = ctx.createBufferSource(); s.buffer = b; s.connect(v.gain); s.start(v.next);
    var depth = v.next - now; v.next += n / sr;
    v.depth.push(depth); if (v.depth.length > 200) v.depth.shift();
    return depth;
  };
  P.voiceStats = function () {
    var out = {}, self = this;
    Object.keys(this.voices).forEach(function (k) {
      var v = self.voices[k], d = v.depth.slice().sort(function (a, b) { return a - b; }), n = v.net.slice().sort(function (a, b) { return a - b; });
      out[k] = { rx: v.rx, under: v.under, drops: v.drops, targetMs: Math.round(v.target * 1000), bufMs: d.length ? Math.round(d[d.length >> 1] * 1000) : null, netMs: n.length ? Math.round(n[n.length >> 1]) : null };
    });
    return out;
  };
  P.outputInfo = function () {
    if (!this.ctx) return { mode: this.mode };
    return { mode: this.mode, sr: this.ctx.sampleRate, baseMs: this.ctx.baseLatency != null ? Math.round(this.ctx.baseLatency * 1000) : null, outMs: this.ctx.outputLatency != null ? Math.round(this.ctx.outputLatency * 1000) : null, state: this.ctx.state };
  };
  /** Silent capability check (master gain 0): decode a song + guide, play both through the context for `secs`
   *  alongside the muted <audio> element, and report decode time, clock rate and whether the element kept playing. */
  P.selfTest = function (url, gurl, secs, done) {
    var self = this, ctx = this.ctx, r = { url: url, ok: false };
    this.testAbort = false; this.testing = true;
    if (!ctx) { r.err = 'no AudioContext'; return done(r); }
    if (ctx.resume) ctx.resume();
    var mem0 = window.performance && performance.memory ? performance.memory.usedJSHeapSize : null, t0 = performance.now();
    var silent = ctx.createGain(); silent.gain.value = 0; silent.connect(ctx.destination);
    this.decode(url, function (b, err) {
      r.decodeMs = Math.round(performance.now() - t0);
      if (!b) { r.err = 'decode: ' + (err && err.message || err); return done(r); }
      r.durS = Math.round(b.duration); r.ch = b.numberOfChannels; r.bufMB = Math.round(b.length * b.numberOfChannels * 4 / 1e5) / 10;
      var t1 = performance.now();
      self.decode(gurl, function (g, gerr) {
        r.guideDecodeMs = Math.round(performance.now() - t1); r.guideOk = !!g; if (g) r.guideMB = Math.round(g.length * g.numberOfChannels * 4 / 1e5) / 10;
        if (gerr) r.guideErr = String(gerr && gerr.message || gerr);
        if (self.testAbort) { r.err = 'aborted: a song started'; self.testing = false; return done(r); }
        var el = self.el, elVol = el.volume; el.volume = 0; el.src = url; var elStart = null; self.testRestore = function () { el.volume = elVol; };
        try { var pp = el.play(); if (pp && pp.catch) pp.catch(function (e) { r.elErr = e.message; }); } catch (e) { r.elErr = e.message; }
        var s = ctx.createBufferSource(); s.buffer = b; s.connect(silent); var gs = null;
        if (g) { gs = ctx.createBufferSource(); gs.buffer = g; gs.connect(silent); }
        var at = ctx.currentTime + 0.05; s.start(at, 30); if (gs) gs.start(at, 30);
        var c0 = ctx.currentTime, p0 = performance.now();
        setTimeout(function () { elStart = el.currentTime; }, 1000);
        setTimeout(function () {
          var c1 = ctx.currentTime, p1 = performance.now();
          r.clockRate = Math.round((c1 - c0) / ((p1 - p0) / 1000) * 1000) / 1000;
          r.elAdvanced = elStart != null ? Math.round((el.currentTime - elStart) * 100) / 100 : null;
          try { s.stop(); if (gs) gs.stop(); } catch (e) {}
          silent.disconnect(); self.testing = false; self.testRestore = null;
          if (self.testAbort) { r.err = 'aborted: a song started (element left to the game)'; return done(r); }  // never touch the game's player
          el.pause(); el.volume = elVol;
          if (self.mode === 'element' && self._src) el.src = self._src; else el.removeAttribute('src');
          r.memMB = mem0 != null && performance.memory ? Math.round((performance.memory.usedJSHeapSize - mem0) / 1e5) / 10 : null;
          r.ctx = self.outputInfo();
          r.ok = r.clockRate > 0.97 && r.clockRate < 1.03 && r.decodeMs < 8000 && r.guideOk;
          done(r);
        }, secs * 1000);
      });
    });
  };
  window.KaraokeEngine = Engine;
})();
