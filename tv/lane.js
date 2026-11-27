/*
 * Pitch lane renderer tuned for TV SoCs (armv7, weak GPU):
 *  - static layer (staff lines, labels, now-line) drawn ONCE into its own canvas
 *  - the song is drawn into 1024 px wide tile canvases inside a strip that scrolls with
 *    translate3d (compositor-only); a tile is repainted only when a note gets scored or
 *    a new pitch segment lands on it (small incremental strokes, no shadows/blur)
 *  - a narrow overlay canvas around the now-line draws the live dot, active-note outline and
 *    a few sparks every frame
 */
(function (root) {
  'use strict';
  var TILE = 1024;
  var COLORS = { Perfect: '#3ff2ff', Great: '#59ffa8', Good: '#ffd75e', Miss: '#ff6b86' };

  function Lane(wrap, song, opts) {
    this.wrap = wrap; this.song = song;
    this.W = opts.width; this.H = opts.height; this.pad = 30;
    this.behind = opts.behind; this.ahead = opts.ahead;
    this.pps = Math.round(this.W / (this.behind + this.ahead));
    this.x0 = Math.round(this.W * opts.nowX);
    this.lo = song.lo; this.hi = song.hi;
    this.rowH = (this.H - 2 * this.pad) / (this.hi - this.lo);
    this.results = [];
    this.segs = []; // persistent trail/lit segments {t0,m0,t1,m1,col,lit,midi}
    this.tiles = {};
    wrap.innerHTML = '';
    this.staticCv = mk(this.W, this.H, 'lane-static'); wrap.appendChild(this.staticCv);
    this.strip = document.createElement('div'); this.strip.className = 'lane-strip'; wrap.appendChild(this.strip);
    // live dot + active-note outline are plain composited DOM elements moved with transforms
    this.outline = document.createElement('div'); this.outline.className = 'lane-outline'; wrap.appendChild(this.outline);
    this.dotEl = document.createElement('div'); this.dotEl.className = 'lane-dot'; this.dotEl.innerHTML = '<i></i>'; wrap.appendChild(this.dotEl);
    this.dot = null; this.lastX = null; this.activeK = -1; this.dotState = ''; this.outlineX = null;
    this.drawStatic();
  }
  var RES = 0.5; // canvases rendered at half resolution; the GPU upscales them (4x less raster/upload work)
  function mk(w, h, cls) {
    var c = document.createElement('canvas'); c.width = Math.round(w * RES); c.height = Math.round(h * RES); c.className = cls;
    c.style.width = w + 'px'; c.style.height = h + 'px';
    c.getContext('2d').setTransform(RES, 0, 0, RES, 0, 0);
    return c;
  }
  Lane.prototype.Y = function (m) { return this.pad + (this.hi - m) / (this.hi - this.lo) * (this.H - 2 * this.pad); };
  Lane.prototype.drawStatic = function () {
    var g = this.staticCv.getContext('2d');
    g.font = '20px sans-serif';
    for (var m = this.lo; m <= this.hi; m++) {
      var y = Math.round(this.Y(m));
      g.fillStyle = (m % 12 === 0) ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.04)';
      g.fillRect(0, y, this.W, (m % 12 === 0) ? 2 : 1);
      if (m % 12 === 0) { g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillText('C' + (m / 12 - 1), 10, y - 6); }
    }
    var grd = g.createLinearGradient(0, 0, 0, this.H);
    grd.addColorStop(0, 'rgba(255,63,164,0)'); grd.addColorStop(0.5, 'rgba(255,63,164,1)'); grd.addColorStop(1, 'rgba(255,63,164,0)');
    g.fillStyle = grd; g.fillRect(this.x0 - 2, 0, 4, this.H);
  };
  Lane.prototype.tile = function (i) {
    var t = this.tiles[i];
    if (!t) {
      var cv = mk(TILE, this.H, 'lane-tile');
      this.strip.appendChild(cv);
      t = this.tiles[i] = { cv: cv, g: cv.getContext('2d'), i: i, x: null };
      this.paintTile(t);
    }
    return t;
  };
  Lane.prototype.paintTile = function (t) {
    var g = t.g, x0 = t.i * TILE, self = this, pps = this.pps;
    g.clearRect(0, 0, TILE, this.H);
    this.song.notes.forEach(function (n, k) {
      var xa = n.t * pps - x0, xb = (n.t + n.d) * pps - x0;
      if (xb < 0 || xa > TILE) return;
      var r = self.results[k], h = self.rowH * 0.9, y = self.Y(n.midi) - h / 2;
      g.globalAlpha = r ? 0.5 : 0.9;
      g.fillStyle = r ? COLORS[r.rating] : '#b9a6ff';
      rr(g, xa, y, Math.max(6, xb - xa), h, h / 2); g.fill();
    });
    g.globalAlpha = 1;
    for (var s = 0; s < this.segs.length; s++) this.paintSeg(g, this.segs[s], x0);
  };
  Lane.prototype.paintSeg = function (g, s, x0) {
    var xa = s.t0 * this.pps - x0, xb = s.t1 * this.pps - x0;
    if (xb < -10 || xa > TILE + 10) return;
    if (s.lit) { g.fillStyle = s.col; g.fillRect(xa, this.Y(s.midi) - this.rowH * 0.28, xb - xa + 1, this.rowH * 0.56); }
    g.strokeStyle = s.col; g.lineWidth = 6; g.lineCap = 'round';
    g.beginPath(); g.moveTo(xa, this.Y(s.m0)); g.lineTo(xb, this.Y(s.m1)); g.stroke();
  };
  /** Add a trail segment between two consecutive pitch frames (song-time t, folded midi m). */
  Lane.prototype.addSegment = function (s) {
    s.m0 = clamp(s.m0, this.lo, this.hi); s.m1 = clamp(s.m1, this.lo, this.hi);
    this.segs.push(s);
    // Batched: every canvas draw re-uploads the whole tile texture on the TV GPU, and pitch frames arrive ~94/s.
    // Trail segments are queued and flushed into the tiles ~7 times a second (the live dot stays per-frame DOM).
    (this.pending = this.pending || []).push(s);
  };
  Lane.prototype.flushSegments = function (force) {
    var now = performance.now();
    if (!this.pending || !this.pending.length || (!force && now - (this.lastFlush || 0) < 140)) return;
    this.lastFlush = now;
    for (var k = 0; k < this.pending.length; k++) {
      var s = this.pending[k], a = Math.floor(s.t0 * this.pps / TILE), b = Math.floor(s.t1 * this.pps / TILE);
      for (var i = a; i <= b; i++) if (this.tiles[i]) this.paintSeg(this.tiles[i].g, s, i * TILE);
    }
    this.pending = [];
  };
  Lane.prototype.markScored = function (k, r) {
    this.results[k] = r;
    var n = this.song.notes[k];
    var a = Math.floor(n.t * this.pps / TILE), b = Math.floor((n.t + n.d) * this.pps / TILE);
    for (var i = a; i <= b; i++) if (this.tiles[i]) this.paintRegion(this.tiles[i], n.t * this.pps - i * TILE - 8, (n.t + n.d) * this.pps - i * TILE + 8);
  };
  /** Repaint only the columns [xa, xb] of a tile (clip), instead of the whole 1024 px tile. */
  Lane.prototype.paintRegion = function (t, xa, xb) {
    xa = Math.max(0, Math.floor(xa)); xb = Math.min(TILE, Math.ceil(xb));
    if (xb <= xa) return;
    var g = t.g, x0 = t.i * TILE, self = this, pps = this.pps;
    g.save(); g.beginPath(); g.rect(xa, 0, xb - xa, this.H); g.clip();
    g.clearRect(xa, 0, xb - xa, this.H);
    this.song.notes.forEach(function (n, k) {
      var na = n.t * pps - x0, nb = (n.t + n.d) * pps - x0;
      if (nb < xa || na > xb) return;
      var r = self.results[k], h = self.rowH * 0.9, y = self.Y(n.midi) - h / 2;
      g.globalAlpha = r ? 0.5 : 0.9;
      g.fillStyle = r ? COLORS[r.rating] : '#b9a6ff';
      rr(g, na, y, Math.max(6, nb - na), h, h / 2); g.fill();
    });
    g.globalAlpha = 1;
    var ta = (x0 + xa - 10) / pps, tb = (x0 + xb + 10) / pps;
    for (var s = 0; s < this.segs.length; s++) { var sg = this.segs[s]; if (sg.t1 >= ta && sg.t0 <= tb) this.paintSeg(g, sg, x0); }
    g.restore();
  };
  Lane.prototype.setLive = function (p, slot) { // {t, m, ys, c, hz, note, color?}; one live dot per player slot
    slot = slot || 0;
    if (!this.dots) this.dots = {};
    var d = this.dots[slot];
    if (!d) {
      var el = document.createElement('div'); el.className = 'lane-dot'; el.innerHTML = '<i></i>';
      if (slot === 0 || !p.color) { el = this.dotEl; if (p.color) { el.style.background = p.color + '73'; el.querySelector('i').style.background = p.color; } } else { el.style.background = p.color + '73'; el.querySelector('i').style.background = p.color; this.wrap.appendChild(el); }
      d = this.dots[slot] = { el: el, state: '', p: null };
    }
    if (d.p && p.t - d.p.t < 0.3) p.ys = d.p.ys; else p.ys = p.m;
    d.p = p;
    if (slot === 0 || !this.dot || this.dotSlot === slot) { this.dot = p; this.dotSlot = slot; }
  };
  /** Per frame: scroll (compositor), overlay (small canvas). t = heard song time. */
  Lane.prototype.draw = function (t, dev) {
    dev = dev || {};
    this.flushSegments(false);
    // Each visible tile is its own small layer positioned inside the viewport (never one huge
    // scrolling layer, which overflows the GPU's max texture size on the TV).
    var left = Math.round(t * this.pps) - this.x0;
    var first = Math.floor(left / TILE), last = Math.floor((left + this.W) / TILE);
    if (dev.tiles !== false) for (var i = first; i <= last; i++) if (i >= 0) {
      var tl = this.tile(i), x = i * TILE - left;
      if (tl.x !== x) { tl.cv.style.transform = 'translate3d(' + x + 'px,0,0)'; tl.x = x; }
    }
    for (var key in this.tiles) if (+key < first || +key > last) { this.strip.removeChild(this.tiles[key].cv); delete this.tiles[key]; }
    var self = this;
    var X = function (tt) { return (tt - t) * self.pps + self.x0; };
    // active-note outline: size changes once per note; position via transform each frame
    var act = -1;
    for (var k = 0; k < this.song.notes.length; k++) {
      var n = this.song.notes[k];
      if (n.t > t) break;
      if (t <= n.t + n.d && !this.results[k]) act = k;
    }
    if (act !== this.activeK) {
      this.activeK = act;
      if (act >= 0) {
        var an = this.song.notes[act], h = this.rowH * 0.9;
        this.outline.style.width = Math.round(an.d * this.pps) + 'px'; this.outline.style.height = Math.round(h) + 'px';
        this.outline.style.display = 'block'; this.outlineY = Math.round(this.Y(an.midi) - h / 2);
      } else this.outline.style.display = 'none';
    }
    if (act >= 0) {
      var ox = Math.round(X(this.song.notes[act].t));
      if (ox !== this.outlineX) { this.outline.style.transform = 'translate3d(' + ox + 'px,' + this.outlineY + 'px,0)'; this.outlineX = ox; }
    }
    var dots = this.dots || {}, nowMs = performance.now(), dtMs = Math.min(100, nowMs - (this.lastDrawMs || nowMs)), ease = 1 - Math.exp(-dtMs / 22); this.lastDrawMs = nowMs;
    for (var key in dots) {
      var D = dots[key], dp = D.p, multi = !!dp && !!dp.color;   // v13.15: any dot with a player colour uses it (solo too)
      if (dp) dp.ys += (dp.m - dp.ys) * ease; // frame-rate independent glide between phone frames
      if (dev.overlay !== false && dp && t - dp.t < 0.35) {
        var cls = multi ? 'pl' : dp.c <= 35 ? 'p' : dp.c <= 100 ? 'g' : dp.c <= 170 ? 'o' : 'm';
        if (cls !== D.state) { D.el.className = 'lane-dot on ' + cls; D.state = cls; }
        D.el.style.transform = 'translate3d(' + Math.round(X(dp.t)) + 'px,' + Math.round(this.Y(clamp(dp.ys, this.lo, this.hi))) + 'px,0)';
      } else if (D.state !== 'off') { D.el.className = 'lane-dot'; D.state = 'off'; }
    }
  };
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rr(g, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  Lane.COLORS = COLORS;
  root.KaraokeLane = Lane;
})(window);
