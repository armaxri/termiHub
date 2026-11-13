#!/usr/bin/env bash
#
# One-time maintainer setup of the in-app updater signing key (#5758).
#
# Generates a minisign key pair with `pnpm tauri signer generate`, protected by a
# random password, then:
#   * writes the PUBLIC key into src-tauri/tauri.updater.conf.json
#     (plugins.updater.pubkey; commit it),
#   * stores the PRIVATE key and its password as the GitHub Actions secrets
#     TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD, which
#     release.yml uses to sign the updater bundles.
# A self-test signs a throwaway file with the new key and verifies it against the
# written public key (scripts/internal/updater-manifest.mjs) before anything is
# uploaded.
#
# The private key and password are piped to `gh secret set` on stdin -- never
# echoed. They live in a private mktemp dir while the script runs and are
# shredded on exit, unless --backup-dir asks for a copy.
#
# KEEP A BACKUP. Every installed termiHub trusts exactly this public key: if the
# private key or its password is lost, no installed copy can ever update in-app
# again (users would have to reinstall from the downloads page). Pass
# --backup-dir and move the two files into your password manager.
#
# Usage:
#   scripts/internal/setup-updater-signing-key.sh [--dry-run] [--backup-dir <dir>]
#       [--config <path>] [--repo <owner/name>] [--force]
#
# Options:
#   --dry-run           Do everything except `gh` calls (prints what it would run).
#                       Without --config it writes a temp copy of the config, so a
#                       dry run never touches the tree.
#   --backup-dir <dir>  Also write updater.key and updater.key.password (mode 600)
#                       into <dir>, which must exist and not already hold them.
#   --config <path>     Tauri config to write the public key into
#                       (default: src-tauri/tauri.updater.conf.json).
#   --repo <o/n>        Repository for the secrets (default: armaxri/termiHub).
#   --force             Replace a public key that is already set. Installed copies
#                       built with the old key then can no longer update in-app;
#                       a compromise response only.
#   --help, -h          Show this help.
#
# Requires: node and the repo's dependencies (`pnpm install`, for the Tauri CLI),
# openssl, and (unless --dry-run) an authenticated `gh` CLI with admin rights on
# the repo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MANIFEST_TOOL="$SCRIPT_DIR/updater-manifest.mjs"

KEY_SECRET="TAURI_SIGNING_PRIVATE_KEY"
PASSWORD_SECRET="TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
REPO="armaxri/termiHub"
DEFAULT_CONFIG="$REPO_ROOT/src-tauri/tauri.updater.conf.json"
CONFIG=""
BACKUP_DIR=""
DRY_RUN=false
FORCE=false

usage() {
    sed -n '3,46p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
    echo "setup-updater-signing-key: $*" >&2
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
    --config)
        [ "$#" -ge 2 ] || die "--config needs a value"
        CONFIG="$2"
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
command -v node >/dev/null 2>&1 || die "node not found"
command -v openssl >/dev/null 2>&1 || die "openssl not found"
TAURI_CLI="$REPO_ROOT/node_modules/.bin/tauri"
[ -x "$TAURI_CLI" ] || die "Tauri CLI not found at $TAURI_CLI (run: pnpm install)"
if ! $DRY_RUN; then
    command -v gh >/dev/null 2>&1 || die "gh CLI not found"
    gh auth status >/dev/null 2>&1 || die "gh is not authenticated (run: gh auth login)"
fi
if [ -n "$BACKUP_DIR" ]; then
    [ -d "$BACKUP_DIR" ] || die "--backup-dir $BACKUP_DIR does not exist"
    for f in updater.key updater.key.password; do
        [ ! -e "$BACKUP_DIR/$f" ] || die "$BACKUP_DIR/$f already exists; refusing to overwrite a backup"
    done
fi

if [ -z "$CONFIG" ]; then
    if $DRY_RUN; then
        # Public material only; left behind so the dry run's result can be inspected.
        CONFIG="$(mktemp -d)/tauri.updater.conf.json"
        cp "$DEFAULT_CONFIG" "$CONFIG"
        echo "[dry-run] working on a copy of $DEFAULT_CONFIG: $CONFIG"
    else
        CONFIG="$DEFAULT_CONFIG"
    fi
fi
[ -f "$CONFIG" ] || die "$CONFIG not found"

existing="$(node "$MANIFEST_TOOL" pubkey --config "$CONFIG")" ||
    die "could not read plugins.updater.pubkey from $CONFIG"
