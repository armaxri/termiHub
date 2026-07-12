#!/bin/bash
# Generate a deterministic FTP test tree for termiHub FTP integration fixtures.
#
# Runs at container build time to pre-populate /srv/ftp, which is the shared
# root for BOTH the anonymous user and the local `ftpuser` account. The tree
# mirrors the `/pub` layout described in the FTP-client concept
# (docs/concepts/backlog/ftp-client.html): 3 folders and 14 files under /pub.
#
# Determinism matters: listing/transfer assertions in the FTP backend sub-issues
# (#1334/#1335/#1336/#1339) compare against KNOWN sizes and, where useful, known
# content. Every file here has a fixed size and fixed byte content (text files
# hold fixed strings; binary files are zero-filled), so both `SIZE` and a
# checksum are reproducible across rebuilds and across machines.
set -e

FTP_ROOT="/srv/ftp"
PUB="$FTP_ROOT/pub"
UPLOADS="$FTP_ROOT/uploads"

echo "=== Generating FTP test data ==="

mkdir -p "$PUB/docs" "$PUB/images" "$PUB/data" "$UPLOADS"

# --- Helper: write exactly N zero bytes (deterministic content + size) ---
zeros() {
    # $1 = path, $2 = byte count
    head -c "$2" /dev/zero >"$1"
}

# --- pub/ root text files (fixed content => fixed size) ---
printf '%s\n' "termiHub FTP test server. See pub/docs for more information." >"$PUB/readme.txt"
printf '%s\n' "Welcome to the termiHub FTP fixture. Anonymous browsing enabled." >"$PUB/welcome.txt"

# --- pub/docs/ (4 text files) ---
printf '%s\n' "Getting started guide for the termiHub FTP fixture." >"$PUB/docs/guide.txt"
printf '%s\n' "Reference manual placeholder for FTP fixture testing." >"$PUB/docs/manual.txt"
printf '%s\n' "v1: initial deterministic FTP fixture tree." >"$PUB/docs/changelog.txt"
printf '%s\n' "Q: Is this deterministic? A: Yes, sizes are fixed." >"$PUB/docs/faq.txt"

# --- pub/images/ (2 binary files, known sizes) ---
zeros "$PUB/images/logo.bin" 2048
zeros "$PUB/images/banner.bin" 4096

# --- pub/data/ (6 binary files spanning empty..1 MiB, known sizes) ---
zeros "$PUB/data/dataset-1k.bin" 1024
zeros "$PUB/data/dataset-8k.bin" 8192
zeros "$PUB/data/dataset-64k.bin" 65536
zeros "$PUB/data/dataset-1m.bin" 1048576
: >"$PUB/data/empty.bin"
printf 'X' >"$PUB/data/single-byte.bin"

# --- Ownership / permissions ---
# The read-only tree is world-readable; the anonymous FTP user (`ftp`) and the
# local `ftpuser` both only need read access. `uploads/` is writable so
# STOR/upload tests have a landing zone.
chmod -R a+rX "$FTP_ROOT"
chown -R root:root "$PUB"
chmod 0777 "$UPLOADS"

# --- Emit a manifest so the expected tree is self-documenting in build logs ---
echo "--- FTP test tree manifest (path : bytes) ---"
find "$PUB" -type f | sort | while read -r f; do
    printf '%s : %s\n' "${f#"$FTP_ROOT"}" "$(wc -c <"$f")"
done
echo "=== FTP test data generation complete ==="
echo "Total pub/ size: $(du -sh "$PUB" | cut -f1)"
