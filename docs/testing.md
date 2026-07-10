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

Add to `.github/workflows/test.yml`:

```yaml
name: Tests

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - run: npm run test:coverage
      - uses: codecov/codecov-action@v3

  system-tests:
    # System / E2E coverage runs through the Python bridge harness
    # (tests/system/), which talks to the app over a WebSocket bridge and needs
    # no tauri-driver — so it runs on all three OSes. See tests/system/README.md.
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: ./scripts/test-system-py.sh -m integration
```

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

termiHub includes a comprehensive test infrastructure with 13 Docker containers (SSH variants, telnet, serial, SFTP stress, network fault injection) and Rust integration tests that exercise the app's backends directly. See the [concept document](concepts/comprehensive-test-infrastructure.md) for the full design.

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

# Stop all containers
docker compose -f tests/docker/docker-compose.yml --profile all down
```

> **Podman users:** The test system scripts auto-detect Podman when Docker is not available.
> You can also force a specific runtime: `CONTAINER_CMD=podman ./scripts/test-system-linux.sh`

### Test Suites

| Suite               | File                                        | Docker Containers                          | Description                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH Auth            | `core/tests/ssh_auth.rs`                    | ssh-password:2201, ssh-keys:2203           | Password, 6 key types, 5 passphrase keys, wrong credentials, wrong passphrase                                                                                                                                                                                                                                                                         |
| SSH Compat          | `core/tests/ssh_compat.rs`                  | ssh-legacy:2202                            | Legacy OpenSSH 7.x compatibility                                                                                                                                                                                                                                                                                                                      |
| SSH Advanced        | `core/tests/ssh_advanced.rs`                | bastion:2204, restricted:2205, tunnel:2207 | Jump host, restricted shell, TCP tunneling                                                                                                                                                                                                                                                                                                            |
| SSH Banner          | `core/tests/ssh_banner.rs`                  | ssh-banner:2206, ssh-password:2201         | Pre-auth banner text, no-banner on standard server, banner on failed auth                                                                                                                                                                                                                                                                             |
| Telnet              | `core/tests/telnet.rs`                      | telnet:2301                                | Connect, output subscribe, login flow                                                                                                                                                                                                                                                                                                                 |
| SFTP Stress         | `core/tests/sftp_stress.rs`                 | sftp-stress:2210                           | Large files, deep trees, symlinks, special filenames, permissions                                                                                                                                                                                                                                                                                     |
| Network Resilience  | `core/tests/network_resilience.rs`          | network-fault:2209                         | Latency, packet loss, throttle, disconnect, jitter, corruption                                                                                                                                                                                                                                                                                        |
| Monitoring          | `core/tests/monitoring.rs`                  | ssh-password:2201                          | CPU, memory, disk stats, stats under load                                                                                                                                                                                                                                                                                                             |
| Agent Deploy SFTP   | `src-tauri/src/utils/remote_exec.rs`        | ssh-password:2201                          | Uploads a file over SFTP and reads it back, exercising the agent auto-deploy `block_in_place` path from `spawn_blocking` (#828/#837). In the desktop crate: `cargo test -p termihub --lib agent_deploy`. Pinned to password auth; port via `TERMIHUB_TEST_SSH_PASSWORD_PORT` (default 2201) — see [Parallel test isolation](#parallel-test-isolation) |
| SSH Banner (system) | `tests/system/tests/test_ssh_banner.py`     | ssh-banner:2206                            | Pre-auth banner / MOTD display (ported from `ssh-banner.test.js`)                                                                                                                                                                                                                                                                                     |
| SSH Keys (system)   | `tests/system/tests/test_ssh_keys.py`       | ssh-keys:2203                              | Key-based auth flows (ported from `ssh-keys.test.js`)                                                                                                                                                                                                                                                                                                 |
| SSH Infra (system)  | `tests/system/tests/test_ssh.py`            | ssh-password:2201, ssh-keys:2203           | Password/key auth, password-prompt modal, connection failure, session output, monitoring show/hide (ported from `ssh.test.js`)                                                                                                                                                                                                                        |
| Win Shells (system) | `tests/system/tests/test_windows_shells.py` | none                                       | PowerShell / cmd.exe selection, rendering, input, the shell selector, and WSL sessions (cwd / `/mnt` path translation). Windows-only; WSL cases skip without WSL2 (ported from `windows-shells.test.js`, #975)                                                                                                                                        |

### Skip Behavior

All Rust integration tests use the `require_docker!` macro which checks TCP port connectivity at runtime. If the required Docker container is not running, the test prints a message and returns early (no failure). This means you can run `cargo test` without Docker and only the tests requiring containers will be skipped.

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

#### Setup

Each checkout owns a gitignored `dev.local.json`. Create it from the committed
template and edit the values:

```bash
cp default.dev.local.json dev.local.json
```

| Key                | Default    | Purpose                                                                                                                                                       |
| ------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev_port`         | `1420`     | Vite dev-server port for `./scripts/dev.sh` (HMR uses `dev_port + 1`).                                                                                        |
| `dev_agent_port`   | `2222`     | Local `sshd` port `./scripts/dev.sh` starts for the dev agent (Unix only).                                                                                    |
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
added to _every_ base test port, and the base ports span `2201…8080`, so the step
must exceed that whole span or ranges would overlap); `dev_port` and
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

