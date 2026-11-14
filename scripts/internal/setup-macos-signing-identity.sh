#!/usr/bin/env bash
#
# One-time maintainer setup of termiHub's macOS code-signing identity (#5545).
#
# No Apple Developer account is involved (maintainer decision 2026-11-13). The
# release is signed with a SELF-SIGNED code-signing certificate that the project
# holds itself. Its point is the keychain, not Gatekeeper: macOS ties a keychain
# item to the designated requirement (DR) of the app that saved it. An ad-hoc
# build's DR is its build hash, new every release, so every update loses access
# to saved passwords. A build signed with this certificate has the DR
#   identifier "com.termihub.app" and certificate root = H"<certificate SHA-1>"
# which every later release signed with the same certificate shares. Gatekeeper's
# "unverified developer" warning on first install stays as it is.
#
# The script:
#   * generates an RSA key and a self-signed certificate (codeSigning extended
#     key usage, 30 years) with openssl, packed into a random-password .p12,
#   * self-tests it in a THROWAWAY keychain (never the login or default keychain,
#     never the search list): two different binaries signed with it must share
#     one DR naming the certificate (scripts/internal/macos-signing.mjs),
#   * writes the certificate SHA-1 into scripts/internal/macos-signing-identity.json
#     (public; commit it),
#   * stores the .p12 (base64) and its password as the GitHub Actions secrets
#     MACOS_SIGNING_P12_BASE64 and MACOS_SIGNING_P12_PASSWORD, which release.yml
#     imports into a temporary keychain on the macOS runner.
#
# The .p12 and password are piped to `gh secret set` on stdin -- never echoed.
# They live in a private mktemp dir while the script runs and are destroyed on
# exit, unless --backup-dir asks for a copy.
#
# KEEP A BACKUP. If the certificate is lost, the next release has to be signed
# with a new one: every user is asked ONCE more to allow keychain access (or
# saves the password again); after that the new certificate is stable again.
# The in-app updater is not affected (it trusts its own minisign key).
#
# Usage:
#   scripts/internal/setup-macos-signing-identity.sh [--dry-run] [--backup-dir <dir>]
#       [--pin-file <path>] [--repo <owner/name>] [--force]
#
# Options:
#   --dry-run           Do everything (incl. the keychain self-test) except `gh`
#                       calls. Without --pin-file it writes a temp copy of the pin
#                       file, so a dry run never touches the tree.
#   --backup-dir <dir>  Also write macos-signing.p12 and macos-signing.p12.password
#                       (mode 600) into <dir>, which must exist and not hold them.
#   --pin-file <path>   Pin file to write (default:
#                       scripts/internal/macos-signing-identity.json).
#   --repo <o/n>        Repository for the secrets (default: armaxri/termiHub).
#   --force             Replace a certificate that is already pinned. Users are
#                       then asked once more for keychain access; a loss or
#                       compromise response only.
#   --help, -h          Show this help.
#
# Requires macOS (security, codesign), openssl, node, and (unless --dry-run) an
# authenticated `gh` CLI with admin rights on the repo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SIGNING_TOOL="$SCRIPT_DIR/macos-signing.mjs"
KEYCHAIN_TOOL="$SCRIPT_DIR/macos-signing-keychain.sh"

P12_SECRET="MACOS_SIGNING_P12_BASE64"
PASSWORD_SECRET="MACOS_SIGNING_P12_PASSWORD"
SUBJECT_CN="termiHub Self-Signed Code Signing"
VALID_DAYS=10950
REPO="armaxri/termiHub"
DEFAULT_PIN="$SCRIPT_DIR/macos-signing-identity.json"
PIN_FILE=""
BACKUP_DIR=""
DRY_RUN=false
FORCE=false

usage() {
    sed -n '3,56p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "setup-macos-signing-identity: $*" >&2
    exit 1
}

