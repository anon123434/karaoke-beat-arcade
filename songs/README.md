# songs/

**This repository ships no copyrighted music.** The only songs tracked here are two self-made demos
(`twinkle`, `amazing-grace`: public-domain melodies and lyrics, with an original piano accompaniment synthesised by
`tools/build-song.js`) and `calibration/` (a few generated beeps). Everything else in this folder is git-ignored.
Only add music you own or have the rights to use.

## Folder format

One folder per song: `songs/<id>/` (`<id>` = lowercase letters, digits and dashes; ingested songs use `user-<slug>`).

| File | Required | What |
|---|---|---|
| `song.json` | yes | Metadata + everything the TV reads (see below) |
| `instrumental.wav` / `.mp3` | yes | Backing track WITHOUT the lead vocal (named by `song.json` → `audio`) |
| `vocals.mp3` | optional | Isolated lead vocal, used for the guide-voice and for charting |
| `lyrics.lrc` | optional | Enhanced LRC with word timestamps (`[mm:ss.xx]<mm:ss.xx>word <mm:ss.xx>word`) |
| `melody.json` / `melody.mid` | optional | Reference melody `[{t,d,midi,syl,line}]` used by the pitch scorer |
| `art.webp` | optional | Square cover art (about 320 px) |
| `preview.mp3`, `preview.json` | optional | ~18 s hook for the song-select preview (made by `tools/build-library.py`) |

`song.json` fields: `id`, `title`, `artist`, `key`, `difficulty`, `bpm`, `leadIn`, `duration`, `audio`, `lrc`, `notes` (the
melody, as in `melody.json`), `lines` (`[{t, end, words:[{t, d, text}]}]` for the lyric display) and optionally `beats` /
`chart` (rhythm chart used by Beat mode). Open `songs/twinkle/song.json` for a complete example.

## Adding songs

* **Automatic (needs ffmpeg, Python 3.11, Demucs, faster-whisper, librosa):**
  `python3 -m venv .venv-ingest && .venv-ingest/bin/pip install demucs faster-whisper librosa numpy soundfile`, then
  `npm run ingest -- path/to/song.mp3 'Artist - Title' --no-install`. This separates vocals, fetches synced lyrics from
  LRCLIB, times the words, extracts a reference melody and writes `songs/user-<slug>/`.
* **By hand:** create the folder with the files above, add a line to `data/library-meta.txt` (genre/year/ballad) and run
  `npm run index` (rebuilds `songs/index.json`) and, optionally, `python3 tools/build-library.py` (categories, previews, `library.json`).

Do not commit your changes to `songs/index.json` (it lists your private library); it is regenerated locally.
