#!/usr/bin/env bash
#
# Release install-smoke: application log + single-instance lifecycle (#1570,
# PER-005, SM-025, #4011).
#
# Drives an INSTALLED release build through two runs and checks what its durable
# log (src-tauri/src/utils/file_log.rs) and the single-instance plugin
# (src-tauri/src/utils/single_instance.rs) promise:
#
#   run 1  launch; the frontend reaches the backend (IPC marker in the log);
#          the startup banner carries this release's version and the pid of the
#          launched process; the log holds no ANSI escape; a real close (window
#          close / Quit AppleEvent) ends with "termiHub exited cleanly".
#   run 2  relaunch; the log was APPENDED (run 1's bytes are untouched, a second
#          banner follows); a second launch with `--workspace <name>` and one
#          with `--workspace-file <file>` each exit while the first instance
#          keeps running, and the first instance logs that it opened the
#          forwarded workspace; `kill -9` leaves NO "exited cleanly" line.
#
# Used by the release install-smoke workflows (Linux AppImage + .deb under
# xvfb + dbus-run-session, macOS .app). The Windows smoke runs the PowerShell
# twin, release-smoke-app-lifecycle.ps1. Single-instance enforcement is
# release + installed only (never debug, never portable), so a dev build cannot
# pass the run-2 checks — this targets the shipped binary.
#
# The script DELETES the log file it is given before run 1 (a fresh log is the
# only way to read run 1's banner unambiguously); it refuses to do that to a
# non-empty log unless --clear-log is passed. CI only: do not point it at the
# log of an app you are using.
#
# Usage:
#   release-smoke-app-lifecycle.sh --exe <path> --log <path> --version <x.y.z> \
#       --close x11|applevent|sigterm [--bundle-id <id>] [--out <dir>] [--clear-log]
#
#   --exe        the installed app executable (AppRun, /usr/bin/termihub,
#                termiHub.app/Contents/MacOS/termihub)
#   --log        the app's durable log file for this platform
#   --version    the release version the banner must carry (no leading v)
#   --close      how run 1 is closed for real:
#                  x11        WM_DELETE_WINDOW to the app's X11 windows (Linux;
#                             needs python3 + python3-xlib); the frontend then
#                             closes the empty window and the app quits
#                  applevent  a Quit AppleEvent via osascript (macOS; needs
#                             --bundle-id). If the runner refuses to send it, the
#                             app is stopped with SIGTERM and the clean-exit check
#                             is reported as skipped, not passed
#                  sigterm    SIGTERM (only meaningful for an app that handles it,
#                             e.g. the stub app check-script-headless.sh drives)
#   --bundle-id  the macOS bundle identifier (applevent only)
#   --out        directory for the launch logs and a copy of the app log
#   --clear-log  allow deleting an existing non-empty log
#
# Exit status: 0 when every check passed (or was explicitly skipped), 1 otherwise.

set -euo pipefail

usage() {
  sed -n '2,/^# Exit status/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

EXE=""
LOG=""
VERSION=""
CLOSE=""
BUNDLE_ID=""
OUT=""
CLEAR_LOG=false
while [ $# -gt 0 ]; do
  case "$1" in
    --help | -h)
      usage
      exit 0
      ;;
    --exe) EXE="${2:-}"; shift 2 ;;
    --log) LOG="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --close) CLOSE="${2:-}"; shift 2 ;;
    --bundle-id) BUNDLE_ID="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
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
[ -n "$EXE" ] || die "--exe is required"
[ -x "$EXE" ] || die "--exe '$EXE' is not an executable file"
[ -n "$LOG" ] || die "--log is required"
[ -n "$VERSION" ] || die "--version is required"
case "$CLOSE" in
  x11 | sigterm) ;;
  applevent) [ -n "$BUNDLE_ID" ] || die "--close applevent needs --bundle-id" ;;
  *) die "--close must be x11, applevent or sigterm" ;;
esac
if [ -s "$LOG" ] && [ "$CLEAR_LOG" != true ]; then
  die "'$LOG' exists and is not empty; pass --clear-log to let this smoke delete it"
fi

WORK="$(mktemp -d)"
OUT="${OUT:-$WORK/out}"
mkdir -p "$OUT"

# Timeouts (seconds). Generous: hosted runners are slow to start a webview.
IPC_TIMEOUT="${SMOKE_IPC_TIMEOUT:-90}"
EXIT_TIMEOUT="${SMOKE_EXIT_TIMEOUT:-30}"
LOG_TIMEOUT="${SMOKE_LOG_TIMEOUT:-30}"

