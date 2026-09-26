# RDP server (xrdp + xorgxrdp) for the `rdp` graphical-backend integration suite
# (core/tests/rdp.rs, #3609).
#
# RDP runs through the separately-built `termihub-rdp-helper` sidecar (IronRDP),
# whose connect -> TLS -> logon -> decode path only exists against a real server.
# Per-PR CI never brings up Docker, so without this fixture that path is
# verified by hand only.
#
# Server:    xrdp 0.10 (Debian trixie) with the xorgxrdp Xorg backend, which
#            supports client-driven dynamic resize over the Display Control
#            virtual channel (MS-RDPEDISP) — the path the backend's `resize`
#            drives (#1755, #3465).
# Security:  TLS (xrdp has no NLA/CredSSP); the credentials travel in the Client
#            Info PDU and xrdp-sesman checks them through PAM.
# User:      testuser / testpass (same convention as the SSH fixtures).
# Session:   `startwm.sh` paints the root window solid pure red (#ff0000), so a
#            decoded frame can be told apart from xrdp's own login screen, and
#            runs a tiny clipboard echo loop (see startwm.sh) for the CLIPRDR
#            round-trip test.
FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xrdp \
    xorgxrdp \
    x11-xserver-utils \
    xvfb \
    freerdp3-shadow-x11 \
    winpr3-utils \
    xclip \
    ssl-cert \
    && rm -rf /var/lib/apt/lists/*

# Test user; must be in ssl-cert to read xrdp's TLS key (the key is group
# ssl-cert readable) — only the xrdp daemon needs it, but keep the image lean.
RUN useradd -m -s /bin/bash testuser \
    && echo "testuser:testpass" | chpasswd \
    && adduser xrdp ssl-cert \
    && mkdir -p /etc/winpr \
    && winpr-hash3 -u testuser -p testpass -f sam > /etc/winpr/SAM

# Only offer the Xorg session type, so the Client Info credentials log straight
# in (autologon) without any session selection. Allow the Xorg wrapper to start
# the X server for a non-console user.
COPY xrdp.ini /etc/xrdp/xrdp.ini
COPY startwm.sh /etc/xrdp/startwm.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /etc/xrdp/startwm.sh /usr/local/bin/entrypoint.sh \
    && printf 'allowed_users=anybody\nneeds_root_rights=no\n' > /etc/X11/Xwrapper.config

EXPOSE 3389
CMD ["/usr/local/bin/entrypoint.sh"]
