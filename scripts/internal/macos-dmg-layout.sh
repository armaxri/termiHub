#!/usr/bin/env bash
#
# Keep Tauri's DMG layout when the macOS app is re-signed (PKG2-009, #4361).
#
# release.yml and dev-build.yml copy the .app out of Tauri's DMG, re-sign it
# ad-hoc inside-out, and used to rebuild the image with
# `hdiutil create -srcfolder <app>`. That image held only the .app: Tauri's
# /Applications drop link (drag-to-install), its volume icon and any Finder
# layout were gone, so users tended to launch the app from the read-only image
# (App Translocation). This helper instead swaps the re-signed .app into a
# writable copy of Tauri's OWN image, so everything else on the volume (the
# Applications link, .VolumeIcon.icns and its custom-icon flag, .DS_Store,
# .background, the volume name) is kept byte-for-byte.
#
# Subcommands:
#   replace-app <dmg> <app>
#       Replace the .app inside <dmg> with <app> (same bundle name, e.g. the
#       re-signed termiHub.app) and rewrite <dmg> as a compressed UDZO image.
#       <dmg> is only replaced once the new image is complete and passes
#       `check`; on any failure the original <dmg> is left untouched.
#       An image without an Applications link gets one (drag-to-install).
#   check <dmg>
#       Fail unless the image holds exactly one .app and an `Applications`
#       symlink to /Applications. Lists the volume's top level.
#
# macOS only (hdiutil, ditto). Environment knobs (tests): HDIUTIL (default
# hdiutil), DITTO (default ditto), MACOS_DMG_HEADROOM_KB (extra space in the
# writable image, default 20480).

set -euo pipefail

usage() {
  sed -n '3,27p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "macos-dmg-layout: $*" >&2
  exit 1
}

HDIUTIL="${HDIUTIL:-hdiutil}"
DITTO="${DITTO:-ditto}"

# Mount points this run attached; detached again on exit, whatever happened.
MOUNTS=()
WORK=""
cleanup() {
  local m
  for m in ${MOUNTS[@]+"${MOUNTS[@]}"}; do
    "$HDIUTIL" detach "$m" -quiet >/dev/null 2>&1 \
      || "$HDIUTIL" detach "$m" -force -quiet >/dev/null 2>&1 || true
  done
  [ -n "$WORK" ] && rm -rf "$WORK"
  return 0
}
trap cleanup EXIT

attach() { # <image> <mountpoint> [extra hdiutil flags...]
  local image="$1" mount="$2"
  shift 2
  mkdir -p "$mount"
  "$HDIUTIL" attach "$image" -mountpoint "$mount" -nobrowse -noautoopen -quiet "$@"
  MOUNTS+=("$mount")
}

detach() { # <mountpoint>
  local mount="$1" i rest=()
  sync
  if ! "$HDIUTIL" detach "$mount" -quiet; then
    # A just-closed file can keep the volume busy for a moment.
    sleep 2
    "$HDIUTIL" detach "$mount" -force -quiet || die "could not detach '$mount'"
  fi
  for i in ${MOUNTS[@]+"${MOUNTS[@]}"}; do
    [ "$i" = "$mount" ] || rest+=("$i")
  done
  MOUNTS=(${rest[@]+"${rest[@]}"})
}

# The .app bundles at the top level of a mounted volume, one per line.
apps_in() {
  find "$1/" -mindepth 1 -maxdepth 1 -name '*.app' -exec basename {} \; | sort
}

# Exit non-zero (with a reason) unless <mount> holds exactly one .app and an
# Applications symlink to /Applications.
assert_layout() {
  local mount="$1" apps count target
  apps="$(apps_in "$mount")"
  count="$(printf '%s' "$apps" | grep -c . || true)"
  if [ "$count" -ne 1 ]; then
    echo "macos-dmg-layout: expected exactly one .app on the volume, found $count:" >&2
    [ -n "$apps" ] && printf '  %s\n' "$apps" >&2
    return 1
  fi
  if [ ! -L "$mount/Applications" ]; then
    echo "macos-dmg-layout: the volume has no 'Applications' symlink (drag-to-install)" >&2
    return 1
  fi
  target="$(readlink "$mount/Applications")"
  if [ "$target" != "/Applications" ]; then
    echo "macos-dmg-layout: 'Applications' points to '$target', not /Applications" >&2
    return 1
  fi
}

