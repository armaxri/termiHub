# SSH server restricted to SFTP only (ForceCommand internal-sftp).
#
# Password auth (testuser / testpass), same as ssh-password, but the server
# forces the internal SFTP subsystem for every session: no exec/shell channel
# is usable. Used to verify that exec-capability detection reports `false` for
# an SFTP-only connection.
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /run/sshd

# Create test user (shell is irrelevant — logins are forced into internal-sftp).
RUN useradd -m -s /usr/sbin/nologin testuser \
    && echo "testuser:testpass" | chpasswd

# Configure SSH: allow password auth and force the internal SFTP subsystem so
# that exec/shell requests never run a command.
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's@^Subsystem\s\+sftp.*@Subsystem sftp internal-sftp@' /etc/ssh/sshd_config \
    && printf '\nUseDNS no\nForceCommand internal-sftp\n' >> /etc/ssh/sshd_config

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
