# SSH server with internal services for tunnel testing
# Contains: HTTP server (port 8080), echo server (port 9090)
# Tests: local forwarding, remote forwarding, dynamic (SOCKS) forwarding
# Test user: testuser / testpass
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    python3 \
    netcat-openbsd \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /run/sshd

# Create test user
RUN useradd -m -s /bin/bash testuser \
    && echo "testuser:testpass" | chpasswd

# Install test public keys too
RUN mkdir -p /home/testuser/.ssh && chmod 700 /home/testuser/.ssh
COPY --from=keys authorized_keys /home/testuser/.ssh/authorized_keys
RUN chmod 600 /home/testuser/.ssh/authorized_keys \
    && chown -R testuser:testuser /home/testuser/.ssh

# Create a simple HTTP server script (serves on port 8080)
RUN printf '%s\n' \
    '#!/usr/bin/env python3' \
    'from http.server import HTTPServer, BaseHTTPRequestHandler' \
    'class Handler(BaseHTTPRequestHandler):' \
    '    def do_GET(self):' \
    '        self.send_response(200)' \
    '        self.send_header("Content-Type", "text/plain")' \
    '        self.end_headers()' \
    '        self.wfile.write(b"TUNNEL_TEST_OK\n")' \
    '    def log_message(self, format, *args):' \
    '        pass  # suppress logs' \
    'HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()' \
    > /usr/local/bin/http-server.py \
    && chmod +x /usr/local/bin/http-server.py

# Create an echo server script (serves on port 9090)
RUN printf '%s\n' \
    '#!/usr/bin/env python3' \
    'import socketserver' \
    'class Handler(socketserver.StreamRequestHandler):' \
    '    def handle(self):' \
    '        for line in self.rfile:' \
    '            self.wfile.write(line)' \
    '            self.wfile.flush()' \
    'server = socketserver.TCPServer(("0.0.0.0", 9090), Handler)' \
    'server.serve_forever()' \
    > /usr/local/bin/echo-server.py \
    && chmod +x /usr/local/bin/echo-server.py

# Startup script: run sshd + internal services
RUN printf '%s\n' \
    '#!/bin/bash' \
    'python3 /usr/local/bin/http-server.py &' \
    'python3 /usr/local/bin/echo-server.py &' \
    'exec /usr/sbin/sshd -D -e' \
    > /usr/local/bin/start.sh \
    && chmod +x /usr/local/bin/start.sh

# Configure SSH: allow forwarding
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/#AllowTcpForwarding yes/AllowTcpForwarding yes/' /etc/ssh/sshd_config \
    && sed -i 's/#GatewayPorts no/GatewayPorts yes/' /etc/ssh/sshd_config \
    && echo "UseDNS no" >> /etc/ssh/sshd_config

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22
# Internal services (not exposed to host — only reachable via SSH tunnel)
# 8080 = HTTP test server, 9090 = TCP echo server
CMD ["/usr/local/bin/start.sh"]
