FROM alpine:3.19

RUN apk add --no-cache \
    openssh-server \
    busybox-extras \
    && mkdir /var/run/sshd \
    && ssh-keygen -A

# Create test user
RUN adduser -D -s /bin/sh testuser \
    && echo "testuser:testpass" | chpasswd

# Configure sshd: enable password auth, disable root login
RUN sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && sed -i 's/#PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config

EXPOSE 22 23

# Entrypoint: start sshd and telnetd
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

CMD ["/entrypoint.sh"]
