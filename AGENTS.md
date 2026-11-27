# Agent guide — Karaoke Beat Arcade

This is the project guide for AI coding agents (Cursor, Claude Code, Codex, and others). Humans may follow it too. Product background and Tizen / Cloudflare setup live in [README.md](README.md). Song file format: [songs/README.md](songs/README.md). Scoring: [docs/SCORING.md](docs/SCORING.md).

## What this is

Pitch-scored karaoke for a TV or any browser, with phones as microphones. Up to four singers. Modes: Sing (pitch), Beat (rhythm), Duet, Jam, Record. The repo ships **two self-made demo songs** (public-domain melodies, original piano backing). It does **not** ship copyrighted music. Only add audio you have the rights to use, and never commit a private library.

You can develop the whole app in a browser on localhost. A Samsung Tizen TV, a Mac, and a Cloudflare Worker are all optional.

## Architecture

```
phone (HTTPS mic + YIN pitch) --wss--> server/index.js (Node relay) --ws--> tv/ (lyrics, pitch lane, scoring)
```

| Path | Role |
|---|---|
| `tv/app.js` (~2,150 lines) | Main TV UI: song select, remote/pointer nav, modes, scoring HUD, results. Edit this for most product behavior. Keep the language ES5-ish (older Tizen browsers). There is no bundler for the TV app. |
| `tv/engine.js` | Audio clock, playback, Web Audio path |
| `tv/lane.js` | Pitch lane rendering |
| `tv/beat.js` | Beat / rhythm highway |
| `tv/queue.js` | Song queue |
| `tv/config.js` | Server URL + output latency. The packaged Tizen widget gets `KARAOKE_SERVER` substituted at `npm run package`. |
| `tv/index.html`, `tv/style.css`, `tv/config.xml` | Shell, styles, Tizen widget id (`KaraokeBA1.KaraokeTV` is a placeholder) |
| `phone/phone.js` | Mic capture, on-phone pitch (YIN), WebSocket to the relay |
| `phone/songs-tab.js` | Phone song search / queue / category filter |
| `shared/scoring.js` | Pitch scoring |
| `shared/yin.js` | Pitch detection |
| `shared/autotune.js` | Guide-voice pitch correction |
| `shared/search.js` | Fuzzy search |
| `shared/song-source.js` | Local + optional Stingray song loading |
| `shared/phone-index.js` | Compact song list for the phone (no audio) |
| `server/index.js` | HTTP `:8780` (TV / songs), HTTPS `:8743` (phone), WebSocket pairing (one TV, up to 4 phones) |
| `server/cloud.js` | Optional bridge to a hosted Worker so phones can join over real HTTPS |
| `server/stingray.js`, `server/stt.js` | Optional Stingray catalog; optional speech-to-text |
| `worker/` | Optional Cloudflare Worker: hosted `/kba` app, invite gate, rooms, leaderboard, online 1v1. `worker/build.mjs` assembles `worker/public` from `tv/`, `phone/`, `shared/`, `songs/` plus patches in `worker/web/`. |
| `tools/dev.sh` | `npm run dev` |
| `tools/test-cert.sh` | Throwaway self-signed cert for local HTTPS / `npm test` |
| `tools/make-cert.sh` | mkcert CA for real phones (`npm run cert`) |
| `tools/ingest.py`, `tools/ingest-batch.py` | Vocal split + lyrics + melody for a new song |
| `tools/build-library.py` | Categories, previews, `songs/library.json`, `data/song-added.json` |
| `tools/build-index.js`, `tools/build-song.js` | `songs/index.json`; regenerate the demo songs |
| `tools/package.py`, `tools/tv.py` | Sign / install the Tizen widget |
| `tools/check-*.mjs`, `perf-*.mjs`, `shot*.mjs` | Headless QA. Many assume a large library, not just the two demos. |
| `test/` | `npm test` (Node test runner) |
| `songs/`, `data/` | Library. Only the demos and `data/library-meta.txt` / demo `data/song-added.json` are tracked. |

