# VeNCrypt X509 VNC (RFB) server for the TLS graphical-backend path.
#
# The plain `vnc-server` fixture serves classic RFB VncAuth over x11vnc, so it
# cannot exercise VeNCrypt (RFB security type 19) at all. #1714 added VeNCrypt
# X509 support to the `vnc` backend (vendored `vnc-rs` fork), but that live
# TLS/X509 negotiate -> authenticate -> decode path only exists against a real
# VeNCrypt server, and per-PR CI runs `-m "not integration"`. This fixture is
# that missing coverage: TigerVNC's Xvnc, whose built-in RFB server speaks
# VeNCrypt natively, serving the same deterministic four-quadrant pattern over
# TLS so the integration test can assert an exact decode end to end.
#
# Server:   TigerVNC `Xvnc` (a headless X server with a built-in VNC server).
# Auth:     VeNCrypt, X509Vnc sub-type (260-262 family) — a rustls TLS handshake
#           against the fixture's self-signed leaf, then the classic VNC-password
#           DES challenge. Password `testpass` (VNC caps passwords at 8 chars;
#           `testpass` is exactly 8), matching the plain fixture.
# TLS:      server.crt / server.key from ./certs (leaf for IP 127.0.0.1, signed
#           by ca.crt). The `insecure` test accepts any cert; the `ca` test
#           trusts ca.crt. See ./certs/gen-certs.sh to regenerate.
# Pattern:  four solid-colour quadrants baked at build time and painted onto the
#           root window with feh — TL RED, TR GREEN, BL BLUE, BR WHITE. Solid
#           regions decode to exact RGBA under every encoding, so the test can
#           assert the decoded framebuffer without tolerance games.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tigervnc-standalone-server \
    x11vnc \
    feh \
    imagemagick \
    x11-utils \
    && rm -rf /var/lib/apt/lists/*

# Bake the deterministic test pattern (four primary-colour quadrants of a
# 1024x768 framebuffer). `lime` is ImageMagick's pure (0,255,0) green.
RUN convert -size 1024x768 xc:black \
    -fill red   -draw "rectangle 0,0 511,383" \
    -fill lime  -draw "rectangle 512,0 1023,383" \
    -fill blue  -draw "rectangle 0,384 511,767" \
    -fill white -draw "rectangle 512,384 1023,767" \
    /root/pattern.png

# Store the RFB password (standard DES-obfuscated VNC format) for Xvnc's
# -rfbauth. TigerVNC on Debian ships no `vncpasswd`, so use x11vnc's
# `-storepasswd` — it writes the same format Xvnc's -rfbauth reads.
RUN mkdir -p /root/.vnc \
    && x11vnc -storepasswd testpass /root/.vnc/passwd \
    && chmod 600 /root/.vnc/passwd

# The committed test TLS material (leaf + key the server presents).
COPY certs/server.crt /root/.vnc/server.crt
COPY certs/server.key /root/.vnc/server.key
RUN chmod 600 /root/.vnc/server.key

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 5900
CMD ["/usr/local/bin/entrypoint.sh"]
