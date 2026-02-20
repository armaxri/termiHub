#!/usr/bin/env bash
set -euo pipefail

# termiHub Agent installer
# Installs the binary and systemd service on a Raspberry Pi (or any Linux host).

BINARY="target/release/termihub-agent"
INSTALL_DIR="/usr/local/bin"
SERVICE_SRC="systemd/termihub-agent.service"
SERVICE_DST="/etc/systemd/system/termihub-agent.service"

if [ "$(id -u)" -ne 0 ]; then
    echo "Error: this script must be run as root (sudo)."
    exit 1
fi

if [ ! -f "$BINARY" ]; then
    echo "Error: binary not found at $BINARY"
    echo "Build first with: cargo build --release"
    exit 1
fi

echo "Installing termihub-agent..."

# Copy binary
install -m 755 "$BINARY" "$INSTALL_DIR/termihub-agent"
echo "  Installed binary to $INSTALL_DIR/termihub-agent"

# Install systemd service
install -m 644 "$SERVICE_SRC" "$SERVICE_DST"
echo "  Installed service to $SERVICE_DST"

# Reload systemd
systemctl daemon-reload
echo "  Reloaded systemd daemon"

# Enable service
systemctl enable termihub-agent.service
echo "  Enabled termihub-agent service"

echo ""
echo "Installation complete. Next steps:"
echo "  sudo systemctl start termihub-agent     # Start the service"
echo "  sudo systemctl status termihub-agent    # Check status"
echo "  journalctl -u termihub-agent -f         # Follow logs"
echo ""
echo "Note: Edit $SERVICE_DST to change the listen address or user."
