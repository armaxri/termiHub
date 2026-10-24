#!/usr/bin/env bash
#
# Release install-smoke: Gatekeeper / quarantine behaviour of the unsigned macOS
# beta (#4933, MT-APP-04 family; README "Install" section).
#
# The beta's DMG is ad-hoc signed, not Developer ID signed or notarized. What a
# user meets after downloading it is pinned here, on the shipped DMG:
#
#   1. the DMG is marked quarantined, the way a browser download is;
#   2. the app is copied out of the mounted image (like a drag-install) and
#      carries the quarantine flag (propagated from the image, or set the way
#      Finder sets it when it does not propagate);
#   3. the bundle's signature is still consistent (`codesign --verify --deep
#      --strict`), so macOS reports it as unverified, never as "damaged";
#   4. Gatekeeper rejects it (`spctl --assess --type exec`), the documented
#      unsigned-beta behaviour;
#   5. the README's one-liner, `xattr -dr com.apple.quarantine <app>`, removes
#      the flag from every file in the bundle;
#   6. with --launch: the app then starts through LaunchServices (`open -n`,
#      the Finder / Dock path). Its startup banner in the durable log names a
#      pid whose executable lies inside this copy; that pid, and only that pid,
#      is then stopped.
#
# If Gatekeeper ever ACCEPTS the bundle (a Developer ID signed and notarized
# build), step 4 fails on purpose: update this smoke and the README together.
#
# Usage:
#   release-smoke-gatekeeper.sh --dmg <path> [--out <dir>] \
#       [--launch --log <path> [--clear-log]]
#
#   --dmg        the release DMG (it is copied; the original is not modified)
#   --out        directory for the copied app and the launch logs
#   --launch     also launch the de-quarantined app through LaunchServices. CI
#                only: on a machine with termiHub installed and running, the
#                single-instance lock would hand the launch to that app
#   --log        the app's durable log (needed with --launch); it is deleted
#                first, which is refused for a non-empty log without --clear-log
#   --clear-log  allow deleting an existing non-empty log
#
# Exit status: 0 when every check passed, 1 otherwise, 2 on a usage error.

set -euo pipefail

usage() {
  sed -n '2,/^# Exit status/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

DMG=""
OUT=""
LAUNCH=false
LOG=""
CLEAR_LOG=false
while [ $# -gt 0 ]; do
  case "$1" in
    --help | -h)
      usage
      exit 0
      ;;
    --dmg) DMG="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --launch) LAUNCH=true; shift ;;
    --log) LOG="${2:-}"; shift 2 ;;
    --clear-log) CLEAR_LOG=true; shift ;;
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
[ "$(uname -s)" = Darwin ] || die "this smoke needs macOS (hdiutil, spctl, xattr)"
[ -n "$DMG" ] || die "--dmg is required"
[ -f "$DMG" ] || die "--dmg '$DMG' is not a file"
if [ "$LAUNCH" = true ]; then
  [ -n "$LOG" ] || die "--launch needs --log"
  if [ -s "$LOG" ] && [ "$CLEAR_LOG" != true ]; then
    die "'$LOG' exists and is not empty; pass --clear-log to let this smoke delete it"
  fi
fi

WORK="$(mktemp -d)"
OUT="${OUT:-$WORK/out}"
mkdir -p "$OUT"
# Canonical (/private/var, not /var), to compare with the launched pid's path.
OUT="$(cd "$OUT" && pwd -P)"
LAUNCH_TIMEOUT="${SMOKE_IPC_TIMEOUT:-90}"
EXIT_TIMEOUT="${SMOKE_EXIT_TIMEOUT:-30}"
QUARANTINE=com.apple.quarantine
BANNER="termiHub starting"

PASSED=0
FAILED=0
pass() { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "::error::gatekeeper smoke: $1"; FAILED=$((FAILED + 1)); }
section() { printf '\n--- %s ---\n' "$1"; }

MOUNT="$WORK/mount"
APP_PID=""
cleanup() {
  if [ -n "$APP_PID" ]; then kill -KILL "$APP_PID" 2>/dev/null || true; fi
  if [ -d "$MOUNT" ]; then hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; fi
  rm -rf "$WORK/dmg"
}
trap cleanup EXIT

# has_quarantine <path>: the path itself carries the quarantine attribute.
has_quarantine() { xattr -p "$QUARANTINE" "$1" >/dev/null 2>&1; }

# quarantined_files <bundle>: how many files in the bundle carry the attribute.
quarantined_files() {
  local n=0 f
  while IFS= read -r -d '' f; do
    if has_quarantine "$f"; then n=$((n + 1)); fi
  done < <(find "$1" -print0)
  echo "$n"
}

echo "=== termiHub release smoke: Gatekeeper / quarantine (unsigned beta) ==="
echo "  dmg: $DMG"

# ---------------------------------------------------------------------------
section "1. The downloaded DMG is quarantined"
mkdir -p "$WORK/dmg"
QDMG="$WORK/dmg/$(basename "$DMG")"
cp "$DMG" "$QDMG"
# flags;hex time;agent;event id: the record a browser download writes.
xattr -w "$QUARANTINE" "0083;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$QDMG"
if has_quarantine "$QDMG"; then
  pass "the DMG copy carries $QUARANTINE ($(xattr -p "$QUARANTINE" "$QDMG"))"
