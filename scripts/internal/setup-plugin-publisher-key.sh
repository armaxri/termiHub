#!/usr/bin/env bash
#
# Maintainer one-time setup of the first-party plugin publisher key (#3980).
#
# Generates an Ed25519 keypair with OpenSSL and, in one go:
#   1. writes the PUBLIC key into plugins/keys/first-party-publisher.pub.pem
#      (commit it): desktops compile it in as an immutable `bundled` publisher,
#      so first-party plugins verify without any trust-on-first-use pin and no
#      trust-store.json edit can remove or replace it,
#   2. stores the PRIVATE key -- as the termihub-plugin-keygen JSON key file the
#      packer's `--sign` and termihub-plugin-sign read -- as the
#      FIRST_PARTY_PLUGIN_SIGNING_KEY GitHub Actions secret, which the
#      "Plugin Packaging" workflow uses to sign first-party plugin packages.
#
# This key is SEPARATE from the agent update signing key and from the
# plugin-index signing key. The private key is piped to `gh secret set` on stdin
# -- never echoed, never kept on disk: it lives in a private mktemp dir for the
# few seconds this script runs and is shredded on exit (success or failure).
# There is deliberately no backup; if it is ever lost or leaked, re-run with
# --force and commit the result (see docs/contributing.md -> "First-party plugin
# publisher key").
#
# Usage:
#   scripts/internal/setup-plugin-publisher-key.sh [--dry-run]
#       [--pub-file <path>] [--repo <owner/name>] [--force]
#
# Options:
#   --dry-run          Do everything except the `gh` calls (prints what it would
#                      run) and write the public key to a temp dir, so the tree is
#                      never touched. The private key is still shredded.
#   --pub-file <path>  Public-key file to write
#                      (default: plugins/keys/first-party-publisher.pub.pem).
#   --repo <o/n>       Repository for the secret (default: armaxri/termiHub).
#   --force            Overwrite a public-key file that already holds a real key
#                      (key loss / compromise response: plugins signed with the
#                      old key stop verifying as first-party in new desktops).
#   --help, -h         Show this help.
#
# Requires: OpenSSL 3.x, and (unless --dry-run) an authenticated `gh` CLI with
# admin rights on the repo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SECRET_NAME="FIRST_PARTY_PLUGIN_SIGNING_KEY"
LABEL="termiHub"
REPO="armaxri/termiHub"
DEFAULT_PUB_FILE="$REPO_ROOT/plugins/keys/first-party-publisher.pub.pem"
PUB_FILE=""
DRY_RUN=false
FORCE=false

