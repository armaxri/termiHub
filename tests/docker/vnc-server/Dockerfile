# VNC (RFB) server for graphical-backend integration testing.
#
# Serves a *static* 1024x768 test pattern over classic RFB VncAuth so the
# `vnc` backend's live negotiate -> authenticate -> decode path (#1681/#1715)
# has real end-to-end coverage. That path is only exercisable against a real
# VNC server, and per-PR CI runs `-m "not integration"`, so without this
# fixture it has no automated coverage at all.
#
# Server:   x11vnc attached to a headless Xvfb :0.
# Auth:     classic RFB VncAuth, password `testpass` (VNC caps passwords at 8
#           chars; `testpass` is exactly 8).
# Pattern:  four solid-colour quadrants baked at build time and painted onto the
#           root window with feh — top-left RED, top-right GREEN, bottom-left
#           BLUE, bottom-right WHITE. Solid regions decode to exact RGBA under
#           every encoding, so the integration test can assert the decoded
#           framebuffer pixel-for-pixel without tolerance games.
# Clipboard: the entrypoint owns a known X selection (via xclip) so x11vnc
#           forwards it to the client as an RFB ServerCutText — the server->client
#           clipboard path (#1737) that the integration test asserts end to end.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    feh \
    imagemagick \
    x11-utils \
    xclip \
    && rm -rf /var/lib/apt/lists/*

# Bake the deterministic test pattern (four primary-colour quadrants of a
# 1024x768 framebuffer). `lime` is ImageMagick's pure (0,255,0) green.
RUN convert -size 1024x768 xc:black \
    -fill red   -draw "rectangle 0,0 511,383" \
    -fill lime  -draw "rectangle 512,0 1023,383" \
    -fill blue  -draw "rectangle 0,384 511,767" \
    -fill white -draw "rectangle 512,384 1023,767" \
    /root/pattern.png

# Store the RFB password (VncAuth format) for x11vnc's -rfbauth.
RUN mkdir -p /root/.vnc && x11vnc -storepasswd testpass /root/.vnc/passwd

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 5900
CMD ["/usr/local/bin/entrypoint.sh"]
