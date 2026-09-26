#!/bin/sh
# Start both RDP servers of the fixture:
#   * xrdp (port 3389): xrdp-sesman (session manager, PAM auth) + xrdp.
#   * FreeRDP shadow server (port 3390): NLA/CredSSP against /etc/winpr/SAM,
#     sharing a headless Xvfb :1 whose root is painted solid pure blue.
set -e

# Stale pid/lock files from an earlier container start make the daemons refuse
# to run.
rm -f /var/run/xrdp/*.pid /var/run/xrdp-sesman.pid /var/run/xrdp.pid /tmp/.X1-lock
mkdir -p /var/run/xrdp
chown xrdp:xrdp /var/run/xrdp 2>/dev/null || true

# -noreset: without it Xvfb resets (repainting the default root) whenever its
# last client disconnects — e.g. right after xsetroot exits.
Xvfb :1 -screen 0 1024x768x24 -nolisten tcp -noreset &
for _ in $(seq 1 50); do
    if DISPLAY=:1 xsetroot -solid '#0000ff' 2>/dev/null; then
        break
    fi
    sleep 0.2
done
DISPLAY=:1 freerdp-shadow-cli3 /port:3390 /sam-file:/etc/winpr/SAM &

/usr/sbin/xrdp-sesman
exec /usr/sbin/xrdp --nodaemon
