# SSH server with password auth + a password-required sudoer, for the
# elevated remote-save integration test (#1494 / #1328).
#
# Test user:  testuser / testpass  — member of the `sudo` group, so
#             `sudo` requires the account password (NOT NOPASSWD).
# Target:     /etc/termihub-elevated-target.txt — root:root, mode 644, known
#             contents. `write_file_content_elevated` rewrites it in place via
#             `sudo -S` while preserving owner/mode.
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    sudo \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /run/sshd

# Create test user and make it a password-required sudoer via the `sudo` group
# (Ubuntu's default `%sudo ALL=(ALL:ALL) ALL` — password required, no NOPASSWD).
RUN useradd -m -s /bin/bash testuser \
    && echo "testuser:testpass" | chpasswd \
    && usermod -aG sudo testuser

# Root-owned target file the elevated save rewrites (contents intentionally
# distinct from anything the test writes, so "unchanged" is unambiguous).
RUN printf 'original-root-owned-content\n' > /etc/termihub-elevated-target.txt \
    && chown root:root /etc/termihub-elevated-target.txt \
    && chmod 644 /etc/termihub-elevated-target.txt

# Configure SSH: allow password auth
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
    && echo "UseDNS no" >> /etc/ssh/sshd_config

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