cmd_check() {
  [ "$#" -eq 1 ] || die "usage: check <dmg>"
  local dmg="$1"
  [ -f "$dmg" ] || die "image '$dmg' does not exist"
  WORK="$(mktemp -d)"
  attach "$dmg" "$WORK/mount" -readonly
  echo "Top level of $(basename "$dmg"):"
  ls -la "$WORK/mount/"
  if ! assert_layout "$WORK/mount"; then
    detach "$WORK/mount"
    die "$(basename "$dmg") lost Tauri's drag-to-install layout"
  fi
  detach "$WORK/mount"
  echo "$(basename "$dmg"): one .app and an Applications link — layout OK."
}

cmd_replace_app() {
  [ "$#" -eq 2 ] || die "usage: replace-app <dmg> <app>"
  local dmg="$1" app="${2%/}" name old app_kb limits cur sectors headroom
  [ -f "$dmg" ] || die "image '$dmg' does not exist"
  [ -d "$app" ] || die "app bundle '$app' does not exist"
  name="$(basename "$app")"
  case "$name" in *.app) ;; *) die "'$app' is not a .app bundle" ;; esac
  headroom="${MACOS_DMG_HEADROOM_KB:-20480}"

  WORK="$(mktemp -d)"
  local rw="$WORK/rw.dmg" out="$WORK/out.dmg" mount="$WORK/mount"

  # 1. A writable copy of Tauri's image, grown so the new .app always fits
  #    (the old one is removed first, so this is generous).
  "$HDIUTIL" convert "$dmg" -format UDRW -o "$rw" -quiet
  app_kb="$(du -sk "$app" | cut -f1)"
  # `resize -limits` prints "<min> <current> <max>" in 512-byte sectors.
  limits="$("$HDIUTIL" resize -limits "$rw")"
  cur="$(printf '%s\n' "$limits" | awk 'NF >= 3 { print $2; exit }')"
  case "$cur" in '' | *[!0-9]*) die "could not read the image size from: $limits" ;; esac
  sectors=$((cur + (app_kb + headroom) * 2))
  "$HDIUTIL" resize -sectors "$sectors" "$rw" -quiet

  # 2. Swap the bundle. Only the same-named bundle is replaced, so a Finder
  #    layout keyed by the app's name still applies.
  attach "$rw" "$mount"
  old="$(apps_in "$mount")"
  if [ "$old" != "$name" ]; then
    die "the image holds [${old//$'\n'/, }], expected exactly '$name'"
  fi
  rm -rf "${mount:?}/$name"
  "$DITTO" "$app" "$mount/$name"
  if [ ! -e "$mount/Applications" ] && [ ! -L "$mount/Applications" ]; then
    echo "::warning::$(basename "$dmg") had no Applications link; adding one (drag-to-install)."
    ln -s /Applications "$mount/Applications"
  fi
  assert_layout "$mount" || die "the rebuilt volume has a broken layout"
  detach "$mount"

  # 3. Compress, verify, and only then replace the original image.
  "$HDIUTIL" convert "$rw" -format UDZO -o "$out" -quiet
  attach "$out" "$WORK/verify" -readonly
  assert_layout "$WORK/verify" || die "the compressed image lost its layout"
  [ "$(apps_in "$WORK/verify")" = "$name" ] || die "the compressed image lost '$name'"
  detach "$WORK/verify"
  mv -f "$out" "$dmg"
  echo "Replaced $name in $(basename "$dmg"); Tauri's layout is kept."
}

case "${1:-}" in
  -h | --help) usage ;;
  check) shift; cmd_check "$@" ;;
  replace-app) shift; cmd_replace_app "$@" ;;
  *) usage >&2; exit 2 ;;
esac
