#!/usr/bin/env bash
# Download a WSL distribution file, resumable and SHA-256 pinned (#5317).
#
# The wsl-live lane installs Debian through Vampire/setup-wsl. On a cache miss
# that action fetches the ~99 MB .wsl file from salsa.debian.org with
# @actions/tool-cache: three attempts, no resume. On develop's dispatched runs
# salsa cut the transfer mid-stream ("aborted") on every attempt, so the job
# died before any grade ran. PR runs passed only because they restored the
# Actions cache entry a develop run had just written; the repo's caches exceed
# GitHub's 10 GB budget, so that entry is evicted between the daily runs.
#
# This script does the download instead. Each attempt is a curl that resumes
# from the bytes already on disk (`-C -`), so a cut transfer keeps its
# progress. There are at most ATTEMPTS attempts, with a growing backoff.
# The result must match the pinned SHA-256: a wrong or truncated file is
# deleted and fetched again, never handed on.
#
# Exit codes: 0 = verified file at <output>; 2 = usage error; 3 = environment
# failure (download or checksum never succeeded). An exit of 3 prints a
# `::error title=WSL environment failure` annotation, so the run shows a runner
# or network problem, not a termiHub test failure.
#
# Usage: scripts/internal/fetch-wsl-distro.sh <url> <sha256> <output>
#   ATTEMPTS (default 6) and BACKOFF_SECONDS (default 15, grows linearly) tune it.
set -euo pipefail

case "${1:-}" in
--help | -h)
    awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
    exit 0
    ;;
esac

if [ "$#" -ne 3 ]; then
    echo "usage: $0 <url> <sha256> <output> (see --help)" >&2
    exit 2
fi
URL="$1"
WANT="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
OUT="$3"
ATTEMPTS="${ATTEMPTS:-6}"
BACKOFF_SECONDS="${BACKOFF_SECONDS:-15}"

case "$WANT" in
*[!0-9a-f]* | "")
    echo "ERROR: '$2' is not a hex SHA-256" >&2
    exit 2
    ;;
esac
if [ "${#WANT}" -ne 64 ]; then
    echo "ERROR: '$2' is not a 64-digit SHA-256" >&2
    exit 2
fi

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

mkdir -p "$(dirname "$OUT")"
PART="$OUT.part"

attempt=1
while :; do
    echo "fetch-wsl-distro: attempt $attempt/$ATTEMPTS: $URL"
    # -C - resumes from $PART's current size. --speed-limit/--speed-time abort
    # a stalled transfer (under 10 KB/s for 60 s) instead of hanging until the
    # step timeout; the next attempt then resumes it.
    if curl -fL --no-progress-meter -C - -o "$PART" \
        --connect-timeout 30 --speed-limit 10240 --speed-time 60 --max-time 900 \
        "$URL"; then
        got="$(sha256_of "$PART")"
        if [ "$got" = "$WANT" ]; then
            mv -f "$PART" "$OUT"
            echo "fetch-wsl-distro: verified $OUT (sha256 $got)"
            exit 0
        fi
        echo "fetch-wsl-distro: SHA-256 mismatch ($got != $WANT); discarding the file" >&2
        rm -f "$PART"
    else
        rc=$?
        # 33 = the server refused the range request. Start the next attempt
        # from byte 0, because a resumed file would be corrupt.
        if [ "$rc" -eq 33 ]; then
            rm -f "$PART"
        fi
        size=0
        if [ -f "$PART" ]; then size="$(wc -c <"$PART" | tr -d ' ')"; fi
        echo "fetch-wsl-distro: curl exited $rc with $size bytes kept for resume" >&2
    fi

    if [ "$attempt" -ge "$ATTEMPTS" ]; then
        break
    fi
    wait_s=$((BACKOFF_SECONDS * attempt))
    echo "fetch-wsl-distro: retrying in ${wait_s}s"
    sleep "$wait_s"
    attempt=$((attempt + 1))
done

rm -f "$PART"
echo "::error title=WSL environment failure::could not download a verified WSL distribution" \
    "from $URL after $ATTEMPTS attempts. The runner or network failed, not a termiHub test (#5317)."
exit 3
