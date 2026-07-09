# termiHub Test Docker Infrastructure

Comprehensive Docker-based test containers for automated system testing.

## Quick Start

```bash
# Start core test containers (Docker)
docker compose -f tests/docker/docker-compose.yml up -d

# Start everything (including fault injection + stress tests)
docker compose -f tests/docker/docker-compose.yml --profile all up -d

# Stop all
docker compose -f tests/docker/docker-compose.yml down
```

> **Parallel checkouts.** Container/network names and published ports are
> parameterised so several checkouts can run these containers at once. A bare
> `docker compose up` (no env) uses the historical names (`termihub-ssh-password`,
> …) and ports (`2201`, `2301`, `8080`, …). Set `TERMIHUB_TEST_PROJECT` and the
> `TERMIHUB_TEST_*_PORT` vars (the test scripts export them from `dev.local.json`
> via `scripts/internal/dev-local-env.sh`) to namespace and offset them — then the
> `docker exec` / `ssh` examples below target `<project>-…` containers. See
> [`docs/testing.md`](../../docs/testing.md) → _Parallel test isolation_.

## Podman

The test infrastructure supports Podman as a drop-in replacement for Docker:

```bash
# Auto-detection: the test scripts detect Podman when Docker is not available
./scripts/test-system-linux.sh

# Force Podman explicitly
CONTAINER_CMD=podman ./scripts/test-system-linux.sh

# Or run compose commands directly with Podman
podman compose -f tests/docker/docker-compose.yml up -d
```

## Containers

### SSH Containers

| Container              | Port     | Auth                  | Purpose                                                 |
| ---------------------- | -------- | --------------------- | ------------------------------------------------------- |
| `ssh-password`         | 2201     | `testuser`/`testpass` | Standard password auth (OpenSSH latest)                 |
| `ssh-legacy`           | 2202     | password + keys       | Legacy OpenSSH 7.x compatibility                        |
| `ssh-keys`             | 2203     | key only              | All key types (RSA, Ed25519, ECDSA)                     |
| `ssh-jumphost-bastion` | 2204     | key only              | ProxyJump bastion (2-hop chain entry)                   |
| `ssh-jumphost-target`  | internal | key only              | ProxyJump target (reachable only via bastion)           |
| `ssh-restricted`       | 2205     | `testuser`/`testpass` | Restricted shell (rbash)                                |
| `ssh-banner`           | 2206     | `testuser`/`testpass` | Pre-auth banner + MOTD                                  |
| `ssh-tunnel-target`    | 2207     | password + keys       | Internal HTTP/echo servers for tunnel testing           |
| `ssh-x11`              | 2208     | password + keys       | X11 forwarding (xterm/xclock/xeyes) + Xvfb render-check |

### Other Protocols

| Container       | Port | Purpose                           |
| --------------- | ---- | --------------------------------- |
| `telnet-server` | 2301 | Telnet with `testuser`/`testpass` |

### Profile Containers

| Container             | Port | Profile  | Purpose                             |
| --------------------- | ---- | -------- | ----------------------------------- |
| `network-fault-proxy` | 2209 | `fault`  | tc/netem network fault injection    |
| `sftp-stress`         | 2210 | `stress` | Pre-populated SFTP stress test data |

## Networks

- **test-net** — Main bridge network connecting all containers
- **jumphost-net** — Internal-only network for jump host testing (bastion bridges both)

## SSH Test Keys

All test SSH keys are in `tests/fixtures/ssh-keys/`. See [the keys README](../fixtures/ssh-keys/README.md) for details.

## Network Fault Injection

```bash
# Start with fault profile
docker compose --profile fault up -d

# Apply faults via docker exec
docker exec termihub-network-fault apply-latency 500ms
docker exec termihub-network-fault apply-loss 10%
docker exec termihub-network-fault apply-throttle 1mbit
docker exec termihub-network-fault apply-jitter 200ms 50ms
docker exec termihub-network-fault apply-disconnect
docker exec termihub-network-fault reset-faults
```

## Jump Host Testing

The jump host chain: Client -> Bastion (port 2204) -> Target (internal only)

```bash
# Test ProxyJump via SSH directly
ssh -o ProxyJump=testuser@localhost:2204 testuser@termihub-ssh-target -i tests/fixtures/ssh-keys/ed25519

# Verify you reached the target
cat /home/testuser/marker.txt  # Should print: JUMPHOST_TARGET_REACHED
```

## X11 forwarding

The `ssh-x11` container (host port `2208`) enables SSH X11 forwarding and ships
`xeyes` / `xclock` / `xdpyinfo` plus two helper scripts for verifying the
forwarded-GUI path. It backs the X-server provisioning epic (#1047); see
[`docs/testing.md`](../../docs/testing.md) → _X11 / GUI forwarding_ for the full
cross-platform manual matrix.

```bash
# Headless render check — proves a GUI client renders to an X server with NO
# host X server (in-container Xvfb). Automatable anywhere Docker runs.
docker compose -f tests/docker/docker-compose.yml exec ssh-x11 render-check.sh
# Prints RENDER_CHECK_OK on success.

# Forwarded-session assertion — run inside a real forwarded session. DISPLAY
# must be set and reachable. Needs a local X server on the client side (an
# Xvfb :0 on Linux CI, or XQuartz on macOS).
ssh -X -p 2208 testuser@localhost /usr/local/bin/test-x11.sh
# Prints X11_FORWARDING_OK on success.
```

The render check is a genuine in-container capability check; it is **not** a
stand-in for the end-to-end forward into the operator's real display, which
remains a manual step (no host X server can be faked in the harness).

## Requirements

- Docker Engine 20.10+ with BuildKit
- Docker Compose v2.17+ (for `additional_contexts` support)
