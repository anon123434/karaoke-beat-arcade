#!/bin/sh
# Creates a throwaway self-signed certificate in certs/ if none exists, so `npm test` works on a fresh clone.
# For real phone use run `npm run cert` (mkcert) instead: phones must trust the CA.
set -e
cd "$(dirname "$0")/.."
[ -f certs/cert.pem ] && [ -f certs/key.pem ] && [ -f certs/rootCA.pem ] && exit 0
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout certs/key.pem -out certs/cert.pem -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
cp certs/cert.pem certs/rootCA.pem
chmod 600 certs/key.pem
echo "created throwaway test certificate in certs/"
