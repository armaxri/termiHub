# Testing Strategy for termiHub

## Overview

termiHub uses a multi-layered testing approach to ensure quality across the entire stack.

## Testing Layers

```
┌──────────────────────────────────────────┐
│   System / E2E Tests (Python bridge)      │  ← User flows, click automation
├──────────────────────────────────────────┤
│   Integration Tests (Rust + React)        │  ← Component + Backend integration
├──────────────────────────────────────────┤
│   Unit Tests                               │  ← Individual functions
│   - Rust (cargo test)                     │
│   - React (Vitest)                         │
└──────────────────────────────────────────┘
```

## 1. System / E2E Testing (Python bridge harness)

**What it does**: Automates complete user workflows by driving a built app over
the in-app test bridge (see [test-bridge.md](test-bridge.md)).
**Use for**:

- Creating terminal connections
- Opening multiple tabs
- Split view operations
- File browser / SFTP interactions
- Infrastructure coverage against Docker fixtures (SSH, telnet, serial, …)

The system/E2E layer is the **Python bridge harness** under `tests/system/`. It supersedes the retired WebdriverIO/`tauri-driver` suites: all previously-shipped wdio specs (UI, local, infrastructure, performance) were ported to it under epic #799, the last suite retired in #1015, and the empty scaffold (`wdio.conf.js`, `tests/e2e/`, the `@wdio/*` devDependencies) was removed in #1027. Unlike the old wdio path, the Python harness works on **macOS, Linux, and Windows** — it talks to the app over a WebSocket bridge rather than a native WebView driver, so it needs no `tauri-driver`.

### Platform Support

