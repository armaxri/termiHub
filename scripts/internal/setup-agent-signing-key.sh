#!/usr/bin/env bash
#
# Maintainer setup and planned rotation of the agent self-update signing key
# (AGT-005, #3213; rotation #3329).
#
# Modes (default: initial setup):
#   (none)         Initial setup. Generates an Ed25519 keypair with OpenSSL, writes
#                  the PUBLIC key into agent/keys/update-signing.pub.pem (commit it)
#                  and stores the PRIVATE key as the AGENT_UPDATE_SIGNING_KEY secret.
#   --rotate       Rotation step 1 (overlap). Generates the NEXT keypair, APPENDS its
#                  public key after the current one and stages the private key in the
#                  free secret slot (AGENT_UPDATE_SIGNING_KEY_NEXT, or
#                  AGENT_UPDATE_SIGNING_KEY once a previous rotation freed it).
#                  Release CI keeps signing with the current key, because it signs
#                  with the key of the FIRST trusted block.
#   --switch-over  Rotation step 2. Drops the FIRST (old) public-key block, so release
#                  CI signs with the staged key from then on. Touches no secret and no
#                  private key: the new private key never leaves GitHub.
#
# Every private key is piped to `gh secret set` on stdin -- never echoed, never kept
# on disk: it lives in a private mktemp dir for the few seconds this script runs and
# is shredded on exit (success or failure). There is deliberately no backup; if it is
# ever lost or leaked, generate a new one (see docs/contributing.md -> "Agent update
# signing key").
#
# Usage:
#   scripts/internal/setup-agent-signing-key.sh [--rotate | --switch-over]
#       [--dry-run] [--pub-file <path>] [--repo <owner/name>] [--secret <name>]
#       [--force]
#
# Options:
#   --dry-run          Do everything except `gh` calls (prints what it would run).
#                      Without --pub-file it works on a temp file (--rotate and
#                      --switch-over start from a copy of the repo key file), so a
#                      dry run never touches the tree.
#   --pub-file <path>  Public-key file to write
#                      (default: agent/keys/update-signing.pub.pem).
#   --repo <o/n>       Repository for the secret (default: armaxri/termiHub).
#   --secret <name>    Secret slot to store the private key in: AGENT_UPDATE_SIGNING_KEY
#                      or AGENT_UPDATE_SIGNING_KEY_NEXT (initial default: the former;
#                      --rotate default: whichever `gh secret list` shows free).
#   --force            Initial mode only: overwrite a public-key file that already
#                      holds a real key (compromise response only -- agents built with
#                      the old key then refuse new updates; plan a rotation instead).
#   --help, -h         Show this help.
#
# Requires: OpenSSL 3.x, and (unless --dry-run or --switch-over) an authenticated
# `gh` CLI with admin rights on the repo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HELPER="$SCRIPT_DIR/agent-update-signing.sh"

# The two secret slots release CI reads (release.yml / dev-build.yml pass both to
# `agent-update-signing.sh select-key`). A rotation stages the next key in the free
# slot, so the slots alternate across rotations and no private key is ever copied.
PRIMARY_SECRET="AGENT_UPDATE_SIGNING_KEY"
NEXT_SECRET="AGENT_UPDATE_SIGNING_KEY_NEXT"
REPO="armaxri/termiHub"
DEFAULT_PUB_FILE="$REPO_ROOT/agent/keys/update-signing.pub.pem"
PUB_FILE=""
SECRET_NAME=""
MODE="setup"
DRY_RUN=false
FORCE=false

usage() {
    sed -n '3,48p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "setup-agent-signing-key: $*" >&2
    exit 1
}

while [ "$#" -gt 0 ]; do
    case "$1" in
    --rotate)
        [ "$MODE" = "setup" ] || die "--rotate and --switch-over are mutually exclusive"
        MODE="rotate"
        shift
        ;;
    --switch-over)
        [ "$MODE" = "setup" ] || die "--rotate and --switch-over are mutually exclusive"
        MODE="switch-over"
        shift
        ;;
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
    --secret)
        [ "$#" -ge 2 ] || die "--secret needs a value"
        SECRET_NAME="$2"
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

case "$SECRET_NAME" in
"" | "$PRIMARY_SECRET" | "$NEXT_SECRET") ;;
*) die "--secret must be $PRIMARY_SECRET or $NEXT_SECRET (the only slots release CI reads)" ;;
esac
if $FORCE && [ "$MODE" != "setup" ]; then
    die "--force applies to the initial setup only (a rotation never overwrites a key)"
fi
if [ "$MODE" = "switch-over" ] && [ -n "$SECRET_NAME" ]; then
    die "--switch-over touches no secret; drop --secret"
fi

# Number of PEM PUBLIC KEY blocks in file $1.
count_blocks() {
    grep -c -- '-----BEGIN PUBLIC KEY-----' "$1" || true
}

