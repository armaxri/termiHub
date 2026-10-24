#!/usr/bin/env bash
#
# Release install-smoke: the shipped bundle carries termiHub's own icon, not a
# generic one (#4933, MT-UI-19).
#
# The dock / launcher icon comes from the bundle: macOS reads the .icns that
# Info.plist's CFBundleIconFile names, and a Linux desktop resolves the .desktop
# entry's Icon= name in the hicolor theme. Each must be byte-identical to an
# icon tauri.conf.json bundles from src-tauri/icons, so a lost, renamed or
# placeholder icon fails here instead of in an operator's eyes. (The Windows
# executable's embedded icon is checked by release-smoke-exe-icon.ps1.)
#
# Usage:
#   release-smoke-bundle-icon.sh --icons <src-tauri/icons> \
#       (--macos-app <termiHub.app> | --linux-root <dir>)
#
#   --icons       the repository's icon directory (src-tauri/icons)
#   --macos-app   an installed macOS app bundle
#   --linux-root  the root the Linux package installed into: / for the .deb,
#                 the extracted squashfs-root for the AppImage (whose top-level
#                 .DirIcon is checked as well)
#
# Exit status: 0 when every check passed, 1 otherwise, 2 on a usage error.

set -euo pipefail

usage() {
  sed -n '2,/^# Exit status/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

ICONS=""
MACOS_APP=""
LINUX_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --help | -h)
      usage
      exit 0
      ;;
    --icons) ICONS="${2:-}"; shift 2 ;;
    --macos-app) MACOS_APP="${2:-}"; shift 2 ;;
    --linux-root) LINUX_ROOT="${2:-}"; shift 2 ;;
    *)
      echo "error: unknown argument '$1' (see --help)" >&2
      exit 2
      ;;
  esac
done

die() {
  echo "error: $*" >&2
  exit 2
}
[ -d "$ICONS" ] || die "--icons '$ICONS' is not a directory"
if [ -n "$MACOS_APP" ] && [ -n "$LINUX_ROOT" ]; then die "pass --macos-app or --linux-root, not both"; fi
[ -n "$MACOS_APP" ] || [ -n "$LINUX_ROOT" ] || die "--macos-app or --linux-root is required"

PASSED=0
FAILED=0
pass() { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "::error::bundle icon smoke: $1"; FAILED=$((FAILED + 1)); }

sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# repo_icon_for <file>: the repository icon (basename) the file is identical to.
repo_icon_for() {
  local want f
  want="$(sha "$1")"
  for f in "$ICONS"/*; do
    [ -f "$f" ] || continue
    if [ "$(sha "$f")" = "$want" ]; then
      basename "$f"
      return 0
    fi
  done
  return 1
}

# expected_for_size <hicolor size dir>: the repository icon that size must be
# (32x32 -> 32x32.png, 256x256@2 -> 128x128@2x.png), when the repo has one.
expected_for_size() {
  local size="$1" side exp
  case "$size" in
    *@2)
      side="${size%%x*}"
      exp="$((side / 2))x$((side / 2))@2x.png"
      ;;
    *) exp="$size.png" ;;
  esac
  if [ -f "$ICONS/$exp" ]; then echo "$exp"; fi
}

# check_icon <label> <file> [expected]: the file exists and is the expected
# repository icon (or, without one, any of them).
check_icon() {
  local label="$1" file="$2" want="${3:-}" match
  if [ ! -s "$file" ]; then
    fail "$label: $file is missing or empty"
  elif [ -n "$want" ]; then
    if [ "$(sha "$file")" = "$(sha "$ICONS/$want")" ]; then
      pass "$label: $file is src-tauri/icons/$want"
    else
      fail "$label: $file is not src-tauri/icons/$want (a placeholder or stale icon)"
    fi
  elif match="$(repo_icon_for "$file")"; then
    pass "$label: $file is src-tauri/icons/$match"
  else
    fail "$label: $file matches no icon in $ICONS (a placeholder or stale icon)"
  fi
}

echo "=== termiHub release smoke: bundled app icon ==="

if [ -n "$MACOS_APP" ]; then
  plist="$MACOS_APP/Contents/Info.plist"
  [ -f "$plist" ] || die "'$MACOS_APP' has no Contents/Info.plist"
  name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$plist" 2>/dev/null || true)"
  if [ -z "$name" ]; then
    fail "Info.plist names no CFBundleIconFile (the Dock would show a generic icon)"
  else
    pass "Info.plist names CFBundleIconFile '$name'"
    case "$name" in *.icns) ;; *) name="$name.icns" ;; esac
    check_icon "Dock icon" "$MACOS_APP/Contents/Resources/$name" icon.icns
  fi
else
  desktop=""
  for f in "$LINUX_ROOT"/usr/share/applications/*.desktop; do
    [ -f "$f" ] || continue
    if grep -qE '^Exec=termihub( |$)' "$f"; then desktop="$f"; fi
  done
  if [ -z "$desktop" ]; then
    fail "no .desktop entry with Exec=termihub under $LINUX_ROOT/usr/share/applications"
  else
    name="$(sed -n 's/^Icon=//p' "$desktop" | head -n1)"
    if [ -z "$name" ]; then
      fail "$desktop has no Icon= line (launchers would show a generic icon)"
    else
      pass "$(basename "$desktop") names Icon=$name"
      found=0
      for f in "$LINUX_ROOT"/usr/share/icons/hicolor/*/apps/"$name".png; do
        [ -f "$f" ] || continue
        found=$((found + 1))
        size="$(basename "$(dirname "$(dirname "$f")")")"
        check_icon "hicolor $size" "$f" "$(expected_for_size "$size")"
      done
      if [ "$found" -eq 0 ]; then
        fail "no hicolor icon named $name.png under $LINUX_ROOT/usr/share/icons"
      fi
      for size in 32x32 128x128; do
        [ -f "$LINUX_ROOT/usr/share/icons/hicolor/$size/apps/$name.png" ] ||
          fail "no $size hicolor icon ($size/apps/$name.png)"
      done
    fi
  fi
  if [ -e "$LINUX_ROOT/.DirIcon" ]; then
    check_icon "AppImage .DirIcon" "$LINUX_ROOT/.DirIcon"
  fi
fi

echo ""
echo "  Bundle icon smoke: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
