# termiHub Test Docker Infrastructure

Comprehensive Docker-based test containers for automated system testing.

## Quick Start

```bash
# Start core test containers (Docker)
docker compose -f tests/docker/docker-compose.yml up -d

# Start everything (including fault injection + stress tests)
docker compose -f tests/docker/docker-compose.yml --profile all up -d

# Start the FTP/FTPS server only
docker compose -f tests/docker/docker-compose.yml --profile ftp up -d --wait ftp-server

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
| `ssh-sftp-only`        | 2211     | `testuser`/`testpass` | SFTP-only (`ForceCommand internal-sftp`, no exec)       |
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

| Container             | Port        | Profile  | Purpose                                       |
| --------------------- | ----------- | -------- | --------------------------------------------- |
| `network-fault-proxy` | 2209        | `fault`  | tc/netem network fault injection              |
| `sftp-stress`         | 2210        | `stress` | Pre-populated SFTP stress test data           |
| `ftp-server`          | 2401 / 2402 | `ftp`    | External FTP/FTPS server + seeded `/pub` tree |

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

## FTP server (profile: `ftp`)

The `ftp-server` container (`ftp-server/`) runs an **independent external FTP
server (ProFTPD)** — deliberately **not** termiHub's embedded `libunftp` server,
so the FTP backend sub-issues (#1334 / #1335 / #1336 / #1339) validate real
interop. One container serves three endpoints over a single seeded `/srv/ftp`
tree:

| Endpoint      | Host port | Container | Auth                                          |
| ------------- | --------- | --------- | --------------------------------------------- |
| plain FTP     | `2401`    | `21`      | `anonymous` (read-only) + `ftpuser`/`ftppass` |
| explicit FTPS | `2401`    | `21`      | AUTH TLS (STARTTLS) on the same listener      |
| implicit FTPS | `2402`    | `990`     | TLS from the first byte                       |

> **Why ProFTPD, not vsftpd?** vsftpd 3.0.5 on Ubuntu 24.04 segfaults on any TLS
> data connection (an OpenSSL-3 incompatibility), which is fatal for the FTPS
> endpoints. ProFTPD (with `proftpd-mod-crypto`) handles all three modes
> reliably in a container.

### Logins

- **Anonymous** — user `anonymous` (any password); **read-only** browse of the
  whole tree. Writes are denied.
- **`ftpuser` / `ftppass`** — a local account chrooted to the same tree; may
  **read everything and upload into `/uploads`**.

### Seeded tree (`/srv/ftp`)

Generated deterministically at build time by `ftp-server/generate-test-data.sh`
(fixed sizes **and** fixed content, so `SIZE` and checksums are reproducible).
`/pub` holds **3 folders and 14 files**:

```text
/pub/readme.txt              61 bytes
/pub/welcome.txt             65 bytes
/pub/docs/guide.txt          52 bytes
/pub/docs/manual.txt         54 bytes
/pub/docs/changelog.txt      44 bytes
/pub/docs/faq.txt            51 bytes
/pub/images/logo.bin       2 048 bytes
/pub/images/banner.bin     4 096 bytes
/pub/data/dataset-1k.bin   1 024 bytes
/pub/data/dataset-8k.bin   8 192 bytes
/pub/data/dataset-64k.bin 65 536 bytes
/pub/data/dataset-1m.bin  1 048 576 bytes
/pub/data/empty.bin            0 bytes
/pub/data/single-byte.bin      1 byte
/uploads/                  (writable landing zone for STOR tests)
```

### Passive ports

FTP passive data connections are advertised as the **same** port number the host
publishes, so the whole passive range is mapped **1:1** (host port == container
port). Two ranges are used — `30000-30009` (plain/explicit) and `30010-30019`
(implicit) — and both the port and the range are offset per checkout via
`scripts/internal/dev-local-env.sh` (`TERMIHUB_TEST_FTP_PORT`,
`TERMIHUB_TEST_FTPS_IMPLICIT_PORT`, `TERMIHUB_TEST_FTP_PASV_MIN/MAX`,
`TERMIHUB_TEST_FTPS_IMPLICIT_PASV_MIN/MAX`). The container templates ProFTPD's
`PassivePorts` from those same values at start-up.

### Verifying the fixture

```bash
# Bring it up (waits for the healthcheck on port 21)
docker compose -f tests/docker/docker-compose.yml --profile ftp up -d --wait ftp-server

# Backend-independent smoke test: lists /pub over plain, explicit + implicit
# FTPS and checks a known-size download. Honours the same port env vars.
bash tests/docker/ftp-server/smoke-test.sh

# Or by hand with curl (-k trusts the self-signed cert):
curl ftp://anonymous:test@127.0.0.1:2401/pub/                 # plain, anonymous
curl -k --ssl-reqd ftp://ftpuser:ftppass@127.0.0.1:2401/pub/  # explicit FTPS
curl -k ftps://ftpuser:ftppass@127.0.0.1:2402/pub/            # implicit FTPS
```

The automated app-level integration tests land with the FTP backend sub-issues;
until then the smoke test above (plus the manual "connect termiHub" step in
[`docs/testing.md`](../../docs/testing.md)) is the verification path.

## Requirements

- Docker Engine 20.10+ with BuildKit
- Docker Compose v2.17+ (for `additional_contexts` support)