Secrets and machine-local files (never commit): `.env`, `.dev.vars`, `.local/` (pairing code, cloud relay, Tizen signing, Stingray key), `certs/`, `dist/`, `songs/library.json`, anything under `songs/` except the demos.

## Exact commands

Requires **Node 20+**. Python, ffmpeg, Demucs, and Whisper are **not** needed to run or test the demo app.

```sh
npm install
npm test                 # also creates certs/ if missing (tools/test-cert.sh)
npm run lint             # syntax-check server/index.js, tv/app.js, phone/phone.js
npm run dev              # preferred local start (see Quick start below)
npm start                # same server, no banner, no automatic cert, respects your env as-is
```

Definition of done for a change: **`npm test` and `npm run lint` both pass.**

Optional:

```sh
npm run index            # rebuild songs/index.json from songs/*/song.json
npm run cert             # mkcert cert for real phones (set KARAOKE_HOST to this machine's LAN IP)
npm run check:browser    # Playwright E2E; run `npx playwright install chromium` first
npm run package          # Tizen widget (needs .local/signing.json and KARAOKE_SERVER)
npm run ingest -- path/to/song.mp3 'Artist - Title' --no-install
cd worker && npm install && npm run build && npm run dev   # hosted Worker, needs a Cloudflare account
```

