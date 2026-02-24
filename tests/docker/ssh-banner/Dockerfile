# SSH server with custom pre-auth banner and MOTD
# Tests that termiHub correctly handles/displays SSH banners
# Test user: testuser / testpass
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /run/sshd

# Create test user
RUN useradd -m -s /bin/bash testuser \
    && echo "testuser:testpass" | chpasswd

# Create a long pre-authentication banner (displayed before login)
RUN printf '%s\n' \
    "========================================================" \
    "  AUTHORIZED ACCESS ONLY - TEST SYSTEM" \
    "========================================================" \
    "" \
    "  This is a termiHub test server." \
    "  All connections are logged and monitored." \
    "" \
    "  By connecting, you agree to the acceptable use policy." \
    "  Unauthorized access will be prosecuted." \
    "" \
    "  System: Ubuntu 24.04 LTS (test-banner)" \
    "  Contact: admin@termihub-test.local" \
    "" \
    "========================================================" \
    > /etc/ssh/banner.txt

# Create MOTD (displayed after login)
RUN printf '%s\n' \
    "" \
    "Welcome to the termiHub test environment!" \
    "SSH Banner Test Container" \
    "" \
    "Last system update: 2024-01-01" \
    "Active sessions: 42" \
    "" \
    > /etc/motd

# Configure SSH with banner
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's|#Banner none|Banner /etc/ssh/banner.txt|' /etc/ssh/sshd_config \
    && echo "UseDNS no" >> /etc/ssh/sshd_config \
    && echo "PrintMotd yes" >> /etc/ssh/sshd_config

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
