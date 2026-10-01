#!/usr/bin/env bash
# CLI smoke for `termiHub install-shell-integration` /
# `termiHub uninstall-shell-integration` on Linux (#4010, SI-5/6/7).
#
# Usage: scripts/internal/shell-integration-cli-smoke.sh <path-to-termihub-binary>
#
# Proves, against a real built binary:
#   * both subcommands exit 0 and print their confirmation line;
#   * they need no elevation: the script refuses to run as root, and fake
#     `sudo` / `pkexec` shims on PATH fail the run if either is ever invoked;
#   * install records the registration (registered + the binary's own path) in
#     settings.json and writes the XDG launcher + the Nautilus script for a
#     configured entry; uninstall removes both and clears the registration.
#
# Safe to run on a developer machine: HOME, XDG_DATA_HOME, XDG_CONFIG_HOME and
# TERMIHUB_CONFIG_DIR all point into a throwaway sandbox that is deleted on
# exit, so the real ~/.local/share, ~/.config and termiHub settings are never
# read or written. Needs python3 (to seed an entry into settings.json).
set -euo pipefail

die() {
  echo "FAIL: $*" >&2
  exit 1
}

usage() {
  echo "usage: $0 <path-to-termihub-binary>"
  echo "Sandboxed Linux smoke of termiHub install-/uninstall-shell-integration (#4010)."
}

bin="${1:-}"
case "$bin" in
  -h | --help)
    usage
    exit 0
    ;;
  "")
    usage >&2
    exit 2
    ;;
esac
[ -x "$bin" ] || die "not an executable: $bin"
bin="$(readlink -f "$bin")"

if [ "$(id -u)" = "0" ]; then
  echo "refusing to run as root: the smoke must prove no elevation is needed" >&2
  exit 2
fi

sandbox="$(mktemp -d "${TMPDIR:-/tmp}/termihub-si-smoke.XXXXXX")"
trap 'rm -rf "$sandbox"' EXIT

export HOME="$sandbox/home"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CONFIG_HOME="$HOME/.config"
export TERMIHUB_CONFIG_DIR="$sandbox/termihub-config"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$TERMIHUB_CONFIG_DIR"
# A Nautilus scripts dir makes Nautilus "detected", so install exercises a
# per-file-manager surface on top of the universal XDG launcher.
mkdir -p "$XDG_DATA_HOME/nautilus/scripts"

# Elevation tripwires: any sudo/pkexec call leaves a marker and fails.
shims="$sandbox/shims"
mkdir -p "$shims"
for tool in sudo pkexec; do
  cat >"$shims/$tool" <<EOF
#!/bin/sh
echo "$tool \$*" >>"$sandbox/elevation-attempts"
exit 1
EOF
  chmod 0755 "$shims/$tool"
done
export PATH="$shims:$PATH"

settings="$TERMIHUB_CONFIG_DIR/settings.json"
apps="$XDG_DATA_HOME/applications"
scripts="$XDG_DATA_HOME/nautilus/scripts"

# run <subcommand> <expected confirmation line>
run() {
  local out code
  set +e
  out="$("$bin" "$1" </dev/null 2>&1)"
  code=$?
  set -e
  echo "--- termiHub $1 (exit $code)"
  echo "$out"
  [ "$code" -eq 0 ] || die "termiHub $1 exited $code"
  grep -qxF "$2" <<<"$out" || die "termiHub $1 did not print '$2'"
}

# settings_field <python expression over `si`> — reads the persisted
# shellIntegration block wherever it sits in settings.json.
settings_field() {
  python3 - "$settings" "$1" <<'EOF'
import json, sys

def find(node):
    if isinstance(node, dict):
        if "shellIntegration" in node:
            return node["shellIntegration"]
        for value in node.values():
            found = find(value)
            if found is not None:
                return found
    return None

si = find(json.load(open(sys.argv[1]))) or {}
print(eval(sys.argv[2], {"si": si}))
EOF
}

seed_entry() {
  python3 - "$settings" <<'EOF'
import json, sys

path = sys.argv[1]
doc = json.load(open(path))

def find(node):
    if isinstance(node, dict):
        if "shellIntegration" in node:
            return node["shellIntegration"]
        for value in node.values():
            found = find(value)
            if found is not None:
                return found
    return None

si = find(doc)
if si is None:
    doc["shellIntegration"] = si = {}
si["entries"] = [{
    "id": "smoke",
    "name": "Open in termiHub Smoke",
    "visibility": "always",
    "showFor": {"folders": True, "files": False, "folderBackground": True},
}]
json.dump(doc, open(path, "w"), indent=2)
EOF
}

# 1. Install with the default (empty) entry list: exits 0, records the facts.
run install-shell-integration "Shell integration installed."
[ -f "$settings" ] || die "install did not persist settings.json"
[ "$(settings_field 'si.get("registered")')" = "True" ] || die "install did not record registered"
[ "$(settings_field 'si.get("registeredExePath")')" = "$bin" ] ||
  die "registeredExePath is not the binary's own path ($bin)"

# 2. Install with a configured entry: the per-user surfaces are written.
seed_entry
run install-shell-integration "Shell integration installed."
desktop="$(grep -lsF "X-TermiHub-Managed=true" "$apps"/termihub-*.desktop || true)"
[ -n "$desktop" ] || die "no managed XDG launcher under $apps"
grep -qF "$bin" "$desktop" || die "XDG launcher does not invoke $bin"
[ -x "$scripts/Open in termiHub Smoke" ] || die "Nautilus script missing or not executable"

# 3. Uninstall: exits 0, removes every surface and clears the registration.
run uninstall-shell-integration "Shell integration removed."
if compgen -G "$apps/termihub-*.desktop" >/dev/null; then
  die "XDG launcher left behind after uninstall"
fi
[ ! -e "$scripts/Open in termiHub Smoke" ] || die "Nautilus script left behind after uninstall"
[ "$(settings_field 'si.get("registered")')" = "False" ] || die "uninstall did not clear registered"

[ ! -e "$sandbox/elevation-attempts" ] ||
  die "elevation attempted: $(cat "$sandbox/elevation-attempts")"

echo "OK: shell-integration CLI install/uninstall smoke passed (no elevation)"
