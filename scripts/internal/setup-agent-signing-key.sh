#!/usr/bin/env bash
#
# One-time maintainer setup of the agent self-update signing key (AGT-005, #3213).
#
# Generates an Ed25519 keypair locally with OpenSSL, then:
#   1. rewrites agent/keys/update-signing.pub.pem with the PUBLIC key (commit it),
#   2. stores the PRIVATE key as the GitHub Actions secret AGENT_UPDATE_SIGNING_KEY
#      (piped to `gh secret set` on stdin -- never echoed, never kept on disk),
#   3. self-tests the pair by signing + verifying a throwaway file.
#
# The private key exists afterwards ONLY as that GitHub secret: it lives in a
# private mktemp dir for the few seconds this script runs and is shredded on exit
# (success or failure). There is deliberately no backup; if it is ever lost or
# leaked, generate a new one (see docs/contributing.md -> "Agent update signing
# key" -> rotation).
#
# Usage:
#   scripts/internal/setup-agent-signing-key.sh [--dry-run] [--pub-file <path>]
#                                               [--repo <owner/name>] [--force]
#
# Options:
#   --dry-run          Do everything except `gh secret set` (prints what it would
#                      run). Without --pub-file the public key goes to a temp file
#                      instead of the repo, so a dry run never touches the tree.
#   --pub-file <path>  Where to write the public key
#                      (default: agent/keys/update-signing.pub.pem).
#   --repo <o/n>       Repository for the secret (default: armaxri/termiHub).
#   --force            Overwrite a public-key file that already holds a real key
#                      (compromise response only -- agents built with the old key
#                      then refuse new updates; a planned rotation needs an
#                      overlap, see the docs first).
#   --help, -h         Show this help.
#
# Requires: OpenSSL 3.x, and (unless --dry-run) an authenticated `gh` CLI with
# admin rights on the repo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SECRET_NAME="AGENT_UPDATE_SIGNING_KEY"
REPO="armaxri/termiHub"
DEFAULT_PUB_FILE="$REPO_ROOT/agent/keys/update-signing.pub.pem"
PUB_FILE=""
DRY_RUN=false
FORCE=false

usage() {
    sed -n '3,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "setup-agent-signing-key: $*" >&2
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

if [ -z "$PUB_FILE" ]; then
    if $DRY_RUN; then
        PUB_FILE="$(mktemp -d)/update-signing.pub.pem"
    else
        PUB_FILE="$DEFAULT_PUB_FILE"
    fi
fi

if [ -f "$PUB_FILE" ] && grep -q -- "-----BEGIN PUBLIC KEY-----" "$PUB_FILE" && ! $FORCE; then
    die "$PUB_FILE already holds a real signing key. Agents built with it would refuse \
updates signed by a new key. Re-run with --force only for a deliberate rotation (read \
docs/contributing.md -> 'Agent update signing key' first)."
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
    echo "# termiHub agent self-update signing key (AGT-005, #3213)."
    echo "#"
    echo "# Ed25519 public key (PEM SubjectPublicKeyInfo) compiled into every agent via"
    echo "# include_str! (agent/src/update/signature.rs). Release CI signs each agent binary"
    echo "# with the matching private key, which exists ONLY as the $SECRET_NAME"
    echo "# GitHub Actions secret. Generated $(date -u +%Y-%m-%d) by"
    echo "# scripts/internal/setup-agent-signing-key.sh. Rotation: docs/contributing.md ->"
    echo "# \"Agent update signing key\"."
    cat "$WORK/pub.pem"
} >"$PUB_FILE.tmp"
mv "$PUB_FILE.tmp" "$PUB_FILE"
chmod 644 "$PUB_FILE"

# --- Self-test: sign + verify a throwaway file with the exact CI pipeline ---
printf 'termihub agent signing self-test\n' >"$WORK/selftest.bin"
"$SCRIPT_DIR/agent-update-signing.sh" --pub "$PUB_FILE" sign --key "$WORK/priv.pem" \
    "$WORK/selftest.bin" >/dev/null || die "self-test signing/verification FAILED"
echo "Self-test: signature round-trip OK."

# --- Store the private key as the GitHub secret (stdin; never echoed) ---
if $DRY_RUN; then
    echo "[dry-run] would run: gh secret set $SECRET_NAME --repo $REPO < <private key>"
else
    gh secret set "$SECRET_NAME" --repo "$REPO" <"$WORK/priv.pem"
    echo "Stored the private key as GitHub Actions secret $SECRET_NAME on $REPO."
fi

echo ""
echo "Public key written to: $PUB_FILE"
if $DRY_RUN; then
    echo "[dry-run] Nothing was uploaded and the repo key file was not touched."
else
    echo "Next step: commit the public key on a branch and open a PR into develop, e.g."
    echo "  git checkout -b chore/agent-update-signing-key origin/develop"
    echo "  git add agent/keys/update-signing.pub.pem"
    echo "  git commit -m 'build(agent): add the agent update signing public key'"
    echo "Until that lands, release.yml refuses to publish (placeholder key)."
fi
