---
id: TIN-007
title: Docker fixtures are Linux-only, so all real-backend journeys are verified on exactly one OS
angle: test-integration
severity: medium
category: test-gap
is_workaround: false
subsystem: .github/workflows/system-integration.yml, tests/docker
evidence:
  - .github/workflows/system-integration.yml:252
  - .github/workflows/system-integration.yml:22
  - docs/testing.md:2559
status: open
---

## What

The integration lane runs on Linux, macOS, and Windows, but the Docker
SSH/telnet/serial/agent/FTP/VNC fixtures come up **only on the Linux leg**
(`system-integration.yml:252-263`, `if: runner.os == 'Linux'`). On the macOS and
Windows legs, every fixture-backed suite **self-skips** (the GitHub-hosted macOS
runner ships no Docker; the Windows runner's daemon runs Windows, not Linux,
containers — `:22-28`). So:

- The macOS/Windows integration legs run only the app-launch / pure-UI suites.
- Every **real-backend** journey — SSH auth, SFTP transfer, telnet, tunnels,
  deployed-agent, FTP, VNC — is exercised end-to-end on **Linux only**.

Additional carve-out: SSH-tunnel live tests are explicitly skipped on macOS even
locally (Docker Desktop's Linux-VM networking, #933 — `docs/testing.md:2559`).

## Why it matters

- Backend behavior that is genuinely OS-specific — path handling, PTY/ConPTY,
  keychain/credential integration, socket/networking quirks, the Windows agent
  over SSH — has **no** real-connection coverage on macOS or Windows. The three
  historical drift bugs include a Windows-specific one (#1587); this is the class
  of gap that lets those through.
- "Green on all three OS legs" overstates parity: two of the three legs never
  touched a backend.

## Evidence

- `system-integration.yml:252-263` — fixtures gated `if: runner.os == 'Linux'`.
- `:291-297` — macOS/Windows legs "self-skip" the Docker-fixture suites.
- Audit of `docs/testing.md`: "There is no automated end-to-end coverage of the
  Windows agent over a live SSH connection" (~L391); macOS tunnel skip (~L2559).

## Recommendation

- Provide a Linux-container runtime on the non-Linux legs where feasible (e.g.
  colima/Docker on the macOS runner, or a Linux service container on Windows via
  WSL2) so at least the SSH/SFTP core journeys run on all three OSes.
- Where a real Linux daemon is impossible, add **native** fixtures for the
  OS-specific paths that matter most: a loopback `sshd` on macOS/Windows (the
  reconnect grade already stands one up via `LocalAgentSshd`) to cover SSH/agent
  connect natively, closing the "Windows agent over live SSH" hole specifically.
