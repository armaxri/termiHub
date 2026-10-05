#!/usr/bin/env bash
#
# Curated plugin-index signing helper (#3716).
#
# Produces and checks the detached `index.json.sig` that the desktop requires
# before it accepts the default plugin index. The signature is an Ed25519
# signature over a domain-separated SHA-256 digest of the exact index bytes:
#
#   message        = "termihub-plugin-index-v1" || 0x00 || SHA-256(index)   (raw bytes)
#   index.json.sig = base64(Ed25519-sign(private_key, message))              (one line)
#
# This MUST stay byte-identical to core/src/plugin/index_signature.rs (its
# `openssl_produced_signature_verifies` test pins this exact pipeline). The key
# is SEPARATE from the agent update signing key (agent-update-signing.sh).
#
# Subcommands:
#   status                    Print "placeholder" (exit 0) when the trusted
#                             public-key file is still the committed placeholder,
#                             "configured" when it holds at least one Ed25519
#                             key; fail when it is neither (a broken file).
#   check-key                 Fail unless the trusted public-key file holds at
#                             least one real Ed25519 key.
#   sign --key <priv.pem> [<index>]
#                             Write <index>.sig, then verify it. Refuses a private
#                             key whose public half is not in the trusted file.
#   verify [<index>]          Verify <index>.sig against the trusted key(s).
#
#   <index> defaults to plugins/index.json.
#
# Common option:
#   --pub <file>              Trusted public-key file (default:
#                             plugins/keys/index-signing.pub.pem)
#
# Requires OpenSSL 3.x (Ed25519 `pkeyutl -rawin`). Never prints key material.
# See docs/contributing.md -> "Plugin index signing key".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DOMAIN="termihub-plugin-index-v1"
PLACEHOLDER_MARKER="TERMIHUB-PLUGIN-INDEX-KEY-PLACEHOLDER"
PUB_FILE="$REPO_ROOT/plugins/keys/index-signing.pub.pem"
DEFAULT_INDEX="$REPO_ROOT/plugins/index.json"

usage() {
    sed -n '3,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "plugin-index-signing: $*" >&2
    exit 1
}

WORK=""
cleanup() {
    if [ -n "$WORK" ] && [ -d "$WORK" ]; then
        rm -rf "$WORK"
    fi
}
trap cleanup EXIT

# Write the exact signed message for index file $1 into file $2.
signed_message() {
    { printf '%s\0' "$DOMAIN"; openssl dgst -sha256 -binary "$1"; } >"$2"
}

# Split every PEM PUBLIC KEY block of $PUB_FILE into $WORK/pub-N.pem and print
# the number of valid Ed25519 keys (invalid blocks are dropped, mirroring the
# desktop, where a garbled block never adds trust).
split_trusted_keys() {
    awk -v dir="$WORK" '
        /-----BEGIN PUBLIC KEY-----/ { n++; out = dir "/pub-" n ".pem"; inblk = 1 }
        inblk { print > out }
        /-----END PUBLIC KEY-----/ { inblk = 0; close(out) }
    ' "$PUB_FILE"
    local count=0 f
    for f in "$WORK"/pub-*.pem; do
        [ -e "$f" ] || continue
        if openssl pkey -pubin -in "$f" -noout -text_pub 2>/dev/null | grep -q '^ED25519 Public-Key'; then
            count=$((count + 1))
        else
            echo "plugin-index-signing: ignoring a non-Ed25519 PUBLIC KEY block in $PUB_FILE" >&2
            rm -f "$f"
        fi
    done
    echo "$count"
}

cmd_status() {
    [ -f "$PUB_FILE" ] || die "trusted key file not found: $PUB_FILE"
    if grep -q "$PLACEHOLDER_MARKER" "$PUB_FILE"; then
        echo "placeholder"
        return 0
    fi
    local n
    n="$(split_trusted_keys)"
    [ "$n" -ge 1 ] || die "$PUB_FILE is not the placeholder but holds no valid Ed25519 PUBLIC KEY block"
    echo "configured"
}

cmd_check_key() {
    [ -f "$PUB_FILE" ] || die "trusted key file not found: $PUB_FILE"
    if grep -q "$PLACEHOLDER_MARKER" "$PUB_FILE"; then
        die "$PUB_FILE is still the PLACEHOLDER — no plugin index signing key is configured. \
Run scripts/internal/setup-plugin-index-signing-key.sh (maintainer) and commit the result."
    fi
    local n
    n="$(split_trusted_keys)"
    [ "$n" -ge 1 ] || die "$PUB_FILE contains no valid Ed25519 PUBLIC KEY block"
    echo "Trusted plugin index signing key(s): $n (from $PUB_FILE)"
}

