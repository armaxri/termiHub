# SFTP stress test container with pre-populated test data
# Contains: large files, deep directory trees, symlinks, various permissions
# Test user: testuser / testpass (SSH + SFTP)
FROM ubuntu:24.04

# Harden apt against transient mirror failures in CI (#2768).
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
    > /etc/apt/apt.conf.d/80-ci-retries

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    openssh-sftp-server \
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

# Configure SSH with SFTP subsystem
# MaxStartups is raised because several suites share this one container and connect
# concurrently: src-tauri/tests/sftp_transfer.rs alone opens ~11 password-auth sessions
# at the same instant under default test parallelism, and core/tests/sftp_stress.rs +
# src-tauri/tests/sftp_transfer_resume.rs can overlap with it. The OpenSSH default
# (10:30:100) starts randomly dropping pre-auth connections past 10 ("drop connection
# #11 ... past MaxStartups" in the sshd log), which the client sees as a flaky
# "SSH handshake failed: Disconnected" (#3310). 100:30:200 matches the ssh-keys fixture:
# roughly 10x headroom over the observed peak while keeping a hard cap.
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
    && echo "UseDNS no" >> /etc/ssh/sshd_config \
    && echo "MaxStartups 100:30:200" >> /etc/ssh/sshd_config

# Copy and run the data generator
COPY generate-test-data.sh /usr/local/bin/generate-test-data.sh
RUN chmod +x /usr/local/bin/generate-test-data.sh \
    && /usr/local/bin/generate-test-data.sh

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