#### What is isolated, and how

`dev.local.json` resolves into a canonical set of environment variables that
every entry point honours. The resolver lives in two mirrored forms:

- **Shell:** `scripts/internal/dev-local-env.sh` — sourced by `test.sh`,
  `test-system*.sh`, and the E2E runner; exports `COMPOSE_PROJECT_NAME`,
  `TERMIHUB_TEST_PORT_OFFSET`, the per-service `TERMIHUB_TEST_*_PORT` values, the
  serial device paths, and `TERMIHUB_TAURI_DRIVER_PORT`.
- **Python:** `termihub_harness.dev_local` — read by the bridge-harness Docker
  fixtures so the harness publishes/looks up the same offset ports and runs
  `compose` under the same project name.

| Resource                         | Base (offset 0)                 | Derivation                                                                 |
| -------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| Docker container / network names | `termihub-*` / `termihub-*-net` | Prefixed with `compose_project` (`COMPOSE_PROJECT_NAME`).                  |
| SSH / telnet / HTTP host ports   | `2201–2211`, `2301`, `8080`     | `base + test_port_offset`, published by `tests/docker/docker-compose.yml`. |
| SSH-tunnel test ports            | `18081–18088`                   | `base + test_port_offset`.                                                 |
| Virtual serial device paths      | `/tmp/termihub-serial-{a,b}`    | Suffixed with `compose_project`.                                           |
| `tauri-driver` (E2E) port        | `4444`                          | `4444 + test_port_offset`.                                                 |

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

#### SSH tunnel start/stop on macOS (manual carve-out, #933)

The three **live** SSH tunnel tests in [`test_ssh_tunnels.py`](../tests/system/tests/test_ssh_tunnels.py) — `test_save_and_start_connects`, `test_start_then_stop`, `test_tunnel_runs_alongside_an_ssh_session` — **skip on macOS** and run only in the Linux integration-fixtures CI lane. Docker Desktop on macOS runs containers inside a Linux VM with no host networking, so the host-native app's russh local-forward to the published `ssh-tunnel-target` port does not drive the live tunnel to a running state the way it does under Linux Docker. The editor/list tests (TUNNEL-01..10) need no running tunnel and stay enabled on every platform. This mirrors the [`tauri-driver` macOS carve-out](#platform-support) (ADR-5).

To verify SSH tunnels actually work on macOS, do this manually against the tunnel-target container:

1. Start the fixture: `docker compose -f tests/docker/docker-compose.yml up -d ssh-tunnel-target` (published on `127.0.0.1:2207`, internal HTTP on `:8080`).
2. In termiHub, enable experimental features, create a **key-auth** SSH connection to `127.0.0.1:2207` (user `testuser`, key `tests/fixtures/ssh-keys/ed25519`).
3. Open the **Tunnels** sidebar → New Tunnel → **Local** forward: local `127.0.0.1:18083` → remote `localhost:8080`, referencing the SSH connection above. **Save & Start**.
4. Confirm the tunnel reaches a running state (sidebar shows Stop control) and `curl http://127.0.0.1:18083` returns `TUNNEL_TEST_OK`.
5. Click **Stop** and confirm the tunnel returns to disconnected and the Start control reappears.

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
