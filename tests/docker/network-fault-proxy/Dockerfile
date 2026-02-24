# Network fault injection proxy using tc/netem
# Sits between the client and target containers, applying network conditions
# Supports: latency, jitter, packet loss, bandwidth throttling, connection reset
#
# Usage via docker exec:
#   docker exec network-fault apply-latency 500ms
#   docker exec network-fault apply-loss 10%
#   docker exec network-fault apply-throttle 1mbit
#   docker exec network-fault reset
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    iproute2 \
    iptables \
    openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /run/sshd

# Create test user (for SSH passthrough)
RUN useradd -m -s /bin/bash testuser \
    && echo "testuser:testpass" | chpasswd

# Install test public keys
RUN mkdir -p /home/testuser/.ssh && chmod 700 /home/testuser/.ssh
COPY --from=keys authorized_keys /home/testuser/.ssh/authorized_keys
RUN chmod 600 /home/testuser/.ssh/authorized_keys \
    && chown -R testuser:testuser /home/testuser/.ssh

# Configure SSH
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
    && echo "UseDNS no" >> /etc/ssh/sshd_config

# Network fault control scripts
COPY fault-control.sh /usr/local/bin/fault-control.sh
RUN chmod +x /usr/local/bin/fault-control.sh \
    && ln -s /usr/local/bin/fault-control.sh /usr/local/bin/apply-latency \
    && ln -s /usr/local/bin/fault-control.sh /usr/local/bin/apply-loss \
    && ln -s /usr/local/bin/fault-control.sh /usr/local/bin/apply-throttle \
    && ln -s /usr/local/bin/fault-control.sh /usr/local/bin/apply-jitter \
    && ln -s /usr/local/bin/fault-control.sh /usr/local/bin/apply-corrupt \
    && ln -s /usr/local/bin/fault-control.sh /usr/local/bin/apply-disconnect \
    && ln -s /usr/local/bin/fault-control.sh /usr/local/bin/reset-faults

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
