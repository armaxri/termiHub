#!/bin/sh
set -e

echo "Starting SSH server..."
/usr/sbin/sshd

echo "Starting Telnet server..."
# busybox telnetd runs in the background by default
telnetd -F -l /bin/login
