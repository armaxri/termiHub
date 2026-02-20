#!/usr/bin/env bash
#
# Create a virtual serial port pair using socat.
#
# This creates two linked pseudo-terminals:
#   /tmp/termihub-serial-a  <-->  /tmp/termihub-serial-b
#
# Connect termiHub to one end and the echo server (or another tool) to the other.
#
set -euo pipefail

PTY_A="/tmp/termihub-serial-a"
PTY_B="/tmp/termihub-serial-b"

if ! command -v socat &>/dev/null; then
    echo "Error: socat is not installed."
    echo ""
    echo "Install it with:"
    echo "  macOS:   brew install socat"
    echo "  Ubuntu:  sudo apt install socat"
    echo "  Fedora:  sudo dnf install socat"
    exit 1
fi

# Clean up stale symlinks
rm -f "$PTY_A" "$PTY_B"

echo "Creating virtual serial port pair..."
echo "  $PTY_A  <-->  $PTY_B"
echo ""
echo "Connect termiHub to $PTY_A and the echo server to $PTY_B (or vice versa)."
echo "Press Ctrl+C to stop."
echo ""

socat -d -d \
    "pty,raw,echo=0,link=$PTY_A" \
    "pty,raw,echo=0,link=$PTY_B"
