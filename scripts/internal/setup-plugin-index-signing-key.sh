#!/usr/bin/env bash
#
# Maintainer one-time setup of the curated plugin-index signing key (#3716).
#
# Generates an Ed25519 keypair with OpenSSL and, in one go:
#   1. writes the PUBLIC key into plugins/keys/index-signing.pub.pem (commit it),
#   2. signs the current plugins/index.json into plugins/index.json.sig with the
#      fresh private key (commit it in the SAME PR, so the default index is
#      signed the moment desktops start requiring it),
#   3. stores the PRIVATE key as the PLUGIN_INDEX_SIGNING_KEY GitHub Actions
#      secret, which the "Plugin Index Signature" workflow uses to re-sign the
#      index whenever it changes.
#
# This key is SEPARATE from the agent update signing key
# (setup-agent-signing-key.sh). The private key is piped to `gh secret set` on
# stdin -- never echoed, never kept on disk: it lives in a private mktemp dir for
# the few seconds this script runs and is shredded on exit (success or failure).
# There is deliberately no backup; if it is ever lost or leaked, re-run with
# --force and commit the result (see docs/contributing.md -> "Plugin index
# signing key").
#
# Usage:
#   scripts/internal/setup-plugin-index-signing-key.sh [--dry-run]
#       [--pub-file <path>] [--index <path>] [--repo <owner/name>] [--force]
#
# Options:
#   --dry-run          Do everything except `gh` calls (prints what it would run)
#                      and work on temp copies, so the tree is never touched: the
#                      public key and a signed copy of the index are left in a
#                      temp dir for inspection. The private key is still shredded.
#   --pub-file <path>  Public-key file to write
#                      (default: plugins/keys/index-signing.pub.pem).
#   --index <path>     Index to sign (default: plugins/index.json); the signature
#                      is written next to it as <path>.sig.
#   --repo <o/n>       Repository for the secret (default: armaxri/termiHub).
#   --force            Overwrite a public-key file that already holds a real key
#                      (key loss / compromise response: desktops built with the
#                      old key reject indexes signed by the new one until they
#                      update).
#   --help, -h         Show this help.
#
# Requires: OpenSSL 3.x, and (unless --dry-run) an authenticated `gh` CLI with
# admin rights on the repo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HELPER="$SCRIPT_DIR/plugin-index-signing.sh"

SECRET_NAME="PLUGIN_INDEX_SIGNING_KEY"
REPO="armaxri/termiHub"
DEFAULT_PUB_FILE="$REPO_ROOT/plugins/keys/index-signing.pub.pem"
DEFAULT_INDEX="$REPO_ROOT/plugins/index.json"
PUB_FILE=""
INDEX=""
DRY_RUN=false
FORCE=false

usage() {
    sed -n '3,43p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "setup-plugin-index-signing-key: $*" >&2
    exit 1
}

while [ "$#" -gt 0 ]; do
    case "$1" in
    --dry-run)
        DRY_RUN=true
        shift
        ;;
    --pub-file)
        [ "$#" -ge 2 ] || die "--pub-file needs a value"
        PUB_FILE="$2"
        shift 2
        ;;
    --index)
        [ "$#" -ge 2 ] || die "--index needs a value"
        INDEX="$2"
        shift 2
        ;;
    --repo)
        [ "$#" -ge 2 ] || die "--repo needs a value"
        REPO="$2"
        shift 2
        ;;
    --force)
        FORCE=true
        shift
        ;;
    --help | -h)
        usage
        exit 0
        ;;
    *)
        die "unknown option: $1 (see --help)"
        ;;
    esac
done

# --- Preconditions (checked before any key material exists) ---
command -v openssl >/dev/null 2>&1 || die "openssl not found (OpenSSL 3.x required)"
if ! $DRY_RUN; then
    command -v gh >/dev/null 2>&1 || die "gh CLI not found"
    gh auth status >/dev/null 2>&1 || die "gh is not authenticated (run: gh auth login)"
fi

# Private scratch dir; everything secret lives only here and is destroyed on exit.
umask 077
WORK="$(mktemp -d)"
destroy_work() {
    if [ -d "$WORK" ]; then
        if command -v shred >/dev/null 2>&1; then
            find "$WORK" -type f -exec shred -u {} + 2>/dev/null || true
        else
            # macOS: overwrite before unlinking (best effort on APFS/SSD).
            find "$WORK" -type f -exec rm -P {} + 2>/dev/null || true
        fi
        rm -rf "$WORK"
    fi
}
trap destroy_work EXIT INT TERM