# --- Preconditions (checked before any key material exists) ---
command -v openssl >/dev/null 2>&1 || die "openssl not found (OpenSSL 3.x required)"
if ! $DRY_RUN && [ "$MODE" != "switch-over" ]; then
    command -v gh >/dev/null 2>&1 || die "gh CLI not found"
    gh auth status >/dev/null 2>&1 || die "gh is not authenticated (run: gh auth login)"
fi

# Private scratch dir; everything secret lives only here and is destroyed on exit.
umask 077
WORK="$(mktemp -d)"
DRY_DIR=""
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
        # Public material only; left behind so the dry run's result can be inspected.
        DRY_DIR="$(mktemp -d)"
        PUB_FILE="$DRY_DIR/update-signing.pub.pem"
        if [ "$MODE" != "setup" ]; then
            [ -f "$DEFAULT_PUB_FILE" ] || die "$DEFAULT_PUB_FILE not found"
            cp "$DEFAULT_PUB_FILE" "$PUB_FILE"
            echo "[dry-run] working on a copy of $DEFAULT_PUB_FILE: $PUB_FILE"
        fi
    else
        PUB_FILE="$DEFAULT_PUB_FILE"
    fi
fi

# Rotation modes start from a file that holds real (non-placeholder) key(s).
if [ "$MODE" != "setup" ]; then
    [ -f "$PUB_FILE" ] || die "$PUB_FILE not found"
    "$HELPER" --pub "$PUB_FILE" check-key >/dev/null ||
        die "$PUB_FILE holds no real signing key yet: run the initial setup (no --rotate) first"
fi

# --- Switch-over: drop the first (old) block; no key material involved ---
if [ "$MODE" = "switch-over" ]; then
    blocks="$(count_blocks "$PUB_FILE")"
    [ "$blocks" -eq 2 ] || die "$PUB_FILE holds $blocks public key(s); --switch-over needs \
exactly 2 (the current key, then the one staged by --rotate)"
    # Drop block #1 together with its "# Private half staged in secret:" line
    # (written directly above each block; absent in files from before #3329).
    awk '
        { line[NR] = $0 }
        /-----BEGIN PUBLIC KEY-----/ && !first { first = NR }
        /-----END PUBLIC KEY-----/ && first && !last { last = NR }
        END {
            from = first
            if (from > 1 && line[from - 1] ~ /^# Private half staged in secret: /) from--
            for (i = 1; i <= NR; i++) {
                if (i >= from && i <= last) continue
                if (line[i] == "#" && prev == "#") continue   # no doubled separators
                print line[i]
                prev = line[i]
            }
        }
    ' "$PUB_FILE" >"$PUB_FILE.tmp"
    [ "$(count_blocks "$PUB_FILE.tmp")" -eq 1 ] || die "could not drop the old key block"
    mv "$PUB_FILE.tmp" "$PUB_FILE"
    chmod 644 "$PUB_FILE"
    "$HELPER" --pub "$PUB_FILE" check-key
    staged="$(sed -n 's/^# Private half staged in secret: \([A-Z_]*\).*/\1/p' "$PUB_FILE" | tail -1)"
    retired=""
    case "$staged" in
    "$PRIMARY_SECRET") retired="$NEXT_SECRET" ;;
    "$NEXT_SECRET") retired="$PRIMARY_SECRET" ;;
    esac
    echo ""
    echo "Dropped the old public key; the remaining key is the one --rotate staged${staged:+ in $staged}."
    echo "Public key file: $PUB_FILE"
    if $DRY_RUN; then
        echo "[dry-run] The repo key file and all secrets were left untouched."
    else
        echo "Next steps:"
        echo "  1. Commit the key file on a branch and open a PR into develop, e.g."
        echo "       git checkout -b build/agent-signing-key-switch-over origin/develop"
        echo "       git add agent/keys/update-signing.pub.pem"
        echo "       git commit -m 'build(agent): switch agent update signing to the rotated key'"
        echo "     From the first release built after it lands, CI signs with the staged key"
        echo "     (the sign job logs 'Selected signing key: ...')."
        echo "  2. After that release is published, delete the retired private key:"
        echo "       gh secret delete ${retired:-<the slot NOT named above>} --repo $REPO"
    fi
    exit 0
fi

if [ "$MODE" = "rotate" ]; then
    blocks="$(count_blocks "$PUB_FILE")"
    [ "$blocks" -eq 1 ] || die "$PUB_FILE already holds $blocks public keys: a rotation is \
in progress. Finish it with --switch-over before staging another key."
fi

