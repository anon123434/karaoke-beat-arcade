#!/usr/bin/env node
// songs/index.json = every songs/<id>/song.json (generated songs first, then ingested ones).
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'songs');
const list = fs.readdirSync(dir).filter(d => fs.existsSync(path.join(dir, d, 'song.json'))).map(d => {
  const s = JSON.parse(fs.readFileSync(path.join(dir, d, 'song.json')));
  return { id: s.id, title: s.title, artist: s.artist, duration: s.duration, key: s.key || '', difficulty: s.difficulty || '', source: s.source || 'generated' };
}).sort((a, b) => (a.source === 'ingest') - (b.source === 'ingest') || (a.id === 'twinkle' ? -1 : b.id === 'twinkle' ? 1 : a.title.localeCompare(b.title)));
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(list, null, 1));
console.log('index:', list.map(s => s.id).join(', '));
