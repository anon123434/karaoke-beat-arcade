/*
 * KaraokeSearch (v13.6): forgiving song search by title + artist. ES5, no dependencies (runs on the TV and in node tests).
 *   KaraokeSearch.index(songs)        -> idx  (precomputed normalised fields)
 *   KaraokeSearch.rank(idx, query)    -> [{ i, score }]  best first; [] when nothing is close
 * Forgives: case, punctuation and accents ("Beyonce", "T-Pain" = "tpain" = "t pain"), partial words ("californ"),
 * typos (edit distance scaled by word length), words typed together or apart ("boys to men", "boyztomen"),
 * sound-alikes (z/s, ph/f, ck/k, double letters, "kn", "wr", "wh") and filler words (the, a, to, of, and, feat).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KaraokeSearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var STOP = { the: 1, a: 1, an: 1, to: 1, of: 1, and: 1, feat: 1, ft: 1, featuring: 1, in: 1, on: 1, i: 0, you: 0 };
  function norm(s) {
    s = String(s == null ? '' : s).toLowerCase();
    if (s.normalize) s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    s = s.replace(/&/g, ' and ').replace(/['\u2019`\u2018]/g, '').replace(/[^a-z0-9]+/g, ' ');
    return s.replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }
  function fold(w) {   // light phonetic fold: sound-alike spellings collapse to one key
    return w.replace(/^kn/, 'n').replace(/^wr/, 'r').replace(/^wh/, 'w').replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c(?=[aou])/g, 'k').replace(/[cz]/g, 's').replace(/x/g, 'ks')
      .replace(/(.)\1+/g, '$1').replace(/(?!^)[aeiouy]+$/, function (m) { return m.length ? '' : m; }).replace(/y/g, 'i');
  }
  function lev(a, b, max) {   // Damerau-ish (adjacent swap = 1) bounded edit distance
    var la = a.length, lb = b.length; if (Math.abs(la - lb) > max) return max + 1;
    var p2 = null, p1 = [], i, j; for (j = 0; j <= lb; j++) p1[j] = j;
    for (i = 1; i <= la; i++) {
      var cur = [i], rowMin = i;
      for (j = 1; j <= lb; j++) {
        var c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1, v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + c);
        if (p2 && i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) v = Math.min(v, p2[j - 2] + 1);
        cur[j] = v; if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1; p2 = p1; p1 = cur;
    }
    return p1[lb];
  }
  function field(text) {
    var n = norm(text), words = n ? n.split(' ') : [];
    return { n: n, words: words, sq: n.replace(/ /g, ''), fw: words.map(fold), fsq: fold(n.replace(/ /g, '')) };
  }
  function index(songs) {
    return songs.map(function (s) {
      var ft = '', t = String(s.title || '').replace(/\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring)\s*([^\)\]]*)[\)\]]/i, function (m, g) { ft = g; return ''; }), f = field(t), a = field((s.artist || '') + ' ' + ft), all = field(t + ' ' + (s.artist || '') + ' ' + ft);
      return { t: f, a: a, all: all };
    });
  }
  // how well one query token matches inside one field: 0..1
  function tokenIn(q, qf, F) {
    var best = 0, w, k, d, L = q.length, max = L <= 3 ? 0 : L <= 6 ? 1 : 2;
    for (k = 0; k < F.words.length; k++) {
      w = F.words[k];
      if (w === q) { best = 1; break; }
      if (L >= 2 && w.indexOf(q) === 0) { best = Math.max(best, 0.92 - Math.min(0.15, (w.length - L) * 0.01)); continue; }   // partial word ("californ")
      if (F.fw[k] === qf) { best = Math.max(best, 0.84); continue; }                                                           // sounds alike
      if (L >= 4) {
        if (max && lev(q, w, max) <= max) best = Math.max(best, 0.8 - 0.14 * lev(q, w, max));
        else if (max) { d = lev(q, w.slice(0, L + 1), max); if (d <= max) best = Math.max(best, 0.72 - 0.14 * d); }          // typo inside a partial word
        if (qf.length >= 4 && F.fw[k].indexOf(qf) === 0) best = Math.max(best, 0.7);
      }
      if (L >= 3 && w.indexOf(q) > 0) best = Math.max(best, 0.5);                                                               // inside a word
    }
    if (best < 0.9 && L >= 3 && F.sq.indexOf(q) >= 0) best = Math.max(best, 0.86);                                              // spans words / punctuation ("tpain")
    if (best < 0.7 && L >= 5 && F.fsq.indexOf(qf) >= 0) best = Math.max(best, 0.7);
    return best;
  }
  function score(Q, I) {
    var all = I.all, t = I.t, a = I.a, sq = Q.sq, s = 0;
    // whole query, spaces ignored ("tpain", "boyztomen", "californ")
    if (sq.length >= 2) {
      if (t.sq === sq || a.sq === sq) s = 1.4;
      else if (t.sq.indexOf(sq) === 0 || a.sq.indexOf(sq) === 0) s = 1.15;
      else if (all.sq.indexOf(sq) >= 0 && sq.length >= 3) s = 1.0;
      else if (sq.length >= 5 && Q.fsq.length >= 4 && (fold(t.sq).indexOf(Q.fsq) === 0 || fold(a.sq).indexOf(Q.fsq) === 0)) s = 0.95;
      else if (sq.length >= 6) {
        var d = Math.min(lev(sq, all.sq.slice(0, sq.length), 2), lev(sq, t.sq.slice(0, sq.length + 1), 2), lev(sq, a.sq.slice(0, sq.length + 1), 2));
        if (d <= (sq.length >= 9 ? 2 : 1)) s = 0.85 - 0.12 * d;
      }
    }
    // word by word: every meaningful query word must land somewhere in title or artist
    var sig = 0, got = 0, miss = 0, i, ts, as, v;
    for (i = 0; i < Q.words.length; i++) {
      var q = Q.words[i]; if (STOP[q] && Q.words.length > 1) continue;
      sig++; ts = tokenIn(q, Q.fw[i], t); as = tokenIn(q, Q.fw[i], a); v = Math.max(ts, as * 0.92);
      if (v >= 0.5) got += v + (ts >= as ? 0.04 : 0); else miss++;
    }
    if (sig) {
      var allowMiss = sig >= 5 ? 1 : 0;
      if (miss <= allowMiss && got > 0) s = Math.max(s, (got / sig) * (miss ? 0.8 : 1.0) + (Q.words.length === t.words.length && !miss ? 0.1 : 0));
    }
    return s;
  }
  function rank(idx, query) {
    var qn = norm(query); if (!qn) return null;
    var Q = field(qn), out = [], i, s;
    Q.words = qn.split(' '); Q.fw = Q.words.map(fold);
    for (i = 0; i < idx.length; i++) { s = score(Q, idx[i]); if (s >= 0.5) out.push({ i: i, score: s }); }
    out.sort(function (x, y) { return y.score - x.score || x.i - y.i; });
    return out;
  }
  return { norm: norm, fold: fold, index: index, rank: rank, lev: lev };
});
