# VNC (RFB) server that sends Tight JPEG rects and CopyRects (#4821).
#
# The other VNC fixtures paint solid-colour quadrants, which every Tight encoder
# sends as fills: they never produce a JPEG rect, so the JPEG pass-through path
# (#4424: compressed JPEG to the webview, decoded with createImageBitmap) had no
# live coverage. This fixture serves a smooth gradient instead.
#
# Server:   TigerVNC `Xvnc`, classic VncAuth, password `testpass`. With a Tight
#           JPEG quality level negotiated, its encoder sends the many-colour
#           gradient as JPEG.
# Pattern:  1024x768, solid grey (64,64,64) with a 512x384 gradient at the top
#           left (`R = x*255//511, G = y*255//383, B = 160`) — see
#           make_pattern.py. Asserted within a JPEG tolerance.
# CopyRect: copy_loop.py alternately fills the bottom-right 512x384 grey and
#           X-CopyAreas the gradient onto it; Xvnc sends that copy as an RFB
#           CopyRect, whose source is the area the client received as JPEG.
FROM debian:bookworm-slim

# Harden apt against transient mirror failures in CI (#2768).
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
    > /etc/apt/apt.conf.d/80-ci-retries

RUN apt-get update && apt-get install -y --no-install-recommends \
    tigervnc-standalone-server \
    x11vnc \
    feh \
    x11-utils \
    python3 \
    python3-xlib \
    && rm -rf /var/lib/apt/lists/*

COPY make_pattern.py copy_loop.py entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/make_pattern.py /usr/local/bin/copy_loop.py \
        /usr/local/bin/entrypoint.sh \
    && python3 /usr/local/bin/make_pattern.py > /root/pattern.ppm

# Store the RFB password for Xvnc's -rfbauth. TigerVNC on Debian ships no
# `vncpasswd`, so use x11vnc's `-storepasswd` (same format).
RUN mkdir -p /root/.vnc \
    && x11vnc -storepasswd testpass /root/.vnc/passwd \
    && chmod 600 /root/.vnc/passwd

EXPOSE 5900
CMD ["/usr/local/bin/entrypoint.sh"]
