#!/bin/sh
# Bring up TigerVNC's Xvnc with classic VncAuth, paint the gradient pattern
# onto the root window, then run the CopyRect loop (see Dockerfile).
set -e

export DISPLAY=:0
# A stale lock from an earlier container start would make Xvnc refuse :0.
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0

# -localhost no: the compose-mapped port must be reachable from outside.
Xvnc :0 \
    -rfbport 5900 \
    -geometry 1024x768 \
    -depth 24 \
    -SecurityTypes VncAuth \
    -rfbauth /root/.vnc/passwd \
    -localhost no \
    -desktop termihub-jpeg &
xvnc_pid=$!

# Wait for the X server to accept connections before painting.
for _ in $(seq 1 50); do
    if xdpyinfo -display :0 >/dev/null 2>&1; then
        break
    fi
    sleep 0.2
done

# Xvnc holds its own framebuffer, so the root pixmap persists once set; repeat
# a few times to defeat any startup race.
for _ in 1 2 3; do
    feh --no-fehbg --bg-fill /root/pattern.ppm || true
    sleep 0.5
done

# The CopyRect loop; restarted if it ever exits.
while true; do
    python3 /usr/local/bin/copy_loop.py || true
    sleep 1
done &

wait "$xvnc_pid"
