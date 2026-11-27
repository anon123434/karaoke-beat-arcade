/* Beat mode v2: the DualSense as an instrument.
 * Lanes (like a drum kit + bass):  0 ✕ kick · 1 ○ snare · 2 □ hi-hat · 3 △ crash
 *   4 ↑ bass rising · 5 ↓ bass falling · 6 ← bass repeat · 7 → bass jump · 8 L1 held pad · 9 R1 accent
 * Charts: song.json "chart" (tools/chart.py, onsets from Demucs drums/bass/other stems), filtered per difficulty;
 * fallback = steady beat grid (song.json "beats"). Highway columns are laid out like the controller:
 * left hand = L1 + D-pad diamond, right hand = face-button diamond + R1. Remote (no controller) = face diamond on the arrows.
 * Rendering: sprites pre-rendered once to canvases -> data URLs; every per-frame change is a transform. */
(function (root) {
  var LANES = [
    { sym: '\u2715', name: 'Kick', short: 'Kick', col: '#4f9dff', btn: [0], key: 40, arrow: '\u25bc', snd: 'kick' },
    { sym: '\u25cb', name: 'Snare', short: 'Snr', col: '#ff4fa8', btn: [1], key: 39, arrow: '\u25b6', snd: 'snare' },
    { sym: '\u25a1', name: 'Hi-hat', short: 'Hat', col: '#a66bff', btn: [2], key: 37, arrow: '\u25c0', snd: 'hat' },
    { sym: '\u25b3', name: 'Crash', short: 'Crash', col: '#2fe6c8', btn: [3], key: 38, arrow: '\u25b2', snd: 'crash' },
    { sym: '\u25b2', name: 'Bass \u2191', short: '\u2191', col: '#ffc23d', btn: [12], snd: 'bass' },
    { sym: '\u25bc', name: 'Bass \u2193', short: '\u2193', col: '#ffc23d', btn: [13], snd: 'bass' },
    { sym: '\u25c0', name: 'Bass =', short: '=', col: '#ffc23d', btn: [14], snd: 'bass' },
    { sym: '\u25b6', name: 'Bass jump', short: 'Jump', col: '#ffc23d', btn: [15], snd: 'bass' },
    { sym: 'L1', name: 'Pad (hold)', short: 'Pad', col: '#7f8cff', btn: [4, 6], snd: 'pad' },
    { sym: 'R1', name: 'Accent', short: 'Acc', col: '#ffe36e', btn: [5, 7], snd: 'accent' }
  ];
  var PAD_COLS = [8, 6, 4, 5, 7, 2, 3, 0, 1, 9], REMOTE_COLS = [2, 3, 0, 1];
  var YOFF = { 8: -64, 9: -64, 4: -30, 3: -30, 5: 30, 0: 30 };
  var DIFF = {
    easy: { lvl: 1, gap: 0.18, lane: 0.2, win: 1.3, pps: 360, pad: [0, 1, 3, 9], remote: [0, 1, 3] },
    normal: { lvl: 2, both: 0.12, gap: 0.14, lane: 0.15, win: 1.0, pps: 430, pad: [0, 1, 2, 3, 4, 5, 6, 7, 9], remote: [0, 1, 2, 3] },
    hard: { lvl: 3, both: 0.1, gap: 0.12, lane: 0.12, win: 0.9, pps: 510, pad: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], remote: [0, 1, 2, 3] }
  };
  var PRIO = { 9: 0, 3: 1, 0: 2, 1: 3, 4: 4, 5: 4, 6: 4, 7: 4, 8: 5, 2: 6 };
  var WIN = { Perfect: 0.05, Great: 0.10, Good: 0.15 };
  var PTS = { Perfect: 1, Great: 0.75, Good: 0.45, Miss: 0 };
  var MOTIF = [[0, 1, 0, 1], [0, 0, 1, 3], [0, 1, 0, 2], [3, 1, 0, 1]];
  function left(l) { return l >= 4 && l <= 8; }

  // ---------- chart shaping (v4): grid-aware reduction, section energy, fills, consistency ----------
  // Rock Band reduction rules + Beat Saber/DDR mapping practice (see .local/beatmap-design.md):
  //  easy = the backbone on the beat (quarter notes), one limb at a time; louder sections may add 8ths
  //  normal = up to 8th notes, nothing on 16ths between time-keeping hits; quiet sections drop hats + bass (rest)
  //  hard = the real performance up to 16ths, kicks thinned (no back-to-back 16th kicks), no kicks inside fills
  //  fills (snare rolls at the end of a bar) move to the D-pad as a ▲◀▶▼ tom sweep (pad, normal+hard)
  // Positions are classified on the song's beat grid; note TIMES stay on the real drum hits (never snapped).
  function gridOf(bt) {
    return function (t) {
      var lo = 0, hi = bt.length - 2; if (hi < 0) return null;
      if (t < bt[0] || t > bt[bt.length - 1]) return null;
      while (lo < hi) { var m = (lo + hi + 1) >> 1; if (bt[m] <= t) lo = m; else hi = m - 1; }
      var L = bt[lo + 1] - bt[lo], f = (t - bt[lo]) / L, f4 = f * 4, q = Math.round(f4), dev4 = Math.abs(f4 - q) * L / 4, f3 = f * 3, q3 = Math.round(f3), dev3 = Math.abs(f3 - q3) * L / 3;
      var k = q === 4 ? lo + 1 : lo; q = q % 4;
      var lvl = dev4 < 0.04 ? (q === 0 ? 0 : q === 2 ? 1 : 2) : dev3 < 0.035 ? (q3 % 3 === 0 ? 0 : q3 === 2 ? 1 : 2) : 3;   // 0 beat · 1 8th (or swung 8th) · 2 16th/triplet · 3 off-grid
      return { k: k, q: q, lvl: lvl, bar: Math.floor(k / 4), inBar: k % 4 };
    };
  }
  var GRID_MAX = { easy: 0, normal: 1, hard: 2 };
  function shape(song, ev, d, diff, input, allow, start, end) {
    var bt = song.beats && song.beats.t;
    var base = ev.filter(function (e) { return allow[e[1]] && e[0] >= start && e[0] <= end && e[4] < 4; });   // level 4 = ghost note, never charted
    if (!bt || bt.length < 16) return base.filter(function (e) { return e[4] <= d.lvl; });
    var at = gridOf(bt), nb = Math.ceil(bt.length / 4) + 1, energy = [], i;
    for (i = 0; i < nb; i++) energy.push(0);
    var info = ev.map(function (e) { var g = at(e[0]); if (g && e[1] <= 3) energy[g.bar] += e[1] <= 1 ? e[3] : e[3] * 0.5; return g; });
    var sm = energy.map(function (v, b) { var s = 0, n = 0; for (var j = Math.max(0, b - 2); j <= Math.min(nb - 1, b + 1); j++) { s += energy[j]; n++; } return s / n; });   // 4-bar sections
    var sorted = sm.filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
    function pct(b) { if (!sorted.length) return 0.5; var v = sm[b], lo = 0; while (lo < sorted.length && sorted[lo] < v) lo++; return lo / sorted.length; }
    // fills: end-of-bar snare rolls (more snare hits in beats 3-4 than 1-2, no hats there)
    var fill = {};
    if (input === 'pad' && diff !== 'easy') {
      var cnt = {}; ev.forEach(function (e, n) { var g = info[n]; if (!g || g.lvl > 2) return; var c = cnt[g.bar] || (cnt[g.bar] = { s1: 0, s2: 0, h2: 0 }); if (e[1] === 1) { if (g.inBar >= 2) c.s2++; else c.s1++; } if (e[1] === 2 && g.inBar >= 2) c.h2++; });
      for (var b in cnt) { var c = cnt[b]; if (c.s2 >= (diff === 'hard' ? 3 : 4) && c.s2 >= c.s1 + 2 && c.h2 <= 1) fill[b] = 1; }
    }
    var out = [], lastKick = null, sweep = [4, 6, 7, 5];
    base.forEach(function (e) {
      var g = at(e[0]), lane = e[1], strong = e[3];
      if (!g) { if (e[4] <= d.lvl) out.push(e); return; }
      var P = pct(g.bar), maxLvl = GRID_MAX[diff];
      if (diff === 'easy' && P >= 0.7 && lane <= 1) maxLvl = 1;                       // chorus / loudest sections: easy gets 8ths too
      var inFill = fill[g.bar] && g.inBar >= 2;
      if (inFill) {
        if (lane === 0 || lane === 2 || (lane >= 4 && lane <= 7)) return;            // no kicks, hats or bass inside a fill
        if (lane === 1 && allow[4]) { if (g.lvl > maxLvl) return; var fe = e.slice(); fe[1] = sweep[((g.inBar - 2) * 4 + g.q) % 4]; fe[5] = 0; out.push(fe); return; }
      }
      if (g.lvl > maxLvl && !(lane === 8) && e[7] !== 1.5) {
        if (!(diff === 'hard' && g.lvl === 3 && lane <= 1 && strong >= 0.5)) return;   // hard keeps strong real hits even off the grid (swing, pushes)
      }
      if (lane <= 1 && diff !== 'hard' && e[4] > d.lvl) return;   // v13.6: easy/normal take only the accented kicks/snares (level set by strength vs the local average)
      if (lane > 1 && e[4] > d.lvl) return;
      if (diff === 'normal' && P < 0.3 && (lane === 2 || (lane >= 4 && lane <= 7)) && e[7] !== 1.5) return;   // quiet section: rest the hats + bass
      if (diff === 'hard' && P < 0.15 && lane === 2) return;
      if (lane === 0 && diff === 'hard' && lastKick && g.k * 4 + g.q - lastKick === 1 && strong < 0.7) return;   // thin back-to-back 16th kicks
      if (lane === 0) lastKick = g.k * 4 + g.q;
      if (lane === 3 && diff === 'easy' && g.inBar !== 0 && e[7] !== 1.5) return;                     // easy: crashes only on bar starts
      out.push(e);
    });
    // pattern memory: bars with the same kit groove (kick/snare/crash positions) share one hat + bass pattern (majority vote),
    // so a repeated groove always charts the same way (players learn it; detection jitter can't reshuffle it)
    var bars = {}, keyOf = {};
    out.forEach(function (e) { var g = at(e[0]); if (!g) return; e._g = g; var B = bars[g.bar] || (bars[g.bar] = { kit: [], rest: {} }); if (e[1] <= 1 || e[1] === 3) B.kit.push(e[1] + '@' + g.inBar * 4 + g.q); else B.rest[e[1] + '@' + g.inBar * 4 + g.q] = 1; });
    var groups = {};
    for (var bb in bars) { var key = bars[bb].kit.sort().join(','); keyOf[bb] = key; (groups[key] || (groups[key] = [])).push(bb); }
    var keepRest = {};
    for (var key in groups) {
      var G = groups[key]; if (G.length < 3 || !key) continue;
      var votes = {}; G.forEach(function (b) { for (var r in bars[b].rest) votes[r] = (votes[r] || 0) + 1; });
      keepRest[key] = {}; for (var r in votes) if (votes[r] * 2 >= G.length) keepRest[key][r] = 1;
    }
    out = out.filter(function (e) {
      var g = e._g; delete e._g; if (!g || e[1] <= 1 || e[1] === 3 || e[1] === 8 || e[7] === 1.5) return true;
      if (fill[g.bar] && g.inBar >= 2) return true;
      var kr = keepRest[keyOf[g.bar]]; return !kr || !!kr[e[1] + '@' + g.inBar * 4 + g.q];
    });
    out.sort(function (x, y) { return x[0] - y[0]; });
    return out;
  }

  // density cap per 4-bar section (DDR/DDC: beginner ~1-2 steps/s, medium ~2-3, hard ~4+). Drops whole lane@position
  // slots in a fixed order (hats, bass, accents, off-beat kit, then crash) so repeated grooves stay identical.
  var CAP = { easy: 2.3, normal: 3.3, hard: 4.6 };
  var DROP_ORDER = [[2, 2], [2, 1], [4, 2], [5, 2], [6, 2], [7, 2], [9, 2], [2, 0], [4, 1], [5, 1], [6, 1], [7, 1], [0, 2], [1, 2], [9, 1], [0, 1], [1, 1], [4, 0], [5, 0], [6, 0], [7, 0], [3, 1]];   // [lane, grid level]
  function capDensity(out, song, diff) {
    var bt = song.beats.t, at = gridOf(bt), cap = CAP[diff] || 3.3, sec = {}, res = [];
    out.forEach(function (p) { var g = at(p.t), s = g ? Math.floor(g.bar / 4) : -1; p._lv = g ? g.lvl : 0; (sec[s] || (sec[s] = [])).push(p); });
    Object.keys(sec).forEach(function (s) {
      var L = sec[s]; if (s < 0 || L.length < 4) { res = res.concat(L); return; }
      var k0 = s * 16, dur = (bt[Math.min(bt.length - 1, k0 + 16)] - bt[Math.min(bt.length - 1, k0)]) || 1, max = Math.round(cap * dur);
      for (var o = 0; L.length > max && o < DROP_ORDER.length; o++) {
        var ln = DROP_ORDER[o][0], lv = DROP_ORDER[o][1];
        L = L.filter(function (p) { return p.solo || !(p.lane === ln && Math.min(2, p._lv) === lv); });
      }
      res = res.concat(L);
    });
    res.forEach(function (p) { delete p._lv; });
    return res.sort(function (a, b) { return a.t - b.t; });
  }

  // ---------- chart: song.chart events -> playable prompts ----------
  // v13.7: "Mine" = the player's recorded map (song.custom from Record map). Played exactly as recorded on every difficulty
  // (remote: face lanes only). merge: the auto chart fills the time outside the recorded sections. song.__range limits a preview.
  function inRanges(t, R) { for (var i = 0; R && i < R.length; i++) if (t >= R[i][0] && t < R[i][1]) return true; return false; }
  function customOf(song) { return song.__draft || (song.pick === 'mine' && song.custom && song.custom.ev && song.custom.ev.length ? song.custom : null); }
  function chart(song, diff, input) {
    var C = customOf(song), out;
    if (C) {
      var d0 = DIFF[diff] || DIFF.normal, al = {}; (input === 'pad' ? d0.pad.concat([8]) : d0.remote).forEach(function (l) { al[l] = 1; });
      if (input === 'pad') for (var q = 0; q < 10; q++) al[q] = 1;
      out = C.ev.filter(function (e) { return al[e[1]]; }).map(function (e) { return { t: e[0], lane: e[1], dur: e[2] || 0, midi: 0 }; });
      if (C.merge) out = out.concat(chartAuto(song, diff, input).filter(function (p) { return !inRanges(p.t, C.sections); }));
      out.sort(function (a, b) { return a.t - b.t || a.lane - b.lane; });
    } else out = chartAuto(song, diff, input);
    if (song.__range) out = out.filter(function (p) { return p.t >= song.__range[0] && p.t < song.__range[1]; });
    return out;
  }
  function chartAuto(song, diff, input) {
    var d = DIFF[diff] || DIFF.normal, allow = {}, out = [];
    (input === 'pad' ? d.pad : d.remote).forEach(function (l) { allow[l] = 1; });
    var ev = song.chart && song.chart.ev ? song.chart.ev : null;
    if (ev && song.chart.drums === false && song.beats && song.beats.t) {   // no real drums: kit lanes follow the beat, the rest follows the stems
      ev = ev.slice(); song.beats.t.forEach(function (t, k) { if (!song.beats.e || song.beats.e[k] >= 0.12) ev.push([t, k % 2 ? 1 : 0, 0, 0.6, k % 2 ? 2 : 1, 0]); });
      ev.sort(function (x, y) { return x[0] - y[0]; });
    }
    var start = 2.0, end = (song.duration || 1e9) - 0.5;
    if (ev && ev.length > 60) {
      var cand = shape(song, ev, d, diff, input, allow, start, end);
      // kick + snare are the backbone (every one, on its real hit): hi-hats near one give way so they can't block it
      var kitT = cand.filter(function (e) { return e[1] <= 1; }).map(function (e) { return e[0]; }), kj = 0;
      cand = cand.filter(function (e) {
        if (e[1] !== 2) return true;
        while (kj < kitT.length && kitT[kj] < e[0] - d.gap) kj++;
        return !(kj < kitT.length && Math.abs(kitT[kj] - e[0]) < d.gap) && !(kj > 0 && Math.abs(kitT[kj - 1] - e[0]) < d.gap) && !(kj + 1 < kitT.length && Math.abs(kitT[kj + 1] - e[0]) < d.gap);
      });
      var lastAny = { L: -9, R: -9 }, lastLane = {}, lastT = -9;
      for (var i = 0; i < cand.length;) {
        var j = i; while (j < cand.length && cand[j][0] - cand[i][0] < 0.03) j++;
        var grp = cand.slice(i, j).sort(function (a, b) { return PRIO[a[1]] - PRIO[b[1]] || b[3] - a[3]; });
        var took = { L: 0, R: 0 };
        grp.forEach(function (e) {
          var hand = left(e[1]) ? 'L' : 'R', t = e[0];
          if (took.kit === 1 - e[1] && e[1] <= 1 && t - (lastLane[e[1]] || -9) >= d.lane) {   // kick + snare together = a ✕+○ chord (one thumb)
            took.kit = 2; lastLane[e[1]] = t; out.push({ t: t, lane: e[1], dur: 0, midi: 0 }); return;
          }
          if (took[hand]) return;                                           // one button per hand at a time
          if (input !== 'pad' || diff === 'easy') { if (took.L || took.R || t - lastT < d.gap) return; }
          else if (t - lastAny[hand] < d.gap || (!(took.L || took.R) && t - lastT < d.both) || ((took.L || took.R) && diff !== 'hard' && e[3] < 0.7)) return;
          if (t - (lastLane[e[1]] || -9) < d.lane) return;
          took[hand] = 1; lastAny[hand] = t; lastLane[e[1]] = t; lastT = t; if (e[1] <= 1) took.kit = e[1];
          out.push({ t: t, lane: e[1], dur: e[1] === 8 ? e[2] : 0, midi: e[5] || 0, solo: e[7] === 1.5 ? 1 : 0 });
          if (e[1] === 8) lastAny.L = t + e[2];                              // left hand busy while holding
        });
        i = j;
      }
      if (song.beats && song.beats.t && song.beats.t.length > 16) out = capDensity(out, song, diff);
      if (out.length > 30) return out;
      out = [];
    }
    // fallback: steady beat grid (songs without a usable chart, e.g. the synthetic demos)
    var b = song.beats; if (!b || !b.t) return [];
    var step = diff === 'easy' ? 2 : 1;
    for (var k = 0; k < b.t.length; k++) {
      var t = b.t[k]; if (t < start || t > end || k % step) continue;
      if (b.e && b.e[k] < 0.12) continue;
      out.push({ t: t, lane: MOTIF[Math.floor(k / 8) % MOTIF.length][k % 4], dur: 0, midi: 0 });
    }
    return out;
  }

  // ---------- pre-rendered sprites ----------
  var spriteCache = {};
  function cv(w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  // v13.8 premium look: glossy glowing orbs with the PlayStation symbol, matching glowing target rings (all pre-rendered once)
  function orb(g, cx, cy, r, col, shoulder) {
    g.beginPath(); if (shoulder) roundRect(g, cx - r * 1.05, cy - r * 0.62, r * 2.1, r * 1.24, r * 0.5); else g.arc(cx, cy, r, 0, Math.PI * 2);
  }
  function gemSprite(lane, gs, trail) {
    var key = 'g' + lane + ':' + gs + ':' + trail; if (spriteCache[key]) return spriteCache[key];
    var L = LANES[lane], pad = 22, w = gs + pad * 2, h = gs + trail + pad * 2, c = cv(w, h), g = c.getContext('2d');
    var cx = w / 2, cy = trail + pad + gs / 2, r = gs / 2, shoulder = lane >= 8;
    var tg = g.createLinearGradient(0, pad, 0, cy); tg.addColorStop(0, 'rgba(0,0,0,0)'); tg.addColorStop(1, L.col + '66');
    g.fillStyle = tg; g.fillRect(cx - r * 0.34, pad, r * 0.68, cy - pad);                       // comet trail
    var halo = g.createRadialGradient(cx, cy, r * 0.7, cx, cy, r + pad); halo.addColorStop(0, L.col + 'aa'); halo.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = halo; g.fillRect(cx - r - pad, cy - r - pad, gs + pad * 2, gs + pad * 2);       // outer glow
    orb(g, cx, cy, r, L.col, shoulder);
    var bg = g.createRadialGradient(cx - r * 0.25, cy - r * 0.35, r * 0.05, cx, cy, r * 1.05);
    bg.addColorStop(0, '#ffffff'); bg.addColorStop(0.18, L.col); bg.addColorStop(0.7, shade(L.col, 0.55)); bg.addColorStop(1, shade(L.col, 0.25));
    g.fillStyle = bg; g.fill();
    g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,.9)'; g.stroke();
    g.lineWidth = 2; g.strokeStyle = L.col; orb(g, cx, cy, r - 4, L.col, shoulder); g.stroke();
    g.beginPath(); g.ellipse ? g.ellipse(cx - r * 0.1, cy - r * 0.5, r * 0.6, r * 0.24, -0.15, 0, Math.PI * 2) : g.arc(cx, cy - r * 0.45, r * 0.3, 0, Math.PI * 2);
    var gl = g.createLinearGradient(0, cy - r * 0.75, 0, cy - r * 0.25); gl.addColorStop(0, 'rgba(255,255,255,.75)'); gl.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gl; g.fill();                                                                     // gloss
    g.fillStyle = '#fff'; g.font = '900 ' + Math.round(gs * (shoulder ? 0.42 : 0.5)) + 'px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = shade(L.col, 0.3); g.shadowBlur = 6; g.fillText(L.sym, cx, cy + 1); g.shadowBlur = 0;
    return (spriteCache[key] = { c: c, w: w, h: h, ox: cx, oy: cy });
  }
  function ringSprite(lane, gs) {
    var key = 'r' + lane + ':' + gs; if (spriteCache[key]) return spriteCache[key];
    var L = LANES[lane], pad = 22, w = gs + pad * 2, c = cv(w, w), g = c.getContext('2d'), cx = w / 2, r = gs / 2, sh = lane >= 8;
    var halo = g.createRadialGradient(cx, cx, r * 0.6, cx, cx, r + pad); halo.addColorStop(0, L.col + '55'); halo.addColorStop(0.55, L.col + '22'); halo.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = halo; g.fillRect(0, 0, w, w);
    orb(g, cx, cx, r - 2, L.col, sh); var inner = g.createRadialGradient(cx, cx - r * 0.3, 0, cx, cx, r); inner.addColorStop(0, 'rgba(30,14,60,.55)'); inner.addColorStop(1, 'rgba(8,3,24,.85)');
    g.fillStyle = inner; g.fill();
    g.shadowColor = L.col; g.shadowBlur = 14; g.lineWidth = 5; g.strokeStyle = L.col; g.stroke(); g.shadowBlur = 0;
    g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,255,255,.7)'; orb(g, cx, cx, r - 2, L.col, sh); g.stroke();
    g.fillStyle = L.col; g.font = '900 ' + Math.round(gs * 0.42) + 'px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = L.col; g.shadowBlur = 8; g.fillText(L.sym, cx, cx + 1); g.shadowBlur = 0;
    return (spriteCache[key] = { c: c, w: w });
  }
  function glowSprite(size, col) {
    var key = 'f' + size + col; if (spriteCache[key]) return spriteCache[key];
    var c = cv(size, size), g = c.getContext('2d'), r = size / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, col); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, size, size); return (spriteCache[key] = c);
  }
  function burstSprite(size, col) {
    var key = 'b' + size + col; if (spriteCache[key]) return spriteCache[key];
    var c = cv(size, size), g = c.getContext('2d'), r = size / 2;
    g.shadowColor = col; g.shadowBlur = 10; g.lineWidth = 6; g.strokeStyle = col; g.beginPath(); g.arc(r, r, r - 10, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 2; g.strokeStyle = '#fff'; g.beginPath(); g.arc(r, r, r - 10, 0, Math.PI * 2); g.stroke();
    return (spriteCache[key] = c);
  }
  function ringHotSprite(lane, gs) {   // target ring brightened once (replaces per-frame 'lighter' compositing)
    var key = 'rh' + lane + ':' + gs; if (spriteCache[key]) return spriteCache[key];
    var base = ringSprite(lane, gs), c = cv(base.w, base.w), g = c.getContext('2d');
    g.drawImage(base.c, 0, 0); g.globalCompositeOperation = 'lighter'; g.drawImage(base.c, 0, 0); g.globalCompositeOperation = 'source-atop'; g.globalAlpha = 0.35; g.fillStyle = '#fff'; g.fillRect(0, 0, base.w, base.w);
    return (spriteCache[key] = { c: c, w: base.w });
  }
  function dotSprite(col) {
    var key = 'd' + col; if (spriteCache[key]) return spriteCache[key];
    var c = cv(24, 24), g = c.getContext('2d'), gr = g.createRadialGradient(12, 12, 0, 12, 12, 12);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.35, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 24, 24); return (spriteCache[key] = c);
  }
  function vignetteSprite(W, H, col, k) {   // streak / combo pulse: edge glow, quarter resolution, scaled up when drawn
    var key = 'v' + W + 'x' + H + col + k; if (spriteCache[key]) return spriteCache[key];
    var w = Math.round(W / 4), h = Math.round(H / 4), c = cv(w, h), g = c.getContext('2d'), e = k / 4;
    [['x', 0], ['x', 1], ['y', 0], ['y', 1]].forEach(function (s) {
      var gr = s[0] === 'x' ? g.createLinearGradient(s[1] ? w : 0, 0, s[1] ? w - e : e, 0) : g.createLinearGradient(0, s[1] ? h : 0, 0, s[1] ? h - e : e);
      gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    return (spriteCache[key] = c);
  }
  function textSprite(txt, size, col, glow) {   // judge / combo / banner words: rendered once, drawn with drawImage
    var key = 't' + txt + size + col + glow; if (spriteCache[key]) return spriteCache[key];
    var m = cv(4, 4).getContext('2d'); m.font = '900 ' + size + 'px sans-serif'; var w = Math.ceil(m.measureText(txt).width) + 40, h = Math.ceil(size * 1.4) + 20;
    var c = cv(w, h), g = c.getContext('2d'); g.font = '900 ' + size + 'px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (glow) { g.shadowColor = glow; g.shadowBlur = 12; }
    if (typeof col !== 'string') { var tg = g.createLinearGradient(0, h / 2 - size * 0.55, 0, h / 2 + size * 0.5); col.forEach(function (cc, ci) { tg.addColorStop(ci / (col.length - 1), cc); }); g.fillStyle = tg; } else g.fillStyle = col;
    g.fillText(txt, w / 2, h / 2); if (glow && typeof col !== 'string') { g.shadowBlur = 0; g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,250,220,.6)'; g.strokeText(txt, w / 2, h / 2); }
    var sp = { c: c, w: w, h: h }; if (Object.keys(spriteCache).length < 400) spriteCache[key] = sp; return sp;
  }
  // ---------- streak visuals (v13.5): tiers like Guitar Hero / Rock Band multipliers (x1 <10, x2 10+, x3 20+, x4 30+) ----------
  var TIERS = [{ col: '#8fc4ff', core: 4, glow: 16 }, { col: '#3ff2ff', core: 6, glow: 22 }, { col: '#ff3fa4', core: 8, glow: 28 }, { col: '#ffd75e', core: 11, glow: 36 }];
  function tierOf(c) { return c >= 30 ? 3 : c >= 20 ? 2 : c >= 10 ? 1 : 0; }
  var CORE_COL = ['#d8ecff', '#d6fdff', '#ffd6ec', '#fff4c8'];   // white-hot tint of each tier colour
  function stampSprite(ti, lit) {
    var key = 'st' + ti + lit; if (spriteCache[key]) return spriteCache[key];
    var T = TIERS[ti], sz = lit ? T.glow + T.core : Math.round((T.glow + T.core) * 0.6), c = cv(sz, sz), g = c.getContext('2d'), r = sz / 2, gr = g.createRadialGradient(r, r, 0, r, r, r), k = T.core / sz;
    if (lit) { gr.addColorStop(0, '#ffffff'); gr.addColorStop(k * 0.7, '#ffffff'); gr.addColorStop(k * 1.4, T.col); gr.addColorStop(0.62, T.col + '3a'); gr.addColorStop(1, 'rgba(0,0,0,0)'); }
    else { gr.addColorStop(0, T.col + 'aa'); gr.addColorStop(0.35, T.col + '55'); gr.addColorStop(1, 'rgba(0,0,0,0)'); }
    g.fillStyle = gr; g.fillRect(0, 0, sz, sz); return (spriteCache[key] = { c: c, s: sz });
  }
  function nodeSprite(ti) {
    var key = 'node' + ti; if (spriteCache[key]) return spriteCache[key];
    var T = TIERS[ti], sz = T.core * 4 + 18, c = cv(sz, sz), g = c.getContext('2d'), r = sz / 2, gr = g.createRadialGradient(r, r, 0, r, r, r);
    gr.addColorStop(0, '#ffffff'); gr.addColorStop(0.25, '#ffffff'); gr.addColorStop(0.4, T.col); gr.addColorStop(0.7, T.col + '44'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, sz, sz); return (spriteCache[key] = { c: c, s: sz });
  }
  function pipSprite(ti, on) {
    var key = 'pip' + ti + on; if (spriteCache[key]) return spriteCache[key];
    var c = cv(22, 30), g = c.getContext('2d'); g.beginPath(); roundRect(g, 3, 3, 16, 24, 5);
    if (on) { g.shadowColor = TIERS[ti].col; g.shadowBlur = 6; g.fillStyle = TIERS[ti].col; g.fill(); g.shadowBlur = 0; g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(6, 6, 10, 6); }
    else { g.fillStyle = 'rgba(255,255,255,.12)'; g.fill(); g.strokeStyle = 'rgba(255,255,255,.25)'; g.lineWidth = 1.5; g.stroke(); }
    return (spriteCache[key] = c);
  }
  var GOLD = ['#fffbe6', '#ffe27a', '#ffb52e', '#ff8a1c'];
  var JUDGE_STYLE = { Perfect: [64, GOLD, '#ff9f1c'], Great: [56, ['#e9fff4', '#59ffa8', '#1fc98a'], '#1a9'], Good: [46, ['#eaf6ff', '#9ad0ff'], null], Miss: [42, '#ff6b86', null] };
  function roundRect(g, x, y, w, h, r) { g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function shade(hex, k) { var n = parseInt(hex.slice(1), 16); k = k || 0.35; return 'rgb(' + Math.round((n >> 16) * k) + ',' + Math.round(((n >> 8) & 255) * k) + ',' + Math.round((n & 255) * k) + ')'; }
  function div(cls, parent) { var d = document.createElement('div'); d.className = cls; parent.appendChild(d); return d; }
  function tf(el, x, y, s) { el.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)' + (s ? ' scale(' + s + ')' : ''); }

  // ---------- the highway ----------
  function Beat(el, song, opts) {
    opts = opts || {};
    this.el = el; this.song = song; this.opts = opts; this.diff = DIFF[opts.diff] ? opts.diff : 'normal'; this.cfg = DIFF[this.diff];
    this.input = opts.input === 'pad' ? 'pad' : 'remote'; this.jam = !!opts.jam;
    this.W = opts.width || 1000; this.H = opts.height || 790;
    this.offset = opts.offsetMs != null ? opts.offsetMs / 1000 : 0;
    this.onJudge = opts.onJudge || function () {};
    this.rec = opts.rec || null;   // v13.7 Record map: { notes: [{t,lane,dur}], ghost: [{t,lane,dur}] } drawn, never judged
    this.prompts = this.jam || this.rec ? [] : chart(song, this.diff, this.input).map(function (p) { return { t: p.t, lane: p.lane, dur: p.dur, midi: p.midi, r: null, el: null, body: null, hold: 0 }; });
    this.units = 0; var self = this; this.prompts.forEach(function (p) { self.units += p.dur ? 2 : 1; });
    this.next = 0; this.counts = { Perfect: 0, Great: 0, Good: 0, Miss: 0 }; this.combo = 0; this.maxCombo = 0; this.pts = 0; this.judged = 0;
    this.errs = []; this.wrong = 0; this.presses = { remote: 0, pad: 0 }; this.holds = { ok: 0, dropped: 0 }; this.lastMidi = 0;
    this.root = bassRoot(song);
    this.build();
  }
  function bassRoot(song) {
    var ev = song.chart && song.chart.ev, cnt = {}, best = 40, bc = 0;
    (ev || []).forEach(function (e) { if (e[5]) { var m = e[5]; cnt[m] = (cnt[m] || 0) + 1; if (cnt[m] > bc) { bc = cnt[m]; best = m; } } });
    while (best > 47) best -= 12; while (best < 33) best += 12; return best;
  }
  Beat.chart = chart; Beat.chartAuto = chartAuto; Beat.LANES = LANES; Beat.WIN = WIN; Beat.DIFF = DIFF;
  Beat.padLane = function (btn) { for (var l = 0; l < LANES.length; l++) if (LANES[l].btn.indexOf(btn) >= 0) return l; return -1; };
  Beat.prototype.build = function () {
    var el = this.el, W = this.W, H = this.H, cols = this.input === 'pad' ? PAD_COLS : REMOTE_COLS, n = cols.length, self = this;
    el.innerHTML = ''; el.className = 'beat-track beat-' + this.input + (this.jam ? ' jam' : '');
    var side = 18, gapW = this.input === 'pad' ? 0.8 : 0, cw = (W - side * 2) / (n + gapW);
    this.gs = Math.round(Math.min(cw * 0.84, 82)); this.hitY = H - 150; this.colX = {}; this.tgtY = {};
    cols.forEach(function (lane, i) { self.colX[lane] = side + cw * (i + 0.5 + (self.input === 'pad' && i >= 5 ? gapW : 0)); self.tgtY[lane] = self.hitY + (YOFF[lane] || 0); });
    // static highway (drawn once)
    var bg = cv(W, H), g = bg.getContext('2d');
    // v13.8 neon highway: dark glass floor, a soft colour wash per lane, glowing lane-colour edge lines, a bright hit bar (all static)
    var hg = g.createLinearGradient(0, 0, 0, H); hg.addColorStop(0, 'rgba(12,4,36,0)'); hg.addColorStop(0.18, 'rgba(14,5,40,.78)'); hg.addColorStop(1, 'rgba(8,2,26,.94)');
    g.fillStyle = hg; g.fillRect(0, 0, W, H);
    var lw = cw * 0.92;
    cols.forEach(function (lane) {
      var x = self.colX[lane], col = LANES[lane].col, lg = g.createLinearGradient(0, 0, 0, H); lg.addColorStop(0, 'rgba(0,0,0,0)'); lg.addColorStop(0.75, col + '26'); lg.addColorStop(1, col + '0c');
      g.fillStyle = lg; g.fillRect(x - lw / 2, 0, lw, H);
      [-1, 1].forEach(function (sd) {   // neon edges of each lane
        var ex = Math.round(x + sd * lw / 2), eg = g.createLinearGradient(0, 0, 0, H); eg.addColorStop(0, 'rgba(0,0,0,0)'); eg.addColorStop(0.35, col + '70'); eg.addColorStop(0.85, col + 'cc'); eg.addColorStop(1, col + '30');
        g.fillStyle = eg; g.globalAlpha = 0.35; g.fillRect(ex - 4, 0, 8, H); g.globalAlpha = 1; g.fillRect(ex - 1, 0, 2, H);
      });
    });
    var outer = g.createLinearGradient(0, 0, 0, H); outer.addColorStop(0, 'rgba(0,0,0,0)'); outer.addColorStop(0.4, 'rgba(255,79,168,.8)'); outer.addColorStop(1, 'rgba(63,242,255,.9)');
    g.fillStyle = outer; g.fillRect(2, 0, 3, H); g.fillRect(W - 5, 0, 3, H);
    var hb = g.createLinearGradient(0, 0, W, 0); hb.addColorStop(0, 'rgba(63,242,255,0)'); hb.addColorStop(0.2, 'rgba(63,242,255,.55)'); hb.addColorStop(0.5, 'rgba(255,255,255,.75)'); hb.addColorStop(0.8, 'rgba(255,79,168,.55)'); hb.addColorStop(1, 'rgba(255,79,168,0)');
    g.fillStyle = hb; g.fillRect(0, self.hitY - 2, W, 4); g.globalAlpha = 0.25; g.fillRect(0, self.hitY - 10, W, 20); g.globalAlpha = 1;
    g.fillStyle = 'rgba(255,255,255,.55)'; g.font = '700 ' + Math.max(13, Math.round(cw * 0.2)) + 'px sans-serif'; g.textAlign = 'center';
    var narrow = cw < 75; cols.forEach(function (lane) { var L = LANES[lane]; g.fillStyle = L.col; g.fillText(self.input === 'remote' ? L.arrow + ' ' + L.name : narrow ? L.short : L.name, self.colX[lane], H - 34); });
    if (this.input === 'pad') { g.fillStyle = 'rgba(255,255,255,.35)'; g.font = '700 16px sans-serif'; g.fillText(narrow ? 'BASS + PAD' : 'LEFT HAND \u00b7 bass + pad', (self.colX[8] + self.colX[7]) / 2, H - 10); g.fillText(narrow ? 'DRUMS' : 'RIGHT HAND \u00b7 drums', (self.colX[2] + self.colX[9]) / 2, H - 10); }
    var bgEl = div('bt-bg', el); bgEl.style.backgroundImage = 'url(' + bg.toDataURL() + ')';
    this.flip = false;
    // everything that moves is drawn on ONE canvas per frame (TV GPU: no per-gem layers, no filters/blurred shadows)
    // 1:1 canvas (opts.res can lower it, but resampling every sprite costs more than it saves)
    var RS = this.res = opts_res(this), cvs = cv(Math.round(W * RS), Math.round(H * RS)); cvs.className = 'bt-cv'; cvs.style.width = W + 'px'; cvs.style.height = H + 'px';
    el.appendChild(cvs); this.cv = cvs; this.g = cvs.getContext('2d'); this.g.setTransform(RS, 0, 0, RS, 0, 0); this.g.imageSmoothingEnabled = true; this.g.lineCap = 'round';
    this.laneList = cols.slice();
    this.judgeSp = {}; for (var jr in JUDGE_STYLE) { var js = JUDGE_STYLE[jr]; this.judgeSp[jr] = textSprite(jr === 'Miss' ? 'MISS' : jr.toUpperCase(), js[0], js[1], js[2]); }
    this.digits = { n: [], hot: [] }; for (var dg = 0; dg < 10; dg++) { this.digits.n.push(textSprite(String(dg), 80, ['#ffffff', '#d9d2ff'], 'rgba(140,100,255,.8)')); this.digits.hot.push(textSprite(String(dg), 80, GOLD, '#ff9f1c')); }
    this.jt = { r: '', t: -9 }; this.ct = { n: 0, t: -9 }; this.bt = { sp: null, t: -9 }; this.scoreDirty = false; this.scoreAt = 0; this.scoreTxt = '';
    this.tgt = {}; this.fx = {}; this.sprite = {};
    cols.forEach(function (lane) {
      var fsz = Math.round(self.gs * 2.4), bsz = Math.round(self.gs * 1.6);
      self.tgt[lane] = ringSprite(lane, self.gs);
      var bf = []; for (var bi = 0; bi < 6; bi++) bf.push(burstSprite(Math.round(bsz * (0.6 + bi * 0.3)), LANES[lane].col));   // expanding ring: 6 pre-rendered sizes
      self.fx[lane] = { glow: glowSprite(fsz, LANES[lane].col), bursts: bf, ringHot: ringHotSprite(lane, self.gs), dot: dotSprite(LANES[lane].col), fsz: fsz, bsz: bsz, t: -9, r: '', miss: -9 };
      self.sprite[lane] = gemSprite(lane, self.gs, Math.round(self.gs * 0.9));
    });
    this.dotGold = dotSprite('#fff6c0');
    this.vig = { pink: vignetteSprite(W, H, 'rgba(255,63,164,.85)', 70), gold: vignetteSprite(W, H, 'rgba(255,215,94,.9)', 84), big: vignetteSprite(W, H, 'rgba(255,246,192,1)', 150) };
    this.pulseT = -9; this.pulseFlip = false; this.pulseEls = {};
    for (var vk in this.vig) { var pe = div('bt-pulse2', el); pe.style.backgroundImage = 'url(' + this.vig[vk].toDataURL() + ')'; this.pulseEls[vk] = pe; }
    this.MAXSPARK = 16; this.sparks = []; for (var si = 0; si < this.MAXSPARK; si++) this.sparks.push({ x: 0, y: 0, vx: 0, vy: 0, t: -9, img: null }); this.sparkI = 0;   // fixed ring pool: no per-hit allocation
    this.holdCol = LANES[8].col;
    this.scoreEl = div('bt-score', el);   // judge / combo / banner are drawn on the canvas (no per-hit DOM work)
    this.scoreEl.textContent = this.jam ? '\ud83c\udfb6 Jam · free play' : '\ud83e\udd41 ' + cap(this.diff) + ' \u00b7 0';
    this.beatIdx = 0; this.streak = false;
    // streak line: ring buffer of recent hit anchors (time + lane), shards on a break; meter + edge glow
    this.MAXA = 6; this.anch = []; for (var ai = 0; ai < this.MAXA; ai++) this.anch.push({ t: 0, lane: 0, ok: false, ti: 0 }); this.anchI = 0; this.anchN = 0;
    this.stamps = [0, 1, 2, 3].map(function (t) { return { lit: stampSprite(t, true), dim: stampSprite(t, false) }; }); this.nodes = [0, 1, 2, 3].map(nodeSprite);
    this.pips = [0, 1, 2, 3].map(function (t) { return { on: pipSprite(t, true), off: pipSprite(t, false) }; });
    this.multSp = [0, 1, 2, 3].map(function (t) { return textSprite('\u00d7' + (t + 1), 40, t ? TIERS[t].col : 'rgba(255,255,255,.7)', t ? TIERS[t].col : null); });
    this.maxSp = textSprite('MAX', 22, '#fff6c0', '#ff9f1c');
    this.shard = { t: -9, n: 0, seg: [] }; for (var sh = 0; sh < this.MAXA; sh++) this.shard.seg.push({ x1: 0, y1: 0, x2: 0, y2: 0, vx: 0, vy: 0, ti: 0 });
    this.tierT = -9; this.tier = 0; this.lastH = 0;
    this.edge = document.createElement('div'); this.edge.className = 'bt-edge'; el.insertBefore(this.edge, this.cv);   // behind the canvas: glows the highway, never washes out gems / meter this.edge.style.backgroundImage = 'url(' + vignetteSprite(W, H, 'rgba(255,215,94,1)', 60).toDataURL() + ')';
  };
  function opts_res(b) { return b.opts && b.opts.res ? b.opts.res : 1; }   // 0.75 measured SLOWER (resampling every sprite); keep 1:1
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  Beat.prototype.give = function () {};   // (canvas renderer: nothing pooled)
  Beat.prototype.score = function () { return this.units ? Math.round(100 * this.pts / this.units) : 0; };
  function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000; }
  Beat.prototype.fxHit = function (lane, r) {
    var f = this.fx[lane]; if (!f) return; f.t = now(); f.r = r;
    var nsp = r === 'Perfect' ? 4 : r === 'Great' ? 2 : 0, x = this.colX[lane], y = this.tgtY[lane];
    for (var i = 0; i < nsp; i++) {
      var a = (i / nsp) * Math.PI * 2 + (f.t * 7 % 1), sp = 190 + 60 * (i % 2);
      var S = this.sparks[this.sparkI]; this.sparkI = (this.sparkI + 1) % this.MAXSPARK;
      S.x = x; S.y = y; S.vx = Math.cos(a) * sp; S.vy = Math.sin(a) * sp; S.t = f.t; S.img = r === 'Perfect' && i % 2 ? this.dotGold : f.dot;
    }
  };
  Beat.prototype.fxMiss = function (lane) { var f = this.fx[lane]; if (f) f.miss = now(); };
  Beat.prototype.showJudge = function (txt, cls) { this.jt.r = cls; this.jt.t = now(); };
  Beat.prototype.judge = function (p, r, err) {
    p.r = r; this.counts[r]++; this.pts += PTS[r]; this.judged++;
    if (r === 'Miss') {
      if (this.combo >= 3) this.shatter(); this.pts += 0; this.combo = 0; this.fxMiss(p.lane); if (p.dur) this.holds.dropped++; this.setTier(0);
      if (this.streak) this.streak = false;
    } else {
      this.combo++; if (this.combo > this.maxCombo) this.maxCombo = this.combo; if (err != null) this.errs.push(err);
      this.fxHit(p.lane, r);
      if (this.combo >= 20 && !this.streak) this.streak = true;
      var A = this.anch[this.anchI]; A.t = p.t; A.lane = p.lane; A.ok = true; A.ti = tierOf(this.combo); this.anchI = (this.anchI + 1) % this.MAXA; this.anchN++;
      this.setTier(tierOf(this.combo));
      if (this.combo % 50 === 0) { this.bt.sp = textSprite(this.combo + ' NOTE STREAK!', Math.min(72, Math.floor((this.W - 40) / 10.5)), '#ffffff', TIERS[this.tier].col); this.bt.t = now(); this.pulseNow(true); }
    }
    if (!p.dur || r === 'Miss') this.give(p);
    this.showJudge(r === 'Miss' ? 'MISS' : r.toUpperCase(), r);
    if (this.combo !== this.ct.n) { this.ct.n = this.combo; this.ct.t = now(); }
    this.scoreDirty = true;   // score text: change-only, at most 4x per second (in draw)
    this.onJudge(r, this, p.lane);
  };
  Beat.prototype.setTier = function (t) {
    if (t === this.tier) return; var up = t > this.tier; this.tier = t; this.tierT = up ? now() : -9;
    if (this.edge) this.edge.className = 'bt-edge' + (t === 3 ? ' on' : '');   // max tier: highway edges glow (DOM opacity, compositor only)
  };
  // a break: the live chain freezes into shards that fall apart and fade (0.55 s)
  Beat.prototype.shatter = function () {
    var S = this.shard, pts = this.chainPts(this.lastH), n = 0;
    for (var i = 0; i + 1 < pts.length && n < this.MAXA; i++) {
      var a = pts[i], b = pts[i + 1], q = S.seg[n++], k = (i * 7919) % 13 / 13;
      q.x1 = a.x; q.y1 = a.y; q.x2 = b.x; q.y2 = b.y; q.vx = (k - 0.5) * 260; q.vy = -120 - 140 * k; q.ti = a.ti;
    }
    S.n = n; S.t = now();
    for (i = 0; i < this.MAXA; i++) this.anch[i].ok = false;
  };
  // positions of the live chain (oldest -> newest hit), still on screen
  Beat.prototype.chainPts = function (h) {
    var out = this._pts || (this._pts = []), pps = this.cfg.pps; out.length = 0;
    for (var k = 0; k < this.MAXA; k++) {
      var A = this.anch[(this.anchI + k) % this.MAXA]; if (!A.ok) continue;
      var y = this.tgtY[A.lane] - (A.t - h) * pps; if (y > this.H + 20) continue;
      out.push({ x: this.colX[A.lane], y: y, ti: A.ti, age: h - A.t });
    }
    return out;
  };
  // glowing segment = pre-rendered glow disc stamped every few px (plain blits: no rotation, scaling, blur or shadow)
  Beat.prototype.beam = function (x1, y1, x2, y2, ti, alpha, dim) {
    // queue only; flushBeams() draws every queued segment as ONE path per (tier, lit/dim, alpha bucket):
    // layered strokes, no blur / shadow -> wide translucent tier glow, tier-colour band, white-hot core.
    // (stamping sprites or stroking each segment separately cost ~20-25% fps on dense charts in the stress test)
    if (Math.abs(x2 - x1) + Math.abs(y2 - y1) < 2 || alpha < 0.03) return;
    var k = ti * 2 + (dim ? 1 : 0) + 8 * Math.min(4, Math.round(alpha * 4)), q = this._bq || (this._bq = {}), L = q[k] || (q[k] = []);
    L.push(x1, y1, x2, y2);
  };
  Beat.prototype.flushBeams = function () {
    var q = this._bq; if (!q) return; var g = this.g;
    for (var k in q) {
      var L = q[k]; if (!L.length) continue;
      var kk = +k, a = Math.floor(kk / 8) / 4, ti = (kk % 8) >> 1, dim = kk & 1, T = TIERS[ti];
      g.beginPath(); for (var i = 0; i < L.length; i += 4) { g.moveTo(L[i], L[i + 1]); g.lineTo(L[i + 2], L[i + 3]); }
      g.strokeStyle = T.col;
      if (dim) { g.globalAlpha = a * 0.55; g.lineWidth = T.core * 1.4; g.stroke(); }
      else {
        g.globalAlpha = a * 0.3; g.lineWidth = T.core * 3.2; g.stroke();
        g.globalAlpha = a * 0.9; g.lineWidth = T.core * 1.7; g.stroke();
        g.globalAlpha = a; g.strokeStyle = CORE_COL[ti]; g.lineWidth = T.core * 0.8; g.stroke();
      }
      L.length = 0;
    }
    g.globalAlpha = 1;
  };
  Beat.prototype.drawStreak = function (h, T) {
    var g = this.g, P = this.prompts, pps = this.cfg.pps, i;
    // live chain: consecutive hit gems joined by a glowing line; thickness / colour by streak tier, fading as it scrolls past the strike line
    if (this.combo >= 3) {
      var pts = this.chainPts(h), H = this.H, fadeAt = H - 70;
      for (i = 0; i + 1 < pts.length; i++) {
        var a = pts[i], b = pts[i + 1], fa = a.y < fadeAt ? 1 : Math.max(0, 1 - (a.y - fadeAt) / 90);
        if (fa > 0.02) this.beam(a.x, a.y, b.x, b.y, b.ti, fa);
      }
      // the path ahead: from the newest hit (clamped to the canvas edge once it scrolls off) on through the coming notes,
      // bright tier colour from x2 up (dim below), fading toward the top of the highway
      var nw = this.anch[(this.anchI + this.MAXA - 1) % this.MAXA];
      if (nw && nw.ok) {
        var lx = this.colX[nw.lane], ly = Math.min(H + 10, this.tgtY[nw.lane] - (nw.t - h) * pps), cnt = 0, horizon = (this.hitY + 40) / pps, lit = this.tier >= 1;
        for (i = this.next; i < P.length && cnt < 4; i++) {
          var q = P[i]; if (q.r) continue; if (q.t - h > horizon) break;
          var qx = this.colX[q.lane], qy = this.tgtY[q.lane] - (q.t - h) * pps, top = Math.max(0, Math.min(1, qy / 160));
          this.beam(lx, ly, qx, qy, this.tier, (lit ? 0.8 : 0.5) * (0.4 + 0.6 * top), !lit); lx = qx; ly = qy; cnt++;
        }
      }
      this.flushBeams();
      for (i = 0; i < pts.length; i++) { var p = pts[i], nd = this.nodes[p.ti], fn = p.y < fadeAt ? 1 : Math.max(0, 1 - (p.y - fadeAt) / 90); if (fn < 0.02) continue; g.globalAlpha = fn; g.drawImage(nd.c, Math.round(p.x - nd.s / 2), Math.round(p.y - nd.s / 2)); }
    }
    // shards after a break
    var sa = T - this.shard.t;
    if (sa < 0.55) {
      for (i = 0; i < this.shard.n; i++) {
        var z = this.shard.seg[i], mx = (z.x1 + z.x2) / 2, my = (z.y1 + z.y2) / 2, ox = z.vx * sa, oy = z.vy * sa + 900 * sa * sa, al = 0.85 * (1 - sa / 0.55);
        this.beam(z.x1 + ox * 0.6, z.y1 + oy, mx + ox * 0.6, my + oy, z.ti, al);
        this.beam(mx + ox * 1.3, my + oy * 1.1, z.x2 + ox * 1.3, z.y2 + oy * 1.1, z.ti, al);
      }
      this.flushBeams();
    }
    g.globalAlpha = 1;
  };
  Beat.prototype.drawMeter = function (T) {   // multiplier meter: 10 pips filling toward the next tier + x1..x4 (+ MAX); cached image, re-rendered only on change
    if (this.jam) return;
    this.g.globalAlpha = 1;
    var g = this.g, t = this.tier, fill = t === 3 ? 10 : this.combo % 10, key = t * 16 + fill, x = 16, y = 14;
    if (!this.meterC) { this.meterC = cv(300, 44); this.meterK = -1; }
    if (key !== this.meterK) {
      this.meterK = key; var m = this.meterC.getContext('2d'), pp = this.pips[t === 3 ? 3 : Math.min(3, t + 1)], ms = this.multSp[t]; m.clearRect(0, 0, 300, 44);
      for (var i = 0; i < 10; i++) m.drawImage(i < fill ? pp.on : pp.off, i * 17, 7);
      m.drawImage(ms.c, 172, 22 - ms.h / 2); if (t === 3) m.drawImage(this.maxSp.c, 172 + ms.w - 30, 22 - this.maxSp.h / 2);
    }
    var a = T - this.tierT;
    if (a < 0.25) { var k = 1.25 - 0.25 * (a / 0.25); g.drawImage(this.meterC, x - 150 * (k - 1), y - 7 - 22 * (k - 1), 300 * k, 44 * k); }   // tier-up pop
    else g.drawImage(this.meterC, x, y - 7);
  };
  Beat.prototype.pulseNow = function (big) {
    var kind = big ? 'big' : this.streak ? 'gold' : 'pink', el = this.pulseEls && this.pulseEls[kind]; if (!el) return;
    this.pulseT = now(); this.pulseFlip = !this.pulseFlip; el.className = 'bt-pulse2 ' + (this.pulseFlip ? 'a' : 'b');
  };
  // h = song time the player hears now. One canvas, redrawn each frame.
  Beat.prototype.draw = function (h, hj) {   // h = display time, hj = judgement time (misses use the judge clock: big A/V offsets e.g. Bluetooth)
    var P = this.prompts, pps = this.cfg.pps, good = WIN.Good * this.cfg.win, gs = this.gs, i, g = this.g, W = this.W, H = this.H, T = now();
    while (this.next < P.length && (P[this.next].r && !P[this.next].hold || (!P[this.next].r && P[this.next].t < (hj != null ? Math.min(h, hj - this.offset) : h) - good))) {
      var q = P[this.next]; if (!q.r) this.judge(q, 'Miss'); this.next++;
    }
    g.clearRect(0, 0, W, H); this.lastH = h;
    // beat lines (+ a pulse on each beat during a streak / jam)
    var bt = this.song.beats && this.song.beats.t;
    if (bt) {
      while (this.beatIdx < bt.length && bt[this.beatIdx] < h - 0.3) this.beatIdx++;
      if (this.beatIdx < bt.length && bt[this.beatIdx] <= h && this.lastPulse !== this.beatIdx) { this.lastPulse = this.beatIdx; if (this.streak || this.jam) this.pulseNow(false); }
      for (i = 0; i < 10; i++) {
        var k = this.beatIdx + i; if (k >= bt.length) break;
        var yy = this.hitY - (bt[k] - h) * pps; if (yy < -10) break; if (yy > H) continue;
        var down = k % 4 === 0; g.fillStyle = down ? 'rgba(255,255,255,.28)' : 'rgba(255,255,255,.13)'; g.fillRect(0, Math.round(yy), W, down ? 4 : 2);
      }
    }
    // pulse (pre-rendered vignette, alpha only)
    // (pulse is a DOM layer animating opacity only: compositor work, no canvas raster)
    // targets + hit / miss fx
    for (var li = 0; li < this.laneList.length; li++) {
      var lane = this.laneList[li], rs = this.tgt[lane], f = this.fx[lane], x0 = this.colX[lane], y0 = this.tgtY[lane], age = T - f.t, ma = T - f.miss;
      var shake = ma < 0.25 ? Math.sin(ma * 60) * 6 * (1 - ma / 0.25) : 0;
      g.globalAlpha = ma < 0.25 ? 0.45 + 0.55 * (ma / 0.25) : 1;
      g.drawImage(rs.c, Math.round(x0 - rs.w / 2 + shake), Math.round(y0 - rs.w / 2));
      // cheap hit fx: unscaled pre-rendered sprites, alpha only (no per-frame scaling, no 'lighter' compositing)
      if (age < 0.16) { var rh = f.ringHot; g.globalAlpha = 1 - age / 0.16; g.drawImage(rh.c, Math.round(x0 - rh.w / 2), Math.round(y0 - rh.w / 2)); }
      var fl = f.r === 'Perfect' ? 0.26 : 0.2;
      if (age < fl) { g.globalAlpha = (f.r === 'Perfect' ? 0.9 : 0.7) * (1 - age / fl); g.drawImage(f.glow, Math.round(x0 - f.fsz / 2), Math.round(y0 - f.fsz / 2)); }
      var bl = f.r === 'Perfect' ? 0.36 : 0.28;
      if (f.r !== 'Good' && age < bl) { var bfr = f.bursts[Math.min(5, ((age / bl) * (f.r === 'Perfect' ? 6 : 4)) | 0)]; g.globalAlpha = 1 - age / bl; g.drawImage(bfr, Math.round(x0 - bfr.width / 2), Math.round(y0 - bfr.height / 2)); }
      g.globalAlpha = 1;
    }
    this.drawStreak(h, T);   // streak chain under the gems
    if (this.rec) this.drawRec(h);
    // notes: hold bodies first, then gems
    var ahead = (this.hitY + 80) / pps;
    for (i = this.next; i < P.length; i++) {
      var p = P[i]; if (p.t > h + ahead) break;
      if (p.r && !p.hold) continue;
      var sp = this.sprite[p.lane]; if (!sp) continue;
      var x = this.colX[p.lane], ty = this.tgtY[p.lane];
      if (p.hold === 1 && h >= p.t + p.dur) { this.finishHold(p, 1); continue; }
      var y = p.hold === 1 ? ty : ty - (p.t - h) * pps;
      if (p.dur) {
        var len = p.hold === 1 ? (p.t + p.dur - h) * pps : p.dur * pps;
        g.globalAlpha = 0.75; g.fillStyle = LANES[p.lane].col; g.fillRect(Math.round(x - gs * 0.21), Math.round(y - len), Math.round(gs * 0.42), Math.round(len)); g.globalAlpha = 1;
        if (p.hold === 1 && len > 4) this.beam(x, y, x, y - len, Math.max(1, this.tier), 0.85 + 0.15 * Math.sin(T * 30)); this.flushBeams();   // sustain: glowing trail while held
      }
      g.drawImage(sp.c, Math.round(x - sp.ox), Math.round(y - sp.oy));
    }
    // sparks (capped)
    for (i = 0; i < this.MAXSPARK; i++) {
      var s = this.sparks[i], sa = T - s.t;
      if (sa > 0.45 || sa < 0) continue;
      var e = sa * (1 - sa / 0.9);
      g.globalAlpha = 1 - sa / 0.45; g.drawImage(s.img, Math.round(s.x + s.vx * e - 12), Math.round(s.y + s.vy * e - 12));   // unscaled
    }
    g.globalAlpha = 1;
    this.drawMeter(T);
    this.drawText(T);
    if (this.scoreDirty && T - this.scoreAt > 0.25) {
      this.scoreDirty = false; this.scoreAt = T; var st = '\ud83e\udd41 ' + cap(this.diff) + ' \u00b7 ' + this.score();
      if (st !== this.scoreTxt) { this.scoreTxt = st; this.scoreEl.textContent = st; }
    }
  };
  Beat.prototype.drawRec = function (h) {   // Record map: old notes ghosted, new taps land on the line and slide on down the highway
    var g = this.g, pps = this.cfg.pps, gs = this.gs, ahead = (this.hitY + 80) / pps, below = (this.H - this.hitY + 60) / pps, L = [this.rec.ghost, this.rec.notes], k, i;
    for (k = 0; k < 2; k++) for (i = 0; i < L[k].length; i++) {
      var p = L[k][i]; if (p.t > h + ahead || p.t + (p.dur || 0) < h - below) continue;
      var sp = this.sprite[p.lane]; if (!sp) continue;
      var x = this.colX[p.lane], y = this.tgtY[p.lane] - (p.t - h) * pps, d = p.live ? Math.max(0, h - p.t) : p.dur || 0;
      g.globalAlpha = k ? 1 : 0.28;
      if (d > 0) { g.globalAlpha *= 0.75; g.fillStyle = LANES[p.lane].col; g.fillRect(Math.round(x - gs * 0.21), Math.round(y - d * pps), Math.round(gs * 0.42), Math.round(d * pps)); g.globalAlpha = k ? 1 : 0.28; }
      g.drawImage(sp.c, Math.round(x - sp.ox), Math.round(y - sp.oy));
    }
    g.globalAlpha = 1;
  };
  Beat.prototype.drawText = function (T) {   // judge word (0.55 s), combo number (pop 0.18 s), N COMBO! banner (1.1 s): sprites + alpha/scale only
    var g = this.g, cx = this.W / 2, a, k, sp, w, h;
    a = T - this.jt.t;
    if (a < 0.55) {
      sp = this.judgeSp[this.jt.r] || this.judgeSp.Good;
      k = a < 0.14 ? 1.35 - 0.35 * (a / 0.14) : 1; g.globalAlpha = a < 0.41 ? 1 : 1 - (a - 0.41) / 0.14; w = sp.w * k; h = sp.h * k;
      g.drawImage(sp.c, cx - w / 2, 70 + 34 - h / 2, w, h);
    }
    if (this.combo > 2) {
      var D = this.combo >= 20 ? this.digits.hot : this.digits.n, n = this.combo, nd = n >= 1000 ? 4 : n >= 100 ? 3 : n >= 10 ? 2 : 1;
      a = T - this.ct.t; k = a < 0.18 ? 1.3 - 0.3 * (a / 0.18) : 1; g.globalAlpha = 1;
      var dw = (D[0].w - 40) * k, x0 = cx + (nd * dw) / 2 - dw / 2;   // digits right-to-left, no strings / allocations
      for (var q = 0; q < nd; q++) { sp = D[n % 10]; n = (n / 10) | 0; w = sp.w * k; h = sp.h * k; g.drawImage(sp.c, x0 - q * dw - w / 2, 150 + 44 - h / 2, w, h); }
    }
    a = T - this.bt.t;
    if (this.bt.sp && a < 1.1) {
      sp = this.bt.sp; k = a < 0.165 ? 0.4 + 0.75 * (a / 0.165) : a < 0.33 ? 1.15 - 0.15 * ((a - 0.165) / 0.165) : 1;
      g.globalAlpha = a < 0.165 ? a / 0.165 : a < 0.88 ? 1 : 1 - (a - 0.88) / 0.22; var dy = a > 0.88 ? -30 * (a - 0.88) / 0.22 : 0;
      w = sp.w * k; h = sp.h * k; g.drawImage(sp.c, cx - w / 2, 240 + 48 - h / 2 + dy, w, h);
    }
    g.globalAlpha = 1;
  };
  Beat.prototype.finishHold = function (p, frac) {
    p.hold = 2; this.pts += frac; if (frac >= 1) { this.holds.ok++; this.showJudge('HOLD \u2713', 'Perfect'); this.fxHit(p.lane, 'Great'); } else this.holds.dropped++;
    this.give(p); this.scoreDirty = true;
  };
  // press: returns rating or null (stray). h is already corrected for output + input latency.
  Beat.prototype.press = function (lane, h, src) {
    if (src) this.presses[src] = (this.presses[src] || 0) + 1;
    h -= this.offset;
    if (this.tgt[lane] && this.jam) this.fxHit(lane, 'Great');
    var P = this.prompts, w = this.cfg.win, best = null, bd = 1e9;
    for (var i = this.next; i < P.length; i++) {
      var p = P[i]; if (p.t > h + WIN.Good * w) break;
      if (p.r || p.lane !== lane) continue;
      var d = Math.abs(p.t - h); if (d < bd) { bd = d; best = p; }
    }
    if (!best || bd > WIN.Good * w) { this.wrong++; return null; }
    if (best.midi) this.lastMidi = best.midi;
    var r = bd <= WIN.Perfect * w ? 'Perfect' : bd <= WIN.Great * w ? 'Great' : 'Good';
    if (best.dur) best.hold = 1;
    this.judge(best, r, h - best.t);
    return r;
  };
  Beat.prototype.release = function (lane, h) {
    h -= this.offset;
    for (var i = this.next; i < this.prompts.length; i++) {
      var p = this.prompts[i]; if (p.t > h) break;
      if (p.lane === lane && p.hold === 1) this.finishHold(p, h >= p.t + p.dur - 0.15 ? 1 : Math.max(0, Math.min(1, (h - p.t) / p.dur)));
    }
  };
  // bass pitch for a D-pad press: the charted note, or (jam) an interval from the song's bass root
  Beat.prototype.bassMidi = function (lane) {
    if (!this.jam && this.lastMidi) return this.lastMidi;
    return this.root + ({ 6: 0, 5: 3, 4: 7, 7: 12 }[lane] || 0);
  };
  Beat.prototype.result = function () {
    var e = this.errs.slice().sort(function (a, b) { return a - b; }), med = e.length ? e[e.length >> 1] : 0;
    return { score: this.score(), counts: this.counts, maxCombo: this.maxCombo, total: this.prompts.length, diff: this.diff, input: this.input,
      bpm: this.song.beats ? this.song.beats.bpm : 0, medianErrMs: Math.round(med * 1000), hits: e.length, wrong: this.wrong, presses: this.presses, holds: this.holds,
      chart: this.song.chart && this.song.chart.drums !== false ? 'instruments' : 'beat-grid', ratings: this.prompts.map(function (p) { return p.r || 'Miss'; }) };
  };
  Beat.prototype.destroy = function () { this.el.innerHTML = ''; this.el.className = 'beat-track'; this.sparks.forEach(function (s) { s.t = -9; }); };

  // ---------- instrument kit: synthesized once into AudioBuffers (no samples shipped) ----------
  function Kit(ctx, dest) {
    this.ctx = ctx; this.out = ctx.createGain(); this.out.connect(dest || ctx.destination); this.out.gain.value = 0.5;
    var sr = ctx.sampleRate, self = this;
    function buf(sec, fn) { var n = Math.round(sec * sr), b = ctx.createBuffer(1, n, sr), d = b.getChannelData(0), st = { lp: 0, hp: 0, prev: 0 }; for (var i = 0; i < n; i++) d[i] = fn(i / sr, st); return b; }
    var ph = 0;
    this.b = {
      kick: buf(0.35, function (t) { var f = 45 + 95 * Math.exp(-t * 28); ph += 2 * Math.PI * f / sr; return Math.sin(ph) * Math.exp(-t * 9) * 0.95 + (t < 0.004 ? (Math.random() - 0.5) * 0.6 : 0); }),
      snare: buf(0.25, function (t, s) { var nz = Math.random() * 2 - 1; s.hp = 0.6 * (s.hp + nz - s.prev); s.prev = nz; return s.hp * Math.exp(-t * 17) * 0.55 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 28) * 0.45; }),
      hat: buf(0.09, function (t, s) { var nz = Math.random() * 2 - 1; s.hp = 0.25 * (s.hp + nz - s.prev); s.prev = nz; return s.hp * Math.exp(-t * 55) * 0.7; }),
      crash: buf(1.3, function (t, s) { var nz = Math.random() * 2 - 1; s.hp = 0.35 * (s.hp + nz - s.prev); s.prev = nz; return s.hp * Math.exp(-t * 2.6) * 0.5 * Math.min(1, t * 400); }),
      bass: buf(0.6, function (t, s) { var x = ((t * 55) % 1) * 2 - 1; s.lp += 0.08 * (x - s.lp); return s.lp * Math.exp(-t * 4.5) * 0.9 * Math.min(1, t * 300); }),
      pad: buf(2.0, function (t, s) { var x = 0; [1, 1.5, 2, 1.003, 1.497].forEach(function (m) { x += ((t * 110 * m) % 1) * 2 - 1; }); s.lp += 0.03 * (x / 5 - s.lp); return s.lp * 0.7; })
    };
    this.padSrc = null;
  }
  Kit.prototype.level = function (v) { this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); };
  Kit.prototype.play = function (name, opt) {
    opt = opt || {}; var ctx = this.ctx; if (ctx.state !== 'running' && ctx.resume) ctx.resume();
    if (name === 'accent') { this.play('crash', { gain: 1 }); this.play('kick', { gain: 1 }); return; }
    if (name === 'pad') return this.padOn(opt.midi || 48);
    var s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = this.b[name]; g.gain.value = opt.gain || 0.8;
    if (name === 'bass' && opt.midi) s.playbackRate.value = Math.pow(2, (opt.midi - 33) / 12);
    s.connect(g); g.connect(this.out); s.start();
  };
  Kit.prototype.padOn = function (midi) {
    this.padOff(); var ctx = this.ctx, s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = this.b.pad; s.loop = true; s.loopStart = 0.1; s.loopEnd = 1.9; s.playbackRate.value = Math.pow(2, (midi - 45) / 12);
    g.gain.value = 0; g.gain.setTargetAtTime(0.45, ctx.currentTime, 0.04); s.connect(g); g.connect(this.out); s.start(); this.padSrc = { s: s, g: g };
  };
  Kit.prototype.padOff = function () { var p = this.padSrc; if (!p) return; var t = this.ctx.currentTime; p.g.gain.setTargetAtTime(0, t, 0.12); try { p.s.stop(t + 0.6); } catch (e) {} this.padSrc = null; };
  Beat.Kit = Kit;
  root.KaraokeBeat = Beat;
})(typeof window !== 'undefined' ? window : this);