## Quick start in a browser (no TV, no Cloudflare, no Mac)

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:8780/tv/**. You should see Song Select with Twinkle, Twinkle, Little Star and Amazing Grace.

To play a demo without a phone: click the song (or press Enter), click **PLAY** (or Enter). The first time, the app warns that no mic is connected — confirm once more (Enter or PLAY) and the song starts in “not scoring” mode. Click or use arrow keys / Enter the same way a TV remote would.

`npm run dev` sets `KTV_CLOUD=0` and writes a throwaway self-signed cert if `certs/` is empty so the HTTPS port can listen. A laptop browser can use the TV page over plain HTTP; no certificate dialog is required for that path.

Phones are optional. A real phone mic needs HTTPS it trusts: install [mkcert](https://github.com/FiloSottile/mkcert), then `KARAOKE_HOST=<this machine's LAN IP> npm run cert`, open `http://<LAN IP>:8780/ca` on the phone and trust the CA. The throwaway cert from `npm run dev` is not trusted by iOS/Android. Alternatively, host the Worker (README) so phones join over real HTTPS.

## Conventions

* TV and `shared/` code must stay **ES5-ish** (no optional chaining, `const` in a bundler-only way is fine in Node tools, but `tv/` and `shared/` run as plain scripts on Tizen). Do not add a compile step for the TV app.
* Prefer small, focused changes. `tv/app.js` is large; change only the region you need.
* If you change a string that `worker/build.mjs` patches, run `cd worker && npm run build` and fix any “patch miss” error.
* Do not hard-code machine IPs, invite codes, API keys, or account ids. Use env vars and git-ignored config (see README).
* Player names in tests should stay generic (not personal names).
* New tests go in `test/*.test.js` and must not touch a live `:8780` server or a production Worker. Use private ports (`HTTP_PORT`, `HTTPS_PORT`).

## How to add a song

You must have the rights to the recording. Do not commit the audio, stems, lyrics, or art.

**By hand** (good for a tiny original or already-prepared karaoke track): create `songs/<id>/` as in [songs/README.md](songs/README.md) (`song.json` + instrumental, optional `lyrics.lrc`, `melody.json`, `art.webp`). Add a line to `data/library-meta.txt`:

```
# id | genre | year | ballad(1/0) | optional extra cats | optional added date YYYY-MM-DD
my-song | pop | 2024 | 0
```

Then `npm run index`. Optionally `python3 tools/build-library.py` (needs `numpy` and `ffmpeg`) for categories, 18 s previews, and the Newly Added registry (`data/song-added.json`). Songs dated in the last 14 days appear under Newly Added, newest first.

**Automatic pipeline** (heavier; first-time setup is slow):

```sh
python3 -m venv .venv-ingest
.venv-ingest/bin/pip install demucs faster-whisper librosa numpy soundfile
# also needs ffmpeg on your PATH
npm run ingest -- path/to/song.mp3 'Artist - Title' --no-install
```

This runs Demucs (vocal / instrumental split), faster-whisper (word timings), LRCLIB (synced lyrics, network), and pYIN melody extraction into `songs/user-<slug>/`. CPU Demucs can take many minutes per song and uses several GB of disk. Always pass `--no-install` unless you intend to package and install a Tizen widget on a TV on the LAN. After ingest, `npm run index` (the batch script usually does this).

## How to add a category

Categories are data, not a new TV screen.

* Existing buckets (R&B, Hip-Hop, Christmas, …) come from the genre / year / ballad columns via `cats()` in `tools/build-library.py`. Put the song in `data/library-meta.txt` and rebuild the library.
* A new named category: add it to `CAT_NAMES` and to `cats()` (or the optional 5th column of `library-meta.txt` for a one-off tag), then rerun `python3 tools/build-library.py`. The TV rail and the phone filter read `songs/library.json` / the phone index — no `app.js` change if the id shows up there.
* Favorites are special (`fav`) and stored by the server, not by genre.
* Newly Added (`new`) is computed from `data/song-added.json` (or the 6th meta column) and a 14-day window.

## How to add a mode or feature

* **New play mode** (alongside Sing / Beat / Duet / Jam / Record): this is the hard path. You will touch `tv/index.html` (mode tabs), `tv/app.js` (`playKind`, `startGame`, results), and possibly `tv/beat.js` or `tv/engine.js`. Look at how `beat` and `sing` branch in `startGame` before adding a third engine.
* **UI / nav / scoring display:** almost always `tv/app.js` plus `tv/style.css`. Pointer and remote input already share the same handlers — keep it that way.
* **Phone behavior:** `phone/phone.js` and/or `phone/songs-tab.js`. The relay validates and rate-limits queue messages in `server/index.js`.
* **Scoring math:** `shared/scoring.js` with tests in `test/scoring.test.js`.
* **Hosted / online / leaderboard:** `worker/src/` (`room.js`, `board.js`, `lobby.js`, `match.js`, `online-config.js`) and `worker/web/`. Feature flags are in `worker/wrangler.toml.example` (`ONLINE_ENABLED`, `LB_PANEL_ENABLED`).

## Gotchas

* `tv/app.js` is a large single file. Search for section comments (`// ----------`) before editing. Do not refactor it “while you are here.”
* Tizen-only bits: `tv/config.xml`, `tools/package.py`, `tools/tv.py`, the `webapis` script tag. Packaging needs *your* signing profile in `.local/signing.json`. The widget streams audio from the server; it does not bundle the tracks.
* `npm start` without `certs/` still serves the TV over HTTP and logs `No certs/ — run npm run cert`. `npm run dev` and `npm test` create a throwaway cert automatically.
* Many `tools/check-*.mjs` scripts wait for `songs().length > 100`. They will time out on a demo-only clone. Adapt or skip them.
* `worker/build.mjs` fails loudly if a patch string in `tv/` or `phone/` moved. That is intentional.
* Durable Objects and large song assets on Cloudflare may need a paid Workers plan. Do not deploy copyrighted audio.
* The first `npm test` on a fresh clone can take a couple of seconds to write `certs/` and start a temporary server; it should stay in the 30s range, not minutes.

## Definition of done

1. `npm test` — 35 tests passing (count may grow; none failing).
2. `npm run lint` — clean.
3. For a TV/phone change that the Worker patches, `cd worker && npm run build` succeeds.
4. No secrets, IPs, or copyrighted song files in the commit. `songs/` only gains a demo or a format example, never a ripped catalog.
