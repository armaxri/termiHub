# SSH server with restricted shell (rbash)
# Tests behavior when user has limited command access
# Test user: testuser / testpass (restricted shell)
# Test user: freeuser / testpass (normal shell, for comparison)
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /run/sshd

# Create restricted user with rbash
RUN useradd -m -s /bin/rbash testuser \
    && echo "testuser:testpass" | chpasswd

# Create a limited set of allowed commands for restricted user
RUN mkdir -p /home/testuser/bin \
    && ln -s /bin/ls /home/testuser/bin/ls \
    && ln -s /bin/cat /home/testuser/bin/cat \
    && ln -s /bin/echo /home/testuser/bin/echo \
    && ln -s /usr/bin/whoami /home/testuser/bin/whoami \
    && echo "PATH=/home/testuser/bin" > /home/testuser/.bash_profile \
    && chown -R testuser:testuser /home/testuser

# Create unrestricted user for comparison tests
RUN useradd -m -s /bin/bash freeuser \
    && echo "freeuser:testpass" | chpasswd

# Configure SSH
RUN sed -i 's/#PasswordAuthentication yes/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PermitRootLogin prohibit-password/PermitRootLogin no/' /etc/ssh/sshd_config \
    && echo "UseDNS no" >> /etc/ssh/sshd_config

# Generate host keys
RUN ssh-keygen -A

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
