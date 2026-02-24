# SSH bastion / jump host for ProxyJump chain testing
# Client → Bastion (this) → Target (ssh-jumphost-target)
# Test user: testuser (key auth)
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    openssh-client \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /run/sshd

# Create test user
RUN useradd -m -s /bin/bash testuser

# Configure SSH: key auth, allow TCP forwarding (needed for ProxyJump)
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && sed -i 's/#PubkeyAuthentication yes/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#AllowTcpForwarding yes/AllowTcpForwarding yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
    && echo "UseDNS no" >> /etc/ssh/sshd_config \
    && echo "GatewayPorts no" >> /etc/ssh/sshd_config

# Install test public keys
RUN mkdir -p /home/testuser/.ssh && chmod 700 /home/testuser/.ssh
COPY --from=keys authorized_keys /home/testuser/.ssh/authorized_keys
RUN chmod 600 /home/testuser/.ssh/authorized_keys \
    && chown -R testuser:testuser /home/testuser/.ssh

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
