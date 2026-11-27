# Stingray Karaoke API v1: findings and adapter status

Source: https://karaoke-api-doc.stingray.com/api/v1/ (OpenAPI 3.0.1 "Karaoke API 1.8.9"; the spec file is not redistributed here, download it from Stingray).

- **Access:** no public sandbox. Credentials are issued by Stingray on request: see Stingray's API documentation, or use
  https://stingraykaraokesupport.zendesk.com/hc/en-us/requests/new (company, contact, intended use).
  The newer docs (v2/v3) describe a client ID + client secret → JWT at `login.stingray.com/loginapi/oauth/deviceLogin`.
- **v1 auth:** header `X-API-KEY: <key>` on every call; `POST /v1/login-device {device_id, country_code, language_code}`
  → `{token, duration_ms}`; catalog calls also need `Authorization: Bearer <token>`.
  **CORS is disabled**, so calls must go through a backend (our local server). The key never reaches the TV.
- **Catalog:** `/v1/search-songs?text=…`, `/v1/songs`, `/v1/trending-songs`, `/v1/artists…`, filters (genres/eras/languages).
- **Media:** `GET /v1/songs/{ids}?withPlayLink=true&withKml=true&videoCodec=H264` → `resources{}` of
  `{mime_type: video/mp4, uri (signed, expires in 15 min to a few hours), mix_type A_MIX (no lead vocal) | C_MIX (lead vocal),
  video_codec H264|H265, background_theme ANIMATED|BLACK, is_sample, preroll_uri}`. These are progressive MP4 links.
  The spec mentions no DRM or HLS, so Tizen's HTML5 media element should play them. That's untested without credentials.
  The v1 doc warns that v1 `/songs` links depended on the user's status; v2 `/songs` is the fix.
- **Lyrics:** KML file (`kml_resource.uri`) with `<pg id="lyrics.N"><ln c="pt.1"><lyr t="4.35" d="0.29" s="WORD "/>` (seconds),
  `<duet>` singer→part mapping, and an optional `<coldstartoffset C="ms">`.
- **Pitch/melody:** **none.** Only `key`, `key_pitch`, `bpm`. Fallback in `server/stingray.js`: decode C_MIX and A_MIX with ffmpeg,
  subtract the aligned, gain-matched instrumental to isolate the lead vocal, run YIN, then take one note per KML word (median pitch).
  The result is cached in `.local/stingray-cache/`. If that fails, the song plays as "sing-along" (unscored).
- **Royalties:** `POST /v1/play-log {song_id, duration_played_seconds}` after every play. The TV calls it through the server.

## Configure (once Stingray sends a key)
`.local/stingray.json` (chmod 600): `{"api_key": "…", "featured_song_id": "KAR:G:…", "country_code": "US"}`,
or set env `STINGRAY_API_KEY`. Then restart: `launchctl kickstart -k gui/$(id -u)/com.karaoketv.server`.
The TV shows the featured song as an extra card. Search API: `/api/stingray/search?q=`.