# Log lines this smoke keys on, each emitted by the app (see the file headers
# that name them): the frontend's first IPC call (commands/connection.rs), the
# run banner and clean-exit breadcrumb (lib.rs), and the forwarded-workspace
# receiver (utils/single_instance.rs).
IPC_MARKER="Loading connections and folders"
BANNER="termiHub starting"
CLEAN_EXIT="termiHub exited cleanly"
FORWARDED="single-instance: opening forwarded workspace"

FORWARD_NAME="SmokeDemo"
FORWARD_FILE_NAME="SmokeForwardedFile"

PASSED=0
FAILED=0
SKIPPED=0
pass() { echo "  PASS: $1"; PASSED=$((PASSED + 1)); }
fail() { echo "::error::app lifecycle smoke: $1"; FAILED=$((FAILED + 1)); }
skip() { echo "::warning::app lifecycle smoke skipped a check: $1"; SKIPPED=$((SKIPPED + 1)); }
section() { printf '\n--- %s ---\n' "$1"; }

LAUNCHED=()
cleanup() {
  local pid
  for pid in "${LAUNCHED[@]+"${LAUNCHED[@]}"}"; do
    kill -KILL "$pid" 2>/dev/null || true
  done
  if [ -f "$LOG" ]; then cp "$LOG" "$OUT/app.log" 2>/dev/null || true; fi
  rm -rf "$WORK/ws"
}
trap cleanup EXIT

alive() { kill -0 "$1" 2>/dev/null; }

file_size() {
  if [ -f "$LOG" ]; then wc -c <"$LOG" | tr -d ' '; else echo 0; fi
}

# The log from byte offset $1 (0-based) on.
log_since() {
  if [ -f "$LOG" ]; then tail -c "+$(($1 + 1))" "$LOG"; fi
}

# launch <tag> [args...]: start the app in the background and set LAUNCHED_PID.
# Not called in a $(...) subshell, so the process stays this shell's child.
LAUNCHED_PID=""
launch() {
  local tag="$1"
  shift
  "$EXE" "$@" >"$OUT/launch-$tag.log" 2>&1 &
  LAUNCHED_PID=$!
  LAUNCHED+=("$LAUNCHED_PID")
}

# wait_log <offset> <text> <timeout> [pid]: wait for <text> in the log after
# <offset>; gives up early if <pid> dies.
wait_log() {
  local offset="$1" text="$2" timeout="$3" pid="${4:-}" i
  for ((i = 0; i < timeout; i++)); do
    if log_since "$offset" | grep -qF -- "$text"; then return 0; fi
    if [ -n "$pid" ] && ! alive "$pid"; then
      log_since "$offset" | grep -qF -- "$text" && return 0
      return 1
    fi
    sleep 1
  done
  return 1
}

# wait_exit <pid> <timeout>: wait for a process to go away.
wait_exit() {
  local pid="$1" timeout="$2" i
  for ((i = 0; i < timeout; i++)); do
    alive "$pid" || return 0
    sleep 1
  done
  ! alive "$pid"
}

# is_same_or_descendant <pid> <ancestor>: true if <pid> is <ancestor> or runs
# under it (an AppImage's AppRun may start the real binary as a child).
is_same_or_descendant() {
  local pid="$1" ancestor="$2" hops
  for ((hops = 0; hops < 8; hops++)); do
    [ "$pid" = "$ancestor" ] && return 0
    pid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    case "$pid" in '' | 0 | 1) return 1 ;; esac
  done
  return 1
}

# The first banner line after <offset>.
banner_after() {
  log_since "$1" | grep -F -- "$BANNER" | head -n1 || true
}
banner_pid() { sed -n 's/.* pid=\([0-9][0-9]*\).*/\1/p' <<<"$1"; }
banner_version() { sed -n 's/.* version="\([^"]*\)".*/\1/p' <<<"$1"; }

