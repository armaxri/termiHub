#!/bin/sh
# Bring up a headless X server, start x11vnc, then paint the baked test pattern
# onto the root window and keep it painted. The framebuffer is static: once the
# pattern is on the root nothing else touches the display, so every framebuffer
# update a client decodes is the same deterministic four-quadrant pattern.
#
# Ordering matters. feh sets the root background and exits; if feh is the *only*
# X client and exits before anything else connects, the paint does not survive
# on a bare Xvfb (no window manager / compositor to hold it). So x11vnc is
# started FIRST — its live connection keeps the painted root alive — and only
# then is the pattern applied (a couple of times, to defeat any startup race).
set -e

export DISPLAY=:0
# A stale lock from an earlier container start would make Xvfb refuse :0.
rm -f /tmp/.X0-lock

Xvfb :0 -screen 0 1024x768x24 -nolisten tcp &

# Wait for the X server to accept connections before serving / painting.
for _ in $(seq 1 50); do
    if xdpyinfo -display :0 >/dev/null 2>&1; then
        break
    fi
    sleep 0.2
done

# Serve forever, allowing shared connections, using VncAuth from the stored
# password file. -noxdamage keeps x11vnc polling-based, which is the reliable
# path against Xvfb (no XDAMAGE extension). Backgrounded so we can paint after
# it has connected, then `wait` on it to keep the container alive.
x11vnc \
    -display :0 \
    -rfbauth /root/.vnc/passwd \
    -rfbport 5900 \
    -forever \
    -shared \
    -noxdamage \
    -quiet &
x11vnc_pid=$!

# Give x11vnc a moment to attach to the display, then paint the static pattern
# onto the root window (no window manager needed — feh writes the root pixmap
# directly). Repeat a few times to be robust against startup timing; with
# x11vnc already connected the paint persists.
sleep 1
for _ in 1 2 3; do
    feh --no-fehbg --bg-fill /root/pattern.png || true
    sleep 0.5
done

wait "$x11vnc_pid"
