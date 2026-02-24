# termiHub Remote Agent test container
#
# Provides an SSH-accessible host with the termihub-agent binary
# pre-installed for E2E testing.
#
# Usage:
#   docker compose -f tests/docker/docker-compose.yml --profile agent up -d
#   # Connects on port 2211 (testuser/testpass)
#
# Note: The agent binary must be cross-compiled for Linux x86_64
# before building this container. Use:
#   cargo build --release -p termihub-agent --target x86_64-unknown-linux-gnu

FROM ubuntu:24.04

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssh-server \
    && rm -rf /var/lib/apt/lists/*

# Create test user
RUN useradd -m -s /bin/bash testuser && \
    echo "testuser:testpass" | chpasswd

# Configure SSH
RUN mkdir -p /run/sshd && \
    sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && \
    sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config

# Copy SSH keys for key-based auth
COPY --from=keys authorized_keys /home/testuser/.ssh/authorized_keys
RUN chown -R testuser:testuser /home/testuser/.ssh && \
    chmod 700 /home/testuser/.ssh && \
    chmod 600 /home/testuser/.ssh/authorized_keys

# Generate host keys
RUN ssh-keygen -A

# Note: The agent binary will be installed via the setup wizard during tests.
# For tests that require a pre-installed agent, build and copy the binary:
# COPY termihub-agent /usr/local/bin/termihub-agent
# RUN chmod +x /usr/local/bin/termihub-agent

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
