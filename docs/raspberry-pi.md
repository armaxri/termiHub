# Raspberry Pi Deployment Guide

## Installation on Raspberry Pi

TermiHub builds for ARM64 Linux, which includes:
- Raspberry Pi 3 (64-bit OS)
- Raspberry Pi 4
- Raspberry Pi 5
- Other ARM64 SBCs (Orange Pi, Rock Pi, etc.)

### Prerequisites

**Raspberry Pi OS Requirements**:
- 64-bit Raspberry Pi OS (Bookworm or newer recommended)
- At least 2GB RAM (4GB+ recommended for better performance)

Check your architecture:
```bash
uname -m
# Should output: aarch64
```

### Installing from Release

#### Option 1: Using .deb Package (Recommended)

```bash
# Download the latest .deb for ARM64
wget https://github.com/armaxri/termiHub/releases/latest/download/TermiHub-X.X.X-linux-arm64.deb

# Install
sudo dpkg -i TermiHub-X.X.X-linux-arm64.deb

# Fix dependencies if needed
sudo apt-get install -f
```

#### Option 2: Using AppImage

```bash
# Download AppImage
wget https://github.com/armaxri/termiHub/releases/latest/download/TermiHub-X.X.X-linux-arm64.AppImage

# Make executable
chmod +x TermiHub-X.X.X-linux-arm64.AppImage

# Run
./TermiHub-X.X.X-linux-arm64.AppImage
```

### System Dependencies

TermiHub requires WebKitGTK and GTK3:

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-0 \
  libgtk-3-0 \
  libayatana-appindicator3-1
```

### Running as the Remote Agent

For the embedded development use case (Raspberry Pi as a persistent remote agent):

1. **Build the agent** (on the Pi or cross-compile):

```bash
cd agent
cargo build --release
```

2. **Install using the provided script**:

```bash
cd agent
sudo ./install.sh
```

This copies the binary to `/usr/local/bin/`, installs the systemd service, and enables it.

3. **Start the service**:

```bash
sudo systemctl start termihub-agent
```

4. **Check status and logs**:

```bash
sudo systemctl status termihub-agent
journalctl -u termihub-agent -f
```

#### Agent Modes

The agent supports two modes:

- **`--listen [addr]`** — TCP listener mode (default: `127.0.0.1:7685`). Used for systemd service. Sessions persist across client reconnects.
- **`--stdio`** — Stdio mode (NDJSON over stdin/stdout). Used when launched over SSH exec channels.

The systemd service uses `--listen` mode by default. To change the listen address, edit `/etc/systemd/system/termihub-agent.service`:

```bash
sudo systemctl edit termihub-agent
# Override ExecStart to change the address
```

#### Connecting from the Desktop

When the agent runs with `--listen`, connect from TermiHub desktop via:

- **SSH port forward**: `ssh -L 7685:127.0.0.1:7685 pi@raspberrypi` then connect to `localhost:7685`
- **Direct LAN**: Start with `--listen 0.0.0.0:7685` and connect to the Pi's IP address

#### Security Notes

The TCP listener does not implement authentication or encryption. Always use one of:

- Bind to `127.0.0.1` (default) and tunnel via SSH
- Run on a trusted local network only

### Serial Port Access

For serial connections on Raspberry Pi:

```bash
# Add user to dialout group
sudo usermod -a -G dialout $USER

# Logout and login for changes to take effect
```

### Performance Tips

**For Raspberry Pi 3/4**:
- Close unnecessary applications to free RAM
- Consider using a lightweight desktop environment (LXDE)
- Use swap if needed: `sudo dphys-swapfile swapoff && sudo nano /etc/dphys-swapfile`

**For Raspberry Pi 5**:
- Should run smoothly with default settings
- Can handle multiple terminal sessions easily

### Troubleshooting

**AppImage won't run**:
```bash
# Install FUSE
sudo apt-get install fuse libfuse2
```

**Slow performance**:
```bash
# Check available memory
free -h

# Check CPU usage
htop
```

**Serial port not accessible**:
```bash
# List serial devices
ls -l /dev/ttyUSB* /dev/ttyACM*

# Check permissions
groups $USER  # Should include 'dialout'
```

### Building from Source on Raspberry Pi

If you want to build TermiHub directly on your Raspberry Pi:

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install dependencies
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pnpm
npm install -g pnpm

# Clone and build
git clone https://github.com/armaxri/termiHub.git
cd termiHub
pnpm install
pnpm run build

# The build will take 20-30 minutes on Pi 4, less on Pi 5
```

### Remote Access Setup

To access the TermiHub agent from your development machine:

1. **Ensure SSH is enabled** on Raspberry Pi:
```bash
sudo systemctl enable ssh
sudo systemctl start ssh
```

2. **Get Raspberry Pi IP**:
```bash
hostname -I
```

3. **Connect from TermiHub on your PC**:
- Add new SSH connection
- Enter Raspberry Pi IP and credentials
- Enable X11 forwarding if needed
- Access file browser for file transfer

### Updates

**Using .deb package**:
```bash
# Download new version
wget https://github.com/armaxri/termiHub/releases/latest/download/TermiHub-X.X.X-linux-arm64.deb

# Update
sudo dpkg -i TermiHub-X.X.X-linux-arm64.deb
```

**Using AppImage**:
- Simply replace the old AppImage with the new one
- Update symlinks if you created any

---

For more help, see the main [README](../README.md) or open an issue.