# --- Choose the secret slot ---
if [ -z "$SECRET_NAME" ]; then
    if [ "$MODE" = "setup" ]; then
        SECRET_NAME="$PRIMARY_SECRET"
    elif $DRY_RUN; then
        SECRET_NAME="$NEXT_SECRET"
        echo "[dry-run] would pick the free slot via: gh secret list --repo $REPO (assuming $SECRET_NAME)"
    else
        existing="$(gh secret list --repo "$REPO" --json name --jq '.[].name')" ||
            die "could not list the secrets of $REPO (admin rights needed)"
        if ! grep -qx "$NEXT_SECRET" <<<"$existing"; then
            SECRET_NAME="$NEXT_SECRET"
        elif ! grep -qx "$PRIMARY_SECRET" <<<"$existing"; then
            SECRET_NAME="$PRIMARY_SECRET"
        else
            die "both $PRIMARY_SECRET and $NEXT_SECRET are set, so there is no free slot. \
Finish the previous rotation first: --switch-over, ship a release, then delete the retired secret."
        fi
    fi
fi

if [ "$MODE" = "setup" ] && [ -f "$PUB_FILE" ] && grep -q -- "-----BEGIN PUBLIC KEY-----" "$PUB_FILE" && ! $FORCE; then
    die "$PUB_FILE already holds a real signing key. Agents built with it would refuse \
updates signed by a new key. For a planned rotation use --rotate; re-run with --force only \
as a compromise response (read docs/contributing.md -> 'Agent update signing key' first)."
fi

# --- Generate and validate the keypair ---
openssl genpkey -algorithm ed25519 -out "$WORK/priv.pem" 2>/dev/null ||
    die "openssl could not generate an Ed25519 key (OpenSSL 3.x required; LibreSSL is not supported)"
openssl pkey -in "$WORK/priv.pem" -pubout -out "$WORK/pub.pem"
openssl pkey -pubin -in "$WORK/pub.pem" -noout -text_pub | grep -q '^ED25519 Public-Key' ||
    die "generated key is not Ed25519"

# --- Write the public-key file (public material only) ---
mkdir -p "$(dirname "$PUB_FILE")"
if [ "$MODE" = "rotate" ]; then
    {
        cat "$PUB_FILE"
        echo "#"
        echo "# Rotation key added $(date -u +%Y-%m-%d) by setup-agent-signing-key.sh --rotate;"
        echo "# release CI signs with it once --switch-over drops the key above."
        echo "# Private half staged in secret: $SECRET_NAME"
        cat "$WORK/pub.pem"
    } >"$PUB_FILE.tmp"
else
    {
        echo "# termiHub agent self-update signing key (AGT-005, #3213)."
        echo "#"
        echo "# Ed25519 public key(s) (PEM SubjectPublicKeyInfo) compiled into every agent and"
        echo "# desktop via include_str! (core/src/agent_update_signature.rs). Release CI signs"
        echo "# each agent binary with the private half of the FIRST key below, which exists"
        echo "# ONLY as a GitHub Actions secret (AGENT_UPDATE_SIGNING_KEY or _NEXT). Generated"
        echo "# $(date -u +%Y-%m-%d) by scripts/internal/setup-agent-signing-key.sh. Rotation:"
        echo "# docs/contributing.md -> \"Agent update signing key\"."
        echo "#"
        echo "# Private half staged in secret: $SECRET_NAME"
        cat "$WORK/pub.pem"
    } >"$PUB_FILE.tmp"
fi
mv "$PUB_FILE.tmp" "$PUB_FILE"
chmod 644 "$PUB_FILE"

# --- Self-test: sign + verify a throwaway file with the exact CI pipeline ---
printf 'termihub agent signing self-test\n' >"$WORK/selftest.bin"
"$HELPER" --pub "$PUB_FILE" sign --key "$WORK/priv.pem" \
    "$WORK/selftest.bin" >/dev/null || die "self-test signing/verification FAILED"
echo "Self-test: signature round-trip OK."
"$HELPER" --pub "$PUB_FILE" check-key

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
elif [ "$MODE" = "rotate" ]; then
    echo "Next steps (overlap; CI keeps signing with the current key meanwhile):"
    echo "  1. Commit the key file on a branch and open a PR into develop, e.g."
    echo "       git checkout -b build/agent-signing-key-rotation origin/develop"
    echo "       git add agent/keys/update-signing.pub.pem"
    echo "       git commit -m 'build(agent): add the next agent update signing public key'"
    echo "  2. Ship at least one release carrying both keys and let agents update to it."
    echo "  3. Then run: scripts/internal/setup-agent-signing-key.sh --switch-over"
else
    echo "Next step: commit the public key on a branch and open a PR into develop, e.g."
    echo "  git checkout -b chore/agent-update-signing-key origin/develop"
    echo "  git add agent/keys/update-signing.pub.pem"
    echo "  git commit -m 'build(agent): add the agent update signing public key'"
    echo "Until that lands, release.yml refuses to publish (placeholder key)."
fi