while [ "$#" -gt 0 ]; do
    case "$1" in
    --dry-run)
        DRY_RUN=true
        shift
        ;;
    --backup-dir)
        [ "$#" -ge 2 ] || die "--backup-dir needs a value"
        BACKUP_DIR="$2"
        shift 2
        ;;
    --pin-file)
        [ "$#" -ge 2 ] || die "--pin-file needs a value"
        PIN_FILE="$2"
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
[ "$(uname -s)" = "Darwin" ] || die "needs macOS (security, codesign)"
for tool in security codesign openssl node; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found"
done
if ! $DRY_RUN; then
    command -v gh >/dev/null 2>&1 || die "gh CLI not found"
    gh auth status >/dev/null 2>&1 || die "gh is not authenticated (run: gh auth login)"
fi
if [ -n "$BACKUP_DIR" ]; then
    [ -d "$BACKUP_DIR" ] || die "--backup-dir $BACKUP_DIR does not exist"
    for f in macos-signing.p12 macos-signing.p12.password; do
        [ ! -e "$BACKUP_DIR/$f" ] || die "$BACKUP_DIR/$f already exists; refusing to overwrite a backup"
    done
fi

if [ -z "$PIN_FILE" ]; then
    if $DRY_RUN; then
        # Public material only; left behind so the dry run's result can be inspected.
        PIN_FILE="$(mktemp -d)/macos-signing-identity.json"
        cp "$DEFAULT_PIN" "$PIN_FILE"
        echo "[dry-run] working on a copy of $DEFAULT_PIN: $PIN_FILE"
    else
        PIN_FILE="$DEFAULT_PIN"
    fi
fi
[ -f "$PIN_FILE" ] || die "$PIN_FILE not found"
existing="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).certificateSha1 ?? ""))' "$PIN_FILE")" ||
    die "could not read certificateSha1 from $PIN_FILE"
if [ -n "$existing" ] && ! $FORCE; then
    die "$PIN_FILE already pins certificate $existing. Every installed copy's \
keychain items trust it; replacing it costs each user one more keychain approval. \
Re-run with --force only after a loss or compromise (read docs/contributing.md -> \
'macOS signing identity' first)."
fi

# Private scratch dir; everything secret lives only here and is destroyed on exit,
# together with the self-test keychain.
umask 077
WORK="$(mktemp -d)"
KEYCHAIN="$WORK/selftest.keychain-db"
cleanup() {
    if [ -e "$KEYCHAIN" ]; then
        bash "$KEYCHAIN_TOOL" delete "$KEYCHAIN" || true
    fi
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
trap cleanup EXIT INT TERM

# --- Generate the certificate and key ---
cat >"$WORK/cert.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = ext
[dn]
CN = $SUBJECT_CN
O = termiHub
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days "$VALID_DAYS" \
    -config "$WORK/cert.cnf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null ||
    die "openssl could not create the certificate"
openssl rand -base64 33 | tr -d '\n' >"$WORK/password"
# 3DES/SHA-1 PKCS#12: the encryption `security import` reads on every macOS
# version, from both OpenSSL 3 and LibreSSL.
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -name "$SUBJECT_CN" -out "$WORK/identity.p12" -passout "file:$WORK/password" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 ||
    die "openssl could not export the .p12"
rm -P "$WORK/key.pem" 2>/dev/null || rm -f "$WORK/key.pem"
cert_sha1="$(openssl x509 -in "$WORK/cert.pem" -noout -fingerprint -sha1 |
    sed 's/.*=//' | tr -d ':' | tr '[:upper:]' '[:lower:]')"
not_after="$(openssl x509 -in "$WORK/cert.pem" -noout -enddate | sed 's/^notAfter=//')"

# --- Self-test in a throwaway keychain ---
# Two different binaries (different code, so different cdhash) signed under one
# identifier, as two releases of the app are: their DR must be identical and
# name the new certificate.
keychain_sha1="$(bash "$KEYCHAIN_TOOL" create "$KEYCHAIN" "$WORK/identity.p12" "$WORK/password")" ||
    die "self-test: could not import the identity into a temporary keychain"
