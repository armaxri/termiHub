#!/bin/sh
# Bring up a headless X server, paint the baked test pattern onto the root
# window, then serve it over RFB with VncAuth. The framebuffer is static: feh
# sets the root pixmap once and nothing else touches the display, so every
# framebuffer update the client decodes is the same deterministic pattern.
set -e

export DISPLAY=:0
# A stale lock from an earlier container start would make Xvfb refuse :0.
rm -f /tmp/.X0-lock

Xvfb :0 -screen 0 1024x768x24 -nolisten tcp &

# Wait for the X server to accept connections before painting.
for _ in $(seq 1 50); do
    if xdpyinfo -display :0 >/dev/null 2>&1; then
        break
    fi
    sleep 0.2
done

# Paint the static test pattern (no window manager needed — feh writes the
# root pixmap directly). --no-fehbg keeps it from writing a ~/.fehbg helper.
feh --no-fehbg --bg-fill /root/pattern.png

# Serve forever, allowing shared connections, using VncAuth from the stored
# password file. -noxdamage keeps x11vnc polling-based, which is the reliable
# path against Xvfb (no XDAMAGE extension).
exec x11vnc \
    -display :0 \
    -rfbauth /root/.vnc/passwd \
    -rfbport 5900 \
    -forever \
    -shared \
    -noxdamage \
    -quiet
