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

# Configure telnet via xinetd
RUN printf '%s\n' \
    'service telnet' \
    '{' \
    '    flags           = REUSE' \
    '    socket_type     = stream' \
    '    wait            = no' \
    '    user            = root' \
    '    server          = /usr/sbin/in.telnetd' \
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