# Verify <index>.sig for index $1 against the split trusted keys.
verify_one() {
    local index="$1" sig="$1.sig" msg raw f
    [ -f "$index" ] || die "index not found: $index"
    [ -f "$sig" ] || die "signature not found: $sig"
    msg="$WORK/msg"
    raw="$WORK/sig.raw"
    signed_message "$index" "$msg"
    tr -d ' \r\n\t' <"$sig" | openssl base64 -d -A -out "$raw" 2>/dev/null ||
        die "malformed signature: $sig"
    [ "$(wc -c <"$raw" | tr -d ' ')" = "64" ] || die "signature in $sig is not 64 bytes"
    for f in "$WORK"/pub-*.pem; do
        [ -e "$f" ] || continue
        if openssl pkeyutl -verify -rawin -pubin -inkey "$f" -in "$msg" -sigfile "$raw" >/dev/null 2>&1; then
            echo "ok    $index ($(basename "$sig") verifies)"
            return 0
        fi
    done
    die "SIGNATURE DOES NOT VERIFY for $index against the trusted key(s) in $PUB_FILE \
(stale after an index change? re-sign it — see docs/contributing.md -> 'Plugin index signing key')"
}

cmd_verify() {
    [ "$#" -le 1 ] || die "verify: at most one index file"
    cmd_check_key >/dev/null
    verify_one "${1:-$DEFAULT_INDEX}"
}

cmd_sign() {
    local key=""
    while [ "$#" -gt 0 ]; do
        case "$1" in
        --key)
            [ "$#" -ge 2 ] || die "sign: --key needs a value"
            key="$2"
            shift 2
            ;;
        --)
            shift
            break
            ;;
        -*) die "sign: unknown option $1" ;;
        *) break ;;
        esac
    done
    [ -n "$key" ] || die "sign: --key <private.pem> is required"
    [ -f "$key" ] || die "sign: private key not found: $key"
    [ "$#" -le 1 ] || die "sign: at most one index file"
    local index="${1:-$DEFAULT_INDEX}"
    [ -f "$index" ] || die "index not found: $index"
    cmd_check_key >/dev/null

    # The key must be the private half of a trusted key — otherwise every
    # desktop would refuse the signed index.
    local keypub="$WORK/key.pub.pem" match=0 f
    openssl pkey -in "$key" -pubout -out "$keypub" 2>/dev/null || die "sign: $key is not a readable private key"
    openssl pkey -pubin -in "$keypub" -noout -text_pub 2>/dev/null | grep -q '^ED25519 Public-Key' ||
        die "sign: $key is not an Ed25519 private key"
    for f in "$WORK"/pub-*.pem; do
        [ -e "$f" ] || continue
        if cmp -s <(openssl pkey -pubin -in "$f" -outform DER) <(openssl pkey -pubin -in "$keypub" -outform DER); then
            match=1
        fi
    done
    [ "$match" -eq 1 ] || die "sign: the private key does not match any trusted public key in $PUB_FILE"

    signed_message "$index" "$WORK/msg"
    openssl pkeyutl -sign -rawin -inkey "$key" -in "$WORK/msg" -out "$WORK/sig.raw"
    { openssl base64 -A -in "$WORK/sig.raw"; echo; } >"$index.sig"
    echo "signed $index -> $index.sig"
    verify_one "$index"
}

# --- Argument parsing ---
SUBCOMMAND=""
ARGS=()
while [ "$#" -gt 0 ]; do
    case "$1" in
    --help | -h)
        usage
        exit 0
        ;;
    --pub)
        [ "$#" -ge 2 ] || die "--pub needs a value"
        PUB_FILE="$2"
        shift 2
        ;;
    *)
        if [ -z "$SUBCOMMAND" ]; then
            SUBCOMMAND="$1"
        else
            ARGS+=("$1")
        fi
        shift
        ;;
    esac
done

[ -n "$SUBCOMMAND" ] || {
    usage >&2
    exit 2
}
command -v openssl >/dev/null 2>&1 || die "openssl not found (OpenSSL 3.x required)"
WORK="$(mktemp -d)"

case "$SUBCOMMAND" in
status) cmd_status ;;
check-key) cmd_check_key ;;
sign) cmd_sign "${ARGS[@]+"${ARGS[@]}"}" ;;
verify) cmd_verify "${ARGS[@]+"${ARGS[@]}"}" ;;
*) die "unknown subcommand: $SUBCOMMAND (expected status, check-key, sign or verify)" ;;
esac
