# SSH server with X11 forwarding support and test X11 applications
# Contains: xterm, xclock, xeyes, xdpyinfo for X11 forwarding verification,
# plus Xvfb + a self-contained headless render-check (see render-check.sh).
# Test user: testuser / testpass
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    xauth \
    x11-apps \
    x11-utils \
    xterm \
    xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /run/sshd

# Create test user
RUN useradd -m -s /bin/bash testuser \
    && echo "testuser:testpass" | chpasswd

# Install test public keys
RUN mkdir -p /home/testuser/.ssh && chmod 700 /home/testuser/.ssh
COPY --from=keys authorized_keys /home/testuser/.ssh/authorized_keys
RUN chmod 600 /home/testuser/.ssh/authorized_keys \
    && chown -R testuser:testuser /home/testuser/.ssh

# Configure SSH: enable X11 forwarding
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/#X11Forwarding yes/X11Forwarding yes/' /etc/ssh/sshd_config \
    && sed -i 's/X11Forwarding no/X11Forwarding yes/' /etc/ssh/sshd_config \
    && sed -i 's/#X11DisplayOffset 10/X11DisplayOffset 10/' /etc/ssh/sshd_config \
    && sed -i 's/#X11UseLocalhost yes/X11UseLocalhost yes/' /etc/ssh/sshd_config \
    && echo "UseDNS no" >> /etc/ssh/sshd_config

# X11 forwarding assertion, run *inside a forwarded session*: checks DISPLAY is
# set (forwarding is up) and that a client can talk to the forwarded X server.
# Prints X11_FORWARDING_OK / X11_FORWARDING_FAILED.
RUN printf '%s\n' \
    '#!/bin/bash' \
    'if [ -z "$DISPLAY" ]; then' \
    '  echo "X11_FORWARDING_FAILED: DISPLAY not set"' \
    '  exit 1' \
    'fi' \
    'if xdpyinfo >/dev/null 2>&1; then' \
    '  echo "X11_FORWARDING_OK: DISPLAY=$DISPLAY"' \
    '  exit 0' \
    'else' \
    '  echo "X11_FORWARDING_FAILED: cannot connect to X server"' \
    '  exit 1' \
    'fi' \
    > /usr/local/bin/test-x11.sh \
    && chmod +x /usr/local/bin/test-x11.sh

# Self-contained headless render check: brings up an in-container Xvfb X server,
# launches a real GUI client (xeyes) against it, and asserts the client actually
# mapped a window — proving the "a GUI app renders to an X server" pipeline end
# to end with no host X server. Automatable anywhere Docker runs, unlike a
# forward into the operator's real X server (which the harness cannot fake).
# See tests/docker/README.md -> "X11 forwarding".
COPY --chmod=755 render-check.sh /usr/local/bin/render-check.sh

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
