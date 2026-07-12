#!/bin/bash
# Render the ProFTPD config from the container env, then run proftpd in the
# foreground. A single daemon serves the plain/explicit server (port 21) and the
# implicit-FTPS VirtualHost (port 990).
#
# The passive-port ranges are templated (not baked into the image) because the
# advertised passive port must equal the host-published port 1:1, so parallel
# checkouts offset the whole range via env — see tests/docker/README.md.
set -e

PASV_ADDRESS="${PASV_ADDRESS:-127.0.0.1}"
MAIN_PASV_MIN="${MAIN_PASV_MIN:-30000}"
MAIN_PASV_MAX="${MAIN_PASV_MAX:-30009}"
IMPLICIT_PASV_MIN="${IMPLICIT_PASV_MIN:-30010}"
IMPLICIT_PASV_MAX="${IMPLICIT_PASV_MAX:-30019}"

sed \
    -e "s|__PASV_ADDRESS__|${PASV_ADDRESS}|g" \
    -e "s|__MAIN_PASV_MIN__|${MAIN_PASV_MIN}|g" \
    -e "s|__MAIN_PASV_MAX__|${MAIN_PASV_MAX}|g" \
    -e "s|__IMPLICIT_PASV_MIN__|${IMPLICIT_PASV_MIN}|g" \
    -e "s|__IMPLICIT_PASV_MAX__|${IMPLICIT_PASV_MAX}|g" \
    /etc/proftpd/proftpd.conf.tmpl >/etc/proftpd/proftpd.conf

echo "[ftp-server] masquerade=${PASV_ADDRESS}"
echo "[ftp-server] plain + explicit FTPS :21 pasv ${MAIN_PASV_MIN}-${MAIN_PASV_MAX}"
echo "[ftp-server] implicit FTPS         :990 pasv ${IMPLICIT_PASV_MIN}-${IMPLICIT_PASV_MAX}"

exec /usr/sbin/proftpd --nodaemon --config /etc/proftpd/proftpd.conf
