# SSH server with X11 forwarding support and test X11 applications
# Contains: xterm, xclock, xeyes, xdpyinfo for X11 forwarding verification
# Test user: testuser / testpass
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    xauth \
    x11-apps \
    x11-utils \
    xterm \
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

# Create an X11 test script that checks if DISPLAY is set and X11 works
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

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
