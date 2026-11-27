#!/bin/sh
# One-command local dev: the TV UI in a browser, with the two demo songs.
# No Cloudflare, no Tizen, no extra hardware. Phones are optional.
set -e
cd "$(dirname "$0")/.."

# A throwaway self-signed cert lets the HTTPS phone page listen on localhost.
# Real phones will not trust it; use `npm run cert` (mkcert) for that. See README / AGENTS.md.
if [ ! -f certs/cert.pem ] || [ ! -f certs/key.pem ] || [ ! -f certs/rootCA.pem ]; then
  sh tools/test-cert.sh
fi

# Fresh clones have no cloud-relay config; default off so we never touch a hosted Worker.
export KTV_CLOUD="${KTV_CLOUD:-0}"

HTTP_PORT="${HTTP_PORT:-8780}"
echo
echo "Karaoke Beat Arcade — local dev"
echo "  Open in a browser:  http://127.0.0.1:${HTTP_PORT}/tv/"
echo "  Cloud relay:        off (KTV_CLOUD=${KTV_CLOUD})"
echo "  To play a demo:     click a song, click PLAY, then confirm once more to sing without a mic."
echo "  Phones:             need a trusted HTTPS cert — run npm run cert (mkcert). See AGENTS.md."
echo

exec node server/index.js