else
  fail "could not mark the DMG copy as quarantined"
fi

# ---------------------------------------------------------------------------
section "2. Drag-install: the app copied out of the image is quarantined"
mkdir -p "$MOUNT" "$OUT/Applications"
hdiutil attach "$QDMG" -mountpoint "$MOUNT" -nobrowse -readonly -quiet
APP_NAME="$(find "$MOUNT" -maxdepth 1 -name '*.app' -exec basename {} \; | head -n1)"
[ -n "$APP_NAME" ] || { fail "no .app bundle in the DMG"; exit 1; }
APP="$OUT/Applications/$APP_NAME"
rm -rf "$APP"
ditto "$MOUNT/$APP_NAME" "$APP"
hdiutil detach "$MOUNT" -quiet
rmdir "$MOUNT" 2>/dev/null || true
if has_quarantine "$APP"; then
  pass "the quarantine flag propagated from the image to the copied app"
else
  # Finder sets it on a drag out of a quarantined image; ditto may not.
  echo "  (ditto did not propagate the flag; setting it as Finder does)"
  xattr -r -w "$QUARANTINE" "$(xattr -p "$QUARANTINE" "$QDMG")" "$APP"
fi
n="$(quarantined_files "$APP")"
if [ "$n" -gt 0 ] && has_quarantine "$APP"; then
  pass "the copied app is quarantined ($n file(s) carry the flag)"
else
  fail "the copied app is not quarantined"
fi

# ---------------------------------------------------------------------------
section "3. The quarantined bundle is consistently signed (not \"damaged\")"
if codesign --verify --deep --strict "$APP" >"$OUT/codesign.log" 2>&1; then
  pass "codesign --verify --deep --strict accepts the quarantined bundle"
else
  fail "codesign rejects the quarantined bundle; macOS would call it damaged"
  sed 's/^/    | /' "$OUT/codesign.log"
fi

# ---------------------------------------------------------------------------
section "4. Gatekeeper rejects the unsigned beta"
rc=0
spctl --assess --type exec --verbose=2 "$APP" >"$OUT/spctl.log" 2>&1 || rc=$?
sed 's/^/    | /' "$OUT/spctl.log"
if [ "$rc" -ne 0 ]; then
  pass "spctl rejected the quarantined bundle (exit $rc), as the README describes"
else
  fail "spctl ACCEPTED the bundle: if it is now Developer ID signed and notarized," \
    "update this smoke and the README's install steps"
fi

# ---------------------------------------------------------------------------
section "5. The README one-liner removes the quarantine flag"
xattr -dr "$QUARANTINE" "$APP"
n="$(quarantined_files "$APP")"
if [ "$n" -eq 0 ]; then
  pass "xattr -dr $QUARANTINE left no quarantined file in the bundle"
else
  fail "$n file(s) in the bundle still carry $QUARANTINE after xattr -dr"
fi

if [ "$LAUNCH" = false ]; then
  echo ""
  echo "  (launch not requested; pass --launch on a CI runner to start the app)"
else
  # -------------------------------------------------------------------------
  section "6. The de-quarantined app starts through LaunchServices"
  EXE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
  EXE="$APP/Contents/MacOS/$EXE_NAME"
  rm -f "$LOG"
  # -n: a new instance of this very bundle; -g: do not steal focus.
  open -n -g "$APP" >"$OUT/open.log" 2>&1 || {
    fail "open -n refused to launch the de-quarantined app"
    sed 's/^/    | /' "$OUT/open.log"
  }
  line=""
  for ((i = 0; i < LAUNCH_TIMEOUT; i++)); do
    line="$(grep -F -- "$BANNER" "$LOG" 2>/dev/null | head -n1 || true)"
    [ -n "$line" ] && break
    sleep 1
  done
  pid="$(sed -n 's/.* pid=\([0-9][0-9]*\).*/\1/p' <<<"$line")"
  comm=""
  if [ -n "$pid" ]; then comm="$(ps -o comm= -p "$pid" 2>/dev/null || true)"; fi
  if [ -n "$pid" ] && [ "$comm" = "$EXE" ]; then
    APP_PID="$pid"
    pass "the app started from this copy (pid $pid, $comm)"
    sleep 5
    if kill -0 "$pid" 2>/dev/null; then
      pass "the app is still running 5s after launch"
    else
      fail "the app (pid $pid) exited shortly after launch"
    fi
    kill -TERM "$pid" 2>/dev/null || true
    for ((i = 0; i < EXIT_TIMEOUT; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$pid" 2>/dev/null || true
    APP_PID=""
  elif [ -n "$pid" ]; then
    fail "the banner names pid $pid ('$comm'), which is not this copy's $EXE"
  else
    fail "no '$BANNER' line in $LOG within ${LAUNCH_TIMEOUT}s of open -n"
  fi
  if [ -f "$LOG" ]; then cp "$LOG" "$OUT/app.log"; fi
fi

echo ""
echo "==========================================="
echo "  Gatekeeper smoke: $PASSED passed, $FAILED failed"
echo "==========================================="
[ "$FAILED" -eq 0 ]
