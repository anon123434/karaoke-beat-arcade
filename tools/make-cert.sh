#!/bin/sh
# Creates a LAN HTTPS cert for the machine running the server with mkcert (local CA, no system trust changes).
# iPhone Safari needs HTTPS for microphone access; install certs/rootCA.pem once on the phone.
set -e
cd "$(dirname "$0")/.."
IP="${KARAOKE_HOST:?set KARAOKE_HOST to this machine'"'"'s LAN IP, e.g. KARAOKE_HOST=192.168.1.50}"
mkdir -p certs
mkcert -cert-file certs/cert.pem -key-file certs/key.pem "$IP" localhost 127.0.0.1 >/dev/null 2>&1
cp "$(mkcert -CAROOT)/rootCA.pem" certs/rootCA.pem   # public CA cert only, never the key
chmod 600 certs/key.pem
echo "cert ready for $IP"
