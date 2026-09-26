#!/bin/sh
# The RDP session the fixture user logs into (run by xrdp-sesman on the
# session's Xorg display).
#
# 1. Paint the root window solid pure red. There is no window manager, so the
#    whole desktop — at any size a resize negotiates — is one known colour that
#    rdp.rs asserts on (and that xrdp's grey login screen never shows).
# 2. Clipboard echo loop: whenever the CLIPBOARD selection (which xrdp-chansrv
#    bridges to the client over CLIPRDR) holds `ping:<x>`, replace it with
#    `pong:<x>`. A client that copies `ping:<x>` therefore receives `pong:<x>`
#    back — a text round trip through the real server in both directions.
xsetroot -solid '#ff0000'

last=""
while true; do
    current="$(xclip -o -selection clipboard 2>/dev/null || true)"
    if [ "$current" != "$last" ]; then
        last="$current"
        case "$current" in
        ping:*)
            reply="pong:${current#ping:}"
            printf '%s' "$reply" | xclip -i -selection clipboard -loops 0 >/dev/null 2>&1 &
            last="$reply"
            ;;
        esac
    fi
    # Keep the root painted after a resize (a new root size re-exposes it).
    xsetroot -solid '#ff0000' 2>/dev/null || true
    sleep 0.3
done
