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
# The bastion also needs a *private* key to hop onward to ssh-jumphost-target
# (SSH-JUMP-01 runs `ssh -i /home/testuser/.ssh/ed25519 ...@target` from here).
# Without it the inner ssh fails auth and returns an empty marker (#864).
COPY --from=keys ed25519 /home/testuser/.ssh/ed25519
RUN chmod 600 /home/testuser/.ssh/authorized_keys /home/testuser/.ssh/ed25519 \
    && chown -R testuser:testuser /home/testuser/.ssh

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