The only remaining `tauri-driver` consumer is the smoke test (`scripts/smoke-test.sh`), which drives it directly over the W3C WebDriver protocol on Linux/Windows and falls back to process/`osascript` checks on macOS. `tauri-driver` still has no macOS WKWebView driver ([tauri-apps/tauri#7068](https://github.com/tauri-apps/tauri/issues/7068)); macOS-specific rendering behavior (WKWebView quirks) must be verified via [manual testing](#manual-testing). See ADR-5 in [architecture.md](architecture.md).

### Running System / E2E Tests

See [tests/system/README.md](../tests/system/README.md) for the full harness
docs and the [Comprehensive System Tests](#comprehensive-system-tests) section
below.

```bash
# Python bridge system-test harness — builds the app if needed, brings up the
# named Docker fixtures, then runs pytest
./scripts/test-system-py.sh --debug -k ssh -x -s
./scripts/test-system-py.sh --fixtures "ssh-password ssh-keys" -m integration -k ssh

# Per-machine orchestration (unit + Rust integration tests against Docker infra)
./scripts/test-system-linux.sh
./scripts/test-system-windows.sh
```

Selectors and UI-driving verbs live in the harness mixins (`tests/system/`); the
bridge dispatcher in `src/testbridge/` exposes the DOM to those verbs. New E2E
coverage is written as `pytest` tests there, not as native WebView specs.

The dispatcher is otherwise **DOM-only**, so UI that renders solely from a
backend-originated event needs `driver.emit_event(event, payload)` — a
test-mode-gated verb that injects a Tauri event through the real event bus, so
the app's own `listen` subscriptions and store-folding hooks still run. See
[Injecting backend events](test-bridge.md#injecting-backend-events-emitevent)
for the gating and payload rules.

## 2. Component Integration Tests

**What it does**: Tests React components with backend integration
**Use for**: Terminal component, connection settings, file browser

### Setup (Vitest + React Testing Library)

```bash
npm install --save-dev \
  vitest \
  @testing-library/react \
  @testing-library/user-event \
  @testing-library/jest-dom \
  @vitest/ui
```

### Example Component Test

```typescript
// src/components/Terminal/Terminal.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Terminal } from './Terminal';
import { mockIPC } from '@tauri-apps/api/mocks';

describe('Terminal Component', () => {
  beforeEach(() => {
    // Mock Tauri IPC
    mockIPC((cmd, args) => {
      if (cmd === 'create_terminal') {
        return Promise.resolve('session-123');
      }
      if (cmd === 'send_input') {
        return Promise.resolve();
      }
      return Promise.reject('Unknown command');
    });
  });

  it('renders terminal and accepts input', async () => {
    render(<Terminal sessionId="test-session" />);

    const terminal = screen.getByTestId('terminal-viewport');
    expect(terminal).toBeInTheDocument();

    // Simulate typing
    await userEvent.type(terminal, 'ls -la{Enter}');

    // Verify input was sent to backend
    await waitFor(() => {
      expect(mockIPC).toHaveBeenCalledWith('send_input', {
        sessionId: 'test-session',
        data: expect.stringContaining('ls -la')
      });
    });
  });

  it('handles terminal resize correctly', async () => {
    const { container } = render(<Terminal sessionId="test-session" />);

    // Simulate window resize
    window.innerWidth = 1920;
    window.innerHeight = 1080;
    window.dispatchEvent(new Event('resize'));

    await waitFor(() => {
      const terminal = container.querySelector('.xterm-viewport');
      expect(terminal).toHaveStyle({ width: '100%' });
    });
  });
});
```

### Running Component Tests

```bash
# Run all component tests
pnpm test

# Watch mode (during development)
pnpm test:watch

# With UI (visual test runner)
pnpm test:ui

# Coverage report
pnpm test:coverage
```

## 3. Rust Backend Tests

**What it does**: Unit and integration tests for Rust code
**Use for**: Terminal backends, SSH logic, serial port handling

### Example Rust Test

```rust
// src-tauri/src/terminal/local_shell.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shell_detection() {
        let shells = detect_available_shells();
        assert!(!shells.is_empty(), "Should detect at least one shell");
    }

    #[tokio::test]
    async fn test_local_shell_spawn() {
        let config = ShellConfig {
            shell_type: ShellType::Bash,
        };

        let mut backend = LocalShell::new(config).unwrap();
        let session_id = backend.spawn().await.unwrap();

        assert!(!session_id.is_empty());
    }

    #[tokio::test]
    async fn test_terminal_input_output() {
        let mut backend = LocalShell::new(ShellConfig::default()).unwrap();
        backend.spawn().await.unwrap();

        // Send command
        backend.send_input(b"echo test\n").await.unwrap();

        // Read output
        let output = backend.read_output().await.unwrap();
        assert!(String::from_utf8_lossy(&output).contains("test"));
    }
}
```

### Running Rust Tests

```bash
cd src-tauri

# Run all tests
cargo test

# Run specific test
cargo test test_shell_detection

# Run with output
cargo test -- --nocapture

# Run in parallel
cargo test -- --test-threads=4
```

## 4. Visual Regression Testing (Optional)

**What it does**: Detects unintended UI changes
**Use for**: Ensuring UI consistency across updates

### Setup with Playwright

```bash
npm install --save-dev @playwright/test
```

### Example Visual Test

```javascript
// tests/visual/terminal.spec.js
import { test, expect } from "@playwright/test";

test("terminal UI should match baseline", async ({ page }) => {
  await page.goto("http://localhost:1420");

  // Wait for app to load
  await page.waitForSelector('[data-testid="terminal-view"]');

  // Take screenshot and compare
  await expect(page).toHaveScreenshot("terminal-view.png", {
    maxDiffPixels: 100, // Allow small differences
  });
});
```

## Test Data Attributes

**Critical**: Add `data-testid` attributes to all interactive elements!

### In React Components

```tsx
// Good
<button
  data-testid="new-connection-btn"
  onClick={handleNewConnection}
>
  New Connection
</button>

// Better (dynamic IDs)
<div data-testid={`connection-${connection.id}`}>
  {connection.name}
</div>

// Best (multiple selectors)
<input
  data-testid="ssh-host-input"
  aria-label="SSH Host"
  name="host"
  type="text"
/>
```

### Naming Convention

```
data-testid="<component>-<element>-<action>"

Examples:
- terminal-tab-close
- connection-list-item
- settings-ssh-host-input
- file-browser-upload-btn
```

## CI Integration

The system/E2E suite runs in **two lanes**, split so per-PR CI stays fast while
the app-launching suites still run on a cadence:

- **Per-PR — collection + non-integration** ([`code-quality.yml`](../.github/workflows/code-quality.yml) → _System-Test Harness_). Every PR runs the bridge harness with `-m "not integration"`, so it proves the harness _collects_ all ~360 tests and the non-integration checks pass. It deliberately does **not** launch the built app or bring up Docker, keeping the check quick.
- **Nightly — integration lane on all three platforms** ([`system-integration.yml`](../.github/workflows/system-integration.yml)). A scheduled + `workflow_dispatch` job builds the app (debug) and runs `-m integration`, which launches the **real per-platform build** and drives it through the bridge. Because the bridge needs no `tauri-driver`/WKWebView driver, this lane carries **Linux, macOS, and Windows** legs (#804/#1649) — macOS app-UI integration testing that used to be manual-only now runs in CI.

The lane runs the app natively on each OS; only the **Docker fixtures** are
Linux-only:

| Leg                            | App launch + UI suites            | Docker-fixture suites (SSH/telnet/serial/agent)                            |
| ------------------------------ | --------------------------------- | -------------------------------------------------------------------------- |
| **Linux** (`ubuntu-latest`)    | Run headless under Xvfb           | Run — Docker Compose fixtures brought up in-job                            |
| **macOS** (`macos-latest`)     | Run natively (WKWebView, no Xvfb) | **Self-skip** — hosted runner has no Linux Docker daemon                   |
| **Windows** (`windows-latest`) | Run natively (WebView2, no Xvfb)  | **Self-skip** — runner's Docker daemon runs Windows, not Linux, containers |

The fixture-backed suites `pytest.skip()` cleanly when no Docker runtime is
present (`conftest.py` → `docker_compose`), so a macOS/Windows leg is green on
the coverage it _can_ run rather than failing on fixtures it cannot reach. This
Docker-daemon boundary is the same one behind the [SSH-tunnel macOS
carve-out](#ssh-tunnel-startstop-on-macos-manual-carve-out-933) and ADR-5.

### Windows Agent CI Coverage

The remote agent (`agent/`) is built and tested on Windows via dedicated CI jobs:

- **Build + test** ([`agent.yml`](../.github/workflows/agent.yml)): the `build-windows` job runs on `windows-latest`, builds the agent for `x86_64-pc-windows-msvc` (native MSVC — cross-rs cannot build the MSVC ABI), and runs `cargo test -p termihub-agent -p termihub-core --all-features`. The full workspace test suite also runs on `windows-latest` via the [`code-quality.yml`](../.github/workflows/code-quality.yml) `tests` matrix.
- **Release artifact** ([`release.yml`](../.github/workflows/release.yml)): the `agent-binaries-windows` job ships `termihub-agent-windows-x64.exe` alongside the Linux and macOS agent binaries on every tagged release.

> **Platform caveat (ADR-5):** the Python bridge system-test harness runs on all three OSes, but its Docker-backed **infrastructure** fixtures (SSH/telnet/serial containers) run against a Linux Docker daemon, and the smoke test's UI checks use `tauri-driver`, which has no macOS WKWebView driver. Windows **agent** verification is therefore limited to unit/integration tests (the jobs above) plus the manual tests in [`tests/manual/remote-agent.yaml`](../tests/manual/remote-agent.yaml). There is no automated end-to-end coverage of the Windows agent over a live SSH connection.

## Coverage Goals

Target coverage levels:

- **Rust Backend**: >80% line coverage
- **React Components**: >70% coverage
- **E2E Critical Paths**: 100% (all main user flows)

## Testing Best Practices

### 1. Test Pyramid

```
        /\
       /  \     Few E2E tests (slow, expensive)
      /____\
     /      \   More integration tests
    /________\
   /          \ Many unit tests (fast, cheap)
  /____________\
```

**Ratio**: ~70% Unit, ~20% Integration, ~10% E2E

### 2. Test Naming

```javascript
// Good
it("should create local bash terminal when user clicks new connection");

// Bad
it("test1");
```

### 3. AAA Pattern (Arrange, Act, Assert)

```javascript
it("should send terminal input to backend", async () => {
  // Arrange
  const terminal = render(<Terminal sessionId="123" />);
  const input = "echo test";

  // Act
  await userEvent.type(terminal, input);

  // Assert
  expect(mockBackend.sendInput).toHaveBeenCalledWith(input);
});
```

### 4. Isolate Tests

- Each test should be independent
- Clean up after tests (close connections, clear state)
- Use beforeEach/afterEach hooks

### 5. Mock External Dependencies

```typescript
// Mock Tauri APIs
vi.mock("@tauri-apps/api/tauri", () => ({
  invoke: vi.fn(),
}));

// Mock file system
vi.mock("@tauri-apps/api/fs", () => ({
  readTextFile: vi.fn().mockResolvedValue("mock content"),
}));
```

### 6. Component-test timeout (Windows CI flake, #1025)

The global Vitest `testTimeout` is raised to **15000ms** in `vitest.config.ts`
(the default is 5000ms). The React-DOM `createRoot` component tests are otherwise
instant — immediately-resolving mocks, no real timers — but the `windows-latest`
CI runner has been observed spending 240s+ on environment setup alone, starving
those tests enough to trip the 5s default (originally seen in
`HttpMonitorPanel.race.test.tsx`). The larger budget absorbs that runner jitter
without masking genuine hangs. If a test legitimately needs to run longer, prefer
a per-`it` override (`it("…", async () => { … }, 30000)`) over lowering the global.

## Test Scripts for package.json

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest run --coverage",
    "test:visual": "playwright test"
  }
}
```

System / E2E tests are not a `package.json` script — they run through the Python
bridge harness via `./scripts/test-system-py.sh` (see
[tests/system/README.md](../tests/system/README.md)).

## Debugging Tests

### System-harness debugging

Run the Python harness with `--debug` to keep the app window visible and stream
bridge traffic, and pass pytest flags through for a single test:

```bash
./scripts/test-system-py.sh --debug -k terminal_creation -x -s
```

### Vitest UI

```bash
pnpm test:ui
```

Opens interactive test runner in browser with:

- Live test results
- Component inspection
- Coverage visualization

### VS Code Integration

Install the recommended VS Code extensions (already configured in `.vscode/extensions.json`):

- **Vitest**: Run and debug tests from the editor with inline results
- **Test Explorer UI**: Visual test tree in the sidebar

## Performance Testing

termiHub includes an automated performance test suite that validates 40 concurrent terminals, running on the cross-platform Python bridge harness:

```bash
# Run the performance suite (requires a built app; runs on all platforms)
TERMIHUB_TEST_APP_BINARY=<path-to-built-app> \
  ./tests/system/pytest.sh tests/test_performance.py -s
```

The suite (`tests/system/tests/test_performance.py`) covers:

- **PERF-01**: Create 40 terminals via the toolbar, verify tab count, log creation throughput
- **PERF-02**: Tab-switch latency to the first / middle / last tab with 40 open (each <2s)
- **PERF-03**: Terminal input still works with 40 open, and the 41st terminal opens promptly (<5s)
- **PERF-04**: Cleanup after closing all terminals, log close timing

The JS-heap check from the original WebdriverIO suite is dropped — it read a Chromium-only `performance.memory` metric via `browser.execute`, which the cross-platform bridge has no verb for (tracked back to #800).

For detailed profiling instructions, baseline metrics, and memory leak detection, see the [Performance Profiling section in Contributing](contributing.md#performance-profiling).

## Accessibility Testing

```javascript
import { axe, toHaveNoViolations } from "jest-axe";
expect.extend(toHaveNoViolations);

it("should have no accessibility violations", async () => {
  const { container } = render(<Terminal />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

## Comprehensive System Tests

termiHub includes a comprehensive test infrastructure with a Docker container fleet (SSH variants, jump-host, telnet, serial, SFTP stress, network fault injection, and more) and Rust integration tests that exercise the app's backends directly. See the [concept document](concepts/implemented/comprehensive-test-infrastructure.html) for the full design.

### Quick Start

```bash
# Start all containers (Docker or Podman — auto-detected)
docker compose -f tests/docker/docker-compose.yml up -d
# Or with Podman:
podman compose -f tests/docker/docker-compose.yml up -d

# Run all Rust integration tests
cargo test -p termihub-core --all-features -- --nocapture

# Run a specific test suite
cargo test -p termihub-core --all-features --test ssh_auth -- --nocapture

# Include fault injection tests (requires fault profile)
docker compose -f tests/docker/docker-compose.yml --profile fault up -d
cargo test -p termihub-core --all-features --test network_resilience -- --nocapture --test-threads=1

# Include SFTP stress tests (requires stress profile)
docker compose -f tests/docker/docker-compose.yml --profile stress up -d
cargo test -p termihub-core --all-features --test sftp_stress -- --nocapture

# Include the VNC servers (requires vnc profile) + drive the vnc backend.
# The vnc profile brings up BOTH the plain VncAuth server (vnc-server) and the
# VeNCrypt X509 TLS server (vnc-vencrypt-server), which the full suite needs.
docker compose -f tests/docker/docker-compose.yml --profile vnc up -d
cargo test -p termihub-core --features vnc --test vnc -- --nocapture

# Include the FTP/FTPS server (requires ftp profile) + backend-independent smoke
docker compose -f tests/docker/docker-compose.yml --profile ftp up -d --wait ftp-server
bash tests/docker/ftp-server/smoke-test.sh   # lists /pub over plain/explicit/implicit FTPS

# Stop all containers
docker compose -f tests/docker/docker-compose.yml --profile all down
```

> **Podman users:** The test system scripts auto-detect Podman when Docker is not available.
> You can also force a specific runtime: `CONTAINER_CMD=podman ./scripts/test-system-linux.sh`

### Test Suites

| Suite                  | File                                                | Docker Containers                                         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH Auth               | `core/tests/ssh_auth.rs`                            | ssh-password:2201, ssh-keys:2203                          | Password, 6 key types, 5 passphrase keys, wrong credentials, wrong passphrase                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| SSH Compat             | `core/tests/ssh_compat.rs`                          | ssh-legacy:2202                                           | Legacy OpenSSH 7.x compatibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SSH Advanced           | `core/tests/ssh_advanced.rs`                        | bastion:2204, restricted:2205, tunnel:2207                | Jump host, restricted shell, TCP tunneling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| SSH Banner             | `core/tests/ssh_banner.rs`                          | ssh-banner:2206, ssh-password:2201                        | Pre-auth banner text, no-banner on standard server, banner on failed auth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Telnet                 | `core/tests/telnet.rs`                              | telnet:2301                                               | Connect, output subscribe, login flow                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| VNC                    | `core/tests/vnc.rs`                                 | vnc-server:2501, vnc-vencrypt-server:2502 (profile `vnc`) | Live RFB path of the `vnc` graphical backend against real servers serving a static four-quadrant pattern. **Plain VncAuth** (vnc-server, x11vnc, #1681/#1713): connect + VncAuth, decode a real framebuffer end to end (asserts each quadrant's colour), input/clipboard round-trip over the wire, wrong-password rejection. **VeNCrypt X509 over TLS** (vnc-vencrypt-server, TigerVNC Xvnc, #1714/#1770): connect + decode with `tlsVerify=insecure` (accept self-signed) and `tlsVerify=ca` (trust the fixture CA), exercising the vendored `vnc-rs` fork's VeNCrypt X509Vnc negotiate → TLS handshake → VNC-password → decode path against a real server. Requires the `vnc` compose profile; ports via `TERMIHUB_TEST_VNC_PORT` (default 2501) / `TERMIHUB_TEST_VNC_VENCRYPT_PORT` (default 2502) — see [Parallel test isolation](#parallel-test-isolation) |
| SFTP Stress            | `core/tests/sftp_stress.rs`                         | sftp-stress:2210                                          | Large files, deep trees, symlinks, special filenames, permissions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Network Resilience     | `core/tests/network_resilience.rs`                  | network-fault:2209                                        | Latency, packet loss, throttle, disconnect, jitter, corruption                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Monitoring             | `core/tests/monitoring.rs`                          | ssh-password:2201                                         | CPU, memory, disk stats, stats under load                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Agent Deploy SFTP      | `src-tauri/src/utils/remote_exec.rs`                | ssh-password:2201                                         | Uploads a file over SFTP and reads it back, exercising the agent auto-deploy `block_in_place` path from `spawn_blocking` (#828/#837). In the desktop crate: `cargo test -p termihub --lib agent_deploy`. Pinned to password auth; port via `TERMIHUB_TEST_SSH_PASSWORD_PORT` (default 2201) — see [Parallel test isolation](#parallel-test-isolation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Elevated Save SFTP     | `src-tauri/src/files/sftp.rs`                       | ssh-sudo:2212, ssh-nosudo:2213                            | Live `SftpSession::write_file_content_elevated` over real SSH (#1494/#1328): correct password → `Success` (root-owned file rewritten, owner/mode preserved), wrong password → `IncorrectPassword`, no-sudo → `Other`; every path confirms no `/tmp/termihub-*` temp leaks. In the desktop crate: `cargo test -p termihub --lib elevated_save`. Ports via `TERMIHUB_TEST_SSH_SUDO_PORT` (2212) / `TERMIHUB_TEST_SSH_NOSUDO_PORT` (2213) — see [Parallel test isolation](#parallel-test-isolation)                                                                                                                                                                                                                                                                                                                                                                |
| Agent Self-Update      | `agent/tests/self_update_integration.rs`            | alpine (one case; self-managed)                           | Live-agent self-update auto-apply-on-idle (#1401/#1534): a real `--allow-self-update` child agent polls a `wiremock` GitHub mock, driving poll -> download -> SHA-256-verify -> binary-swap -> re-exec. Asserts the deferred apply re-execs and returns, the `coordinated` gate stages without applying, an active session (shell + real Docker) is never cut, and a failed apply keeps `pending_update`. Unix-only; Docker case skips it.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Deferred Update Hook   | `agent/tests/deferred_update_hook_integration.rs`   | none                                                      | The env-gated pending-update hook (#1546) against a real child `--listen` agent: armed, it announces `agent.update_available` on attach (and on every re-attach) and makes `agent.request_deferred_update` take the **deferred/busy** branch with an active session; unarmed, it stages nothing, announces nothing, and rejects the apply. Also pins that the hook can never swap the agent binary. No Docker and no network. Unix-only. See [Agent deferred-update E2E hook (#1546)](#agent-deferred-update-e2e-hook-1546)                                                                                                                                                                                                                                                                                                                                     |
| Docker Deferred Update | `agent/tests/docker_deferred_update_integration.rs` | alpine (self-managed)                                     | The deferred-update apply-on-last-disconnect cycle (#1519) driven through the `agent.request_deferred_update` RPC against a real **Docker** container session: staging a real newer binary while the session is busy **defers** (`applied: false`) and leaves the binary untouched; closing the last session performs a genuine **binary swap + re-exec** and the agent returns on the same port; the successful apply leaves no `pending_update` (#1551). The missing intersection of the self-update (idle-poll swap) and hook (never-swap) suites. Unix-only; skips when Docker is unavailable.                                                                                                                                                                                                                                                              |
| SSH Banner (system)    | `tests/system/tests/test_ssh_banner.py`             | ssh-banner:2206                                           | Pre-auth banner / MOTD display (ported from `ssh-banner.test.js`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SSH Keys (system)      | `tests/system/tests/test_ssh_keys.py`               | ssh-keys:2203                                             | Key-based auth flows (ported from `ssh-keys.test.js`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| SSH Infra (system)     | `tests/system/tests/test_ssh.py`                    | ssh-password:2201, ssh-keys:2203                          | Password/key auth, password-prompt modal, connection failure, session output, monitoring show/hide (ported from `ssh.test.js`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Win Shells (system)    | `tests/system/tests/test_windows_shells.py`         | none                                                      | PowerShell / cmd.exe selection, rendering, input, the shell selector, and WSL sessions (cwd / `/mnt` path translation). Windows-only; WSL cases skip without WSL2 (ported from `windows-shells.test.js`, #975)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Skip Behavior

All Rust integration tests use the `require_docker!` macro which checks TCP port connectivity at runtime. If the required Docker container is not running, the test prints a message and returns early (no failure). This means you can run `cargo test` without Docker and only the tests requiring containers will be skipped.

#### Agent deferred-update E2E hook (#1546)

The desktop's agent-update banner has two branches, and the **agent** decides
which one a test sees: with sessions open, "Apply Now" is _deferred_; idle, it
applies. A live agent under test never took the deferred branch, because it never
held a `pending_update` — `state.json` is read once at startup, the only runtime
seeder is `#[cfg(test)]` (so absent from the shipped binary), a staged update is
not replayed on attach, and the real signal comes only from the 24-hour
self-update timer behind `--allow-self-update`.

`TERMIHUB_AGENT_TEST_PENDING_UPDATE` closes that gap. Set it on the agent process
and the agent stages a `pending_update` at startup and emits an
`agent.update_available` notification to **every** client that attaches — the
same notification, over the same channel, as a real self-update detection:

| Variable                                    | Value                                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `TERMIHUB_AGENT_TEST_PENDING_UPDATE`        | The version to advertise (e.g. `1.2.3`), or `1`/`true`/`yes` for the default `99.99.99`. Unset, empty, `0`/`false`/`no` → hook disarmed. |
| `TERMIHUB_AGENT_TEST_PENDING_UPDATE_BINARY` | Optional. Path recorded as the staged binary. **Only set this if you want a real binary swap** — see below.                              |

Notes worth knowing before you use it:

- **Test-only, and env-only.** Deliberately not a CLI flag, so it can never
  appear in `--help` or in a desktop-built SSH exec command. Unset, the agent's
  behaviour is unchanged and the code path is never entered.
- **It does not swap the binary.** The default staged path points at a file the
  agent never writes. A `pending_update` is live — closing the last session fires
  a real deferred apply — so this matters: the apply fails, logs, and keeps the
  record (#1401), and the agent keeps running. Point
  `…_BINARY` at a real binary only if a swap + re-exec is what you are testing.
- **It survives an agent restart.** The #1551 startup sweep drops a
  `pending_update` the running agent has already applied. The default version is
  newer than any real release and the staged path cannot match the running
  executable, so both of that sweep's tests agree the record is unapplied and it
  is kept. Override the version with something _not_ newer than the agent and you
  opt out of this: the sweep will correctly drop it on the next startup.

`agent/tests/deferred_update_hook_integration.rs` drives all of the above against
a real child agent, including the unarmed (production) case.

The desktop-UI consumer is `tests/system/tests/test_agent_update_apply_now_live.py`
(#1520): it arms a **dedicated** deployed-agent container,
`remote-agent-pending-update` (compose profile `agent`, host port 2214), by
building the `remote-agent` image with `PENDING_UPDATE_VERSION` set — which bakes
`PermitUserEnvironment yes` and `~testuser/.ssh/environment` so the env var reaches
the desktop-launched `termihub-agent --stdio` process (the var can never be a CLI
flag). It is a separate service from `remote-agent` on purpose: the on-attach
update announcement would otherwise surface a banner in the banner-_surfacing_
suite, whose gating tests assert none appears until they announce one.

#### Python system-test harness — cross-platform shells (#886)

The local UI system suites author and clean up files **through the terminal**, and on Windows the local-shell backend defaults to **PowerShell** (no `printf`/`rm -f`/`touch`). File authoring/cleanup therefore goes through `ShellCommands` / `ShellFsUi` (`tests/system/termihub_harness/shell.py`), which emits the POSIX **or** PowerShell command for the host's default shell — so `test_editor.py` and the file-authoring half of `test_file_browser_local.py` run on every platform.

The cwd/`pwd`/path checks are cross-platform too (#902): `ShellCommands` builds the `pwd`-equality markers (POSIX `[ "$(pwd)" = … ]` vs PowerShell `if ((Get-Location).Path -eq …)`), supplies per-platform scratch directories for the cwd-following tests (`/tmp`,`/etc` vs `$env:TEMP`,`$env:WINDIR`) and starting-directory values, and `is_absolute_path()` accepts a POSIX root, a Windows drive, or a UNC path — so `test_local_shell.py` and the cwd-aware `test_file_browser_local.py` tests run on every platform with no `@skip_on_windows` gate.

### Parallel Test Isolation

Several checkouts of termiHub can run **all** of their test environments at the
same time on one machine — the full Docker container set, the Python bridge
harness, the Rust integration tests, the serial fixtures, and the E2E driver —
without any cross-checkout side effects. Every shared host resource (container
names, published ports, Docker networks, the `tauri-driver` port, the virtual
serial device paths) is derived from a single per-checkout config file so two
checkouts never contend for the same resource.

#### Disk cost per checkout

Ports and container names are isolated, but **disk is shared** — it is what
actually caps how many checkouts fit on one machine. Each checkout carries its
own `target/`, and nothing is shared between them. Measured on macOS
(aarch64, rustc 1.93) with the workspace `[profile.dev] debug = 0` set in the
root `Cargo.toml`:

| Checkout state                                   | `target/debug` |
| ------------------------------------------------ | -------------- |
| Cold (never built)                               | 0              |
| After `cargo build --workspace` (or `setup.sh`)  | **3.3 GB**     |
| After the test binaries are built (`cargo test`) | **5.0 GB**     |

So budget **~5 GB per checkout** — a primed-but-untested checkout starts at
3.3 GB and grows toward 5 GB as soon as its suites run. Five parallel checkouts
need ~25 GB of free disk, ten need ~50 GB.

> Without the `[profile.dev]` setting these were **6.7 GB / 9.4 GB** — Cargo's
> default `debug = true` emits full DWARF for every crate in the dependency
> graph ([#1537](https://github.com/armaxri/termiHub/issues/1537)).
>
> `debug = 0` is a deliberate trade: dev/test builds emit **no debug info**, so
> a panic backtrace names its frames but gives **no file/line for them**. The
> panic site itself is still reported with file and line — that comes from
> `#[track_caller]`, not from debug info — so a failing test still points at
> where it blew up. If you need full backtraces or a step-debugger for a
> session, build with `RUSTFLAGS="-C debuginfo=2"` (or `=1` for file/line
> only); the disk cost above then reverts for that checkout.

Two things worth knowing before provisioning N checkouts:

- **A cold checkout pulls its whole `target/` the first time anything builds
  it** — including the first time a test run builds it. Several cold checkouts
  can therefore exhaust the disk mid-run and fail builds in **every** checkout
  at once, including ones that were already working. If builds start failing
  across unrelated checkouts, check free space before reading any diff.
- **Reclaim with `cargo clean`** in an idle checkout (at the cost of a full
  rebuild). Never `git clean -xfd` — `dev.local.json` is gitignored, so that
  would delete this checkout's isolation config (see below).

#### Setup

Each checkout owns a gitignored `dev.local.json`. Create it from the committed
template and edit the values:

```bash
cp default.dev.local.json dev.local.json
```

| Key                | Default    | Purpose                                                                                                                                                       |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev_port`         | `1420`     | Vite dev-server port (HMR uses `dev_port + 1`). Honoured by `./scripts/dev.sh` **and** by a bare `pnpm tauri dev`.                                            |
| `dev_agent_port`   | `2222`     | Local `sshd` port `./scripts/dev.sh` starts for the dev agent (Unix only). **Only `dev.sh` starts it** — `pnpm tauri dev` does not.                           |
| `dev_name`         | —          | Label for the dev-agent connection entry in the termiHub sidebar (optional).                                                                                  |
| `compose_project`  | `termihub` | Docker Compose project name for the test containers. Namespaces every **container, network and volume**, so parallel checkouts never share a container.       |
| `test_port_offset` | `0`        | Integer added to **every** published / looked-up test infrastructure port. Keep it a multiple of `1000` and unique per checkout so port ranges never overlap. |

Every key is optional. An **omitted** key (or no `dev.local.json` at all) falls
back to the default above — which reproduces the historical single-checkout
behaviour exactly (project `termihub`, ports `2201…`, etc.), so CI and a lone
checkout need no config.

#### Recommended per-checkout values

Give each parallel checkout a distinct row:

| Checkout | `dev_port` | `dev_agent_port` | `compose_project` | `test_port_offset` |
| -------- | ---------- | ---------------- | ----------------- | ------------------ |
| dev0     | `1420`     | `2222`           | `termihub-test-0` | `0`                |
| dev1     | `1430`     | `2232`           | `termihub-test-1` | `1000`             |
| dev2     | `1440`     | `2242`           | `termihub-test-2` | `2000`             |
| dev3     | `1450`     | `2252`           | `termihub-test-3` | `3000`             |

Note the different step per key: `test_port_offset` jumps by **1000** (it is
added to _every_ base test port; the scheme is collision-free **not** because
`1000` exceeds the `2201…8080` base-port span — it does not — but because no two
base ports differ by an exact multiple of `1000`, so no checkout's offset port
ever lands on another checkout's. Keep that invariant in mind when adding a base
port); `dev_port` and
`dev_agent_port` step by **10** (`dev_port` reserves `dev_port + 1` for Vite HMR);
and `compose_project` just increments its numeric suffix (a name, not a port
range). With offset `1000` the SSH containers move to `3201…3211`, telnet to
`3301`, and the network-tools HTTP target to `9080`; offset `2000` moves them to
`4201…`, `4301`, `10080`; offset `3000` to `5201…`, `5301`, `11080`.

Rather than hand-editing values, copy a ready-made row from the committed
examples — one fully-filled, non-colliding file per checkout:

```bash
cp examples/dev0.dev.local.json dev.local.json   # or dev1 / dev2 / dev3
```

#### Running the app in a parallel checkout

Both launch paths honour this checkout's `dev_port`, so neither one collides
with checkout 0's dev server:

```bash
./scripts/dev.sh     # preferred
pnpm tauri dev       # same dev port, but no dev agent
```

Prefer **`./scripts/dev.sh`**. It is the only one that also starts this
checkout's `dev_agent_port` `sshd` and registers the dev-agent connection, frees
a stale `dev_port`, and takes a one-off port override (`./scripts/dev.sh 1499`).

`pnpm tauri dev` is isolated by construction rather than by convention
([#1588](https://github.com/armaxri/termiHub/issues/1588)): it routes through
`scripts/internal/tauri.mjs`, which resolves `dev_port` and merges a matching
`build.devUrl` over the static `http://localhost:1420` in `tauri.conf.json`.
Both halves have to agree — Vite binds the port, Tauri loads the URL — so the
wrapper and `vite.config.ts` read the same resolver. Before that, `pnpm tauri dev`
bound **1420 in every checkout**, silently squatting on checkout 0's dev server;
it only ever failed loudly when something already held the port.

#### What is isolated, and how

`dev.local.json` resolves into a canonical set of environment variables that
every entry point honours. The resolver lives in three mirrored forms:

- **Shell:** `scripts/internal/dev-local-env.sh` — sourced by `test.sh`,
  `test-system*.sh`, and the E2E runner; exports `COMPOSE_PROJECT_NAME`,
  `TERMIHUB_TEST_PORT_OFFSET`, the per-service `TERMIHUB_TEST_*_PORT` values, the
  serial device paths, and `TERMIHUB_TAURI_DRIVER_PORT`.
- **Python:** `termihub_harness.dev_local` — read by the bridge-harness Docker
  fixtures so the harness publishes/looks up the same offset ports and runs
  `compose` under the same project name.
- **Node:** `scripts/internal/dev-local.mjs` — read by `vite.config.ts` and the
  `pnpm tauri` wrapper to resolve `dev_port`.

All three apply the same precedence: an explicit **environment variable** wins,
then the `dev.local.json` key, then the built-in default. So `dev.sh` keeps
overriding via `TERMIHUB_DEV_PORT`, and a checkout with no `dev.local.json` — a
fresh clone, or CI — behaves exactly as it always did.

| Resource                         | Base (offset 0)                     | Derivation                                                                    |
| -------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| Docker container / network names | `termihub-*` / `termihub-*-net`     | Prefixed with `compose_project` (`COMPOSE_PROJECT_NAME`).                     |
| SSH / telnet / HTTP host ports   | `2201–2213`, `2301`, `8080`         | `base + test_port_offset`, published by `tests/docker/docker-compose.yml`.    |
| VNC host ports                   | `2501` (VncAuth), `2502` (VeNCrypt) | `base + test_port_offset`, published by `tests/docker/docker-compose.yml`.    |
| FTP / FTPS host ports            | `2401`, `2402`, PASV `30000–30019`  | `base + test_port_offset`, published by `tests/docker/docker-compose.yml`.    |
| Quick-start (E2E) host ports     | `2214` (SSH), `2323` (telnet)       | `base + test_port_offset`, published by `examples/docker/docker-compose.yml`. |
| SSH-tunnel test ports            | `18081–18088`                       | `base + test_port_offset`.                                                    |
| Virtual serial device paths      | `/tmp/termihub-serial-{a,b}`        | Suffixed with `compose_project`.                                              |
| `tauri-driver` (E2E) port        | `4444`                              | `4444 + test_port_offset`.                                                    |

The Rust integration tests reach the jump-host target through its **Compose
service-name network alias** (`ssh-jumphost-target`, `ssh-jumphost-bastion`),
which is stable across projects, and the network-fault container is addressed via
`compose exec` under the active project — so namespacing the containers does not
break them.

#### Verifying isolation

```bash
# Render the compose file with a checkout's project + offset applied:
COMPOSE_PROJECT_NAME=termihub-test-1 TERMIHUB_TEST_SSH_PASSWORD_PORT=3201 \
  docker compose -f tests/docker/docker-compose.yml config | grep -E 'name:|published'

# Bring this checkout's isolated containers up / down (the scripts do this for you):
docker compose -p termihub-test-1 -f tests/docker/docker-compose.yml up -d ssh-password
docker compose -p termihub-test-1 -f tests/docker/docker-compose.yml down
```

#### Note: sharing vs. isolating containers

The **Agent Deploy SFTP** test
(`agent_deploy_sftp_upload_round_trips_over_real_ssh`) targets the `ssh-password`
container on `TERMIHUB_TEST_SSH_PASSWORD_PORT` (default `2201`, or `2201 +
test_port_offset` once the resolver is sourced). It self-skips when that port is
unreachable, and every upload uses a UUID-suffixed remote path, so even checkouts
that **share** one container never collide on the remote `/tmp` file. With a
per-checkout `test_port_offset` each checkout instead gets its **own** container,
which is required for the mutating fixtures — e.g. the network-fault tests apply
`tc` qdisc faults to the whole container, so two checkouts must not share it.

> The per-checkout `dev_agent_port` `sshd` that `./scripts/dev.sh` starts is **not**
> used by the agent-deploy test: it is key-auth only (`PasswordAuthentication no`),
> so it is incompatible with the password-auth path the test pins to.

### Per-Machine Test Scripts

Platform-specific orchestration scripts that start Docker containers, run all applicable tests, and tear down infrastructure:

```bash
# macOS (unit + Rust integration tests)
./scripts/test-system-mac.sh
./scripts/test-system-mac.sh --with-all --keep-infra

# Linux (unit + Rust integration tests)
./scripts/test-system-linux.sh
./scripts/test-system-linux.sh --with-fault --with-stress

# Windows (via WSL or Git Bash)
./scripts/test-system-windows.sh
```

> UI/infrastructure E2E coverage moved to the Python bridge harness — run it
> with [`./scripts/test-system-py.sh`](../scripts/test-system-py.sh) (see
> [tests/system/README.md](../tests/system/README.md)).

Common flags: `--skip-build`, `--skip-unit`, `--skip-serial`, `--with-fault`, `--with-stress`, `--with-all`, `--keep-infra`.

### Network Resilience Tests

The network resilience suite (`network_resilience.rs`) must run single-threaded because tests modify shared container state via `docker exec`:

```bash
cargo test -p termihub-core --all-features --test network_resilience -- --nocapture --test-threads=1
```

Each test uses a `FaultGuard` that automatically resets faults on drop (including panics).

## Smoke Testing

The smoke test script (`scripts/smoke-test.sh` / `.cmd`) provides a quick post-install verification that the built app launches, renders its UI, and shuts down cleanly. It is intended to run after `pnpm tauri build` or after installing a release binary.

### Usage

```bash
# Linux — built binary
./scripts/smoke-test.sh ./src-tauri/target/release/termihub

# macOS — installed app bundle
./scripts/smoke-test.sh /Applications/termiHub.app

# Windows — built binary
scripts\smoke-test.cmd src-tauri\target\release\termihub.exe
```

### What It Checks

| Check | Description            | Linux/Windows (WebDriver)                | Linux/Windows (fallback) | macOS                  |
| ----- | ---------------------- | ---------------------------------------- | ------------------------ | ---------------------- |
| 1     | App launches           | WebDriver session create                 | Process start            | `open` + pgrep         |
| 2     | Window/UI visible      | Activity bar element found               | Process stable after 10s | osascript window query |
| 3     | Create local shell     | Click new-connection, fill form, connect | Skipped                  | Skipped                |
| 4     | Terminal I/O           | Send `echo smoke-test-ok`, verify output | Skipped                  | Skipped                |
| 5     | Open Settings          | Click activity-bar-settings              | Skipped                  | Skipped                |
| 6     | Open connection editor | Click new-connection button              | Skipped                  | Skipped                |
| 7     | Clean shutdown         | WebDriver session delete                 | SIGTERM + verify exit    | osascript quit         |

### Platform Details

- **Linux/Windows with tauri-driver**: Full 7-check suite using W3C WebDriver protocol via `curl` (no Node.js required). Requires `tauri-driver` installed (`cargo install tauri-driver`).
- **Linux/Windows without tauri-driver**: Falls back to process-based checks — verifies app launches, stays alive, and exits cleanly. UI interaction checks (3-6) are skipped.
- **macOS**: Uses `osascript` for window verification. UI interaction checks (3-6) are skipped because tauri-driver does not support macOS (no WKWebView driver). See [E2E platform constraint](testing.md#platform-support).

## Related Documentation

- [Contributing](contributing.md) — Development setup, building, workflow, coding standards, and performance profiling
- [Test bridge protocol](test-bridge.md) — how the Python harness drives the app
- [Tauri Testing Guide](https://tauri.app/v1/guides/testing/)
- [React Testing Library](https://testing-library.com/react)
- [Vitest](https://vitest.dev/)

---

## Manual Testing

Manual test procedures for verifying user-facing features before releases and after major changes. Tests already covered by automated suites (unit, integration, E2E) have been removed from this list.

### E2E Automation Coverage

Manual tests that can be automated have been moved to the Python bridge system-test harness (`tests/system/`). The YAML files now contain only items that truly require manual verification. See the [E2E Coverage Map](#e2e-coverage-map) below for the mapping from manual test IDs to the automated test files.

**100 manual test items remain** across 14 YAML files. These cannot be automated due to:

| Reason                                | Items | Examples                                                          |
| ------------------------------------- | ----- | ----------------------------------------------------------------- |
| Visual rendering verification         | ~16   | Powerline glyphs, white flash, 1px borders, cursor blink          |
| Keyboard shortcuts                    | ~8    | Chord bindings, rebinding, shortcut conflicts                     |
| OS-level behavior                     | ~10   | macOS key repeat, accent picker, custom app icon, app updater     |
| Native OS dialogs (file picker, save) | ~6    | Import/export connections, SSH key browse, save terminal to file  |
| Drag-and-drop                         | ~7    | Split view drag, cross-group tab drag, connection folder drag     |
| External app integration              | ~7    | Open in VS Code (local + SFTP), VS Code not installed             |
| Right-click behavior                  | ~5    | Quick copy/paste, context menu, setting persistence               |
| Credential store (master password)    | ~3    | Setup, unlock, auto-lock, wrong password, change password         |
| Platform-specific SSH/agent           | ~5    | SSH agent setup, X11 forwarding, Windows WSL file browser paths   |
| Cross-platform (external window)      | ~1    | X11 forwarding displays remote window                             |
| Embedded network services             | ~6    | HTTP/FTP/TFTP server start/stop, file transfer, auto-start (#526) |

E2E test coverage: all WebdriverIO specs have been ported to the cross-platform Python bridge harness in `tests/system/` (epic #799), and the wdio harness has been fully retired — the empty `wdio.conf.js` scaffold, the `tests/e2e/` helper tree, and the `@wdio/*` devDependencies were removed in #1027. The last specs ported and removed include the SSH tunnels editor/list and Network Tools panel-UI suites → `tests/system/tests/test_ssh_tunnels.py` / `test_network_tools.py` (#810), the live-network cases → `test_network_tools_live.py` (#946), the remote-agent and Windows-shells/WSL infrastructure suites (#974, #975), and finally the now-empty `infra` wdio suite itself (#1015).

### Test Environment Setup

- Build the release app with `pnpm tauri build`
- For SSH/Telnet testing: Docker containers from `tests/docker/` (see [tests/docker/README.md](../tests/docker/README.md))
- Pre-generated SSH test keys in `tests/fixtures/ssh-keys/`
- For serial port tests: host-side virtual serial ports via `socat` + echo server, set up by `scripts/test-system-linux.sh` (see also `examples/serial/`)
- Test on each target OS (macOS, Linux, Windows) for cross-platform items

### Multi-window close-with-live-tabs & per-OS quit policy (#1903)

The close decision surface and the classification/store branches are covered by
unit tests (`src/utils/windowClose.test.ts`, `src/store/appStore.windowClose.test.ts`,
`src/components/Terminal/CloseWindowDecisionDialog.test.tsx`) and the per-OS
policy by Rust unit tests (`src-tauri/src/window/mod.rs`). The steps below verify
the native-window behaviour, which cannot be automated — `tauri-driver` has no
macOS WKWebView driver (ADR-5) and window-close/Dock behaviour is OS-native.

1. **Detach-vs-terminate dialog.** Open a window with at least one persistent
   session (SSH/agent) **and** one non-persistent session (local shell), e.g. via
   "Move to New Window" (#1901). Close that window (title-bar X). **Expected:** a
   "Close this window?" dialog lists each session — the persistent one as
   "Detaches — keeps running", the local shell as "Would be terminated" — with
   **Move tabs to …** as the primary (blue) action, **Close & end sessions** as
   the red action, and **Cancel**.
2. **Move (safe).** Click **Move tabs to Window N**. **Expected:** the window
   closes and all its tabs reappear in the target window, sessions still live
   (scrollback replays); nothing was terminated.
3. **Close & end.** Reopen a similar window, close it, click **Close & end
   sessions**. **Expected:** the window closes; the persistent session detaches
   (still visible in the Open Connections panel), the local shell is terminated.
4. **Cancel.** Close a window with a live local shell and click **Cancel**.
   **Expected:** the window stays open, no session is touched.
5. **All-persistent → no dialog.** Close a window whose sessions are all
   persistent/agent. **Expected:** no dialog; a toast reads "N sessions detached
   — still running" and the window closes.
6. **Empty window → no prompt.** Close a window with no live sessions.
   **Expected:** it closes immediately, no dialog.
7. **Per-OS quit policy — macOS.** With multiple windows, close a non-last window
   → only that window closes, the app keeps running. Close the **last** window →
   the app **stays alive in the Dock**; clicking the Dock icon **recreates a
   window**. Cmd+Q quits the app.
8. **Per-OS quit policy — Windows/Linux.** Closing the **last** window **quits**
   the app; closing a non-last window closes only that window and never quits.

### VNC VeNCrypt / TLS authentication (#1714)

The VNC backend auto-negotiates **VeNCrypt** (RFB security type 19) when the
server offers it. The live TLS/X509 path is now covered by the **integration
tests** (VNC-06/07 in `core/tests/vnc.rs`) against the `vnc-vencrypt-server`
fixture (TigerVNC Xvnc, `-SecurityTypes VeNCrypt,X509Vnc`), which exercise the
X509Vnc negotiate → TLS handshake → VNC-password → decode path with both
`tlsVerify=insecure` and `tlsVerify=ca` — see the VNC row in [Test Suites](#test-suites).
The manual steps below remain useful for the **X509Plain** sub-type and the
connection-editor UI, which the integration lane does not drive:

1. Generate a self-signed certificate and start a TigerVNC X509 server (Linux
   host or container):

   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
     -keyout key.pem -out cert.pem -subj "/CN=localhost"
   printf 'secret\nsecret\n' | vncpasswd -f > /tmp/vncpasswd   # or `vncpasswd`
   Xvnc :9 -SecurityTypes VeNCrypt,X509Vnc \
     -X509Cert cert.pem -X509Key key.pem -rfbauth /tmp/vncpasswd -geometry 800x600
   # attach something to draw: DISPLAY=:9 xterm &
   ```

2. In the connection editor create a **VNC** connection: host `localhost`,
   port `5909` (display 9), Password `secret`. Under **VNC Options** set **TLS
   Certificate Verification** to **Accept self-signed (insecure)**.
3. Connect. **Expected:** the session comes up over TLS and paints the remote
   desktop — the VeNCrypt X509Vnc path (TLS handshake + VNC-password second
   stage) succeeded. The state dot goes connecting → active.
4. Certificate modes: with **System trust store** selected, the same self-signed
   server must be **rejected** with a TLS error (the cert is not chained to a
   public CA). Selecting **Custom CA bundle** and pointing **TLS CA Bundle** at
   `cert.pem` must connect again (the cert verifies against itself).
5. X509Plain: restart the server with `-SecurityTypes VeNCrypt,X509Plain` and set
   the connection's **Username** + **Password**. **Expected:** connects using the
   Plain second stage over TLS.
6. Fallback: a server offering only classic `VncAuth` (the existing `vnc`
   fixture) must still connect exactly as before — VeNCrypt is preferred only
   when actually offered.

> The anonymous-TLS sub-types (`TLSNone`/`TLSVnc`/`TLSPlain`, 257–259) are **not**
> supported — rustls has no anonymous-cipher support — so an `x11vnc -ssl` server
> (anon-TLS) will not connect via VeNCrypt. Tracked as a follow-up.

### RDP via the IronRDP sidecar (#1747)

The RDP backend decodes through the separately-built `termihub-rdp-helper`
sidecar (workspace-excluded crate; see #1747 / #1725). Live RDP needs a real
server, and per-PR CI does not run integration/container tests, so the wire path
is covered by unit tests (`termihub-core` `backends::rdp_sidecar` + the sidecar
crate) plus these manual steps.

Prerequisites: enable experimental features (#1705); build the helper and point
the app at it.

1. Build the sidecar: `./scripts/build-rdp-sidecar.sh --release` (emits
   `rdp-sidecar/target/release/termihub-rdp-helper`).
2. Make it discoverable: either copy it next to the desktop binary, or
   `export TERMIHUB_RDP_HELPER=<abs-path-to-helper>` before launching via
   `./scripts/dev.sh`.
3. Stand up an RDP server (a Windows host with Remote Desktop enabled, or a Linux
   `xrdp` container).
4. In the connection editor create an **RDP** connection: host, port (3389),
   username, password, and — for a domain account — the **Domain** field; leave
   Security on **Auto** (NLA/CredSSP).
5. Connect. **Expected:** the tab shows the remote desktop painting in the shared
   canvas; the state dot goes connecting → active. Move the mouse and type — the
   remote cursor and input track. Close the tab — the helper process exits (no
   orphan `termihub-rdp-helper`).
6. Failure paths: a wrong password surfaces an authentication error (state
   `authFailed`); an unreachable host surfaces a connect error; deleting/renaming
   the helper before connecting surfaces an actionable "failed to launch RDP
   helper" error that names `scripts/build-rdp-sidecar.sh` / `TERMIHUB_RDP_HELPER`.

#### Drive redirection (RDPDR, #1757)

Drive redirection is off by default and opt-in per connection. The RDPDR
filesystem backend is covered by unit tests against a temp directory
(`rdp-sidecar` `drive` module), but the live mount needs a real server:

1. In the RDP connection editor, enable **Redirect a Local Drive**, set **Shared
   Folder** to a local directory that has a few files/subfolders, and optionally
   a **Drive Name** (defaults to `termiHub`).
2. Connect to a Windows RDP host and open File Explorer on the remote.
   **Expected:** a redirected drive appears under "This PC" as
   "`<Drive Name>` on termiHub".
3. Browse into it — the shared folder's files and subfolders list correctly.
   Open a file (read), create/edit/save a file (write), rename and delete a file.
   All changes are reflected in the local shared folder.
4. Security: confirm only the selected folder is exposed — you cannot navigate
   above it, and nothing outside it is reachable from the remote.
5. Leave **Redirect a Local Drive** off and reconnect. **Expected:** no drive
   appears in the remote session.

#### Audio output redirection (rdpsnd, #1764)

Audio output is off by default and opt-in per connection. The PCM decode and
format advertisement are covered by unit tests (`rdp-sidecar` `audio` module),
but audible playback needs a real server and a host audio device, and is
**macOS/Windows only** in this slice (the Linux sidecar omits the audio backend
— see PR #1764's Linux follow-up). Verify on macOS or Windows:

1. Build the sidecar and point `TERMIHUB_RDP_HELPER` at it (as above).
2. In the RDP connection editor, enable **Redirect Audio Output**.
3. Connect to a Windows RDP host, then play sound in the remote session (e.g. a
   YouTube clip, a system sound, or `Test-Sound`).
   **Expected:** the audio is heard through this computer's speakers/output
   device, reasonably in sync with the remote.
4. Adjust the remote volume — local playback volume tracks it.
5. Leave **Redirect Audio Output** off and reconnect. **Expected:** no remote
   audio plays locally (the client advertises no audio formats).
6. On a host with no audio device (or headless), confirm the session still
   connects and runs normally, just without sound.

#### Clipboard file transfer (CLIPRDR, #1765 receive / #1778 serve)

Clipboard file transfer is off by default and opt-in per connection ("Receive
Clipboard Files"), and reuses the drive-redirection shared folder (#1757) — no
new local access. The pure logic (sandboxing, size/range serving, name
dedup/skip rules) is covered by unit tests in the `rdp-sidecar` `clipboard`
module, but the live PDU exchange needs a real server:

1. Build the sidecar and point `TERMIHUB_RDP_HELPER` at it (as above); in the RDP
   connection editor enable **Redirect a Local Drive** (with a **Shared Folder**)
   and **Receive Clipboard Files**, then connect to a Windows RDP host.
2. **Receive (#1765):** copy one or more files in the remote session (Explorer →
   Ctrl+C). **Expected:** the files appear in the local shared folder. Oversized
   files are skipped; colliding names are deduplicated (`file (1).txt`).
3. **Serve (#1778):** with a file already in the local shared folder **before
   connecting**, paste into a folder in the remote session (Ctrl+V).
   **Expected:** the file's contents arrive on the remote intact. Only files
   directly in the shared folder are offered (subfolders are not yet recursed).
   Note: the offer is sent when the clipboard format list is first exchanged, so
   files dropped into the folder _after_ connecting are not re-advertised until
   the offer is re-sent — dynamic re-advertising is a follow-up (#1788).
4. **Security:** confirm nothing outside the shared folder is ever served — the
   remote can only paste files that are in that one folder.
5. **View-only:** reconnect with **View Only** enabled and a file in the shared
   folder. **Expected:** the remote sees no local files to paste (nothing is
   advertised or served).
6. Leave **Receive Clipboard Files** off and reconnect. **Expected:** no file
   formats are advertised in either direction; text clipboard still works.

#### Delayed-render paste to the host OS clipboard (macOS, #1804)

On macOS the remote-copied files are surfaced to the **host OS clipboard** with
delayed rendering instead of eagerly downloaded into the shared folder: the bytes
are streamed from the remote only when the user actually pastes into a local app.
The selection/index logic and manager plumbing are unit-tested (`macos_clipboard`,
`graphical_manager`), but the live `NSPasteboard` promise + real paste need a
manual run (per-PR CI does not run the CLIPRDR wire lane, #1569):

1. On **macOS**, build the sidecar and point `TERMIHUB_RDP_HELPER` at it (as
   above); in the RDP connection editor enable **Redirect a Local Drive** (with a
   **Shared Folder**) and **Receive Clipboard Files**, then connect to a Windows
   RDP host.
2. Copy one or more files in the remote session (Explorer → Ctrl+C). **Expected:**
   the files do **not** appear in the shared folder (delayed rendering replaces the
   eager download on macOS).
3. Open the RemoteDesktop hover toolbar's **Clipboard** panel. **Expected:** a
   **Remote files** section lists the copied files, with a **Copy to clipboard**
   button.
4. Click **Copy to clipboard**. **Expected:** a toast confirms `N file(s) ready`.
   No bytes have been fetched yet.
5. Paste into a local app — Finder (Cmd+V into a folder), a mail draft, etc.
   **Expected:** the real files appear, their contents intact; the fetch happens
   at this moment (delayed), streamed into a bounded staging file.
6. **Other-platform regression check:** on a platform whose host binding is not
   yet wired, repeat step 2 with the same options. **Expected:** unchanged #1765
   behaviour — files download into the shared folder, and the **Remote files**
   section does not appear (no host binding, so nothing is surfaced). Windows
   (#1814) and Linux (#1815) now have their own host bindings — see the two
   sections below.

#### Delayed-render paste to the host OS clipboard (Windows, #1814)

The Windows sibling of the macOS binding above: remote-copied files are offered to
the **Windows clipboard** as a delayed-render `CF_HDROP` and served on the real
paste gesture (`WM_RENDERFORMAT`) from a dedicated message-only owner window. The
pure parts are unit-tested (`windows_clipboard`: the `CF_HDROP` builder round-trip
and the pasteable-index selection; `graphical_manager`), but the live
`WM_RENDERFORMAT` render + real paste need a message loop and a live session, so
they need a **manual run on Windows** (per-PR CI does not run the CLIPRDR wire
lane, #1569):

1. On **Windows**, build the sidecar and point `TERMIHUB_RDP_HELPER` at it (as
   above); in the RDP connection editor enable **Redirect a Local Drive** (with a
   **Shared Folder**) and **Receive Clipboard Files**, then connect to a Windows
   RDP host.
2. Copy one or more files in the remote session (Explorer → Ctrl+C). **Expected:**
   the files do **not** appear in the shared folder (delayed rendering replaces the
   eager download on Windows).
3. Open the RemoteDesktop hover toolbar's **Clipboard** panel. **Expected:** a
   **Remote files** section lists the copied files, with a **Copy to clipboard**
   button.
4. Click **Copy to clipboard**. **Expected:** a toast confirms `N file(s) ready`.
   No bytes have been fetched yet (the clipboard holds only the delayed-render
   `CF_HDROP` offer with a NULL handle).
5. Paste into a local app — Explorer (Ctrl+V into a folder), an Outlook draft, etc.
   **Expected:** the real files appear, their contents intact; the fetch happens at
   this moment (delayed), streamed into a bounded staging file, and the `CF_HDROP`
   is built from the staged local paths.
6. **Regression check:** the eager shared-folder path (#1765) still applies when
   **Receive Clipboard Files** is off.

#### Delayed-render paste to the host OS clipboard (Linux X11 + Wayland, #1815/#1847)

On Linux the remote-copied files are surfaced to the **host clipboard** with
delayed rendering, the sibling of the macOS and Windows bindings: instead of
eagerly downloading into the shared folder, the app owns the selection and serves
`text/uri-list` (plus `x-special/gnome-copied-files` /
`x-special/mate-copied-files`) only when a paste happens, and the bytes are
streamed from the remote at that moment. There are two owners, chosen by session at
runtime (`bind_remote_clipboard_files`): the **X11 `CLIPBOARD` selection** owner
(#1815, `x11rb`), which also covers XWayland-bridged apps; and, on a Wayland
session, a native **`wlr-data-control` data source** (#1847, `wayland-client` /
`wayland-protocols-wlr`) that serves its `send` callback on paste so native-only
Wayland clients see the files. On a Wayland session with XWayland present, both are
bound (native apps read the Wayland source, XWayland apps read the X11 selection);
a compositor without `wlr-data-control` degrades to X11/XWayland only. The pure
parts (index selection, `file://` URI encoding, `text/uri-list` and gnome/mate
formatting, MIME→target mapping, session detection) are unit-tested
(`linux_clipboard`), but the live selection ownership + real paste need a manual
run (per-PR CI does not run the CLIPRDR wire lane, #1569, and cannot exercise a
live X server or compositor):

1. On a **Linux desktop** (X11 session, or a Wayland session with XWayland — see
   step 6), build the sidecar and point `TERMIHUB_RDP_HELPER` at it (as above); in
   the RDP connection editor enable **Redirect a Local Drive** (with a **Shared
   Folder**) and **Receive Clipboard Files**, then connect to a Windows RDP host.
2. Copy one or more files in the remote session (Explorer → Ctrl+C). **Expected:**
   the files do **not** appear in the shared folder (delayed rendering replaces the
   eager download on Linux now).
3. Open the RemoteDesktop hover toolbar's **Clipboard** panel. **Expected:** a
   **Remote files** section lists the copied files, with a **Copy to clipboard**
   button.
4. Click **Copy to clipboard**. **Expected:** a toast confirms `N file(s) ready`.
   No bytes have been fetched yet (the app now owns the `CLIPBOARD` selection).
5. Paste into a local file manager — Files/Nautilus, Nemo, Caja, or Dolphin
   (Ctrl+V into a folder). **Expected:** the real files appear, their contents
   intact; the fetch happens at this moment (delayed), streamed into a bounded
   staging file. Try both a single file and several at once.
6. **Wayland coverage (#1847).** On a **pure Wayland session** (e.g. GNOME or a
   wlroots compositor such as sway/Hyprland; `echo $WAYLAND_DISPLAY` is set), repeat
   the paste into a **native-only Wayland** file manager — one that reads solely over
   `wlr-data-control`, not through XWayland (e.g. GNOME Files/Nautilus under Wayland).
   **Expected:** the files paste with the bytes fetched at the paste, same as X11.
   Also confirm XWayland-backed apps still work (both owners are bound). On a
   compositor without `wlr-data-control` support the native source is skipped and
   XWayland-bridged apps still paste via the X11 selection (no regression).
7. **Filename check.** Copy a file whose name has a space and a non-ASCII
   character (e.g. `naïve report.txt`). **Expected:** it pastes with the exact
   name (the `file://` URI is percent-encoded and decoded back correctly).

### Deferred agent update (apply on last disconnect) (#1352)

Verifies that a deferred agent update never interrupts active sessions and
applies strictly when the last session disconnects, and that "Apply Now" forces
it. Requires a real remote agent (SSH) whose staged binary can be swapped — use
a Unix agent host (the exec-replace is Unix-only). See PR #1352.

1. **No interruption while busy.** Connect to a remote agent and open at least one
   long-running session (e.g. `tail -f` or `top`). Stage/deploy a newer agent
   binary and request a deferred update (or trigger the staged-update banner and
   press **Apply Now**). Expect: the session keeps running uninterrupted, and the
   banner/toast reports the update is deferred until the last session disconnects
   (naming the active-session count).
2. **Applies on last disconnect.** Close the session(s) one by one. Expect: nothing
   happens until the **last** session closes; when it does, the agent swaps its
   binary and re-execs (the connection drops).
3. **New version on reconnect.** Reconnect to the agent. Expect: the agent version
   badge reports the new version, and any persistent daemon sessions are recovered.
4. **Apply Now when idle.** With a staged-update banner shown and no active
   sessions on the agent, press **Apply Now**. Expect: the update applies
   immediately, the connection drops, and reconnecting shows the new version.

5. **Dismiss.** Press **Dismiss** on the banner. Expect: the banner hides for the
   session and no update is requested.

### Coordinated desktop-push Update deploy (#1616)

Verifies that triggering an **Update** (the desktop-push deploy, not just the
self-update banner) on a **Coordinated**-strategy agent notifies the other hosts
and lets them reconnect cleanly, on Unix, with a documented Windows fallback.
Requires three desktops (A, B, C) and one **Unix** agent host, plus a Windows
agent host for step 4. See PR #1636.

1. **Coordinated Unix deploy notifies others.** Set the agent's update strategy to
   **Coordinated**. Connect desktops A, B, C to the same Unix agent and open a
   persistent session on B. From A, open the agent's **Update** dialog and confirm.
   Expect: A stages the binary and reports how many other hosts were notified; B
   and C show the "being updated by another host" notice, suspend, and
   auto-reconnect; B's persistent session survives (detached daemon) and resumes.
2. **Applies after the window.** The agent applies once B and C disconnect or the
   10s coordination window closes; A's connection drops as the agent re-execs.
   Reconnect from A → the agent version badge shows the new version.
3. **No hard cut.** Confirm B and C never saw an unexplained disconnect — only the
   coordinated notice + reconnect.
4. **Windows fallback.** Repeat step 1 against a **Windows** agent host. Expect: the
   Update falls back to the immediate deploy (shutdown + redeploy); other connected
   hosts are surfaced by the connected-host guard warning ("Notify Others &
   Update") exactly as today — the coordinated self-swap is not attempted on
   Windows, and the update path is not regressed.

### Command palette (#1484)

Verifies the Cmd/Ctrl+P command palette that fuzzy-matches application commands
and saved connections. Introduced in PR #1484.

1. Press the palette shortcut (macOS **Cmd+P**, Windows/Linux **Ctrl+Shift+P**) →
   a modal opens with an empty search box focused, listing commands first, then
   saved connections.
2. Type part of a command name (e.g. `new term`) → **New Terminal** ranks to the
   top with its accelerator shown on the right. Press **Enter** → a new terminal
   tab opens and the palette closes.
3. Reopen the palette and type part of a saved connection's name or host → the
   matching connection ranks to the top with its connection-type badge. Press
   **Enter** → it connects exactly as a sidebar double-click would (including any
   password/passphrase or credential-store-unlock prompt).
4. With the palette open, use **Arrow Up/Down** to move the highlight and
   **Esc** to close without running anything.

### FTP insecure-connection warning & editor behaviors (#1338)

Verifies the plaintext-FTP warning modal, the schema-conditional editor fields,
and the TLS-mode → port auto-adjust. See PR #1338.

**Editor — conditional fields.**

1. Create a new connection and set Type to **FTP**.
2. With TLS Mode = **None**, confirm the inline **cleartext warning callout**
   appears in the Security section.
3. Switch TLS Mode to **Explicit** or **Implicit** → the warning callout
   disappears.
4. Toggle **Use anonymous login** on → Username and Password rows hide; toggle
   it off → they reappear.

**Editor — port auto-adjust.**

1. On a fresh FTP connection (Port shows 21), switch TLS Mode to **Implicit** →
   Port becomes **990**. Switch back to **None**/**Explicit** → Port becomes
   **21**.
2. Type a custom Port (e.g. **2121**), then switch TLS Mode → the custom port is
   **preserved** (not overwritten).

**Connect — insecure warning modal.**

1. Save a plain-FTP connection (TLS Mode = None) and connect (double-click).
   Before any connection is attempted, the **Insecure Connection** modal appears.
2. Click **Cancel** → nothing connects.
3. Connect again, then click **Connect Anyway** → the connection proceeds and no
   flag is persisted (the modal reappears on the next connect).
4. Connect again, tick **Don't warn again for this connection**, then **Connect
   Anyway** → the connection proceeds. Reconnect → the modal is **not** shown.
5. Connect an **FTPS** (explicit or implicit) connection → the modal is **never**
   shown.

### Toast close button — light/dark rendering (#1504)

Verifies the bottom-right toast close (X) button renders and is styled
correctly in both themes. See PR #1504.

1. Trigger any toast (e.g. save a connection to get a success toast, or perform
   an action that fails to get a persistent error toast).
2. Confirm a close (**X**) button appears in the top-right of the toast, using
   the lucide `X` icon, not overlapping the message or action button.
3. Hover the button → it shows a subtle background; **Tab** to it → a visible
   focus ring appears; press **Enter/Space** or click → the toast dismisses
   immediately.
4. Switch between **light** and **dark** themes (Settings → Appearance) and
   repeat: the icon, hover, and focus ring must remain legible in both.
5. Repeat across variants (success, error, info). Loading toasts intentionally
   have no close button; confirm the toast they resolve into (success/error)
   does.

### Zoomed tab repaints terminal content immediately (#1823)

Verifies that zooming a terminal tab repaints its content at the new size right
away, with no need to scroll up/down to force a rerender. The fit + refresh path
has a unit test (`TerminalRegistry.test.tsx` → `fitTerminal`), but the actual GPU
repaint of the reparented terminal is visual and macOS-WKWebView specific, so it
stays manual. See PR for #1823.

1. Open a terminal tab and produce a full screen of visible content
   (e.g. run `ls -la /usr/bin` or `seq 1 200`) so the viewport is not blank.
2. Zoom the tab into the overlay (**Cmd+Shift+Enter** on macOS,
   **Ctrl+Shift+Enter** elsewhere, or the tab's zoom control).
3. **Expected:** the terminal content is visible in the zoom overlay
   **immediately**, at the new size — you do **not** have to scroll up/down to
   make it appear.
4. Repeat several times (the original bug was intermittent) and with both zoom
   in and out (Esc / the close button to un-zoom). Content must always render
   without a manual scroll.
5. Regression check: dragging the split-view splitter to resize a terminal must
   still reflow and repaint as before.

### Terminal output stays in order under scrolling output (#1849)

Verifies that command output paints top-to-bottom in buffer order, with no later
prompt/command line spliced between an earlier command's output lines. The
symptom (from image001.png) was a `git status` whose two trailing prompt lines
were painted in the middle of the untracked-files list, clearing only after the
tab was resized. The output-flush path forces a full-viewport `xterm.refresh`
after each write (unit-tested in `Terminal.output-repaint.test.tsx`), but the
underlying stale-row repaint is renderer/WebView specific — it was reported on
**Windows local CMD (ConPTY)** — so this stays manual.

Run on **Windows** against a **local CMD** session (the ConPTY path):

1. Open a local CMD terminal tab and `cd` into a directory with **many untracked
   files** in a fresh git repo (e.g. `git init` in a project folder), so a
   `git status` produces a long "Untracked files:" list that scrolls the
   viewport.
2. Run `git status`, then immediately press Enter a couple of times to emit a
   few bare prompt lines right after it.
3. **Expected:** the untracked-files list renders as one contiguous block, and
   the bare prompt lines appear **after** the whole `git status` output — never
   spliced into the middle of the file list — **without** resizing the tab.
4. Repeat a few times (the original glitch was intermittent) and try other
   scrolling output (e.g. `dir /s`, `type` of a large file). Rows must always
   stay in order.
5. Regression check: resizing the tab/window and high-throughput output
   (e.g. a large file dump) must still render and scroll normally with no
   visible slowdown.

### Connections sidebar renders fully on first paint (#1828)

Verifies that the Connections sidebar lays out completely on launch, with no
clipped/partial rendering that only clears after resizing the tab or window.
The underlying flex-sizing fix has a unit test (`useSectionResize.test.tsx`),
but the residual mis-paint was macOS-WKWebView specific, so this stays manual.
See PR for #1828.

Requires the **Remote Agents** section (enable experimental features in
Settings) with at least one saved remote agent, since the glitch appeared as
those sections mounted after settings/agents loaded.

1. Fully quit and cold-launch the app (do not just reload) so the sidebar mounts
   from scratch while settings and remote agents load.
2. **Expected:** the Connections sidebar renders fully and correctly on the
   first paint — group headers with their chevrons **and** titles, the filter
   box, and every connection/agent row are laid out at the right width, with no
   truncated text, stray chevrons, cut-off search box, or clipped rows.
3. You must **not** need to resize the tab or window to make the sidebar look
   right.
4. Repeat a few times (the original bug was intermittent) and at different window
   sizes, including a narrow window.
5. Regression check: dragging the sidebar resize handle and the inner
   section-resize handles (between Connections and Remote Agents, and between
   expanded agents) must still resize as before.

### Agent binary SHA-256 checksums (release dry-run, #1350)

Verifies that every published agent binary has a matching `*.sha256` asset and
that the desktop rejects a tampered binary before install. See PR #1350.

**Release-asset presence (release dry-run).**

1. Trigger a release (or inspect the most recent tagged release) so the
   `agent-binaries-linux`, `agent-binaries-macos`, and `agent-binaries-windows`
   jobs in [`release.yml`](../.github/workflows/release.yml) run.
2. On the GitHub Release page, confirm **each** agent artifact has a sibling
   `.sha256` asset: `termihub-agent-linux-x64`, `-linux-arm64`, `-linux-armv7`,
   `-macos-arm64`, `-macos-x64`, and `termihub-agent-windows-x64.exe` each with a
   matching `<name>.sha256`.
3. Download one binary and its sidecar and verify locally:
   `sha256sum -c termihub-agent-linux-x64.sha256` (macOS: `shasum -a 256 -c …`)
   → prints `OK`.

**Local build sidecars.**

1. Run `./scripts/build-agents.sh --native --dev` (or a cross build).
2. Confirm a `<binary>.sha256` sidecar sits next to each built agent binary under
   `target/<triple>/<profile>/` and that `sha256sum -c` on it passes.

**Tampered-binary rejection (desktop).**

1. Let the desktop resolve/deploy an agent once so `~/.cache/termihub/agent-binaries/<version>/termihub-agent-<arch>`
   and its `.sha256` sidecar are populated.
2. Corrupt the cached binary without updating the sidecar
   (e.g. `printf 'x' >> …/termihub-agent-<arch>`).
3. Deploy/redeploy the agent again → the deploy must **fail** with a checksum
   verification error naming the expected vs. computed digest, and the corrupted
   binary must **not** be uploaded/executed on the remote host.
4. Delete the tampered cache entry; the next deploy re-downloads, re-verifies,
   and succeeds.

### Keyboard-shortcuts menu discoverability (#1353)

Verifies the shortcuts reference is reachable from a visible menu and that
Settings-menu rows show their accelerators. The menu item and accelerator
rendering are covered by unit tests; this manual check confirms the accelerator
strings render correctly per platform and reflect a user rebinding. See PR #1487.

1. Open the Settings wheel menu in the Activity Bar.
2. Confirm a **Keyboard Shortcuts** row appears with its accelerator on the
   right (`Cmd+K Cmd+S` on macOS, `F1` on Windows/Linux), and the **Settings**
   row shows `Cmd+,` / `Ctrl+,`.
3. Click **Keyboard Shortcuts** → the keyboard-shortcuts overlay opens.
4. In Settings, rebind "Open Settings" to a different combo, then reopen the
   Settings menu → the Settings row accelerator reflects the new binding.

### Docker/Podman directory-mount container spawn — Podman variant (#1372)

The Docker path is covered by the `docker_spawn` integration test
(`core/tests/docker_spawn.rs`, runs with `--features docker` against a reachable
daemon). The Podman variant is manual because CI has no Podman daemon. See PR #1372.

**Podman new-container spawn with a mounted directory.**

1. With a working `podman` machine running, create a scratch directory on the
   host and drop a marker file in it (e.g. `echo hi > ~/tmp/mnt-check/hello.txt`).
2. Spawn a Podman "new container" for that directory (via the CLI path once SI-3
   lands, or by driving `resolve_container_spawn` + create session with the
   returned settings and `runtime: "podman"`). Use a tagged image such as
   `alpine:3`.
3. Confirm the shell opens **already `cd`'d into `/workspace`** (`pwd` prints
   `/workspace`) and that the marker file is visible (`cat hello.txt` prints the
   content) — proving the host directory is bind-mounted.
4. Close the session/tab. Run `podman ps -a` and confirm the `termihub-…`
   container is **still present in an exited state** (stopped, not removed).
5. Restarting that container (`podman start`) and re-attaching should still see
   the mounted directory. Remove it manually to clean up.

### Container spawn opens a Spawned Docker tab (frontend consumption, #1446)

The frontend wiring (event listener → `resolve_container_spawn` → open Docker
tab → "Spawned" badge → separate Open Connections tracking → confirmation toast)
is covered by unit tests (`src/hooks/useSpawnRequests.test.ts`,
`src/components/Terminal/Tab.spawned-badge.test.tsx`,
`src/components/OpenConnections/OpenConnectionsModal.spawned.test.tsx`). A live
end-to-end run needs Docker + a built app (PR #1464), so the full path below is
manual.

**Container spawn from the CLI opens a bind-mounted Spawned tab.**

1. With a working Docker daemon and the built app already running, create a
   scratch directory and drop a marker file (e.g. `echo hi > ~/tmp/spawn/hi.txt`).
2. From another terminal run
   `termiHub spawn --location ~/tmp/spawn --container-image alpine:3`.
3. Confirm a **new Docker terminal tab** opens in the running app, titled
   `Container: alpine:3 (Spawned)`, and that a brief **confirmation toast**
   reports the spawn (mentions the location).
4. Confirm the tab shows a **"Spawned"** badge next to its title.
5. In the terminal, `pwd` prints `/workspace` and `cat hi.txt` prints `hi` —
   proving the host directory is bind-mounted at the working directory.
6. Open **Settings → Open Connections**. Confirm a dedicated **Spawned
   Containers** section lists the container (with a `spawned` badge) and that it
   is **not** also listed under **Local Sessions**. Its **Kill** action stops the
   backend session.
7. (Boundary) Run `termiHub spawn --location ~/tmp/spawn` with **no**
   `--container-image`. Confirm this now opens a **local shell tab** `cd`'d to the
   directory (the SI-2 path below), not a container.

### Session Picker dialog (SI-3, #1366)

Rendering, section visibility, the inline container form, the confirm payload and
cancel are covered by unit tests (`src/components/Spawn/SpawnPicker.test.tsx`,
`src/hooks/useSpawnRequests.test.ts`), and the resolution of a picked target by
Rust unit tests (`src-tauri/src/commands/spawn.rs`). What cannot be automated is
**cross-platform option enumeration** — the picker reports whatever the host
actually has — so the steps below are manual and platform-specific.

**The picker enumerates this host's real targets.**

1. With the built app already running, run `termiHub spawn --location ~/tmp/spawn --pick`
   from another terminal.
2. Confirm the app window is **focused** and the **Session Picker** opens — and
   that **no session opens yet**.
3. Confirm the header shows the resolved path (`~/tmp/spawn`, expanded).
4. Confirm the **Local shells** section lists the shells this host really has and
   nothing it does not (compare against the shells offered when creating a local
   connection). The first is preselected.
5. Confirm section presence matches the host:
   - **WSL** — listed with each installed distribution on Windows; **absent
     entirely** on macOS/Linux.
   - **Docker** / **Podman** — a section appears only when that runtime's daemon
     responds. Stop the Docker daemon, reopen the picker, and confirm the Docker
     section is gone (not merely disabled).
6. Select a **non-default** shell (e.g. `zsh` when `bash` is preselected) and
   press **Open**. Confirm the tab opens that shell (`echo $0`), `cd`'d to the
   target — not the system default.
7. (Windows) Select a WSL distribution and press **Open**. Confirm the session
   opens **that** distribution (`cat /etc/os-release`) at the `/mnt/`-converted
   path, even when a saved WSL connection names a different one.

**The inline container form and runtime pick.**

1. Reopen the picker and select **Docker → New container…**. Confirm the row
   expands an inline **Image** dropdown (listing local images plus `ubuntu:22.04`)
   and a **Mount as** field defaulting to `/workspace`.
2. Confirm selecting a different section **collapses** the form again.
3. Pick an image, press **Open**, and confirm the container opens with the host
   directory bind-mounted at the mount path (`pwd`, then read a marker file).
4. (Both runtimes installed) Repeat via the **Podman** section and confirm the
   container really runs under **Podman** (`podman ps` shows it; `docker ps` does
   not) — auto-detection would otherwise have preferred Docker.

**Cancel closes cleanly.**

1. Reopen the picker and press **Cancel** (then repeat with **ESC**, and again by
   clicking the scrim).
2. Confirm the picker closes each time, **no session opens**, and no toast fires.

### External local/WSL/SSH spawn opens a shell tab (frontend consumption, #1365)

The wiring (spawn event / cold-start drain → `resolve_shell_spawn` → focus window
→ open local shell tab `cd`'d to the target → confirmation toast) is covered by
unit tests (`src-tauri/src/spawn/handler.rs`, `src/hooks/useSpawnRequests.test.ts`).
A live end-to-end run needs a built app, so the path below is manual (window focus
per-OS, especially Wayland, is manual-only). Referenced by PR #1508.

**Spawn a local shell at a directory / file / missing path.**

1. With the built app already running, create a scratch directory with a file
   (e.g. `mkdir -p ~/tmp/spawn && echo hi > ~/tmp/spawn/hi.txt`).
2. From another terminal run `termiHub spawn --location ~/tmp/spawn`.
3. Confirm the termiHub **window comes to the foreground**, a **new local shell
   tab** opens titled `spawn (Spawned)` with a **"Spawned"** badge, and a brief
   **confirmation toast** reports the shell was opened (mentions the location).
4. In the terminal, `pwd` prints the target directory — proving the shell opened
   `cd`'d there.
5. (File) Run `termiHub spawn --location ~/tmp/spawn/hi.txt`. Confirm the shell
   opens in the **parent directory** (`~/tmp/spawn`).
6. (Missing) Run `termiHub spawn --location ~/tmp/does-not-exist`. Confirm the
   shell opens in your **home directory** and an **info toast** warns the path was
   not found.
7. (Windows/WSL) With `--kind wsl`, confirm the WSL shell opens at the target
   converted to its `/mnt/<drive>/…` path.
8. (Cold start) Quit the app, then run `termiHub spawn --location ~/tmp/spawn`.
   Confirm the app launches and, once loaded, focuses and opens the shell tab at
   the target (the queued cold-start spawn is processed post-UI-ready).

### External WSL/SSH spawn opens its real backend (#1511)

The settings mapping (WSL: distribution + `/mnt/` `startingDirectory`; SSH:
saved-connection settings + post-connect `cd`) is covered by unit tests
(`src-tauri/src/spawn/handler.rs`, `src-tauri/src/commands/spawn.rs`,
`src/hooks/useSpawnRequests.test.ts`). A live end-to-end run needs a real WSL
distro / SSH host and a built app, so the paths below are manual. Referenced by
PR #1529.

**WSL spawn opens a distribution at the converted path (Windows).**

1. With a WSL distro installed and the built app running, from a Windows shell run
   `termiHub spawn --kind wsl --location C:\Users\<you>\project`.
2. Confirm a **new WSL tab** opens (titled `project (Spawned)`, with the
   **"Spawned"** badge) running inside the distribution — `uname -a` shows Linux.
3. In the terminal, `pwd` prints `/mnt/c/Users/<you>/project` — proving the
   Windows path was converted to its `/mnt/` form and the distro started there.
4. (Named distro) With a saved WSL connection whose distribution is e.g. `Debian`,
   run the same command with `--connection <that-connection-id>` and confirm the
   session uses **that** distribution rather than the default distro.

**SSH spawn opens the saved connection and `cd`s into the target.**

1. With a saved SSH connection (note its id, e.g. `Prod/Web`) and the built app
   running, run `termiHub spawn --kind ssh --connection Prod/Web --location /srv/app`.
2. Confirm a **new SSH tab** opens (titled `<connection name> (Spawned)`, with the
   **"Spawned"** badge) and connects to that host — **not** a local shell.
3. Once connected, confirm the session has `cd`'d into `/srv/app` (`pwd` prints it)
   — the `cd` runs after connect since SSH cannot set a start cwd at spawn.
4. (Error) Run the same command with `--connection does-not-exist`. Confirm an
   **error toast** reports the connection was not found and **no** tab opens
   (no silent local-shell fallback). Likewise a `--connection` pointing at a
   non-SSH connection reports "not an SSH connection".

### Spawned container grouping survives tab close (#1466)

See PR #1495. The spawned origin is now recorded on the backend session
registry (`SessionInfo.spawned` → `LocalSessionInfo.spawned`), not only on the
frontend tab, so the **Open Connections** panel groups **Spawned Containers**
from the authoritative backend marker. This keeps an orphaned spawned container
(tab closed, backend session leaked) visible and killable in its own section
instead of silently falling back into **Local Sessions**. Requires Docker/Podman.

1. Spawn a container (CLI `termiHub spawn --location <dir>` / context-menu "new
   container", or any flow that opens a spawned Docker tab). Confirm the tab
   carries the **Spawned** badge.
2. Open **Open Connections** (Settings wheel → Open Connections). Confirm the
   container appears under **Spawned Containers** (not **Local Sessions**), with a
   `spawned` badge, and is not double-listed.
3. **Close the spawned tab** but leave the container's backend session running
   (e.g. the container keeps running / the session leaks). Re-open **Open
   Connections**.
4. Confirm the container is **still listed under Spawned Containers** — it must
   NOT have moved into **Local Sessions** — and that its **Kill** button (and the
   section **Kill All**) still terminates it. After killing, the row disappears.

### Shell-integration registration — per-OS file-manager entries (SI-5/6/7)

The "Open in termiHub" **registration** subsystem (`src-tauri/src/spawn/registry.rs`, epic #1363)
is heavily unit-tested for the artefacts it writes and losslessly removes — Windows registry keys
(#1368), macOS `.workflow` bundles / `NSServices` (#1369/#1409), and Linux `.desktop` / Nautilus /
KDE / Thunar files (#1370/#1397). What **cannot** be automated is whether a real OS file manager
actually surfaces the entry on right-click, the full install → click → uninstall round-trip through
that file manager, and the binary-path **staleness banner**. Those are consolidated here as one
per-OS manual pass. All registration is **user-level — it must never prompt for admin/elevation.**
See the concept
[`shell-context-menu-integration.html`](../docs/concepts/implemented/shell-context-menu-integration.html)
and [ADR-13](architecture.md#adr-13-multi-instance-with-a-spawn-ipc-rendezvous).

**Common setup (all platforms).**

1. Build and launch the app. Open **Settings → Shell Integration**.
2. Ensure at least one entry exists (e.g. the default "Open in termiHub", target: folders). Add a
   second named entry so the multi-entry surfaces are exercised.
3. Click **Install** (or run `termiHub install-shell-integration` from a terminal). Confirm it
   completes **without any elevation/UAC/sudo prompt** and the panel shows the entries as installed.

**Windows (SI-5, #1368).**

1. After installing, right-click a **folder** in Explorer → confirm an **Open in termiHub** entry
   (with the app icon) appears; right-click **empty space inside a folder** (Background) and the
   **folder itself** per the entry's targets.
2. With **three or more** entries configured, confirm they collapse into a single **cascading
   submenu** rather than cluttering the top level.
3. Mark an entry **Extended** in settings and re-install → it appears only under
   **Shift**+right-click, not the normal menu.
4. Click an entry → the running termiHub window comes to the foreground and opens a session tab
   `cd`'d into that directory (per the spawn manual tests above).
5. Click **Uninstall** (or `termiHub uninstall-shell-integration`) → confirm **every** entry is gone
   from all three right-click contexts and no orphan `HKCU\Software\Classes\…\shell\termihub_*` keys
   remain (`reg query` under `Directory`, `Directory\Background`, `*`).

**macOS (SI-6, #1369/#1409).**

1. After installing, in **Finder** select a folder → **right-click → Quick Actions** (or the
   **Services** submenu) → confirm the **Open in termiHub** entry appears. It may require toggling it
   on once in **System Settings → Keyboard → Keyboard Shortcuts → Services**.
2. Trigger it → the running app focuses and opens a tab `cd`'d into the selection; verify the
   app-level entry also appears in the application **Services** menu (served by the native
   `NSServices` provider), not only as a per-entry Quick Action.
3. Click **Uninstall** → confirm the `~/Library/Services/*.workflow` bundles termiHub created are
   removed and the Quick Action disappears from Finder (a Finder/`pbs` refresh or re-login may be
   needed for the menu cache).

**Linux (SI-7, #1370/#1397).**

1. After installing on a box with **Nautilus (GNOME)**, **Dolphin/KDE**, and/or **Thunar (XFCE)**,
   right-click a folder in each installed file manager → confirm the **Open in termiHub** action
   appears. Only file managers actually detected on the machine should have been written to.
2. Trigger it → the running app focuses and opens a tab `cd`'d into the directory.
3. Confirm the generated launchers reference the themed `termihub` icon and that the XDG
   `.desktop` "Open With" entry also lists termiHub.
4. Click **Uninstall** → confirm the termiHub-owned files are removed
   (`~/.local/share/applications/termihub-*.desktop`, Nautilus scripts, KDE
   `kservices5`/`kio/servicemenus` entries, and termiHub's actions removed from Thunar's shared
   `uca.xml`) while **foreign** entries in `uca.xml` are left intact.

**Binary-path staleness banner (all platforms, #1367/#1371).**

1. With shell integration installed, **move or rename** the app binary/bundle (or copy a portable
   install to a new folder and launch it from there) so the running exe path no longer matches the
   `registeredExePath` written at install time.
2. Launch termiHub from the new location → confirm a **reinstall banner** appears noting the
   registration points at a stale path.
3. Re-install from the banner (or Settings) → the banner clears and the context-menu entries now
   launch the app from its new location. This is the documented mitigation for the portable-mode
   tension (registration writes absolute exe paths into system-global locations).

### Native-dialog → Modal migration (#1348)

Verifies the three flows that previously used native `window.prompt` /
`window.confirm` now use the shared Modal / inline-edit affordances. See PR
for #1348.

**File rename (inline).**

1. Open the file browser on a local or SFTP directory containing a file with an
   extension (e.g. `report.pdf`).
2. Select the file and press **F2** (or right-click → **Rename**). The row turns
   into an inline text input — no native prompt appears.
3. Confirm the base name (`report`) is pre-selected while the extension
   (`.pdf`) is preserved. Type a new base name and press **Enter** → the file is
   renamed and a success toast appears. On error a recoverable error toast is
   shown.
4. Start another rename and press **Escape** (or click away with no change) →
   the edit is abandoned and no rename occurs.

**File browser virtual scrolling — large directories (#1514).**

1. Open the file browser on a directory with several thousand entries (e.g. a
   large FTP/SFTP listing, or a local folder with a few thousand files).
2. The list appears instantly and scrolls smoothly top-to-bottom with no freeze
   or jank; only the visible rows are in the DOM (inspect the element tree — the
   row count stays small and changes as you scroll). A single scrollbar (the
   shared/global style) is used — no nested or second scrollbar appears.
3. Multi-select still works: click a row, then Shift-click a far-off row (scroll
   to reach it) → the whole range is selected; Ctrl/Cmd-click toggles individual
   rows; the "N selected" indicator reflects the full selection. Ctrl/Cmd-A
   selects the entire directory.
4. Keyboard navigation still works: click a row, then use ArrowDown/ArrowUp,
   Home/End, and type-ahead. Focus follows the active row and **End** (or a
   type-ahead match far down) scrolls the previously off-screen focused row into
   view and keeps focus on it.
5. Drag a file from the OS (Finder/Explorer) onto the list → the upload/copy
   drop still works. Start an inline rename (F2) on a row → the inline editor
   appears in place and commit/cancel behave as before. Trigger a transfer and
   confirm the transfer footer still renders below the list.

See PR for #1514.

**File multi-delete outcome reporting (#1394).**

1. Open the file browser on a local or SFTP directory. Prepare at least one entry
   that cannot be deleted (e.g. a read-only / permission-protected file) alongside
   ordinary files.
2. Multi-select several files including the undeletable one (Ctrl/Cmd-click), then
   right-click → **Delete (N items)** and confirm the dialog.
3. The batch does **not** abort on the first failure: the deletable files are
   removed and a single toast reports the outcome — "Deleted N items, M failed:
   \<names>" naming the failed entries. When every item deletes, a "Deleted N
   items" success toast appears instead.
4. Delete a **single** undeletable file (right-click → **Delete**, confirm) → an
   error toast naming the file appears instead of failing silently; deleting a
   normal single file shows a success toast.

**Wake-on-LAN "Save Current".**

1. Open **Network Tools → Wake-on-LAN**, enter a valid MAC address, then click
   **Save Current**. A themed modal opens (no native prompt).
2. Confirm the modal shows a **Device name** field and the MAC address; an
   invalid MAC shows an inline error and the **Save** button is disabled until a
   name is present and the MAC is valid.
3. Enter a name and confirm → the device is saved, the modal closes, and a
   success toast appears; the saved-devices list refreshes.

**Port Scanner large-scan warning.**

1. Open **Network Tools → Port Scanner**. Enter a single host and a small port
   list and click **Run** → the scan starts immediately (no modal).
2. Enter a large port range (e.g. `1-2000`) or a CIDR block (e.g. `10.0.0.0/24`)
   with a few ports and click **Run** → a themed confirm modal appears (no
   native confirm) stating the approximate probe count.
3. **Cancel** → the scan does not start. Re-run and **Start scan** → the scan
   proceeds.

### File browser rename / new-file / new-folder / copy feedback (#1399)

Verifies every FileBrowser mutating/clipboard action gives success/error
feedback instead of resolving silently or only logging to the console. See PR
for #1399.

**New folder / New file.**

1. Open the file browser on a local or SFTP directory. Click **New Folder**
   (toolbar or background right-click → **New Folder**), type a name, press
   **Enter** → the folder is created and a `Created folder "<name>"` success
   toast appears.
2. Repeat with **New File** → a `Created file "<name>"` success toast appears.
3. Trigger a failure (e.g. create a folder whose name already exists, or in a
   read-only directory) → a recoverable error toast naming the target appears
   instead of a silent no-op.

**Copy Name / Copy Path.**

1. Right-click a file → **Copy Name** → a `Copied name` toast appears and the
   file's name is on the clipboard (paste to verify).

2. Right-click a file → **Copy Path** → a `Copied path` toast appears and the
   file's full path is on the clipboard.

### Network Tools shared field validation (#1381)

Verifies every Network Tools text input shares one label + input + inline-error
affordance and blocks the Run/Send button on invalid input. See PR #1436.

1. Open **Network Tools → Ping** (repeat for **Traceroute** and **Port
   Scanner**). Clear the **Host** field → an inline "Host is required" error
   appears under the field and the **Start** button is disabled. Type a host →
   the error clears and the button enables.
2. Open **Network Tools → DNS Lookup**. Clear the **Hostname** field → an inline
   "Hostname is required" error appears and **Run** is disabled. The **Server**
   field renders through the same shared field (optional, no error).
3. Open **Network Tools → Port Scanner**. Clear the **Ports** field → an inline
   "Enter at least one port" error appears and **Start** is disabled.
4. Open **Network Tools → Wake-on-LAN**. Type a malformed MAC (e.g. `zz:zz`) →
   an inline "Enter a valid MAC address" error appears and **Send** is disabled.
   Enter a valid MAC (e.g. `AA:BB:CC:DD:EE:FF`) → the error clears and **Send**
   enables.

5. In every case a pristine, never-touched field shows no error text (only the
   disabled button) — the inline message appears once you engage the field.

### Embedded-server delete confirmation (#1393)

See PR #1426. Verifies that deleting an embedded server now requires an explicit
confirmation via the shared `ConfirmDialog`, consistent with tunnels and
workspaces.

1. Open the **Services** sidebar and create (or select) a **stopped** embedded
   server. Click its **Delete** (trash) action → a themed confirm dialog appears
   (no instant deletion). **Cancel** → the server remains. Re-open and click
   **Delete** in the dialog → the server is removed and a success toast appears.
2. Start an embedded server so it is **running**. Click its **Delete** action →
   the confirm dialog's wording states it will **stop and delete the running
   server**. Confirm → the running server is stopped, deleted, and a success
   toast appears.
3. Repeat via the right-click **context menu → Delete** → the same confirmation
   dialog gates the deletion.

### Embedded-server delete backend-failure toast (#1427)

See PR #1439. Verifies that a backend delete failure surfaces a
user-visible error toast instead of failing silently (the store used to swallow
the error to `console.error`).

1. Create an embedded server, then make its delete fail on the backend (e.g.
   revoke write access to the config store, or otherwise force
   `delete_embedded_server` to error).
2. Click **Delete** and confirm in the dialog → an **error toast** ("Failed to
   delete …") appears with the backend error message, and the server **remains**
   in the Services list (it is not removed).

### Remote-agent update-strategy settings persist (#1354)

Verifies the per-agent update settings appear in the editor and round-trip
through save/load. See PR #1388.

1. In the **Remote Agents** sidebar, edit an existing agent (or create one) to
   open the connection editor, then open the **Agent** tab.
2. In the **Updates** section confirm two controls appear: an **Update Strategy**
   select (Immediate / Coordinated / Deferred, defaulting to **Immediate**) and an
   **Allow agent self-update** toggle (defaulting to **off**).
3. Set Update Strategy to **Deferred** and turn **Allow agent self-update** on,
   then save.
4. Reopen the same agent's editor → the Agent → Updates section still shows
   **Deferred** and the toggle **on** (values persisted to disk).
5. Trigger an agent update (redeploy) with a non-Immediate strategy selected →
   the update still succeeds via the immediate path, and the app log records a
   warning that the coordinated/deferred strategy is not yet honored (#1351/#1352).

### Connected-host update guard + Update dialog (#1349)

Verifies that updating an agent warns when other hosts are connected and
requires explicit confirmation. Needs a **shared agent process** so a second
desktop is visible to the first — run the agent in TCP `--listen` mode (the
default SSH `--stdio` deployment gives each desktop its own process, so the
guard correctly sees no other hosts and this warning never fires). See
PR #1349.

Prerequisites: an agent binary reachable in `--listen` mode, and two termiHub
desktops (or two app instances) both connected to that same agent.

1. From **desktop A**, connect to the shared agent. From **desktop B**, connect
   to the **same** agent so two clients are attached.
2. On desktop A, trigger **Update agent** for that agent → the Update dialog
   opens showing **Installed** vs **Available** versions and an amber warning
   reading "1 other host(s) are connected to this agent" that lists desktop B
   with a relative "connected … ago" time. The primary button reads **Notify
   Others & Update**.
3. Click **Cancel** → the dialog closes and nothing is updated (desktop B stays
   connected).
4. Reopen the dialog and click **Notify Others & Update** → the update proceeds
   (via `update_agent_force`); desktop B is disconnected (hard-cut) and, on
   reconnect, sees the new agent version.
5. Now disconnect desktop B and repeat **Update agent** from desktop A with no
   other hosts → the dialog omits the warning, shows "No other hosts are
   connected. The update applies immediately.", and the primary button reads
   plain **Update**; clicking it updates without any extra confirmation (same as
   before this change).

### Guided Git for Windows install (#1672)

Verifies the detect-and-guide flow that offers to install Git for Windows when no
Unix shell is present. **Windows only** — the gate and helpers are unit-tested on
every CI platform, but the guided install (winget terminal tab, git-scm.com deep
link, and post-install re-detection) cannot be exercised by per-PR CI. Tracked in
issue 1672 and its PR.

Prerequisites: a Windows machine with **Git for Windows not installed** (no Git
Bash, no WSL bash detected).

1. Launch termiHub and open **Settings → General → Default Shell**.
2. Confirm the picker shows a **"Git Bash — set up…"** entry (it must not appear
   once Git Bash or a WSL distro is detected).
3. Select it → a **"Set up Git Bash"** dialog opens. Nothing is installed yet.
4. Click **Open git-scm.com** → the official download page opens in the browser.
   Close the browser; the dialog remains.
5. Click **Install in terminal** → a local terminal tab titled **"Install Git for
   Windows"** opens, pre-loaded with `winget install --id Git.Git -e`, and the
   dialog closes with a success toast.
6. Complete the winget install in that tab (drive any UAC prompt).
7. Re-open **Settings → General → Default Shell** (no app restart) → **Git Bash**
   now appears as a normal selectable row and the "set up…" entry is gone.
8. On a machine that already has Git Bash or WSL bash, confirm the "set up…" entry
   never appears.

### Windows Explorer context-menu registration (#1368)

Verifies that shell-integration registration writes/removes the Windows Explorer
context-menu entries. **Windows only** — the registry writes are `#[cfg(windows)]`
and validated automatically by the Windows CI job; these steps confirm the live
Explorer behavior, which CI cannot observe. See PR #1368.

Prerequisites: a Windows build of termiHub, with at least one shell-integration
entry configured (an "Open in termiHub" folders entry exists by default once the
settings UI lands; until then, seed `shellIntegration.entries` in `settings.json`).

1. Install from the CLI: run `termiHub.exe install-shell-integration` (or invoke
   the `install_shell_integration` command from the app). It prints
   `Shell integration installed.` and exits 0.
2. In File Explorer, **right-click a folder** → the configured entry (e.g. "Open
   in termiHub") appears. Choosing it opens termiHub with a session at that folder.
3. **Right-click empty space** inside an open folder (folder background) → the
   entry appears and opens a session at the current folder (`%V`).
4. **Right-click a file** → if the entry enables the _Files_ target, it appears
   and opens a session at the file's parent directory.
5. For an entry set to **Extended** visibility: it is hidden on a normal
   right-click and appears only under **Shift + right-click**.
6. Configure **three or more** always-visible entries and reinstall → the entries
   are grouped under a single cascading **termiHub** submenu instead of appearing
   at the top level.
7. Reinstall again without changes → no duplicate entries appear (idempotent).
8. Uninstall: run `termiHub.exe uninstall-shell-integration` (or the
   `uninstall_shell_integration` command) → all entries and the submenu disappear
   from every right-click surface, and no `termihub_*` / `termiHubMenu` keys
   remain under `HKCU\Software\Classes\Directory\shell`,
   `…\Directory\Background\shell`, or `…\*\shell` (verify with `regedit`).

### Linux file-manager detection in Shell Integration settings (#1397)

Verifies that the Shell Integration settings report the file managers actually
installed on the host, with versions. **Linux only** — detection shells out to
each manager's `--version` and reads the per-user file-manager directories,
which are `#[cfg(target_os = "linux")]`-gated and depend on the live environment,
so they cannot be validated from macOS CI. The pure version parsers are unit
tested on every platform; these steps confirm the live probe. See PR for #1397.

Prerequisites: a Linux build of termiHub on a desktop with at least one of
Nautilus, Dolphin (KDE) or Thunar installed (`nautilus --version` /
`dolphin --version` / `thunar --version` should print a version at a shell).

1. Open **Settings → Shell Integration**. Under **Linux — File Manager
   Integrations**, each of Nautilus / KDE service menu / Thunar shows either
   "— detected: `<Name> <version>`" (e.g. "detected: Nautilus 43.2") for an
   installed manager, or "— not detected" for an absent one.
2. Cross-check the shown version against the manager's own `--version` output —
   they must match.
3. On a host with **none** of the three installed, all three rows read
   "— not detected" (the previous behavior was an always-empty list, so nothing
   was annotated at all).
4. Install or remove a manager (e.g. `apt install thunar`), reopen the settings
   panel, and confirm the detected/not-detected state updates accordingly.

### macOS app-level Services provider (#1409)

Verifies the app-level **"Open in termiHub"** entry in the macOS **Services**
menu is functional — i.e. it opens a session at the selected path rather than
being an inert menu item. **macOS only** — the native Cocoa service provider is
`#[cfg(target_os = "macos")]`-gated and needs a running GUI, so it cannot be
automated (no WKWebView driver; see [ADR-5](#platform-support)). The app-level
`NSServices` entry (`openInTermiHub`) is declared in `src-tauri/Info.plist`
(#1369) and wired to `NSApp.servicesProvider` at startup (#1409). See PR #1449.

Prerequisites: an **installed** `termiHub.app` bundle (a plain `cargo run`/dev
build is not registered with Launch Services, so the OS will not surface its app
Services). Build the bundle with `./scripts/build.sh`, then move
`termiHub.app` into `/Applications` and launch it at least once.

1. **Register with Launch Services.** After first launch, open **System
   Settings → Keyboard → Keyboard Shortcuts → Services** (or right-click a
   Finder item → **Services**) and confirm **"Open in termiHub"** is listed. If
   it does not appear immediately, run
   `/System/Library/CoreServices/pbs -flush` (or log out/in) and re-check.
2. **Folder.** In Finder, **right-click a folder → Services → "Open in
   termiHub"** → the running termiHub opens a new session at that folder.
3. **File.** **Right-click a file → Services → "Open in termiHub"** → a session
   opens at (or targeting) the selected file's path.
4. **Multiple selection.** Select several items, invoke the Service → one
   session opens per selected path.
5. **No dead item.** Confirm the entry never does nothing: every invocation
   results in a session (this is the regression the app-level entry previously
   exhibited — it was declared but not backed by a provider).
6. The per-entry **Automator Quick Action** bundles under
   `~/Library/Services` (#1369) remain the primary path and continue to work
   independently; both surfaces can coexist.

### Agent GitHub self-update (opt-in, #1355)

Verifies the optional agent-side self-update check is gated behind
`allow_self_update`, notifies on a newer release, verifies checksums, and skips
cleanly offline. Requires a Linux remote host (agent binaries are Linux-only).
See PR #1389.

1. **Off by default (no network).** Deploy an agent to a Linux host with **Allow
   agent self-update** left **off**. Confirm the SSH exec command is
   `…/termihub-agent --stdio` (no `--allow-self-update`) — e.g. inspect the app
   log or run `agent_exec_command`. On the host, confirm the agent makes no
   outbound request to `api.github.com` (e.g. `ss -tnp | grep termihub-agent`
   shows no GitHub connection).
2. **Opt in.** Edit the agent, turn **Allow agent self-update** on in **Agent →
   Updates**, save, and reconnect. Confirm the exec command now ends with
   `--stdio --allow-self-update` and the agent log records
   `Agent self-update enabled — checking GitHub … every 24h`.
3. **Newer release notifies.** With self-update on and the host's agent an older
   version than the latest published release, wait for (or force) a check. Confirm
   the desktop receives an `agent.update_available` notification (self-update
   toast) naming the available version.
4. **Verified staging when idle.** With no active sessions on that agent, confirm
   the agent downloads the new binary, verifies its `.sha256`, and records a
   `pending_update` in the host's `state.json`
   (`~/.config/termihub-agent/state.json`). A binary whose checksum does not
   match must be rejected and removed (not staged).
5. **Offline is graceful.** Block the host's outbound access to `api.github.com`
   (firewall) with self-update on. Confirm the agent logs a warning
   (`could not reach GitHub, skipping this cycle`) and keeps serving sessions —
   it must not crash. `last_check_time` in `state.json` still updates.

### Agent self-update auto-apply on idle (#1401)

Verifies that an agent with self-update enabled automatically applies a staged,
verified update once its last session closes — respecting the connection's
update strategy and never interrupting active sessions. Requires a Linux remote
host. See PR for #1401. (End-to-end apply across a real restart is covered by the
deferred Docker integration follow-up #1519.)

1. **Strategy reaches the agent.** Edit the agent, turn **Allow agent self-update**
   on, set **Update Strategy** to **Deferred** (or **Immediate**), save, and
   reconnect. Confirm the SSH exec command now ends with
   `--stdio --allow-self-update --update-strategy deferred` (inspect the app log
   or `agent_exec_command`).
2. **Active session blocks apply.** With a newer release published and a staged
   `pending_update` in the host's `state.json`, keep at least one session open on
   that agent. Wait for (or force) a self-update cycle. Confirm the agent does
   **not** swap its binary while a session is active (the session keeps running;
   `pending_update` remains in `state.json`).
3. **Applies on last disconnect.** Close the last session on that agent. Confirm
   the agent applies the staged binary (exec-replace), comes back on the new
   version, and clears `pending_update` from `state.json`. Persistent daemon
   sessions (if any were re-opened) survive the restart and re-attach.
4. **Coordinated does not auto-apply.** Repeat step 1 with **Update Strategy** set
   to **Coordinated**. Confirm that on idle the agent stages and notifies but does
   **not** auto-apply — `pending_update` stays recorded for a later coordinated
   apply.
5. **Retry on failure.** Make the staged binary unusable (e.g. corrupt the staged
   file after staging) and trigger an apply on last disconnect. Confirm the apply
   fails, the agent keeps running the old version, logs the failure, and retains
   `pending_update` so the next cycle retries.

### Agent version + update-state badge — light/dark colors (#1347)

Verifies the agent version chip and update-state badge render with the correct,
legible colors in both themes, across all four states. See PR for #1347. Badge
colors: up-to-date = success/green, update available = notice/amber,
incompatible = error/red, updating = accent/blue.

1. Connect a remote agent whose version matches the desktop. In the Connections
   sidebar, confirm the agent header shows a neutral monospace version chip
   (e.g. `v0.1.0`) followed by a green check badge (**up to date**). Hover the
   badge — the tooltip reads "Agent up to date (v…)".
2. Toggle the app between light and dark themes (Settings → Appearance). In both
   themes confirm the chip text stays legible against its neutral background and
   the green badge is clearly readable (not washed out).
3. Open **Open Connections** (Settings wheel → Open Connections). Confirm the
   agent row shows the same version chip plus a **labelled** state badge
   (e.g. "Up to date"). Verify legibility in both themes.
4. Simulate the other states (e.g. point the agent at an older/newer/mismatched
   binary, or temporarily adjust the compared versions): confirm an **amber**
   up-arrow badge for _update available_, a **red** warning badge for
   _incompatible_ (major mismatch or unparseable version), and — for the
   transient _updating_ state — a **blue** spinner that respects
   `prefers-reduced-motion` (no spin when reduced motion is enabled). Each must
   remain legible in light and dark.
5. In the status bar, with at least one agent connected, confirm the
   `N agents` summary appears; when an agent has an update available, confirm the
   amber `· M updates available` count shows and clicking the item opens the
   Connections sidebar.

### File editor read-only badge + banner (#1325)

Verifies a read-only remote (SFTP) file surfaces its state in the editor.
Detection only — no elevated save is offered. See PR #1486 (#1325).

1. On a remote (SSH/SFTP) connection, browse to a file the connecting user
   **cannot** write (e.g. a root-owned `/etc/…` file, or `chmod 400`/`chown` a
   file to another user). Right-click → **Edit** to open it in the editor.
2. Confirm a **Read-only** lock badge appears in the toolbar next to the
   **Remote** badge, and a warning-colored info banner appears above the editor
   explaining the file is read-only. Hover the badge — the tooltip shows the
   file's permission string (e.g. `-rw-r--r--`).
3. Click the banner's dismiss (×) control → the banner disappears while the
   Read-only badge **remains** (the badge is a persistent state indicator).
4. Open a **writable** remote file (one you own with write permission) → neither
   the badge nor the banner appears, and Save works as before.
5. Open a **local** file → neither the badge nor the banner appears (no probe is
   performed for local files).
6. Toggle light/dark themes (Settings → Appearance) with a read-only file open →
   the badge and banner stay legible in both themes.

### File editor elevated (sudo) edit mode (#1329)

Verifies read-only remote files can be saved with `sudo` via the in-app prompt.
Requires an SSH/SFTP connection whose user has `sudo` rights on the host (e.g. a
Raspberry Pi). See PR #1508 (#1329).

1. On a remote SSH/SFTP connection, open a **root-owned** file the user cannot
   write directly (e.g. `/etc/hosts`). Confirm the read-only badge/banner appear
   and the toolbar action is **Edit with sudo** (not **Save**).
2. Make an edit, then click **Edit with sudo**. In the prompt confirm the **host**,
   **user**, and **file** are named and the password field is masked. Leave
   **Remember for this session** on (default). Enter the correct password →
   **Authorize**.
3. The save succeeds (success toast), a persistent accent **sudo** marker appears
   in the toolbar, and the buffer is clean. Verify the file was actually changed
   on the host (`cat` it in a shell).
4. Edit again and press **Save** / `Ctrl+S` → it saves elevated **without**
   re-prompting (the session password is cached). The `sudo` marker stays.
5. Open another root-owned file, click **Edit with sudo**, and enter a **wrong**
   password three times → the prompt shows an "Incorrect password. Attempt N of 3"
   counter, then after the 3rd failure the dialog closes and the #969 save-error
   banner appears with the buffer **intact** (still dirty; nothing lost).
6. With the credential store **locked** (or in `none` mode), open the sudo prompt →
   the **Save in credential store** option is **hidden**. Unlock the store and
   reopen the prompt → the option appears; enabling it and authorizing persists
   the sudo password (a later session reuses it silently).
7. On a file whose writability was **unknown**, press **Save**, let the direct save
   fail with a permission error → the #969 banner shows a **Retry with sudo**
   action; click it to open the prompt and save elevated.
8. Confirm the sudo password is never visible in the LogViewer (elevated-save DEBUG
   lines name the host/path only) and never written to workspace/tab state.

### File editor SFTP-only read-only fallback (#1330)

Verifies the graceful fallback for a read-only file on an SFTP-only / relayed
connection (no exec channel, so no `sudo` path). See PR #1525 (#1330).

1. Open a file on an **SFTP-only** connection where the connecting user cannot
   write it (e.g. a root-owned file, or one `chmod`/`chown`ed to another user). A
   good source is a remote-agent SFTP relay or an SFTP-only jump, i.e. any
   connection that does **not** expose a shell/exec channel.
2. Confirm the **Read-only** badge appears and the banner reads that the file is
   read-only **and sudo elevation isn't available on this connection**. Confirm
   there is **no** "Edit with sudo" action and the **Save** button is **disabled**
   (it stays disabled even after you type an edit).
3. Click **Save a copy…** → a dialog opens pre-filled with the file's path. Change
   it to a **writable** remote path (e.g. `~/hosts.copy`) and confirm → a success
   toast appears and the copy exists on the host (`cat` it in a shell); the copy
   contains your edited buffer, and the original file is unchanged.
4. Click **Download** → choose a local destination in the save dialog → a pending
   toast then a "Downloaded …" success toast; the file exists locally with the
   remote contents.
5. Dismiss the banner (×) → it disappears while the Read-only badge remains.
6. Regression: open a read-only file on a full **SSH+shell** (exec-capable)
   connection → the **Edit with sudo** action is shown (not the fallback), and no
   "Save a copy…" / "Download" actions appear in the banner (see #1329).

### Multi-window: move a live tab between windows (#1900)

Multi-window behavior cannot be automated on macOS (`tauri-driver` has no
WKWebView driver, ADR-5) and the Python bridge harness is not yet multi-window
aware, so the foundation's end-to-end path is verified manually. The UI to
trigger a move (context-menu "Move to Window") is #1901; until it lands, drive
the store seam from the DevTools console.

Foundation smoke test (all platforms; **required on macOS**):

1. Launch via `./scripts/dev.sh`. Open a **local shell** tab in the main window
   and run a few commands so it has visible scrollback (e.g. `ls -la`, `pwd`).
2. Open the DevTools console. Grab the store, find the active leaf/tab ids, and
   move the tab into a **new** window:

```js
const store = (await import("/src/store/appStore.ts")).useAppStore;
const { getAllLeaves } = await import("/src/utils/panelTree.ts");
const leaf = getAllLeaves(store.getState().rootPanel)[0];
store.getState().moveTabToWindow(leaf.tabs[0].id, leaf.id, { kind: "new" });
```

Then verify:

1. A second native window opens; the tab appears in it with its **scrollback
   repainted**; the tab disappears from the main window; the shell is **still
   live** (type a command in the moved tab — it responds, the backend PTY never
   restarted).
2. In the new (empty) main-window leaf, confirm no orphaned/blank terminal is
   left behind and the source session was not killed.
3. Close the second window → confirm the main window's other sessions, tunnels,
   and embedded/X servers are untouched (app-wide teardown only runs when the
   last window closes; full close policy is #1903).

### Guided-Manual Tests in the Python Harness (preferred)

Guided-manual tests are **first-class `pytest` tests** in the Python system-test harness (`tests/system/`). Each one does all the automatable setup through the existing mixins — launch the app, build connections/state — and then prompts the operator for only the irreducibly-manual step (a native OS dialog, xterm-canvas color fidelity, cursor blink). This is the key difference from the legacy YAML runner: the operator does just the un-automatable bit, and the test shares the harness's app/agent orchestration, fixtures, and reporting.

A guided test is marked `@pytest.mark.manual` and mixes in `ManualUi`, whose verbs (`manual_step`, `manual_confirm`, `manual_observe`) print the instruction + expected result and record pass/fail/skip.

```bash
# From tests/system/. Without --manual (or with no interactive TTY) these
# tests SKIP, so CI / AI-agent / normal runs stay green:
./pytest.sh -m manual                         # lists/skips manual tests
./pytest.sh --manual -k native_dialog -s      # walk an operator through one test
./pytest.sh --manual --manual-platform=windows -s   # select platform-scoped items
```

At the end of a `--manual` session a `manual-<ts>-<platform>-<arch>.{json,md}` report (pass/fail/skip + notes, platform, timestamps) is written to [`tests/reports/`](../tests/reports/). See the worked examples in [`tests/system/tests/test_manual_examples.py`](../tests/system/tests/test_manual_examples.py) and the harness [README](../tests/system/README.md#guided-manual-tests---manual).

Migrated guided-manual suites so far:

| Suite                                                                        | Covers (manual IDs)                                                              | The human step                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`test_manual_examples.py`](../tests/system/tests/test_manual_examples.py)   | worked examples (visual / dialog)                                                | eyeball colours / drive a save dialog / yes-no                                                                                                                                                                                        |
| [`test_native_dialogs.py`](../tests/system/tests/test_native_dialogs.py)     | MT-CONN-08/09/17/12..16/23, MT-TAB-08/17/18/19, MT-PORT-04                       | pick / save the path the harness names in the native OS dialog; the harness verifies the file / store (incl. encrypted import, Save As, portable export, external file — #1004)                                                       |
| [`test_visual_rendering.py`](../tests/system/tests/test_visual_rendering.py) | MT-SSH-02, MT-UI-31/35/36, MT-SER-01/02, MT-UI-02.., MT-UI-01/16/19, MT-LOCAL-05 | look and confirm the rendered result (glyphs, ANSI colours, box-drawing, theme, scrollbar, no startup/connect white-flash, no black bottom bar, OS app icon) — screenshot attached                                                    |
| [`test_external_app.py`](../tests/system/tests/test_external_app.py)         | MT-FB-04/14/15/16, MT-SSH-07/09/14/15/16/18, MT-XPLAT-03, MT-KB-01..04           | confirm the external result — VS Code launched, the SSH-agent/X11 window appeared, the clipboard pasted (harness verifies the in-app side: menu item, persisted X11 flag, session connect)                                            |
| [`test_input_routing.py`](../tests/system/tests/test_input_routing.py)       | MT-KB-09..14, MT-UI-26..30/34, MT-TAB-06/07/16, MT-CONN-01/24, MT-FB-20          | perform the real keypress / drag / right-click / OS file-drop the synthetic bridge cannot reproduce (harness verifies the in-app side: persisted pass-through flag, resulting leaf count / panel tree, the moved connection's folder) |

> **MT-UI-01/16/19, MT-LOCAL-05 — startup/connect white-flash + app icon (#1003).**
> Follow-up to #915 (delivered in PR #943): the remaining timing- and OS-level
> visual items were added to
> [`test_visual_rendering.py`](../tests/system/tests/test_visual_rendering.py).
> They are paint-timing / OS-chrome artefacts the DOM/store bridge cannot assert,
> so each stays operator-confirmed, but the harness still automates everything
> around the look:
>
> - **MT-UI-01 (no startup white-flash).** The harness does a real
>   kill-and-relaunch (`restart_app`); the operator confirms the window came up
>   with the dark background (#1e1e1e) already painted — no white flash before the
>   app's first paint. Watch the window during the relaunch (re-run if you looked
>   away).
> - **MT-LOCAL-05 (no SSH connect / setup-command flash).** The harness drives the
>   full password-SSH connect (create → Save & Connect → answer the prompt → land
>   in the terminal); the operator confirms the remote prompt appeared cleanly with
>   no flash of setup/wrapper commands and no white/black flicker. Needs the Docker
>   SSH password container (`ssh_fixtures`); skips when no container runtime is
>   available.
> - **MT-UI-16 (no black bar at the terminal bottom).** The harness opens a
>   terminal and prints a line; the operator confirms the terminal background fills
>   to the bottom of the pane — no black strip between the last row and the pane
>   edge / status bar.
> - **MT-UI-19 (OS app icon).** The harness ensures the app is running and focused;
>   the operator checks the dock (macOS) / taskbar (Windows) / launcher (Linux) and
>   confirms the custom termiHub icon is shown, not a generic default.
>
> Run them under `./pytest.sh --manual -k visual -s` with an operator.

<!-- -->

> **MT-CRED-01/02/03 — OS credential stores (PR #956).** As of #956 the app has a
> native **OS Keychain** credential mode (alongside `master_password` and `none`),
> backed by the `keyring` crate. These are platform-scoped guided-manual checks —
> the harness can drive the in-app side (switch to OS Keychain mode in
> Settings → Security, save a connection with "Save password"), but confirming the
> secret actually landed in the OS store is the irreducibly-manual step:
>
> - **MT-CRED-02 (macOS Keychain).** After saving a credential in OS Keychain mode,
>   open **Keychain Access** and search for service **`termiHub`** — confirm an entry
>   exists whose account is `<connection-id>:password` (or `:key_passphrase`).
> - **MT-CRED-01 (Windows Credential Manager).** Open **Control Panel → Credential
>   Manager → Windows Credentials** (or `cmdkey /list`) and confirm a generic
>   credential under the **`termiHub`** target with the matching account.
> - **MT-CRED-03 (Linux Secret Service).** With a Secret Service provider running
>   (GNOME Keyring / KWallet), use **`secret-tool search service termiHub`** (or
>   Seahorse) and confirm the stored secret appears.
>
> The cross-platform saved-credential _behaviour_ (round-trips, re-prompt, removal)
> is covered by [`test_credential_store.py`](../tests/system/tests/test_credential_store.py);
> only the "appears in the OS store" assertion is manual. Migration _out of_ the OS
> Keychain mode is not yet implemented (the OS stores are not portably enumerable),
> so switching away from it does not migrate existing entries.

New irreducibly-manual checks should be written as guided-manual pytest tests. The legacy YAML runner below is being migrated into this flow incrementally (epic [#913](https://github.com/armaxri/termiHub/issues/913)).

#### Caps Lock warning on password fields (PR #1465, #1360)

The Caps Lock indicator depends on the OS keyboard modifier state, which the WebSocket
harness cannot toggle, so verify it manually:

1. Turn **Caps Lock ON**, then open any password field — the unlock dialog (relaunch
   with a master-password store), the connect-time password prompt, or **Settings →
   Security → Change Master Password**. Type a character.
2. Confirm the amber **"Caps Lock is on"** warning appears directly beneath the field
   (in all three consumers, since they share `PasswordInput`).
3. Press **Caps Lock** again to turn it OFF while the field stays focused — the warning
   must disappear.
4. With Caps Lock ON and the warning showing, click elsewhere to blur the field — the
   warning clears.
5. (Accessibility) With a screen reader active, confirm the warning is announced when it
   appears (it is an `role="alert"` / `aria-live="assertive"` region).

#### SSH tunnel start/stop on macOS (manual carve-out, #933)

The three **live** SSH tunnel tests in [`test_ssh_tunnels.py`](../tests/system/tests/test_ssh_tunnels.py) — `test_save_and_start_connects`, `test_start_then_stop`, `test_tunnel_runs_alongside_an_ssh_session` — **skip on macOS** and run only in the Linux integration-fixtures CI lane. Docker Desktop on macOS runs containers inside a Linux VM with no host networking, so the host-native app's russh local-forward to the published `ssh-tunnel-target` port does not drive the live tunnel to a running state the way it does under Linux Docker. The editor/list tests (TUNNEL-01..10) need no running tunnel and stay enabled on every platform. This mirrors the [`tauri-driver` macOS carve-out](#platform-support) (ADR-5).

To verify SSH tunnels actually work on macOS, do this manually against the tunnel-target container:

1. Start the fixture: `docker compose -f tests/docker/docker-compose.yml up -d ssh-tunnel-target` (published on `127.0.0.1:2207`, internal HTTP on `:8080`).
2. In termiHub, enable experimental features, create a **key-auth** SSH connection to `127.0.0.1:2207` (user `testuser`, key `tests/fixtures/ssh-keys/ed25519`).
3. Open the **Tunnels** sidebar → New Tunnel → **Local** forward: local `127.0.0.1:18083` → remote `localhost:8080`, referencing the SSH connection above. **Save & Start**.
4. Confirm the tunnel reaches a running state (sidebar shows Stop control) and `curl http://127.0.0.1:18083` returns `TUNNEL_TEST_OK`.
5. Click **Stop** and confirm the tunnel returns to disconnected and the Start control reappears.

### SSH agent forwarding (#1699)

SSH **agent forwarding** (OpenSSH `ForwardAgent`) makes the operator's local
`ssh-agent` keys reachable on the target host — and, because the forwarded-agent
channel rides the jump-host tunnel, end to end through a `ProxyJump` chain — so
onward SSH (or git over a bastion) works without copying private keys onto the
hosts. The **Forward SSH agent** toggle in the connection editor's SSH section
drives it (per-connection `forwardAgent`). The config (de)serialization, the
settings→`SshConfig` mapping, the handler-side opt-in gate, and the
no-agent-available no-op are covered by **Rust unit tests**
(`core/src/config/mod.rs`, `core/src/backends/ssh/{mod,handler,agent_forward}.rs`)
and the toggle by **Vitest/RTL** (`ConnectionEditor.test.tsx`). The forwarding
itself needs a **live agent + real SSH server**, which per-PR CI does not run
(integration lane only), so verify it manually:

1. Ensure a local agent has a key: `ssh-add -l` lists at least one identity
   (add one with `ssh-add` if needed).
2. Start an SSH fixture, e.g.
   `docker compose -f tests/docker/docker-compose.yml up -d ssh-jumphost-target ssh-jumphost-bastion`.
3. **Direct target:** create a key-auth SSH connection to the target, enable
   **Forward SSH agent**, and connect. On the target run `ssh-add -l` — it must
   list your local keys, and an onward `ssh` from the target using an agent key
   must succeed.
4. **Through a jump chain:** add the bastion as a `ProxyJump` hop to the same
   connection and reconnect. `ssh-add -l` on the final target must still list the
   local keys (forwarding survives the multi-hop tunnel).
5. **No agent:** stop the agent (unset `SSH_AUTH_SOCK` / stop the Windows OpenSSH
   agent) and connect with the toggle still on — the connection must **succeed**
   with forwarding silently skipped (a debug log line notes the skip); `ssh-add -l`
   on the target reports no agent.

Note: intermediate jump hosts are pure transport (termiHub opens no interactive
shell on a bastion), so the agent is not separately exposed as `$SSH_AUTH_SOCK`
on a hop — it is reachable on the **final target** through the chain. Genuine
per-bastion shell agent access would require opening a session on the hop and is
tracked separately if ever needed.

### SSH agent forwarding through the remote agent (#1719)

Issue #1699 delivered `forwardAgent` for the desktop russh path. When an SSH session is
routed through a **deployed termiHub agent** instead, the agent reuses the same
core SSH backend (`agent/src/registry.rs` registers
`termihub_core::backends::ssh::Ssh`) and runs it in the per-session daemon
(`agent/src/daemon/process.rs`), so `forwardAgent` is honored on the agent→target
leg by the very same connector request and handler bridge — no separate agent-side
implementation.

**Chosen model — agent-host-local agent.** The forwarded-agent channel is bridged
to the ssh-agent **local to the agent host** (`$SSH_AUTH_SOCK` on Unix, the
`\\.\pipe\openssh-ssh-agent` OpenSSH pipe on Windows). The session daemon inherits
the agent's environment (`SystemDaemonLauncher` never clears it), so no bespoke
transport is added. The important consequence: when the **desktop→agent leg is
itself SSH with agent forwarding enabled**, the agent host's `$SSH_AUTH_SOCK`
already points at a socket that forwards to the operator's own agent, so the
operator's keys reach the final target **end to end** transparently — this is
standard OpenSSH agent chaining, not a termiHub relay. The no-agent-available case
(agent host has no live ssh-agent) is the same graceful no-op as the desktop path.

The agent-side seam (the `forwardAgent` flag surviving the `TERMIHUB_SETTINGS`
daemon transport and mapping to `SshConfig.forward_agent`) is covered by **Rust
unit tests** (`agent/src/daemon/process.rs`); the connector request, handler
bridge and no-op are covered by the core tests from #1699. End-to-end forwarding
needs a live agent + real SSH server (integration lane only, not per-PR CI), so
verify manually:

1. Reach a target through a deployed agent (deploy the agent to an intermediate
   host and add an agent-routed SSH connection to the final target).
2. Ensure an ssh-agent with a key is reachable on the agent host — either run
   `ssh-add` there, or reach the agent host over SSH **with agent forwarding on**
   so its `$SSH_AUTH_SOCK` chains to your local agent.
3. Enable **Forward SSH agent** on the target connection and connect. On the
   target run `ssh-add -l` — it must list the forwarded identities, and an onward
   `ssh` from the target using an agent key must succeed.
4. **No agent:** with no ssh-agent reachable on the agent host, connect with the
   toggle still on — the connection must **succeed** with forwarding silently
   skipped (a debug log notes it).

Limitation / future work: when the desktop reaches the agent over the **TCP
transport** (`--listen`) rather than SSH, there is no SSH leg to piggyback, so the
operator's agent is only reachable if the agent host runs its own agent. Relaying
the desktop's agent to the agent host over the desktop↔agent JSON-RPC transport
would close that gap and is tracked as a follow-up.

### X11 / GUI forwarding

SSH **X11 forwarding** lets a remote GUI app (`xeyes`, `xclock`, a graphical IDE)
render as a native window on the machine running termiHub. Making a usable **local
X server** available — and tearing it down cleanly afterwards — is the X-server
provisioning subsystem (epic #1047). The strategy is chosen **per platform**, so the
verification is too. Architecture:
[X Server Provisioning](architecture.md#x-server-provisioning-ssh-x11-forwarding) and
[ADR-10](architecture.md#adr-10-per-platform-x-server-provisioning).

**Shipped across:** manual UI — settings toggles + X Servers section + setup dialog
(#1053, PRs #1110 / #1111 / #1118); connect-triggered consent + live progress (#1116,
PR #1298); unified consent UI + recoverable error / Retry (#1296, PR #1302);
cancellable readiness wait (#1260, PR #1285). This section consolidates their manual
steps in one place.

Everything below the "automated" line needs a **real local X server rendering a real
window** (or a native OS install dialog), which the harness cannot fake (per ADR-5);
those steps are the deliverable, executed by a human for the release.

#### What is automated vs. manual

| Layer                                                                                                                                                                                                        | Coverage                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Per-platform decision, adopt/spawn lifecycle, session refcount (#1107), consent gate, Linux gap classifier, VcXsrv detect + winget install decision, XQuartz detect + brew args, readiness-wait cancellation | **Rust unit tests** (`src-tauri/src/terminal/xserver/*`, `core/src/backends/ssh/x11.rs`) — run on every CI host |
| Setup dialog, connect-time consent dialog, X Servers section rows/actions                                                                                                                                    | **Vitest/RTL** component tests (`XServerSetupDialog`, `XServerConnectConsent`, `OpenConnectionsModal.xservers`) |
| A GUI app renders to an X server **headlessly, in-container** (Xvfb)                                                                                                                                         | **Docker fixture** `ssh-x11` → `render-check.sh` (automatable anywhere Docker runs)                             |
| Forwarded GUI renders into the **operator's real X server** end to end; per-OS provisioning UX; clean shutdown / no orphan                                                                                   | **Manual** (the release matrix below)                                                                           |

#### Docker fixture: `ssh-x11`

`tests/docker/ssh-x11/` is an sshd container with X11 forwarding enabled plus
`xeyes` / `xclock` / `xdpyinfo` (host port `2208`; `core/tests/common` exposes
`port_ssh_x11()`). Two baked-in helper scripts:

- **`render-check.sh`** — brings up an in-container **Xvfb** X server, launches
  `xeyes` against it, and asserts the client actually mapped a window
  (`RENDER_CHECK_OK`). This proves the "a GUI client renders to an X server"
  pipeline with **no host X server**, so it runs in any Docker environment:
  `docker compose -f tests/docker/docker-compose.yml exec ssh-x11 render-check.sh`.
- **`test-x11.sh`** — run _inside a forwarded session_
  (`ssh -X -p 2208 testuser@localhost test-x11.sh`); asserts `DISPLAY` is set and a
  client can reach the forwarded server (`X11_FORWARDING_OK`). Automatable on Linux
  with an Xvfb `:0`; on macOS it needs XQuartz (manual). See
  [`tests/docker/README.md`](../tests/docker/README.md) → _X11 forwarding_.

The container render-check is a genuine capability check, not a stand-in for the
end-to-end forward into the operator's real display — that remains the manual matrix.

#### Cross-platform release matrix

Execute once per release on a **clean box** of each OS. **This is a human release
step — it cannot be run by CI or an AI agent** (no real X server, and the per-OS
install dialogs are native). Record the result against the release.

| OS          | Strategy                                                                | Clean-box procedure                                                                                                                                                                                                                                                                                                                                                                                                                            | Pass criteria                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows** | Install VcXsrv via winget (#1318)                                       | Enable X11 on an SSH connection → first connect **pauses for consent** → **Enable** → termiHub runs `winget install -e --id marha.VcXsrv …` (or skips if already installed) → the managed server launches → a forwarded `xeyes` / `xclock` renders as a native window. **Without winget**: the error offers **Install App Installer** (opens the Store) + **Open VcXsrv download**; after installing App Installer, **Retry** installs VcXsrv. | Window renders; nothing installed silently; choice remembered (2nd X11 connect does **not** prompt); on disconnect the managed server shuts down when idle — **no orphan `vcxsrv.exe`** in Task Manager. |
| **macOS**   | Detect / guide XQuartz (`brew --cask`; guide Homebrew if absent, #1117) | Without XQuartz → connect surfaces **XQuartz-missing** guidance; run **Install**. With Homebrew present → `brew install --cask xquartz` (admin prompt). Without Homebrew → **Install Homebrew** opens a terminal tab running the official installer, then **Retry** installs XQuartz; or **Open xquartz.org** for a manual install. With XQuartz → connect launches it (`open -a XQuartz`) and a forwarded `xclock` renders.                   | Guidance never auto-installs silently; the Homebrew installer runs in a visible terminal; window renders; aborting the connect **while XQuartz is still starting** stops promptly (#1260).               |
| **Linux**   | Native X, guide-only                                                    | On a normal X / Wayland-with-XWayland desktop → connect **adopts** the running server (no prompt), forwarded `xeyes` renders. On a gap env (Wayland-only, headless, sandboxed) → connect shows the **targeted hint**.                                                                                                                                                                                                                          | Window renders on a normal desktop; each gap yields its specific actionable hint, never a silent failure or generic error (#1055).                                                                       |

Detailed per-OS procedures follow.

#### Linux X server detect-and-guide edge cases (#1055)

The Linux X-server gap classifier (`src-tauri/src/terminal/xserver/linux_gap.rs`)
turns an unreachable-server failure into a targeted hint. The classification is
covered exhaustively by unit tests (fixtures → gap → error), but confirming the
hint actually surfaces in a real edge-case environment is manual. A normal
graphical desktop must be unaffected (server adopted, no prompt).

To verify the **Wayland-without-XWayland** hint (the headline case):

1. On a Wayland-only VM/session, ensure XWayland is not installed and no X
   socket exists: `ls /tmp/.X11-unix` is empty and `echo $DISPLAY` is unset.
2. In termiHub, open an SSH connection with **X11 forwarding** enabled.
3. Confirm the connect surfaces the **XWayland** dependency hint (install
   `xwayland`, then reconnect) — not a generic "no display" error.

Optional additional cases:

- **Headless:** on a box with no local display (no `DISPLAY`, no
  `/tmp/.X11-unix`, no `Xorg`/`Xwayland`), connect with X11 forwarding and
  confirm the headless hint (graphical session / Xvfb) appears.

- **Sandboxed socket:** run termiHub as a Flatpak/Snap without the X socket
  granted; confirm the hint names the `--socket=x11` / `--socket=fallback-x11`
  grant.

#### macOS XQuartz detect + guided install (#1054)

macOS can't embed an X server, so termiHub detects XQuartz and offers an
explicit, consent-based install (`src-tauri/src/terminal/xserver/macos.rs`).
Detection is unit-tested (mock FS), but the guided install and forwarded
rendering are macOS-only and manual (per ADR-5). **No install may ever run
silently** — it happens only on the explicit install action.

On a clean macOS **without** XQuartz (`/opt/X11` and
`/Applications/Utilities/XQuartz.app` both absent):

1. Open an SSH connection with **X11 forwarding** enabled. Confirm it surfaces
   the **XQuartz missing** guidance (with a link to xquartz.org) — no silent
   install, no generic failure.
2. Trigger the install action (the `x_server_install_dependency` command, via
   the #1053 UI once present):
   - **With Homebrew installed:** confirm `brew install --cask xquartz` runs
     (admin auth prompted by brew/macOS), progress is shown, and it reports
     success.
   - **Without Homebrew (guided Homebrew install, #1117):** confirm the error
     screen offers **Install Homebrew** and **Open xquartz.org** (not a dead-end
     message). Click **Install Homebrew** → a new **local terminal tab** opens
     pre-loaded with the official Homebrew installer (`/bin/bash -c "$(curl …
install.sh)"`); the installer runs there with its real `sudo` / RETURN
     prompts (nothing installs silently). After Homebrew finishes, click
     **Retry** and confirm it now re-detects `brew` and runs
     `brew install --cask xquartz`. Alternatively, **Open xquartz.org** opens the
     manual download page (declining Homebrew — help ends there).

With XQuartz **present**:

1. Connect with X11 forwarding to a host running a GUI app (e.g. `xclock`).
   Confirm termiHub launches XQuartz if it isn't running (`open -a XQuartz`) and
   the remote window renders locally. (XQuartz's "Allow connections from network
   clients" preference may be required.)

**Cancellable readiness wait (#1260, PR #1285):** XQuartz takes ~1-2 s to create
its socket, so termiHub polls for readiness (≤ ~4 s budget). Start an X11-forwarding
connect on a box where XQuartz is **not yet running**, then **Stop** the connect
while it is still coming up. Confirm the abort takes effect **promptly** — it must
not block for the full readiness budget before the Stop is honored.

#### VcXsrv install via winget (Windows, #1318)

termiHub installs VcXsrv via **winget** on first use of SSH X11 forwarding —
symmetric to the macOS Homebrew path — and launches the installed `vcxsrv.exe`
(`src-tauri/src/terminal/xserver/windows.rs`). Detection and the install decision
are unit-tested (mock FS); the install + forwarded rendering are Windows-only and
manual. **No install may ever run silently** — only on the explicit consent /
install action.

Verify on a **clean Windows box with winget** (App Installer present), no VcXsrv
installed:

1. Trigger X server provisioning (open an SSH connection with X11 forwarding, or
   use the Open Connections **X Servers** control). Confirm termiHub runs
   `winget install -e --id marha.VcXsrv …` (winget's own UAC prompt appears),
   reports progress, and installs VcXsrv to `C:\Program Files\VcXsrv\vcxsrv.exe`.
2. Confirm the managed server then launches and a forwarded `xeyes` / `xclock`
   displays as a native window.
3. Already-installed re-run: with VcXsrv present, confirm provisioning **skips**
   the winget install and launches the server directly.

Verify on a **clean Windows box without winget** (App Installer absent):

1. Trigger the install action. Confirm the error screen offers **Install App
   Installer** (opens the Microsoft Store to the App Installer page) and **Open
   VcXsrv download** (sourceforge) — never a silent install or an opaque failure.
2. After installing App Installer, click **Retry** and confirm termiHub now
   re-detects winget and installs VcXsrv.

#### Connect-triggered X server consent + live progress (Windows, #1116)

The first time an X11-forwarding SSH connection is opened with no local X server
and automatic provisioning undecided, termiHub pauses the connect to ask for
download consent and streams provisioning progress
(`src-tauri/src/terminal/xserver/mod.rs`, `XServerConnectConsent.tsx`). The
handshake and progress emission are unit-tested; the on-connect experience is
Windows-only and manual. Verify on a clean Windows box (no VcXsrv, "Provide X
server automatically" left at its default/undecided):

1. Open an SSH connection with **X11 forwarding** enabled. Confirm the connect
   **pauses** and the "Set up X server" consent dialog appears (nothing is
   downloaded yet).
2. Choose **Enable**. Confirm live progress is shown, provisioning completes, the
   remote X client displays, and the choice is remembered — a second X11 connect
   provisions **without** re-prompting.
3. Repeat from a fresh undecided state and choose **Not now**. Confirm the SSH
   connection still opens (shell works) but without X forwarding, and that the
   next X11 connect prompts again.
4. Repeat and press **Stop** while the consent dialog is up. Confirm the connect
   aborts promptly rather than hanging.
5. Sanity: a non-Windows connect, or a connect with a server already running, is
   unaffected apart from gaining progress feedback (no prompt).
6. Force a provisioning **failure** after choosing Enable (e.g. block the VcXsrv
   download, or use a fault-injected environment). Confirm the dialog now shows a
   **recoverable error screen** with **Retry** — not a toast-and-close (#1296) —
   and that Retry re-provisions in place; on a missing-dependency failure an
   **Install** action appears. The screen must match the manual "X Servers → Set
   up" dialog (`XServerSetupContent.tsx`).

### FTP client against the FTP fixture (#1333)

Backs the FTP-client epic (#1331). The `ftp-server` Docker fixture (profile
`ftp`, see [tests/docker/README.md](../tests/docker/README.md)) provides plain
FTP, explicit FTPS, and implicit FTPS over a deterministic seeded `/pub` tree.
The **backend-independent** listing/transfer path is already covered by
`tests/docker/ftp-server/smoke-test.sh`; this manual step verifies the future
termiHub FTP **client** end-to-end once the backend sub-issues
(#1334/#1335/#1336/#1339) land.

1. Start the fixture: `docker compose -f tests/docker/docker-compose.yml --profile ftp up -d --wait ftp-server`.
2. In termiHub, add an FTP connection to `127.0.0.1:2401`, log in as
   `ftpuser` / `ftppass` (or anonymous), and open it — the file browser should
   list `/pub` with **3 folders (docs, images, data) and 14 files** of the
   documented sizes (e.g. `data/dataset-1m.bin` = 1 048 576 bytes).
3. Download `pub/data/dataset-1k.bin` and confirm it is exactly 1 024 bytes;
   upload a file into `/uploads` as `ftpuser` (anonymous uploads must be denied).
4. Repeat with **explicit FTPS** (TLS Mode = Explicit, port 2401) and **implicit
   FTPS** (TLS Mode = Implicit, port 2402); accept the self-signed cert. The
   plain-FTP insecure warning must appear only for TLS Mode = None.

### FTP symlink icon, navigation, and target in properties (#1513)

Verifies the file browser's symbolic-link handling. Parser population and the
frontend rendering/navigation are covered by unit tests
(`cargo test -p termihub-core --lib backends::ftp`, `pnpm test FileBrowser`);
this manual step confirms it end-to-end against a real FTP server whose `/pub`
tree contains a symlink (create one on the host, e.g. `ln -s data linkdir` and
`ln -s data/dataset-1k.bin linkfile` under the served root).

1. Open the FTP connection and browse to the directory holding the symlinks.
   Each symlink row must show the distinct **link-badge icon** (not a plain
   file/folder glyph) and, for `ls -l`-style listings, an inline `→ target`
   hint after the name (hovering shows the full `Symbolic link → target` title).
2. Double-click (or select + Enter) the directory symlink `linkdir` — the
   browser must **follow** it and list the target directory's contents.
3. Confirm a non-symlink file shows no link icon and no `→ target` hint.

### Docker, WSL, and SFTP symlink icon and target (#1523)

Extends the #1513 symlink handling to the Docker, WSL, and SFTP browsers. The
Docker `find`/`stat` parsers are covered by unit tests
(`cargo test -p termihub-core --all-features --lib backends::docker`); the SFTP
`readlink` and WSL `symlink_metadata` paths need a live server/distribution, so
confirm them manually. In each case, on the host create a symlink to a file and
one to a directory (e.g. `ln -s data linkdir` and `ln -s data/file.bin linkfile`).

1. **Docker** — connect to a running container, browse to a directory holding
   symlinks. Each link row shows the distinct **link-badge icon** and an inline
   `→ target` hint; a directory symlink follows into the target on double-click.
2. **SFTP (SSH)** — browse an SSH connection's directory containing symlinks.
   Each link row shows the link-badge icon and the `→ target` hint (resolved via
   a best-effort `readlink`); a plain file shows neither.
3. **WSL** (Windows only) — browse a WSL distribution's directory containing
   symlinks. Each link row shows the link-badge icon and, where the target could
   be read, the `→ target` hint.

### FTP transfer queue: concurrency, pause/resume, retry, resume (#1336)

Verifies the shared transfer-queue model (queue / bounded concurrency /
pause / resume / auto-retry / `REST` resume) and FTP up/download end-to-end.
Requires an `ftp`-feature build (default) and the FTP fixture from the section
above (`--profile ftp`, `127.0.0.1:2401`, `ftpuser` / `ftppass`). The live
byte-exact + kill/resume Docker integration test is deferred to a follow-up;
verify manually until it lands. See PR #1509.

1. **Concurrency cap + queue:** start **three** downloads of large files (e.g.
   `pub/data/dataset-1m.bin` to three local paths) in quick succession. Confirm
   at most **two** are `active` at once and the third shows `queued`; when one
   finishes, the queued one promotes to `active` automatically.
2. **Pause / resume:** pause an active download mid-flight. Confirm it stops
   moving bytes (state `paused`) and a queued transfer takes its slot. Resume it
   and confirm it continues from where it stopped (via `REST`) and completes to
   the exact original byte size — not restarting from zero.
3. **Cancel:** cancel a queued transfer (it just disappears) and an active one
   (its partial local file is removed). Both leave browsing responsive.
4. **Auto-retry / backoff:** start a transfer, then break the server mid-flight
   (e.g. `docker pause` the `ftp-server` container). Confirm the transfer reports
   `failed (n/3)` and auto-retries with increasing backoff; unpause the container
   before the 3rd attempt and confirm it resumes and completes. Leave it paused
   past 3 attempts to confirm it surfaces a permanent failure, then use retry to
   restart it once the server is back.
5. **Upload:** repeat 1–4 for uploads into `/uploads` as `ftpuser`, confirming
   byte-exact results and that concurrent uploads use separate connections.

### Transfer Queue panel: rows, controls, minimized state (#1337)

Verifies the connection-type-agnostic Transfer Queue panel UI docked above the
status bar. Use the FTP fixture from the section above (or an SFTP session) to
drive real transfers. See PR #1530.

1. **Panel appears with a live row:** start a download of a large file. Confirm
   the panel docks above the status bar with one row showing the direction
   arrow, file name, remote path, an animating progress bar, a rising percent,
   and a live throughput (e.g. `112 KB/s`). The header summary reads
   `N active …`.
2. **Per-state controls:** while active the row shows **Pause** + **Cancel**.
   Pause it → the row turns `paused` (amber bar) and shows **Resume** +
   **Cancel**; Resume returns it to `active`. Let one complete → it stays as a
   green `done` row with a **Remove** control. Break the server mid-flight to get
   a `failed (n/3)` row (red bar, error tooltip) showing **Retry** + **Remove**.
   Cancel an active transfer → it becomes a `cancelled` row with **Retry** +
   **Remove**. Confirm every control shows pending feedback and a success/error
   toast.
3. **Footer actions:** with a mix of completed and active rows, click **Clear
   Completed** → only the `done` rows disappear; failed/cancelled/active stay.
   Click **Cancel All** → every in-progress transfer is cancelled.
4. **Minimize / restore:** click **Minimize** in the panel header → the panel
   collapses and a status-bar indicator shows `N transferring` with a count
   badge. Click the indicator → the panel re-expands. Confirm the indicator
   disappears when the queue is emptied.
5. **Visual review (light + dark):** switch themes and confirm the bar colours
   (accent/amber/green/red), status text colours, and count badge match the
   concept mockup (`docs/concepts/implemented/ftp-client.html`), with no raw scroll
   bar or off-token colours.

### Remote system monitoring

#### Monitoring auto-reconnect on a mid-stream drop (#1230)

Verifies that remote system monitoring auto-reconnects after a transient
transport drop and resolves to `Offline` when the reconnect budget is
exhausted. Pending a fault-injection system test (follow-up), verify manually:

1. Start the SSH test containers (`tests/docker/`) and open an SSH connection to
   `ssh-password:2201`. Confirm the status-bar monitoring chips show live CPU /
   memory / disk (`Live`).
2. **Transient drop → recovery:** briefly interrupt the monitored host's sshd
   (e.g. `docker pause`/`unpause` the container, or drop the network for a few
   seconds via the `network-fault-proxy`). Confirm the status bar dims and shows
   **Stale**, then **Reconnecting**, and returns to live numbers automatically
   once the host is reachable again — no manual Kill / re-pick.
3. **Exhausted backoff → Offline:** stop the monitored host's sshd and leave it
   down. Confirm monitoring goes `Stale` → `Reconnecting`, retries under an
   increasing backoff (capped at 30 s), and after the attempt budget resolves to
   **Offline** and stops retrying (no runaway reconnect loop).
4. Repeat against a monitored host **behind the agent** (agent monitoring
   subscription) to confirm the agent mirrors the same behavior.

### Design tokens: pill radius + muted text (#1406)

Verifies the `--radius-full` and `--text-muted` design tokens render their
intended pill radius / muted color across every theme (they were previously
referenced but undefined). See PR #1421. Purely visual, so manual.

For **each** theme (Dark, Light, Solarized Dark, Solarized Light — switch via
Settings):

1. Open the **Open Connections** panel (Settings wheel → Open Connections).
   Confirm the section-count and `.oc-row__badge` pills have fully rounded
   (pill) corners, and that muted row text (icons, detail text, muted titles)
   reads as lower-emphasis than the primary row title — not black/transparent.
2. Trigger the **X server setup dialog** and confirm the progress bar is fully
   rounded and any muted helper text renders in the theme's muted color.
3. Confirm **status bar** muted text renders with the per-theme muted color
   (visible but de-emphasized) rather than a broken fallback.

### Legacy Guided Manual Test Runner (YAML)

The remaining manual test items are still defined as machine-readable YAML in [`tests/manual/*.yaml`](../tests/manual/). The standalone runner presents applicable tests one at a time, manages infrastructure, and generates a JSON report. It is being subsumed by the harness flow above:

```bash
# Run all manual tests for the current platform
python scripts/test-manual.py

# List applicable tests without running
python scripts/test-manual.py --list

# Run a specific category or single test
python scripts/test-manual.py --category ssh
python scripts/test-manual.py --test MT-LOCAL-03

# Resume an interrupted session
python scripts/test-manual.py --resume tests/reports/manual-*.json
```

See [scripts/README.md](../scripts/README.md) for all options. Reports are saved to `tests/reports/`.

### Test Categories

| Category              | YAML File                                                                  | ID Prefix  |
| --------------------- | -------------------------------------------------------------------------- | ---------- |
| Local Shell           | [`local-shell.yaml`](../tests/manual/local-shell.yaml)                     | `MT-LOCAL` |
| SSH                   | [`ssh.yaml`](../tests/manual/ssh.yaml)                                     | `MT-SSH`   |
| Serial                | [`serial.yaml`](../tests/manual/serial.yaml)                               | `MT-SER`   |
| Tab Management        | [`tab-management.yaml`](../tests/manual/tab-management.yaml)               | `MT-TAB`   |
| Connection Management | [`connection-management.yaml`](../tests/manual/connection-management.yaml) | `MT-CONN`  |
| File Browser + Editor | [`file-browser.yaml`](../tests/manual/file-browser.yaml)                   | `MT-FB`    |
| UI / Layout           | [`ui-layout.yaml`](../tests/manual/ui-layout.yaml)                         | `MT-UI`    |
| Remote Agent          | [`remote-agent.yaml`](../tests/manual/remote-agent.yaml)                   | `MT-AGENT` |
| Credential Store      | [`credential-store.yaml`](../tests/manual/credential-store.yaml)           | `MT-CRED`  |
| Keyboard Shortcuts    | [`keyboard.yaml`](../tests/manual/keyboard.yaml)                           | `MT-KB`    |
| Cross-Platform        | [`cross-platform.yaml`](../tests/manual/cross-platform.yaml)               | `MT-XPLAT` |
| Portable Mode         | [`portable-mode.yaml`](../tests/manual/portable-mode.yaml)                 | `MT-PORT`  |
| Embedded Services     | [`embedded-services.yaml`](../tests/manual/embedded-services.yaml)         | `MT-SVC`   |
| Network Tools         | [`network-tools.yaml`](../tests/manual/network-tools.yaml)                 | `MT-NET`   |

When adding new manual tests, add the YAML definition to the appropriate file in `tests/manual/` — the YAML files are the **source of truth** for guided testing.

### E2E Coverage Map

Mapping of manual test IDs that have been automated to their Python harness test files:

| Manual Test IDs                  | E2E Test File                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MT-LOCAL-01, 07                  | `tests/system/tests/test_local_shell.py`                                                                                                                                                 |
| MT-LOCAL-09, 10                  | `tests/system/tests/test_cross_platform.py`                                                                                                                                              |
| MT-LOCAL-02, 04, 06, 11–20       | `tests/system/tests/test_windows_shells.py` (Windows-only; WSL cases skip without WSL2)                                                                                                  |
| MT-SSH-04–06, 10–12, 20–33, 35   | `tests/system/tests/test_ssh*.py`                                                                                                                                                        |
| MT-SSH-19 (X11 backward-compat)  | `tests/system/tests/test_connection_forms.py`                                                                                                                                            |
| MT-SSH-08 (agent-auth warning)   | _dropped_ (`agent` is no longer a selectable SSH auth method)                                                                                                                            |
| MT-SSH-13, 17, 34                | `tests/system/tests/test_ssh_extended.py`                                                                                                                                                |
| SERIAL-01, 05 + custom path      | `tests/system/tests/test_serial.py`                                                                                                                                                      |
| MT-SER-09 (live serial I/O)      | _manual_ (no host socat echo fixture in harness yet, #859)                                                                                                                               |
| TELNET-01–03                     | `tests/system/tests/test_telnet.py`                                                                                                                                                      |
| MT-TAB-01–05, 15, 18             | `tests/system/tests/test_tab_management.py`                                                                                                                                              |
| MT-TAB-08–14, 19–21              | `tests/system/tests/test_tab_horizontal_scroll.py`                                                                                                                                       |
| MT-CONN-02–07, 25–30             | `test_connection_crud.py`, `test_connection_forms.py`, `test_connection_editor.py`                                                                                                       |
| MT-CONN-10–11, 13                | `tests/system/tests/test_export_import.py`                                                                                                                                               |
| MT-CONN-12, 14–16 (enc. import)  | _manual_ (import opens a native OS file picker)                                                                                                                                          |
| MT-CONN-20–22, 31                | `tests/system/tests/test_external_files.py`                                                                                                                                              |
| MT-FB-01, 02                     | `tests/system/tests/test_file_browser_local.py`                                                                                                                                          |
| MT-FB-03, 13, 19                 | `tests/system/tests/test_sftp_infra.py`                                                                                                                                                  |
| MT-FB-06, 17                     | _manual_ (serial not bridge-selectable; SFTP fault injection)                                                                                                                            |
| MT-FB-05, 11, 18                 | `tests/system/tests/test_file_browser_local.py`                                                                                                                                          |
| EDITOR-01/STATUS/INDENT/LANG     | `tests/system/tests/test_editor.py`                                                                                                                                                      |
| #504 (terminal auto-scroll)      | `tests/system/tests/test_terminal_auto_scroll.py`                                                                                                                                        |
| MT-UI-06–08                      | `tests/system/tests/test_ui_state.py`                                                                                                                                                    |
| MT-UI-17, 18, 20                 | _manual_ (OS window resize / dev favicon — not bridge-drivable)                                                                                                                          |
| MT-UI-21                         | `tests/system/tests/test_sidebar_sections.py`                                                                                                                                            |
| MT-UI-22–25                      | _manual_ (separator size/cursor, overflow scroll — visual)                                                                                                                               |
| MT-AGENT (create/error/setup)    | `tests/system/tests/test_remote_agent.py` (create, error dialog, setup wizard vs. the password container)                                                                                |
| MT-AGENT (live connect/sessions) | `tests/system/tests/test_remote_agent_live.py` (live connect + shells, child shell session, persistent-session reconnect, connected-agent menu — vs. the deployed-agent container, #995) |
| MT-AGENT (update banner)         | `test_agent_update_banner_live.py` (surfacing, gates, dismiss) + `test_agent_update_apply_now_live.py` (Apply Now live deferred/busy vs. armed container — #1520/#1546)                  |
| MT-CRED-04–08                    | `tests/system/tests/test_credential_store.py`                                                                                                                                            |
| MT-RECOVERY-01–06                | `tests/system/tests/test_config_recovery.py`                                                                                                                                             |
| MT-RECOVERY-07–12                | covered by `test_connection_crud.py` / `test_credential_store.py` / `test_export_import.py` / `test_external_files.py`                                                                   |
| MT-XPLAT-01, 02                  | `tests/system/tests/test_cross_platform.py`                                                                                                                                              |
| MT-SVC-01, 02, 03                | `tests/system/tests/test_embedded_services.py` (SVC-01..11)                                                                                                                              |
| MT-SVC-04, 05 (transfer)         | `tests/system/tests/test_embedded_services.py` (SVC-12 FTP, SVC-13 TFTP via curl)                                                                                                        |
| MT-NET-01–09                     | `tests/system/tests/test_network_tools.py`                                                                                                                                               |
| MT-NET-10, 12, 14, 17, 18        | `tests/system/tests/test_network_tools_live.py` (loopback + local stdlib servers; no Docker `network` profile)                                                                           |
| MT-NET-13                        | _manual_ (large-range warning is a native `window.confirm()`, no `data-testid`)                                                                                                          |

#### WSL shell-integration note (`/mnt/<drive>` translation, #1029)

The WSL file browser follows the shell's CWD via an injected **OSC 7** hook and
translates `/mnt/<letter>` into a native Windows drive path (`C:/`) rather than
the inaccessible `\\wsl$\` UNC view. How the shell exposes `PROMPT_COMMAND`
varies by distro, which affects how the hook must register:

- **Scalar `PROMPT_COMMAND`** (Ubuntu/Debian and most distros) — termiHub
  prepends its hook as a string.
- **Array `PROMPT_COMMAND`** (bash 5.1+, e.g. **Fedora**, which also ships no
  `vte.sh` and tracks context via systemd's OSC 3008) — termiHub appends its
  hook as a first-class array element (`PROMPT_COMMAND+=(__termihub_osc7)`).
  A scalar assignment here would only overwrite element `[0]`, which caused the
  file browser to settle on the `\\wsl$\` UNC root after `cd /mnt/c` (#1029).

`MT-LOCAL-19` (`test_wsl_file_browser_follows_cwd`) exercises the scalar path on
a general-purpose distro (Ubuntu is preferred by `_pick_wsl_distro`). The
array-`PROMPT_COMMAND` shape is covered by Rust unit tests
(`osc7_bash_handles_array_prompt_command`, `osc7_wsl_handles_array_prompt_command`
in `core/src/session/shell.rs`) and was manually verified end-to-end on
FedoraLinux-44 (bash 5.3): `cd /mnt/c` emits `file:///mnt/c` → `C:/`.

#### macOS Finder Quick Actions / Services registration (#1369)

termiHub registers each configured shell-integration entry as an Automator
Quick Action bundle under `~/Library/Services/<name>.workflow`
(`src-tauri/src/spawn/registry.rs`, macOS arm). The generated bundle layout,
`document.wflow` command line, `Info.plist` NSServices declaration, XML escaping,
idempotent install, and owner-aware uninstall are covered by macOS-gated unit
tests (`spawn::registry::macos_tests`). Confirming that Finder actually surfaces
and runs the entries is macOS-only and manual (per ADR-5).

On macOS:

1. Configure at least one shell-integration entry, then run the install action
   (the `install_shell_integration` command, or `termiHub install-shell-integration`).
2. Confirm a `<entry-name>.workflow` bundle appears under `~/Library/Services/`
   for each entry (`ls ~/Library/Services`), each containing
   `Contents/document.wflow` and `Contents/Info.plist`.
3. In **System Settings → Keyboard → Keyboard Shortcuts → Services** (or
   right-click a folder/file in Finder → **Quick Actions** / **Services**),
   confirm the entry is listed. If a new entry does not appear, log out/in or run
   `/System/Library/CoreServices/pbs -flush` to refresh the Services cache.
4. Right-click a folder in Finder → choose the entry → confirm termiHub opens a
   session at that path (the workflow runs
   `termiHub spawn --entry-id <id> --location "$@"`). Repeat on a file for an
   entry whose **Show for → Files** is enabled.
5. Run the uninstall action (`uninstall_shell_integration` /
   `termiHub uninstall-shell-integration`) and confirm the termiHub `.workflow`
   bundles are removed from `~/Library/Services/` while any unrelated
   third-party Quick Actions there are left untouched.

> Note: the app-level `NSServices` entry declared in `src-tauri/Info.plist` is a
> discovery aid; the fully functional path is the per-entry Quick Action bundles
> above. Wiring a native Services provider so the **app** entry also runs is
> tracked as a follow-up.

#### Linux file-manager registration (#1370)

termiHub registers each configured shell-integration entry into the Linux file
managers (`src-tauri/src/spawn/registry.rs`, Linux arm): a universal XDG
`.desktop` launcher plus per-manager Nautilus scripts, KDE service menus, and a
Thunar custom action. The file content, `0o755` script mode, detection logic,
Thunar `uca.xml` append/de-append (foreign-action preservation), and
owner-aware uninstall are covered by Linux-gated unit tests
(`spawn::registry::linux::tests`, validated by the Linux CI job). Confirming
each file manager actually surfaces and runs the entries is desktop-environment
specific and manual.

On a Linux desktop (run steps for whichever managers you have installed):

1. Configure at least one shell-integration entry with **Show for → Folders**
   enabled and its per-manager toggles (Nautilus / KDE / Thunar) on. Run the
   install action (the `install_shell_integration` command, or
   `termiHub install-shell-integration`).
2. **XDG (universal):** confirm a `termihub-<slug>.desktop` file appears under
   `~/.local/share/applications/` and that `update-desktop-database` ran
   (`grep -l termiHub ~/.local/share/applications/mimeinfo.cache` or simply
   right-click a folder → **Open With Other Application** and confirm termiHub is
   listed for folders).
3. **Nautilus (GNOME Files):** confirm a script named after the entry exists
   under `~/.local/share/nautilus/scripts/` and is executable (`ls -l`; mode
   `0o755`). In Files, right-click a folder → **Scripts → <entry name>** and
   confirm termiHub opens a session at that path.
4. **KDE (Dolphin):** confirm a `termihub-<slug>.desktop` service menu exists
   under `~/.local/share/kio/servicemenus/` (KDE 6) and/or
   `~/.local/share/kservices5/ServiceMenus/` (KDE 5). Right-click a folder in
   Dolphin → **Actions** (or the top-level menu) → confirm the entry runs.
5. **Thunar (XFCE):** confirm the action was appended to
   `~/.config/Thunar/uca.xml` (`grep termihub- ~/.config/Thunar/uca.xml`) and
   that **any custom actions you had before are still present**. In Thunar,
   right-click a folder → confirm the entry appears and opens a termiHub session.
6. Run the uninstall action (`uninstall_shell_integration` /
   `termiHub uninstall-shell-integration`) and confirm **all four** artifacts are
   removed: the XDG `.desktop`, the Nautilus script, the KDE service menu, and
   termiHub's Thunar action — while any **foreign** Thunar actions in `uca.xml`
   and unrelated Nautilus scripts remain untouched.

### Sudo-elevated remote save over SFTP (#1328)

Verifies the `sftp_write_file_content_elevated` backend command: a temp upload
followed by an in-place `sudo -S` rewrite over the exec channel, with typed
outcomes and guaranteed temp cleanup. The command composition, injection
neutralization, and sudo error classification are covered by unit tests
(`cargo test -p termihub --lib files::sftp`); exercising it against a real host
with `sudo` is manual. See PR for #1328.

On a real host where your SSH user has `sudo` rights (e.g. a Raspberry Pi):

1. Open an SFTP session to the host and pick a **root-owned** file the user
   cannot write directly (e.g. `/etc/nginx/nginx.conf` or a `root:root`,
   `-rw-r--r--` file). Change a line and trigger the elevated save
   (`sftpWriteFileContentElevated`) with the **correct** sudo password.
2. Confirm the result is `success`, the file's contents are updated, and its
   owner/mode are **unchanged** (`ls -l` still shows the original `root:root`
   and permission bits — `cat >` rewrote in place, it did not replace the file).
   Confirm no `/tmp/termihub-*` file remains (`ls /tmp/termihub-*` → none).
3. Repeat with a **wrong** password → the result is `incorrectPassword` (safe to
   re-prompt), the file is unchanged, and no `/tmp/termihub-*` temp is left
   behind.
4. On a host where the user is **not** in the sudoers file (or `sudo` is not
   installed) → the result is `other` with a descriptive message, the file is
   unchanged, and no temp file remains.
5. Inspect the LogViewer / backend logs during all of the above and confirm the
   **sudo password never appears** in any log line.

### Application log file (#1570)

Rotation, capping, the platform log-directory resolution, and the INFO-level file
filter are covered by unit tests (`src-tauri/src/utils/file_log.rs`). The steps
below are manual because they need a **bundled** app: only a real install exercises
the launch path a post-mortem cares about, and the point of the feature is that the
evidence exists on disk after the process is gone. Referenced by PR #1578.

**A run leaves a log behind, on every platform.**

1. Launch the installed app and open a session, then locate the log file:
   - macOS: `~/Library/Logs/com.termihub.app/termihub.log`
   - Windows: `%LOCALAPPDATA%\com.termihub.app\logs\termihub.log`
   - Linux: `~/.local/share/com.termihub.app/logs/termihub.log`
2. Confirm the file exists and its first line of the run is the
   `termiHub starting` banner carrying the **version** and **pid**.
3. Confirm entries are timestamped, carry a level and a target, and contain **no
   ANSI escape sequences** (the file is read in a plain editor, not a terminal).

**A clean exit is visible as a clean exit.**

1. Close the app via the **window close button**. Re-open the log and confirm it
   ends with the full breadcrumb sequence: `Window close requested`,
   `Exit requested, shutting down`, then `termiHub exited cleanly` — whose absence
   in the 2026-07-17 investigation forced the reconstruction from Apple's unified
   log.
2. Relaunch and quit via the **app menu / Cmd+Q** instead. Confirm the log ends with
   `termiHub exited cleanly`. Note that this path emits **only** that line — Tauri
   raises neither `CloseRequested` nor `ExitRequested` for a menu quit, so
   `termiHub exited cleanly` is the one marker common to every clean exit and the
   line to look for. Do not treat a missing `Exit requested` as evidence of a crash.
3. Relaunch, then **kill** the app (`kill -9`, or Force Quit). Confirm the log ends
   _without_ `termiHub exited cleanly` — a killed run is distinguishable from a clean
   one by inspection alone, which is the whole point.
4. Relaunch once more and confirm the new run **appends** below the previous one
   rather than truncating it, so the run before an incident survives the restart.

**The cap holds and secrets stay out.**

1. Connect to an SSH host using a password and/or unlock the credential store.
   Confirm the log records the _actions_ ("Unlocking credential store") but that
   the password, passphrase, and private-key material appear **nowhere** in the
   file. Confirm terminal contents are not logged.
2. Relaunch with `TERMIHUB_FILE_LOG=debug` and open an SSH session. Confirm the
   file gains termiHub's own DEBUG detail but still contains **no `russh` packet
   logging** — raising termiHub's verbosity must never unclamp SSH internals into
   a file users paste into issues (`russh` is held at WARN on top of any override).
3. To exercise rotation without waiting for 5 MiB, append filler to the live file
   (`python3 -c "open('termihub.log','a').write('x'*(5*1024*1024))"`) and relaunch:
   the startup banner alone then trips the cap. Confirm `termihub.log` starts fresh
   with the banner, the previous content moved to `termihub.1.log`, and that after
   enough churn `termihub.2.log` is the oldest kept — `termihub.3.log` must
   **never** appear and the directory must stay under ~15 MiB.

### Workflow editor menus are clickable inside the modal (#1868)

The workflow editor is a modal Radix `Dialog`, which sets `pointer-events: none`
on `document.body` while open. Any Radix menu/select that portals to
`document.body` (the default) therefore renders **outside** the dialog and is
dead/unclickable in a real WebView. jsdom does not enforce `pointer-events`, so
unit tests structurally cannot catch this — hence a manual test in the running
app. The fix portals these into the dialog's own content node (via the shared
`Modal` primitive's portal container). Referenced by PR for #1868.

**Launch the app** (`./scripts/dev.sh` — never `pnpm tauri dev`).

**The "+ Add step…" menu works.**

1. Open the **Workflows** panel → **New Workflow**.
2. Click **"+ Add step…"**. Confirm the step-kind menu **opens and each item is
   clickable** (not just visible). Add one of every kind — send-command,
   run-script, run-macro, wait, run-local-process — confirming each appends a
   step row.

**Pickers inside the editor work.**

1. On a **Run macro** step, open the **Macro** `Select` and confirm the listbox
   opens and a macro can be selected (this `Select` portals to the same place
   and was dead for the same reason).
2. Reorder, edit, and delete steps as normal to confirm the fix changed nothing
   else about the editor's behavior.
3. Save the workflow and confirm it persists with the steps you added.
