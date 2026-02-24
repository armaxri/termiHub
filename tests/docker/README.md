# termiHub Test Docker Infrastructure

Comprehensive Docker-based test containers for automated system testing.

## Quick Start

```bash
# Start core test containers
docker compose -f tests/docker/docker-compose.yml up -d

# Start everything (including fault injection + stress tests)
docker compose -f tests/docker/docker-compose.yml --profile all up -d

# Stop all
docker compose -f tests/docker/docker-compose.yml down
```

## Containers

### SSH Containers

| Container | Port | Auth | Purpose |
|-----------|------|------|---------|
| `ssh-password` | 2201 | `testuser`/`testpass` | Standard password auth (OpenSSH latest) |
| `ssh-legacy` | 2202 | password + keys | Legacy OpenSSH 7.x compatibility |
| `ssh-keys` | 2203 | key only | All key types (RSA, Ed25519, ECDSA) |
| `ssh-jumphost-bastion` | 2204 | key only | ProxyJump bastion (2-hop chain entry) |
| `ssh-jumphost-target` | internal | key only | ProxyJump target (reachable only via bastion) |
| `ssh-restricted` | 2205 | `testuser`/`testpass` | Restricted shell (rbash) |
| `ssh-banner` | 2206 | `testuser`/`testpass` | Pre-auth banner + MOTD |
| `ssh-tunnel-target` | 2207 | password + keys | Internal HTTP/echo servers for tunnel testing |
| `ssh-x11` | 2208 | password + keys | X11 forwarding with xterm/xclock/xeyes |

### Other Protocols

| Container | Port | Purpose |
|-----------|------|---------|
| `telnet-server` | 2301 | Telnet with `testuser`/`testpass` |
| `serial-echo` | volume | Virtual serial ports with echo servers |

### Profile Containers

| Container | Port | Profile | Purpose |
|-----------|------|---------|---------|
| `network-fault-proxy` | 2209 | `fault` | tc/netem network fault injection |
| `sftp-stress` | 2210 | `stress` | Pre-populated SFTP stress test data |

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

## Requirements

- Docker Engine 20.10+ with BuildKit
- Docker Compose v2.17+ (for `additional_contexts` support)
