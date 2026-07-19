#!/bin/sh
# Regenerate the committed VeNCrypt X509 test certificates.
#
# The VNC VeNCrypt fixture (tests/docker/vnc-vencrypt-server) serves TLS with a
# self-signed CA and a leaf certificate for 127.0.0.1. These are *test-only*
# credentials committed to the repo on purpose so both sides agree:
#
#   * the container presents server.crt / server.key (via TigerVNC -X509Cert),
#   * the `ca` integration test points `tlsVerify=ca` at ca.crt.
#
# Nothing outside the test fixture ever trusts these keys. Re-run this only when
# the certs expire (10-year validity) or the SANs need to change; commit the
# regenerated ca.crt / server.crt / server.key.
set -e
cd "$(dirname "$0")"

DAYS=3650

# 1. Self-signed CA (CA:TRUE) — the trust anchor the `ca` test loads.
openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout ca.key -out ca.crt -days "$DAYS" \
    -subj "/CN=termiHub VNC VeNCrypt Test CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"

# 2. Server leaf, signed by the CA, valid for 127.0.0.1 (IP SAN) + localhost.
openssl req -newkey rsa:2048 -nodes \
    -keyout server.key -out server.csr \
    -subj "/CN=termihub-vnc-vencrypt"

openssl x509 -req -in server.csr \
    -CA ca.crt -CAkey ca.key -CAcreateserial \
    -out server.crt -days "$DAYS" \
    -extfile /dev/stdin <<'EXT'
subjectAltName=IP:127.0.0.1,DNS:localhost
extendedKeyUsage=serverAuth
basicConstraints=critical,CA:FALSE
EXT

# Drop intermediate artefacts; keep only what the fixture and test need.
rm -f server.csr ca.srl ca.key

echo "Regenerated ca.crt, server.crt, server.key"
