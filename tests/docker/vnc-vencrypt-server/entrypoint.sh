#!/bin/sh
# Bring up TigerVNC's Xvnc (a headless X server with a built-in VNC server that
# speaks VeNCrypt natively), then paint the baked four-quadrant test pattern onto
# the root window. Unlike x11vnc-on-Xvfb, Xvnc owns its own framebuffer and keeps
# it alive with no client attached, so once feh sets the root pixmap the pattern
# persists for every client that connects — the framebuffer is static and every
# decoded update is the same deterministic pattern.
set -e

export DISPLAY=:0
# A stale lock from an earlier container start would make Xvnc refuse :0.
rm -f /tmp/.X0-lock /tmp/.X11-unix/X0

# Serve VeNCrypt with the X509Vnc sub-type: a TLS handshake against the fixture's
# leaf certificate, then the classic VNC-password (DES) second stage. Xvnc listens
# on 5900 (mapped to the host by compose). -localhost no so the mapped port is
# reachable from outside the container.
Xvnc :0 \
    -rfbport 5900 \
    -geometry 1024x768 \
    -depth 24 \
    -SecurityTypes VeNCrypt,X509Vnc \
    -X509Cert /root/.vnc/server.crt \
    -X509Key /root/.vnc/server.key \
    -rfbauth /root/.vnc/passwd \
    -localhost no \
    -desktop termihub-vencrypt &
xvnc_pid=$!

# Wait for the X server to accept connections before painting.
for _ in $(seq 1 50); do
    if xdpyinfo -display :0 >/dev/null 2>&1; then
        break
    fi
    sleep 0.2
done

# Paint the static pattern onto the root window (no window manager needed — feh
# writes the root pixmap directly). Repeat a few times to defeat any startup
# race; Xvnc holds the framebuffer, so the paint persists.
for _ in 1 2 3; do
    feh --no-fehbg --bg-fill /root/pattern.png || true
    sleep 0.5
done

# Keep the container alive on the X server.
wait "$xvnc_pid"
