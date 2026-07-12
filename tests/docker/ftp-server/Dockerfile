# FTP server for termiHub FTP-client integration fixtures.
#
# Provides an INDEPENDENT external FTP server (ProFTPD) — deliberately NOT the
# embedded libunftp server — so the FTP backend sub-issues validate real interop.
# One container exposes three endpoints over a single seeded /srv/ftp tree:
#   * plain FTP           on :21  (anonymous + ftpuser/ftppass)
#   * explicit FTPS       on :21  (AUTH TLS / STARTTLS on the same listener)
#   * implicit FTPS       on :990 (TLS from the first byte)
#
# ProFTPD (not vsftpd) is used because vsftpd 3.0.5 on Ubuntu 24.04 segfaults on
# any TLS data connection (an OpenSSL-3 incompatibility), which is fatal for the
# FTPS endpoints. See tests/docker/README.md for endpoints, logins, and the
# seeded tree.
FROM ubuntu:24.04

# proftpd-mod-crypto ships mod_tls (TLS/SSL) as a DSO — required for the FTPS
# endpoints (proftpd-core alone has no TLS support).
RUN apt-get update && apt-get install -y --no-install-recommends \
    proftpd-core \
    proftpd-mod-crypto \
    openssl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Local FTP account (nologin shell — this account only exists for FTP). Its home
# is the shared /srv/ftp tree, so DefaultRoot chroots it onto the seeded data.
RUN useradd -M -d /srv/ftp -s /usr/sbin/nologin ftpuser \
    && echo "ftpuser:ftppass" | chpasswd

# Ensure the anonymous FTP account exists (home = the seeded tree).
RUN id ftp >/dev/null 2>&1 || useradd -M -d /srv/ftp -s /usr/sbin/nologin ftp

# Config template + entrypoint (passive ranges templated from env at runtime).
COPY proftpd.conf.tmpl /etc/proftpd/proftpd.conf.tmpl
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Self-signed TLS material (key + cert in one PEM).
RUN openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
    -subj "/C=US/ST=Test/L=Test/O=termiHub/CN=termihub-ftp" \
    -keyout /etc/ssl/private/proftpd.pem -out /tmp/ftp-cert.pem \
    && cat /tmp/ftp-cert.pem >> /etc/ssl/private/proftpd.pem \
    && rm /tmp/ftp-cert.pem \
    && chmod 600 /etc/ssl/private/proftpd.pem

# Seed the deterministic /srv/ftp tree at build time.
COPY generate-test-data.sh /usr/local/bin/generate-test-data.sh
RUN chmod +x /usr/local/bin/generate-test-data.sh \
    && /usr/local/bin/generate-test-data.sh \
    && chown ftpuser:nogroup /srv/ftp/uploads

EXPOSE 21 990
CMD ["/usr/local/bin/entrypoint.sh"]
