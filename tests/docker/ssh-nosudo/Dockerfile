# SSH server with password auth but NO `sudo` installed, for the "not
# permitted" branch of the elevated remote-save integration test (#1494 / #1328).
#
# Test user:  testuser / testpass  — a plain account with sudo absent, so
#             `sudo -S …` fails ("command not found") and
#             `write_file_content_elevated` classifies the result as `Other`.
# Target:     /etc/termihub-elevated-target.txt — root:root, mode 644, known
#             contents. The test asserts it is left UNCHANGED on this path.
FROM ubuntu:24.04

# Deliberately do NOT install `sudo`.
RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /run/sshd

# Create test user (no sudo group membership; sudo is not present anyway).
RUN useradd -m -s /bin/bash testuser \
    && echo "testuser:testpass" | chpasswd

# Root-owned target file that must remain untouched on the failure path.
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