usage() {
    sed -n '3,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "setup-plugin-publisher-key: $*" >&2
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
if command -v sha256sum >/dev/null 2>&1; then
    sha256_hex() { sha256sum | cut -c1-64; }
else
    sha256_hex() { shasum -a 256 | cut -c1-64; }
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

if $DRY_RUN; then
    # Public material only; left behind so the dry run's result can be inspected.
    DRY_DIR="$(mktemp -d)"
    [ -n "$PUB_FILE" ] || PUB_FILE="$DRY_DIR/first-party-publisher.pub.pem"
    echo "[dry-run] working in $DRY_DIR (the repo tree is not touched)"
else
    [ -n "$PUB_FILE" ] || PUB_FILE="$DEFAULT_PUB_FILE"
fi

if [ -f "$PUB_FILE" ] && grep -q -- "-----BEGIN PUBLIC KEY-----" "$PUB_FILE" && ! $FORCE; then
    die "$PUB_FILE already holds a real publisher key. Plugins signed with it would stop \
verifying as first-party in desktops built with a new one. Re-run with --force only if the \
private key was lost or leaked (read docs/contributing.md -> 'First-party plugin publisher \
key' first)."
fi

# --- Generate and validate the keypair ---
openssl genpkey -algorithm ed25519 -out "$WORK/priv.pem" 2>/dev/null ||
    die "openssl could not generate an Ed25519 key (OpenSSL 3.x required; LibreSSL is not supported)"
openssl pkey -in "$WORK/priv.pem" -pubout -out "$WORK/pub.pem"
openssl pkey -pubin -in "$WORK/pub.pem" -noout -text_pub | grep -q '^ED25519 Public-Key' ||
    die "generated key is not Ed25519"

# Raw 32-byte seed / public key: the tails of the PKCS#8 (48-byte) and SPKI
# (44-byte) DER encodings -- the form termihub-plugin-keygen key files carry.
openssl pkey -in "$WORK/priv.pem" -outform DER -out "$WORK/priv.der"
openssl pkey -pubin -in "$WORK/pub.pem" -outform DER -out "$WORK/pub.der"
[ "$(wc -c <"$WORK/priv.der" | tr -d ' ')" = 48 ] || die "unexpected PKCS#8 length"
[ "$(wc -c <"$WORK/pub.der" | tr -d ' ')" = 44 ] || die "unexpected SPKI length"
tail -c 32 "$WORK/priv.der" >"$WORK/seed.bin"
tail -c 32 "$WORK/pub.der" >"$WORK/pub.bin"
PUB_B64="$(openssl base64 -A -in "$WORK/pub.bin")"
KEY_ID="sha256:$(sha256_hex <"$WORK/pub.bin")"

# Self-test: a signature made with the private key verifies with the public key.
printf 'termihub first-party publisher key self-test\n' >"$WORK/msg"
openssl pkeyutl -sign -inkey "$WORK/priv.pem" -rawin -in "$WORK/msg" -out "$WORK/msg.sig"
openssl pkeyutl -verify -pubin -inkey "$WORK/pub.pem" -rawin -in "$WORK/msg" \
    -sigfile "$WORK/msg.sig" >/dev/null || die "self-test signature did NOT verify"

# The key file the packer signs with (SigningKeyFile JSON; base64 has no
# characters that need JSON escaping). Written only inside $WORK.
{
    printf '{\n'
    printf '  "privateKey": "%s",\n' "$(openssl base64 -A -in "$WORK/seed.bin")"
    printf '  "publicKey": "%s",\n' "$PUB_B64"
    printf '  "keyId": "%s",\n' "$KEY_ID"
    printf '  "label": "%s"\n' "$LABEL"
    printf '}\n'
} >"$WORK/first-party.key"

# --- Write the public-key file (public material only) ---
mkdir -p "$(dirname "$PUB_FILE")"
{
    echo "# termiHub first-party plugin publisher key -- the bundled trust anchor (#3980)."
    echo "#"
    echo "# Ed25519 public key(s) (PEM SubjectPublicKeyInfo) compiled into the desktop via"
    echo "# include_str! (core/src/plugin/trust_store.rs) as an immutable bundled publisher."
    echo "# Key id: $KEY_ID"
    echo "# The private half exists ONLY as the $SECRET_NAME GitHub"
    echo "# Actions secret, used by the Plugin Packaging workflow. SEPARATE from the agent"
    echo "# update and plugin-index signing keys. Generated $(date -u +%Y-%m-%d) by"
    echo "# scripts/internal/setup-plugin-publisher-key.sh."
    echo "# See docs/contributing.md -> \"First-party plugin publisher key\"."
    cat "$WORK/pub.pem"
} >"$PUB_FILE.tmp"
mv "$PUB_FILE.tmp" "$PUB_FILE"
chmod 644 "$PUB_FILE"
grep -q -- "-----BEGIN PUBLIC KEY-----" "$PUB_FILE" || die "public-key file was not written"

# --- Store the private key file as the GitHub secret (stdin; never echoed) ---
if $DRY_RUN; then
    echo "[dry-run] would run: gh secret set $SECRET_NAME --repo $REPO < <private key file>"
else
    gh secret set "$SECRET_NAME" --repo "$REPO" <"$WORK/first-party.key"
    echo "Stored the private key as GitHub Actions secret $SECRET_NAME on $REPO."
fi

echo ""
echo "Public key written to: $PUB_FILE"
echo "First-party publisher key id: $KEY_ID"
if $DRY_RUN; then
    echo "[dry-run] Nothing was uploaded and the repo tree was not touched."
else
    echo "Next step: commit the key file on a branch and open a PR into develop, e.g."
    echo "  git checkout -b build/plugin-publisher-key"
    echo "  git add plugins/keys/first-party-publisher.pub.pem"
    echo "  git commit -m 'build(plugins): add the first-party plugin publisher key'"
    echo "Desktops built after it lands trust first-party plugins signed with it."
fi
