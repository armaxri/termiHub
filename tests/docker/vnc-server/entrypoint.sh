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

# Keep x11vnc's selection machinery warm. A freshly started x11vnc does not
# reliably forward the X selection as a ServerCutText to its *first* connecting
# client — the selection watching only settles a little while after a client has
# been attached. So hold a persistent internal VNC viewer connected: it renders
# to a throwaway headless Xvfb :1 (never the served :0 framebuffer, so the test
# pattern is untouched) and simply keeps a client attached, so the real test
# client always connects to an already-warm server and receives the echo
# promptly. The loop reconnects if the viewer ever drops.
Xvfb :1 -screen 0 320x240x16 -nolisten tcp &
for _ in $(seq 1 50); do
    if xdpyinfo -display :1 >/dev/null 2>&1; then
        break
    fi
    sleep 0.2
done
while true; do
    DISPLAY=:1 xtightvncviewer -passwd /root/.vnc/passwd -viewonly \
        127.0.0.1:5900 >/dev/null 2>&1 || true
    sleep 1
done &

# Own a known X selection so x11vnc forwards it to the client as an RFB
# ServerCutText — the server->client clipboard path asserted by the VNC
# integration test (#1737). This string MUST match VNC_SERVER_CLIPBOARD in
# core/tests/vnc.rs. Kept pure ASCII so it survives the RFB latin-1 cut-text
# encoding unchanged.
CLIPBOARD_TEXT="termiHub vnc server clipboard 4711"
# A distinct priming value the loop alternates with. x11vnc only emits a
# ServerCutText on a *genuine* selection change and de-duplicates identical
# text, and it does not replay its cached selection to a client that connects
# later. Re-asserting the same value would therefore reach only whoever was
# already attached for the very first change. Alternating between two different
# values guarantees a real change every cycle, so a client attaching at any time
# receives CLIPBOARD_TEXT on the next cycle.
PRIMING_TEXT="termiHub vnc priming selection"

# Each `xclip` invocation (no -loops) forks into the background and holds the
# selection until a newer owner replaces it, so re-running it flips the value
# and produces the change x11vnc forwards. Set both PRIMARY and CLIPBOARD every
# phase because x11vnc may forward either.
set_selection() {
    text="$1"
    printf '%s' "$text" | xclip -display :0 -selection primary >/dev/null 2>&1 || true
    printf '%s' "$text" | xclip -display :0 -selection clipboard >/dev/null 2>&1 || true
}
while true; do
    set_selection "$PRIMING_TEXT"
    sleep 2
    set_selection "$CLIPBOARD_TEXT"
    sleep 2
done &

wait "$x11vnc_pid"
