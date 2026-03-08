#!/bin/bash
set -e

# ─── Generate SSH key pair for key-based auth tests ──────────────────────────
# Write the private key to /shared-keys (a Docker volume shared with e2e-runner)
# so the test runner can use it for key-based authentication tests.

SHARED_KEYS="/shared-keys"
if [ -d "$SHARED_KEYS" ]; then
    echo "Generating SSH test key pair..."
    ssh-keygen -t ed25519 -f "$SHARED_KEYS/test_ed25519" -N "" -C "e2e-test@termihub" -q
    mkdir -p /home/testuser/.ssh
    cat "$SHARED_KEYS/test_ed25519.pub" >> /home/testuser/.ssh/authorized_keys
    chmod 700 /home/testuser/.ssh
    chmod 600 /home/testuser/.ssh/authorized_keys
    chown -R testuser:testuser /home/testuser/.ssh
    echo "  Key pair generated and public key installed for testuser."
fi

echo "Starting SSH server..."
/usr/sbin/sshd

echo "Starting Telnet server..."
# in.telnetd via inetd-style: listen in the foreground
in.telnetd -debug 23
