/*
 * Phone song index (v13.12): a small, audio-free list the phone page filters client-side (title, artist, categories).
 *   PhoneIndex.build(indexArray, library) -> { v:1, cats:[[id,name],...], songs:[[id,title,artist,[catIdx,...]],...] }
 * Source of truth is songs/index.json + songs/library.json (the same files the TV reads). No audio, no art, ~12 KB for 109 songs.
 * Used by server/index.js (served at /phone/songs-index.json) and by the hosted Worker web build (written to /kba/phone/songs-index.json).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PhoneIndex = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function build(index, lib) {
    var cats = [], map = {}, i, c, s, L = (lib && lib.songs) || {};
    ((lib && lib.cats) || []).forEach(function (k) { if (k.id !== 'all' && k.id !== 'fav') { map[k.id] = cats.length; cats.push([k.id, String(k.name || k.id)]); } });
    var songs = [];
    for (i = 0; i < (index || []).length; i++) {
      s = index[i]; if (!s || typeof s.id !== 'string' || !/^[a-z0-9-]+$/.test(s.id)) continue;
      var cs = ((L[s.id] && L[s.id].cats) || []).map(function (id) { return map[id]; }).filter(function (x) { return x != null; });
      songs.push([s.id, String(s.title || ''), String(s.artist || ''), cs]);
    }
    return { v: 1, cats: cats, songs: songs };
  }
  return { build: build };
});
