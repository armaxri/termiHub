#!/usr/bin/env bash
#
# Agent self-update signing helper (AGT-005, #3213).
#
# Produces and checks the detached `<binary>.sig` sidecar that a release-built
# termiHub agent requires before it applies a self-update. The signature is an
# Ed25519 signature over a domain-separated SHA-256 digest of the binary:
#
#   message   = "termihub-agent-update-v1" || 0x00 || SHA-256(binary)   (raw bytes)
#   <bin>.sig = base64(Ed25519-sign(private_key, message))              (one line)
#
# This MUST stay byte-identical to agent/src/update/signature.rs (its
# `openssl_produced_signature_verifies` test pins this exact pipeline).
#
# Subcommands:
#   check-key                 Fail unless the trusted public-key file holds at
#                             least one real Ed25519 key (i.e. not the committed
#                             placeholder). release.yml runs this before building.
#   sign --key <priv.pem> <binary>...
#                             Write <binary>.sig for each binary, then verify it.
#                             Refuses a private key whose public half is not in
#                             the trusted file (a mismatched CI secret).
#   verify <binary>...        Verify each <binary>.sig against the trusted key(s).
#
# Common option:
#   --pub <file>              Trusted public-key file (default:
#                             agent/keys/update-signing.pub.pem)
#
# Requires OpenSSL 3.x (Ed25519 `pkeyutl -rawin`). Used by release.yml and
# dev-build.yml; see docs/contributing.md -> "Agent update signing key".

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DOMAIN="termihub-agent-update-v1"
PLACEHOLDER_MARKER="TERMIHUB-AGENT-UPDATE-KEY-PLACEHOLDER"
PUB_FILE="$REPO_ROOT/agent/keys/update-signing.pub.pem"

usage() {
    sed -n '3,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "agent-update-signing: $*" >&2
    exit 1
}

WORK=""
cleanup() {
    if [ -n "$WORK" ] && [ -d "$WORK" ]; then
        rm -rf "$WORK"
    fi
}
trap cleanup EXIT

# Write the exact signed message for binary $1 into file $2.
signed_message() {
    { printf '%s\0' "$DOMAIN"; openssl dgst -sha256 -binary "$1"; } >"$2"
}

# Split every PEM PUBLIC KEY block of $PUB_FILE into $WORK/pub-N.pem and print
# the number of blocks that are valid Ed25519 public keys (invalid ones are
# removed, mirroring the agent, where a garbled block never adds trust).
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
            echo "agent-update-signing: ignoring a non-Ed25519 PUBLIC KEY block in $PUB_FILE" >&2
            rm -f "$f"
        fi
    done
    echo "$count"
}

cmd_check_key() {
    [ -f "$PUB_FILE" ] || die "trusted key file not found: $PUB_FILE"
    if grep -q "$PLACEHOLDER_MARKER" "$PUB_FILE"; then
        die "$PUB_FILE is still the PLACEHOLDER — no agent update signing key is configured. \
Run scripts/internal/setup-agent-signing-key.sh (maintainer) and commit the result."
    fi
    local n
    n="$(split_trusted_keys)"
    [ "$n" -ge 1 ] || die "$PUB_FILE contains no valid Ed25519 PUBLIC KEY block"
    echo "Trusted agent update signing key(s): $n (from $PUB_FILE)"
}

# Verify <binary>.sig for binary $1 against the split trusted keys.
verify_one() {
    local bin="$1" sig="$1.sig" msg raw f
    [ -f "$bin" ] || die "binary not found: $bin"
    [ -f "$sig" ] || die "signature sidecar not found: $sig"
    msg="$WORK/msg"
    raw="$WORK/sig.raw"
    signed_message "$bin" "$msg"
    tr -d ' \r\n\t' <"$sig" | openssl base64 -d -A -out "$raw" 2>/dev/null ||
        die "malformed signature sidecar: $sig"
    [ "$(wc -c <"$raw" | tr -d ' ')" = "64" ] || die "signature in $sig is not 64 bytes"
    for f in "$WORK"/pub-*.pem; do
        [ -e "$f" ] || continue
        if openssl pkeyutl -verify -rawin -pubin -inkey "$f" -in "$msg" -sigfile "$raw" >/dev/null 2>&1; then
            echo "ok    $bin ($(basename "$sig") verifies)"
            return 0
        fi
    done
    die "SIGNATURE DOES NOT VERIFY for $bin against the trusted key(s) in $PUB_FILE"
}

cmd_verify() {
    [ "$#" -ge 1 ] || die "verify: no binaries given"
    cmd_check_key >/dev/null
    local b
    for b in "$@"; do
        verify_one "$b"
    done
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
        --) shift; break ;;
        -*) die "sign: unknown option $1" ;;
        *) break ;;
        esac
    done
    [ -n "$key" ] || die "sign: --key <private.pem> is required"
    [ -f "$key" ] || die "sign: private key not found: $key"
    [ "$#" -ge 1 ] || die "sign: no binaries given"
    cmd_check_key >/dev/null

    # The CI secret must be the private half of a trusted key — otherwise every
    # published signature would be refused by every agent.
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

    local b
    for b in "$@"; do
        [ -f "$b" ] || die "binary not found: $b"
        signed_message "$b" "$WORK/msg"
        openssl pkeyutl -sign -rawin -inkey "$key" -in "$WORK/msg" -out "$WORK/sig.raw"
        { openssl base64 -A -in "$WORK/sig.raw"; echo; } >"$b.sig"
        echo "signed $b -> $b.sig"
        verify_one "$b"
    done
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

[ -n "$SUBCOMMAND" ] || { usage >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || die "openssl not found (OpenSSL 3.x required)"
WORK="$(mktemp -d)"

case "$SUBCOMMAND" in
check-key) cmd_check_key ;;
sign) cmd_sign "${ARGS[@]+"${ARGS[@]}"}" ;;
verify) cmd_verify "${ARGS[@]+"${ARGS[@]}"}" ;;
*) die "unknown subcommand: $SUBCOMMAND (expected check-key, sign or verify)" ;;
esac
