# Contributing

Thanks for helping! This is a small hobby project, so keep it simple. Coding agents should read [AGENTS.md](AGENTS.md) first.

* **Never commit music** (audio, stems, lyrics, cover art) for songs you do not own, or any library data for them. `songs/` is
  git-ignored except for the demo songs; please do not force-add anything.
* **Never commit secrets**: Worker secrets (`INVITE_CODE`, `SECRET`, `RELAY_TOKEN`), `.dev.vars`, `.local/`, Tizen
  certificates or profiles, API keys, or your own IP addresses/domains. Use the config files and env vars documented in the README.
* `npm test` and `npm run lint` must pass. If you change the TV/phone code that the Worker patches (`worker/build.mjs`), run
  `cd worker && npm run build`; it fails loudly when a patch point moved.
* Keep the TV app dependency-free (plain ES5-ish JS runs on older Tizen browsers; avoid new syntax in `tv/` and `shared/`).
* Small, focused pull requests with a short description of what you tested (TV, phone, Worker) are easiest to review.
* By contributing you agree your work is released under the MIT license.