if [ -n "$existing" ] && ! $FORCE; then
    die "$CONFIG already holds an updater public key. Installed copies trust it; \
replacing it strands them on their version. Re-run with --force only as a \
compromise response (read docs/contributing.md -> 'Updater signing key' first)."
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

# --- Generate the key pair ---
# The password is random and never shown; `signer generate` takes it only as
# an argument, so it is visible in this machine's process list for the second
# the command runs.
openssl rand -base64 33 | tr -d '\n' >"$WORK/password"
"$TAURI_CLI" signer generate --ci -p "$(cat "$WORK/password")" \
    -w "$WORK/updater.key" -f >/dev/null ||
    die "tauri signer generate failed"
[ -s "$WORK/updater.key" ] && [ -s "$WORK/updater.key.pub" ] ||
    die "tauri signer generate wrote no key pair"
pubkey="$(tr -d '\n\r' <"$WORK/updater.key.pub")"

# --- Self-test: sign a throwaway file and verify it against the public key ---
printf 'termihub updater signing self-test\n' >"$WORK/selftest.bin"
TAURI_SIGNING_PRIVATE_KEY="$(cat "$WORK/updater.key")" \
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$WORK/password")" \
    "$TAURI_CLI" signer sign --app-version 0.0.0-selftest "$WORK/selftest.bin" >/dev/null ||
    die "self-test signing FAILED"
UPDATER_TOOL="$MANIFEST_TOOL" UPDATER_PUB="$pubkey" UPDATER_FILE="$WORK/selftest.bin" \
    node --input-type=module -e '
import { readFileSync } from "node:fs";
const { UPDATER_TOOL: tool, UPDATER_PUB: pub, UPDATER_FILE: file } = process.env;
const { verifySignature } = await import(tool);
const fields = verifySignature(readFileSync(file + ".sig", "utf8"), readFileSync(file), pub);
if (fields.version !== "0.0.0-selftest") throw new Error("signed version missing");
' || die "self-test verification FAILED"
echo "Self-test: signature round-trip OK."

# --- Write the public key into the config (public material only) ---
node -e '
const fs = require("fs");
const [file, key] = process.argv.slice(1);
const config = JSON.parse(fs.readFileSync(file, "utf8"));
config.plugins.updater.pubkey = key;
fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
' "$CONFIG" "$pubkey"
# Keep the file in the repo's Prettier style, so the commit only changes the key.
"$REPO_ROOT/node_modules/.bin/prettier" --config "$REPO_ROOT/.prettierrc" \
    --log-level warn --write "$CONFIG" ||
    die "could not format $CONFIG"
[ "$(node "$MANIFEST_TOOL" pubkey --config "$CONFIG")" = "$pubkey" ] ||
    die "could not write the public key into $CONFIG"

# --- Optional backup for the maintainer's password manager ---
if [ -n "$BACKUP_DIR" ]; then
    cp "$WORK/updater.key" "$BACKUP_DIR/updater.key"
    cp "$WORK/password" "$BACKUP_DIR/updater.key.password"
    chmod 600 "$BACKUP_DIR/updater.key" "$BACKUP_DIR/updater.key.password"
    echo "Backup written to $BACKUP_DIR (updater.key, updater.key.password)."
    echo "Move both into your password manager and delete them from disk."
fi

# --- Store the private key and password as GitHub secrets (stdin; never echoed) ---
if $DRY_RUN; then
    echo "[dry-run] would run: gh secret set $KEY_SECRET --repo $REPO < <private key>"
    echo "[dry-run] would run: gh secret set $PASSWORD_SECRET --repo $REPO < <password>"
else
    gh secret set "$KEY_SECRET" --repo "$REPO" <"$WORK/updater.key"
    gh secret set "$PASSWORD_SECRET" --repo "$REPO" <"$WORK/password"
    echo "Stored $KEY_SECRET and $PASSWORD_SECRET as GitHub Actions secrets on $REPO."
fi

echo ""
echo "Public key written to: $CONFIG"
if $DRY_RUN; then
    echo "[dry-run] Nothing was uploaded and the repo config was not touched."
else
    if [ -z "$BACKUP_DIR" ]; then
        echo "WARNING: no backup was kept (--backup-dir). If this key is ever lost, no"
        echo "installed copy can update in-app again."
    fi
    echo "Next step: commit the public key on a branch and open a PR into develop, e.g."
    echo "  git checkout -b build/updater-signing-key origin/develop"
    echo "  git add src-tauri/tauri.updater.conf.json"
    echo "  git commit -m 'build(release): add the in-app updater public key'"
    echo "From the first release built after it lands, release.yml signs the updater"
    echo "bundles and publishes latest.json; until then it skips them with a notice."
fi