[ "$keychain_sha1" = "$cert_sha1" ] ||
    die "self-test: keychain identity $keychain_sha1 is not the new certificate $cert_sha1"
for build in true false; do
    cp "/usr/bin/$build" "$WORK/release-$build"
    codesign --force --timestamp=none --keychain "$KEYCHAIN" -s "$cert_sha1" \
        --identifier com.termihub.selftest "$WORK/release-$build" 2>/dev/null ||
        die "self-test: codesign failed"
    codesign --verify --strict "$WORK/release-$build" || die "self-test: signature does not verify"
done
node "$SIGNING_TOOL" check --cert-sha1 "$cert_sha1" --identifier com.termihub.selftest \
    "$WORK/release-true" "$WORK/release-false" >/dev/null ||
    die "self-test: the designated requirement does not name the new certificate"
dr="$(node "$SIGNING_TOOL" same "$WORK/release-true" "$WORK/release-false")" ||
    die "self-test: two builds signed with the identity have different designated requirements"
bash "$KEYCHAIN_TOOL" delete "$KEYCHAIN"
echo "Self-test: ${dr#ok  }"

# --- Write the pin (public material only) ---
node -e '
const fs = require("fs");
const [file, sha1, subject] = process.argv.slice(1);
const pin = JSON.parse(fs.readFileSync(file, "utf8"));
pin.certificateSha1 = sha1;
pin.subject = subject;
fs.writeFileSync(file, JSON.stringify(pin, null, 2) + "\n");
' "$PIN_FILE" "$cert_sha1" "CN=$SUBJECT_CN, O=termiHub (valid until $not_after)"

# --- Optional backup for the maintainer's password manager ---
if [ -n "$BACKUP_DIR" ]; then
    cp "$WORK/identity.p12" "$BACKUP_DIR/macos-signing.p12"
    cp "$WORK/password" "$BACKUP_DIR/macos-signing.p12.password"
    chmod 600 "$BACKUP_DIR/macos-signing.p12" "$BACKUP_DIR/macos-signing.p12.password"
    echo "Backup written to $BACKUP_DIR (macos-signing.p12, macos-signing.p12.password)."
    echo "Move both into your password manager and delete them from disk."
fi

# --- Store the .p12 and its password as GitHub secrets (stdin; never echoed) ---
if $DRY_RUN; then
    echo "[dry-run] would run: gh secret set $P12_SECRET --repo $REPO < <base64 .p12>"
    echo "[dry-run] would run: gh secret set $PASSWORD_SECRET --repo $REPO < <password>"
else
    base64 <"$WORK/identity.p12" | tr -d '\n' | gh secret set "$P12_SECRET" --repo "$REPO"
    gh secret set "$PASSWORD_SECRET" --repo "$REPO" <"$WORK/password"
    echo "Stored $P12_SECRET and $PASSWORD_SECRET as GitHub Actions secrets on $REPO."
fi

echo ""
echo "Certificate SHA-1 (the designated-requirement hash): $cert_sha1"
echo "Valid until: $not_after"
echo "Pin written to: $PIN_FILE"
if $DRY_RUN; then
    echo "[dry-run] Nothing was uploaded and the repo pin was not touched."
else
    if [ -z "$BACKUP_DIR" ]; then
        echo "WARNING: no backup was kept (--backup-dir). If the certificate is lost, every"
        echo "user is asked once more for keychain access after the next release."
    fi
    echo "Next step: commit the pin on a branch and open a PR into develop, e.g."
    echo "  git checkout -b build/macos-signing-identity origin/develop"
    echo "  git add scripts/internal/macos-signing-identity.json"
    echo "  git commit -m 'build(release): pin the macos signing identity'"
    echo "From the first release built after it lands, release.yml signs the macOS app"
    echo "with this identity; until then it stays ad-hoc signed with a notice."
fi