# check_banner <offset> <launched pid> <label>: the run's banner names this
# release's version and the launched process. Sets APP_PID to the pid the banner
# names when it belongs to the launched process, else to the launched pid.
APP_PID=""
check_banner() {
  local offset="$1" launched="$2" label="$3" line pid version
  APP_PID="$launched"
  line="$(banner_after "$offset")"
  if [ -z "$line" ]; then
    fail "$label: no '$BANNER' banner in the log"
    return 0
  fi
  pid="$(banner_pid "$line")"
  version="$(banner_version "$line")"
  if [ "$version" = "$VERSION" ]; then
    pass "$label: banner carries version $VERSION"
  else
    fail "$label: banner version '$version', expected '$VERSION' ($line)"
  fi
  if [ -n "$pid" ] && is_same_or_descendant "$pid" "$launched"; then
    pass "$label: banner pid $pid is the launched process ($launched)"
    APP_PID="$pid"
  else
    fail "$label: banner pid '$pid' is not the launched process $launched ($line)"
  fi
}

# close_for_real <app pid>: ask the app to quit the way a user does. Returns 0
# when the request was delivered, 2 when the platform refused to deliver it.
close_for_real() {
  local pid="$1"
  case "$CLOSE" in
    sigterm)
      kill -TERM "$pid"
      ;;
    applevent)
      # perl's alarm is the portable timeout on macOS (no coreutils `timeout`).
      if ! perl -e 'alarm shift; exec @ARGV' 30 \
        osascript -e "tell application id \"$BUNDLE_ID\" to quit" >"$OUT/osascript.log" 2>&1; then
        cat "$OUT/osascript.log"
        return 2
      fi
      ;;
    x11)
      # Send WM_DELETE_WINDOW to every top-level window of the process — what a
      # window manager does when the user clicks the close button. No WM runs
      # under xvfb, so talk to the X server directly.
      python3 - "$pid" <<'PY'
import sys

from Xlib import X, display, protocol

pid = int(sys.argv[1])
d = display.Display()
root = d.screen().root
NET_WM_PID = d.intern_atom("_NET_WM_PID")
WM_PROTOCOLS = d.intern_atom("WM_PROTOCOLS")
WM_DELETE_WINDOW = d.intern_atom("WM_DELETE_WINDOW")
sent = 0
for win in root.query_tree().children:
    prop = win.get_full_property(NET_WM_PID, X.AnyPropertyType)
    if not prop or int(prop.value[0]) != pid:
        continue
    if WM_DELETE_WINDOW not in (win.get_wm_protocols() or []):
        continue
    ev = protocol.event.ClientMessage(
        window=win, client_type=WM_PROTOCOLS, data=(32, [WM_DELETE_WINDOW, X.CurrentTime, 0, 0, 0])
    )
    win.send_event(ev, event_mask=X.NoEventMask)
    sent += 1
d.flush()
d.close()
print(f"sent WM_DELETE_WINDOW to {sent} window(s) of pid {pid}")
sys.exit(0 if sent else 1)
PY
      ;;
  esac
}

echo "=== termiHub release smoke: app log + single instance ==="
echo "  exe:     $EXE"
echo "  log:     $LOG"
echo "  version: $VERSION"
echo "  close:   $CLOSE"

rm -f "$LOG"

# The forwarded workspace definition (WorkspaceDefinition, workspace/config.rs).
mkdir -p "$WORK/ws"
WS_FILE="$WORK/ws/forwarded.json"
cat >"$WS_FILE" <<EOF
{"id":"smoke-forwarded-file","name":"$FORWARD_FILE_NAME","tabGroups":[{"name":"Main","layout":{"type":"leaf","tabs":[]}}]}
EOF

# ---------------------------------------------------------------------------
section "Run 1: launch"
launch run1
RUN1="$LAUNCHED_PID"
if wait_log 0 "$IPC_MARKER" "$IPC_TIMEOUT" "$RUN1"; then
  pass "run 1: the frontend reached the backend"
else
  fail "run 1: no '$IPC_MARKER' in the log within ${IPC_TIMEOUT}s"
  cat "$OUT/launch-run1.log"
  exit 1
fi
check_banner 0 "$RUN1" "run 1"
APP1="$APP_PID"

section "Run 1: no ANSI escapes in the log"
if LC_ALL=C grep -q $'\033' "$LOG"; then
  fail "the log contains ANSI escape sequences:"
  LC_ALL=C grep -n $'\033' "$LOG" | head -n5 | cat -v
else
  pass "the log has no ANSI escape sequences"
fi

section "Run 1: close for real ($CLOSE)"
rc=0
close_for_real "$APP1" || rc=$?
if [ "$rc" -eq 2 ]; then
  skip "the runner could not deliver a Quit AppleEvent; stopping with SIGTERM instead"
  kill -TERM "$APP1" 2>/dev/null || true
  wait_exit "$APP1" "$EXIT_TIMEOUT" || kill -KILL "$APP1" 2>/dev/null || true
  skip "'$CLEAN_EXIT' after a real quit (no quit could be delivered)"
