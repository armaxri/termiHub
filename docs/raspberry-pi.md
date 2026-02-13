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

For the embedded development use case (TermiHub running on Raspberry Pi as remote agent):

1. **Install TermiHub** using one of the methods above

2. **Configure systemd service** (for 24/7 operation):

```bash
# Create service file
sudo nano /etc/systemd/system/termihub-agent.service
```

```ini
[Unit]
Description=TermiHub Remote Agent
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi
ExecStart=/usr/bin/termihub-agent  # Adjust path if needed
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

3. **Enable and start service**:

```bash
sudo systemctl daemon-reload
sudo systemctl enable termihub-agent
sudo systemctl start termihub-agent
```

4. **Check status**:

```bash
sudo systemctl status termihub-agent
```

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
