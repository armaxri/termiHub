#!/bin/bash
set -e

echo "Starting SSH server..."
/usr/sbin/sshd

echo "Starting Telnet server..."
# in.telnetd via inetd-style: listen in the foreground
in.telnetd -debug 23