elif [ "$rc" -ne 0 ]; then
  fail "could not ask the app to close (exit $rc)"
  kill -KILL "$APP1" 2>/dev/null || true
else
  if wait_exit "$APP1" "$EXIT_TIMEOUT"; then
    pass "run 1: the app exited after the close request"
  else
    fail "run 1: the app was still running ${EXIT_TIMEOUT}s after the close request"
    kill -KILL "$APP1" 2>/dev/null || true
  fi
  if log_since 0 | grep -qF -- "$CLEAN_EXIT"; then
    pass "run 1: '$CLEAN_EXIT' logged on the way out"
  else
    fail "run 1: no '$CLEAN_EXIT' line after a real close"
  fi
fi
wait_exit "$RUN1" "$EXIT_TIMEOUT" || kill -KILL "$RUN1" 2>/dev/null || true

# ---------------------------------------------------------------------------
section "Run 2: relaunch appends to the log"
RUN1_BYTES="$(file_size)"
cp "$LOG" "$WORK/run1.log"
launch run2
RUN2="$LAUNCHED_PID"
if wait_log "$RUN1_BYTES" "$IPC_MARKER" "$IPC_TIMEOUT" "$RUN2"; then
  pass "run 2: the frontend reached the backend"
else
  fail "run 2: no '$IPC_MARKER' in the log within ${IPC_TIMEOUT}s"
  cat "$OUT/launch-run2.log"
  exit 1
fi
if head -c "$RUN1_BYTES" "$LOG" | cmp -s - "$WORK/run1.log"; then
  pass "run 2 appended: run 1's $RUN1_BYTES bytes are intact"
else
  fail "run 2 did not append: run 1's log content changed (truncated or rotated)"
fi
check_banner "$RUN1_BYTES" "$RUN2" "run 2"
APP2="$APP_PID"
banners="$(grep -cF -- "$BANNER" "$LOG" || true)"
if [ "$banners" -ge 2 ]; then
  pass "the log holds both runs' banners ($banners)"
else
  fail "expected 2 banners after a relaunch, found $banners"
fi

# second_launch <tag> <expected workspace> <args...>: a second instance must
# hand its arguments to the running one and exit; the running one stays up.
second_launch() {
  local tag="$1" want="$2" offset pid code=0
  shift 2
  offset="$(file_size)"
  launch "$tag" "$@"
  pid="$LAUNCHED_PID"
  if wait_exit "$pid" "$EXIT_TIMEOUT"; then
    wait "$pid" 2>/dev/null || code=$?
    pass "$tag: the second instance exited (code $code)"
  else
    fail "$tag: the second instance was still running after ${EXIT_TIMEOUT}s"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  if alive "$APP2"; then
    pass "$tag: the first instance is still the one running"
  else
    fail "$tag: the first instance (pid $APP2) is gone"
  fi
  if wait_log "$offset" "$FORWARDED" "$LOG_TIMEOUT" &&
    log_since "$offset" | grep -F -- "$FORWARDED" | grep -qF -- "workspace=$want"; then
    pass "$tag: the running instance opened the forwarded workspace '$want'"
  else
    fail "$tag: the running instance did not log '$FORWARDED' for '$want'"
    log_since "$offset" | grep -F 'single-instance' || true
  fi
}

section "Single instance: --workspace is forwarded"
second_launch forward-name "$FORWARD_NAME" --workspace "$FORWARD_NAME"
section "Single instance: --workspace-file is forwarded"
second_launch forward-file "$FORWARD_FILE_NAME" --workspace-file "$WS_FILE"

section "Run 2: kill -9 leaves no clean-exit line"
kill -KILL "$APP2" 2>/dev/null || true
[ "$APP2" = "$RUN2" ] || kill -KILL "$RUN2" 2>/dev/null || true
wait_exit "$APP2" "$EXIT_TIMEOUT" || true
sleep 1
if log_since "$RUN1_BYTES" | grep -qF -- "$CLEAN_EXIT"; then
  fail "run 2 logged '$CLEAN_EXIT' although it was killed with SIGKILL"
else
  pass "run 2 (SIGKILL) left no '$CLEAN_EXIT' line"
fi

echo ""
echo "==========================================="
echo "  App lifecycle smoke: $PASSED passed, $FAILED failed, $SKIPPED skipped"
echo "==========================================="
[ "$FAILED" -eq 0 ]
