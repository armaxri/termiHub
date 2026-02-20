# termiHub Examples & Test Environment

This directory provides Docker-based test targets and scripts for testing all termiHub connection types without external infrastructure.

## Prerequisites

- **Docker** (with Docker Compose)
- **pnpm** (for launching the app)
- **socat** (optional, for virtual serial port testing)

## Quick Start

Start the Docker test environment and launch termiHub with pre-configured test connections:

```bash
./scripts/start-test-environment.sh
```

This will:

1. Build and start a Docker container with SSH and Telnet servers
2. Wait for the services to be ready
3. Launch termiHub with `TERMIHUB_CONFIG_DIR` pointing to `examples/config/`

When you're done, stop the test containers:

```bash
./scripts/stop-test-environment.sh
```

## Test Connections

The example config (`config/connections.json`) includes pre-configured connections:

| Connection | Type | Host | Port | Credentials | Notes |
|-----------|------|------|------|-------------|-------|
| Docker SSH | SSH | 127.0.0.1 | 2222 | `testuser` / `testpass` | |
| Docker SSH + X11 | SSH | 127.0.0.1 | 2222 | `testuser` / `testpass` | X11 forwarding enabled |
| Docker Telnet | Telnet | 127.0.0.1 | 2323 | `testuser` / `testpass` | |

SSH connections prompt for the password at connect time.

### X11 Forwarding Testing

The Docker container includes `xclock` and `xeyes` for testing X11 forwarding. To test:

1. **macOS**: Install and start [XQuartz](https://www.xquartz.org/). After installing, log out and back in so `DISPLAY` is set.
2. **Linux**: Your X server should already be running.
3. Connect using the "Docker SSH + X11" connection.
4. Run `xclock` or `xeyes` in the terminal — the window should appear on your local display.
5. Verify with `echo $DISPLAY` — it should show something like `localhost:N.0`.

## Serial Port Testing

See [`serial/README.md`](serial/README.md) for virtual serial port setup using `socat`.

Quick version:

```bash
# Terminal 1: Create virtual serial pair
./scripts/setup-virtual-serial.sh

# Terminal 2: Start echo server
python3 serial/serial-echo-server.py

# Terminal 3: Connect termiHub to /tmp/termihub-serial-a
```

## Directory Structure

```
examples/
├── README.md                          # This file
├── config/
│   └── connections.json               # Pre-configured test connections
├── docker/
│   ├── Dockerfile                     # Ubuntu + SSH + Telnet + X11
│   ├── docker-compose.yml             # Port mappings (2222, 2323)
│   └── entrypoint.sh                  # Starts sshd + telnetd
├── scripts/
│   ├── start-test-environment.sh      # Build, start, and launch app
│   ├── stop-test-environment.sh       # Tear down containers
│   └── setup-virtual-serial.sh        # Create socat virtual serial pair
└── serial/
    ├── README.md                      # Serial testing guide
    └── serial-echo-server.py          # Echo server for serial testing
```

## Troubleshooting

### Port conflicts

If ports 2222 or 2323 are already in use, edit `docker/docker-compose.yml` to change the host port mappings (left side of the colon).

### Docker not running

```
Error: Docker daemon is not running.
```

Start Docker Desktop or the Docker service:

- **macOS**: Open Docker Desktop
- **Linux**: `sudo systemctl start docker`

### SSH connection refused

If the start script reports that SSH didn't start in time:

1. Check Docker logs: `docker compose -f examples/docker/docker-compose.yml logs`
2. Ensure no other service is using port 2222

### socat not found

Install `socat` for virtual serial port testing:

- **macOS**: `brew install socat`
- **Ubuntu/Debian**: `sudo apt install socat`
- **Fedora**: `sudo dnf install socat`

## Config Directory Override

The start script uses the `TERMIHUB_CONFIG_DIR` environment variable to point termiHub at the example config. You can use this independently:

```bash
TERMIHUB_CONFIG_DIR=/path/to/custom/config pnpm tauri dev
```

When unset, termiHub uses the default Tauri config directory.
