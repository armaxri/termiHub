# Telnet server for protocol testing
# Supports authenticated and unauthenticated connections
# Test user: testuser / testpass
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    xinetd \
    telnetd \
    && rm -rf /var/lib/apt/lists/*

# Create test user
RUN useradd -m -s /bin/bash testuser \
    && echo "testuser:testpass" | chpasswd

# Configure telnet via xinetd.
# On Ubuntu 24.04 the `telnetd` package is a transitional shim for
# `inetutils-telnetd`, which installs the daemon at /usr/sbin/telnetd (there is
# no /usr/sbin/in.telnetd). `-h` (--no-hostinfo) suppresses host-specific info
# before login but still shows /etc/issue.net and the `login:` prompt; the
# default login program (/bin/login) is used.
RUN printf '%s\n' \
    'service telnet' \
    '{' \
    '    flags           = REUSE' \
    '    socket_type     = stream' \
    '    wait            = no' \
    '    user            = root' \
    '    server          = /usr/sbin/telnetd' \
    '    server_args     = -h' \
    '    log_on_failure  += USERID' \
    '    disable         = no' \
    '}' \
    > /etc/xinetd.d/telnet

# Create a login banner
RUN printf '%s\n' \
    "" \
    "termiHub Telnet Test Server" \
    "============================" \
    "" \
    > /etc/issue.net

EXPOSE 23
CMD ["/usr/sbin/xinetd", "-dontfork", "-stayalive"]