[ -n "$INDEX" ] || INDEX="$DEFAULT_INDEX"
[ -f "$INDEX" ] || die "index not found: $INDEX"
if $DRY_RUN; then
    # Public material only; left behind so the dry run's result can be inspected.
    DRY_DIR="$(mktemp -d)"
    [ -n "$PUB_FILE" ] || PUB_FILE="$DRY_DIR/index-signing.pub.pem"
    cp "$INDEX" "$DRY_DIR/index.json"
    INDEX="$DRY_DIR/index.json"
    echo "[dry-run] working in $DRY_DIR (the repo tree is not touched)"
else
    [ -n "$PUB_FILE" ] || PUB_FILE="$DEFAULT_PUB_FILE"
fi

if [ -f "$PUB_FILE" ] && grep -q -- "-----BEGIN PUBLIC KEY-----" "$PUB_FILE" && ! $FORCE; then
    die "$PUB_FILE already holds a real signing key. Desktops built with it would reject an \
index signed by a new key. Re-run with --force only if the private key was lost or leaked \
(read docs/contributing.md -> 'Plugin index signing key' first)."
fi

# --- Generate and validate the keypair ---
openssl genpkey -algorithm ed25519 -out "$WORK/priv.pem" 2>/dev/null ||
    die "openssl could not generate an Ed25519 key (OpenSSL 3.x required; LibreSSL is not supported)"
openssl pkey -in "$WORK/priv.pem" -pubout -out "$WORK/pub.pem"
openssl pkey -pubin -in "$WORK/pub.pem" -noout -text_pub | grep -q '^ED25519 Public-Key' ||
    die "generated key is not Ed25519"

# --- Write the public-key file (public material only) ---
mkdir -p "$(dirname "$PUB_FILE")"
{
    echo "# termiHub curated plugin-index signing key (#3716)."
    echo "#"
    echo "# Ed25519 public key(s) (PEM SubjectPublicKeyInfo) compiled into the desktop via"
    echo "# include_str! (core/src/plugin/index_signature.rs). The default plugin index"
    echo "# (plugins/index.json on main) is only accepted with a plugins/index.json.sig made"
    echo "# by the private half, which exists ONLY as the $SECRET_NAME"
    echo "# GitHub Actions secret. SEPARATE from the agent update signing key. Generated"
    echo "# $(date -u +%Y-%m-%d) by scripts/internal/setup-plugin-index-signing-key.sh."
    echo "# See docs/contributing.md -> \"Plugin index signing key\"."
    cat "$WORK/pub.pem"
} >"$PUB_FILE.tmp"
mv "$PUB_FILE.tmp" "$PUB_FILE"
chmod 644 "$PUB_FILE"
"$HELPER" --pub "$PUB_FILE" check-key

# --- Sign the current index with the exact CI pipeline (also the self-test) ---
"$HELPER" --pub "$PUB_FILE" sign --key "$WORK/priv.pem" "$INDEX" ||
    die "signing the index FAILED"
chmod 644 "$INDEX.sig"

# --- Store the private key as the GitHub secret (stdin; never echoed) ---
if $DRY_RUN; then
    echo "[dry-run] would run: gh secret set $SECRET_NAME --repo $REPO < <private key>"
else
    gh secret set "$SECRET_NAME" --repo "$REPO" <"$WORK/priv.pem"
    echo "Stored the private key as GitHub Actions secret $SECRET_NAME on $REPO."
fi

echo ""
echo "Public key written to: $PUB_FILE"
echo "Index signature written to: $INDEX.sig"
if $DRY_RUN; then
    echo "[dry-run] Nothing was uploaded and the repo tree was not touched."
else
    echo "Next step: commit both files on a branch and open a PR into develop, e.g."
    echo "  git checkout -b build/plugin-index-signing-key"
    echo "  git add plugins/keys/index-signing.pub.pem plugins/index.json.sig"
    echo "  git commit -m 'build(plugins): add the plugin index signing key and signature'"
    echo "Desktops built after it lands require the signature on the default index."
fi
