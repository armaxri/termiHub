#!/bin/bash
# Smoke-test the FTP fixtures from the HOST using curl.
#
# Brings nothing up itself — run `docker compose --profile ftp up -d --wait`
# first. Verifies, against the running container:
#   1. plain FTP        anonymous listing of /pub
#   2. plain FTP        ftpuser/ftppass listing of /pub
#   3. explicit FTPS    (AUTH TLS) listing of /pub
#   4. implicit FTPS    (TLS from start) listing of /pub
#   5. a known-size download (pub/data/dataset-1k.bin == 1024 bytes)
#
# This is the backend-independent integration smoke referenced by issue #1333;
# the FTP Rust backend sub-issues (#1334/#1335/#1336/#1339) add app-level tests.
#
# Ports honour the same env vars as docker-compose.yml (offset for parallel
# checkouts via scripts/internal/dev-local-env.sh).
set -euo pipefail

HOST="127.0.0.1"
FTP_PORT="${TERMIHUB_TEST_FTP_PORT:-2401}"
IMPLICIT_PORT="${TERMIHUB_TEST_FTPS_IMPLICIT_PORT:-2402}"
USER_PW="ftpuser:ftppass"

fail() {
    echo "SMOKE FAIL: $*" >&2
    exit 1
}

check_listing() {
    # $1 = human label, rest = curl args; expects the /pub listing to contain
    # the three known folders.
    local label="$1"
    shift
    local out
    out="$("$@")" || fail "$label: curl exited non-zero"
    for entry in docs images data readme.txt; do
        echo "$out" | grep -q "$entry" || fail "$label: '$entry' missing from listing"
    done
    echo "OK: $label lists /pub (docs, images, data, readme.txt)"
}

echo "== FTP fixture smoke test (host $HOST, ftp:$FTP_PORT implicit:$IMPLICIT_PORT) =="

# 1. Plain FTP, anonymous
check_listing "plain/anonymous" \
    curl -s --ftp-method nocwd "ftp://anonymous:test@${HOST}:${FTP_PORT}/pub/"

# 2. Plain FTP, ftpuser
check_listing "plain/ftpuser" \
    curl -s --ftp-method nocwd "ftp://${USER_PW}@${HOST}:${FTP_PORT}/pub/"

# 3. Explicit FTPS (AUTH TLS). -k: self-signed cert.
check_listing "explicit-ftps/ftpuser" \
    curl -s -k --ssl-reqd --ftp-method nocwd "ftp://${USER_PW}@${HOST}:${FTP_PORT}/pub/"

# 4. Implicit FTPS (ftps:// scheme, TLS from the start).
check_listing "implicit-ftps/ftpuser" \
    curl -s -k --ftp-method nocwd "ftps://${USER_PW}@${HOST}:${IMPLICIT_PORT}/pub/"

# 5. Known-size download over plain FTP.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -s "ftp://anonymous:test@${HOST}:${FTP_PORT}/pub/data/dataset-1k.bin" -o "$tmp" \
    || fail "download: curl exited non-zero"
size="$(wc -c <"$tmp" | tr -d ' ')"
[ "$size" = "1024" ] || fail "download: dataset-1k.bin is $size bytes, expected 1024"
echo "OK: downloaded pub/data/dataset-1k.bin ($size bytes)"

echo "== All FTP smoke checks passed =="
