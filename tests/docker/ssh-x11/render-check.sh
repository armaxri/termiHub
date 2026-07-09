#!/bin/bash
# Self-contained headless X11 render check for the ssh-x11 fixture.
#
# Brings up an in-container Xvfb X server, launches a real GUI client (xeyes)
# against it, and asserts the client actually mapped a window. This proves the
# "a GUI app renders to an X server" pipeline end to end WITHOUT needing a host
# X server, so it is automatable anywhere Docker runs — unlike a forward into
# the operator's real display, which the system-test harness cannot fake.
#
# Usage (from the repo root, container up):
#   docker compose -f tests/docker/docker-compose.yml exec ssh-x11 render-check.sh
#
# Exit 0 and prints RENDER_CHECK_OK on success; non-zero + RENDER_CHECK_FAILED
# otherwise. Deterministic: no timing-sensitive pixel diffing, only window map.
set -euo pipefail

DISPLAY_NUM="${1:-99}"
DISPLAY_ID=":${DISPLAY_NUM}"
XVFB_PID=""
APP_PID=""

cleanup() {
  [ -n "${APP_PID}" ] && kill "${APP_PID}" 2>/dev/null || true
  [ -n "${XVFB_PID}" ] && kill "${XVFB_PID}" 2>/dev/null || true
}
trap cleanup EXIT

# Start a virtual framebuffer X server.
Xvfb "${DISPLAY_ID}" -screen 0 1024x768x24 >/tmp/xvfb.log 2>&1 &
XVFB_PID=$!
export DISPLAY="${DISPLAY_ID}"

# Wait for the server to accept connections.
ready=0
for _ in $(seq 1 50); do
  if xdpyinfo >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.2
done
if [ "${ready}" -ne 1 ]; then
  echo "RENDER_CHECK_FAILED: Xvfb did not become ready on ${DISPLAY_ID}"
  cat /tmp/xvfb.log || true
  exit 1
fi

# Launch a real GUI client and wait for it to map a window.
xeyes >/tmp/xeyes.log 2>&1 &
APP_PID=$!

mapped=0
for _ in $(seq 1 50); do
  if xwininfo -root -children 2>/dev/null | grep -qi 'xeyes'; then
    mapped=1
    break
  fi
  # Bail early if the client died.
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

if [ "${mapped}" -eq 1 ]; then
  echo "RENDER_CHECK_OK: xeyes mapped a window on ${DISPLAY_ID}"
  exit 0
fi

echo "RENDER_CHECK_FAILED: xeyes never mapped a window on ${DISPLAY_ID}"
cat /tmp/xeyes.log || true
exit 1
