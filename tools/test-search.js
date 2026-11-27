// node tools/test-search.js : fuzzy search quality against the real library (titles+artists only)
const fs = require('fs'), KS = require('../shared/search.js');
const ids = JSON.parse(fs.readFileSync('songs/index.json')).map(e => e.id);
const songs = ids.map(id => { const s = JSON.parse(fs.readFileSync(`songs/${id}/song.json`)); return { id, title: s.title, artist: s.artist }; });
const idx = KS.index(songs);
const cases = [
  ['californ', ['californication', 'hotel-california']], ['tpain', ['bartender-feat-akon', 'buy-u-a-drank-feat-yung-joc']], ['t pain', ['buy-u-a-drank-feat-yung-joc']], ['boys to men', null], ['boyz 2 men', null],
  ['hotel calif', ['hotel-california']], ['killin me softly', ['killing-me-softly']], ['kiling in the name', ['killing-in-the-name']], ['gettin', ['gettin-it']], ['usher', null], ['whitney', null], ['beyonce', null],
  ['i swear', ['i-swear']], ['i want it that wya', ['i-want-it-that-way']], ['backstreet', null], ['africa', ['africa']], ['toto', ['africa']], ['carribean queen', ['caribbean-queen']], ['rid wit me', ['ride-wit-me']],
  ['dont leave me', ['dont-leave-me']], ['dont', null], ['xyzzy', []], ['qqqq', []], ['ill make love', ['ill-make-love-to-you']], ['cant tell me', ['cant-tell-me-nothing']], ['regulat', ['regulate']], ['warren g', ['regulate']], ['notorious', ['notorious-thugs']],
  ['moneytrees', ['money-trees']], ['my boo alicia', ['my-boo-feat-alicia-keys']], ['alishia keys', null], ['red hot chili', null], ['christmas', null], ['wanna know', ['i-wanna-know']], ['usher yeah', null]
];
let bad = 0;
for (const [q, want] of cases) {
  const r = KS.rank(idx, q) || []; const top = r.slice(0, 4).map(x => songs[x.i].id.replace('user-', ''));
  let ok = true; if (want) ok = want.length ? want.some(w => top.slice(0, 3).includes(w)) : r.length === 0;
  if (!ok) bad++;
  console.log((ok ? 'ok  ' : 'BAD ') + JSON.stringify(q).padEnd(22), r.length + ' hits', want === null ? '(info)' : '', top.map(i => i.replace('user-', '')).join(', '));
}
console.log(bad ? bad + ' failed' : 'all ok');
const t0 = Date.now(); for (let i = 0; i < 200; i++) KS.rank(idx, 'californ'); console.log('rank x200 on', songs.length, 'songs:', Date.now() - t0, 'ms');
process.exit(bad ? 1 : 0);
