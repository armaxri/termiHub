# Testing Strategy for termiHub

## Overview

termiHub uses a multi-layered testing approach to ensure quality across the entire stack.

## Testing Layers

```
┌─────────────────────────────────────┐
│   E2E Tests (WebdriverIO)           │  ← User flows, click automation
├─────────────────────────────────────┤
│   Integration Tests (Rust + React)  │  ← Component + Backend integration
├─────────────────────────────────────┤
│   Unit Tests                         │  ← Individual functions
│   - Rust (cargo test)               │
│   - React (Vitest)                   │
└─────────────────────────────────────┘
```

## 1. E2E Testing with WebdriverIO

**What it does**: Automates complete user workflows
**Use for**:

- Creating terminal connections
- Opening multiple tabs
- Drag & drop functionality
- Split view operations
- File browser interactions

### Platform Support

> **Important:** `tauri-driver` (the WebDriver proxy that bridges WebdriverIO to Tauri's WebView) only supports **Linux** (WebKitGTK via `WebKitWebDriver`) and **Windows** (Edge WebView2 via `msedgedriver`). It does **not** support macOS because Apple provides no WKWebView driver — `safaridriver` only controls Safari the browser, not WKWebView instances embedded in apps. This is a known upstream limitation ([tauri-apps/tauri#7068](https://github.com/tauri-apps/tauri/issues/7068)).
>
> **On macOS**, E2E tests run inside a Docker container with a Linux environment (Xvfb + WebKitGTK + tauri-driver). This tests the Linux build of the app, which shares the same React UI and Rust backend logic. macOS-specific rendering behavior (WKWebView quirks) must be verified via [manual testing](#manual-testing).
>
> **Future:** The experimental [danielraffel/tauri-webdriver](https://github.com/danielraffel/tauri-webdriver) project (Feb 2026) aims to provide native WKWebView WebDriver support via a Tauri plugin. If it matures, it could enable native macOS E2E testing without Docker. See ADR-5 in [architecture.md](architecture.md).

### Setup

```bash
npm install --save-dev \
  @wdio/cli \
  @wdio/local-runner \
  @wdio/mocha-framework \
  @wdio/spec-reporter \
  wdio-tauri-service
```

### Configuration (`wdio.conf.js`)

See [`wdio.conf.js`](../wdio.conf.js) in the project root.

### Example E2E Test

```javascript
// tests/e2e/terminal-creation.test.js
describe("Terminal Creation Flow", () => {
  it("should create a new local bash terminal", async () => {
    // Open sidebar
    await browser.$('[data-testid="activity-bar-connections"]').click();

    // Click "New Connection"
    await browser.$('[data-testid="new-connection-btn"]').click();

    // Select connection type
    await browser.$('[data-testid="connection-type-local"]').click();

    // Select bash shell
    await browser.$('[data-testid="shell-type-bash"]').click();

    // Enter connection name
    const nameInput = await browser.$('[data-testid="connection-name-input"]');
    await nameInput.setValue("Test Bash Terminal");

    // Save connection
    await browser.$('[data-testid="save-connection-btn"]').click();

    // Verify connection appears in list
    const connection = await browser.$('[data-testid="connection-Test Bash Terminal"]');
    await expect(connection).toExist();

    // Double-click to open
    await connection.doubleClick();

    // Verify terminal tab opened
    const tab = await browser.$('[data-testid="tab-Test Bash Terminal"]');
    await expect(tab).toExist();

    // Verify terminal is active
    const terminal = await browser.$('[data-testid="terminal-active"]');
    await expect(terminal).toExist();
  });

  it("should create SSH connection with X11 forwarding", async () => {
    // Similar flow for SSH
    await browser.$('[data-testid="connection-type-ssh"]').click();

    // Fill SSH details
    await browser.$('[data-testid="ssh-host"]').setValue("192.168.1.100");
    await browser.$('[data-testid="ssh-port"]').setValue("22");
    await browser.$('[data-testid="ssh-username"]').setValue("testuser");

    // Enable X11
    await browser.$('[data-testid="ssh-enable-x11"]').click();

    // Verify X11 status indicator
    const x11Status = await browser.$('[data-testid="x11-status"]');
    await expect(x11Status).toHaveText("X Server Running");
  });
});
```

### Running E2E / System Tests

The example above shows the legacy WebdriverIO API. All previously-shipped
WebdriverIO specs (UI, local, infrastructure, performance) were ported to the
**Python bridge harness** under `tests/system/` (epic #799); `wdio.conf.js`
remains only as a scaffold for future tauri-driver UI specs (it currently
matches zero specs). System and infrastructure coverage now runs through the
Python harness, which works on macOS, Linux, and Windows:

```bash
# Python bridge system-test harness — builds the app if needed, brings up the
# named Docker fixtures, then runs pytest (see tests/system/README.md)
./scripts/test-system-py.sh --debug -k ssh -x -s
./scripts/test-system-py.sh --fixtures "ssh-password ssh-keys" -m integration -k ssh

# Per-machine orchestration (unit + Rust integration tests against Docker infra)
./scripts/test-system-linux.sh
./scripts/test-system-windows.sh

# The wdio scaffold (no specs ship today; Linux/Windows only, tauri-driver required)
pnpm test:e2e
```

### Recording Interactions (Manual → Automated)

**Use WebdriverIO's Inspector** to record actions:

```bash
npx wdio repl
```

Then manually perform actions in the app, and it generates test code!

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

  e2e-tests:
    # NOTE: `wdio.conf.js` is currently an empty scaffold (all specs were ported
    # to the Python bridge harness, tests/system/); this job is a placeholder for
    # future tauri-driver UI specs. tauri-driver only runs on Linux and Windows
    # (no macOS WKWebView driver) — see ADR-5 in architecture.md.
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
      - run: npm run build
      - run: npm run test:e2e
```

### Windows Agent CI Coverage

The remote agent (`agent/`) is built and tested on Windows via dedicated CI jobs:

- **Build + test** ([`agent.yml`](../.github/workflows/agent.yml)): the `build-windows` job runs on `windows-latest`, builds the agent for `x86_64-pc-windows-msvc` (native MSVC — cross-rs cannot build the MSVC ABI), and runs `cargo test -p termihub-agent -p termihub-core --all-features`. The full workspace test suite also runs on `windows-latest` via the [`code-quality.yml`](../.github/workflows/code-quality.yml) `tests` matrix.
- **Release artifact** ([`release.yml`](../.github/workflows/release.yml)): the `agent-binaries-windows` job ships `termihub-agent-windows-x64.exe` alongside the Linux and macOS agent binaries on every tagged release.

> **Platform caveat (ADR-5):** System/E2E tests (`tauri-driver` + Docker) remain **Linux-only** — `tauri-driver` has no macOS WKWebView driver, and the Docker E2E suite targets Linux. Windows **agent** verification is therefore limited to unit/integration tests (the jobs above) plus the manual tests in [`tests/manual/remote-agent.yaml`](../tests/manual/remote-agent.yaml). There is no automated end-to-end coverage of the Windows agent over a live SSH connection.

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

## Test Scripts for package.json

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest run --coverage",
    "test:e2e": "wdio run ./wdio.conf.js",
    "test:visual": "playwright test",
    "test:all": "pnpm test && pnpm test:e2e"
  }
}
```

## Debugging Tests

### WebdriverIO Inspector

```bash
# Launch interactive session
npx wdio repl

# Then in REPL:
> await browser.$('[data-testid="terminal"]').click()
> await browser.debug()  // Pauses execution
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
TERMIHUB_TEST_APP_BINARY=<path-to-built-app> tests/system/.venv/bin/python \
  -m pytest tests/system/tests/test_performance.py -s
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

| Suite               | File                                        | Tests | Docker Containers                          | Description                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------- | ----- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSH Auth            | `core/tests/ssh_auth.rs`                    | 15    | ssh-password:2201, ssh-keys:2203           | Password, 6 key types, 5 passphrase keys, wrong credentials, wrong passphrase                                                                                                                                                                                                                                                                                         |
| SSH Compat          | `core/tests/ssh_compat.rs`                  | 2     | ssh-legacy:2202                            | Legacy OpenSSH 7.x compatibility                                                                                                                                                                                                                                                                                                                                      |
| SSH Advanced        | `core/tests/ssh_advanced.rs`                | 5     | bastion:2204, restricted:2205, tunnel:2207 | Jump host, restricted shell, TCP tunneling                                                                                                                                                                                                                                                                                                                            |
| SSH Banner          | `core/tests/ssh_banner.rs`                  | 3     | ssh-banner:2206, ssh-password:2201         | Pre-auth banner text, no-banner on standard server, banner on failed auth                                                                                                                                                                                                                                                                                             |
| Telnet              | `core/tests/telnet.rs`                      | 3     | telnet:2301                                | Connect, output subscribe, login flow                                                                                                                                                                                                                                                                                                                                 |
| SFTP Stress         | `core/tests/sftp_stress.rs`                 | 16    | sftp-stress:2210                           | Large files, deep trees, symlinks, special filenames, permissions                                                                                                                                                                                                                                                                                                     |
| Network Resilience  | `core/tests/network_resilience.rs`          | 10    | network-fault:2209                         | Latency, packet loss, throttle, disconnect, jitter, corruption                                                                                                                                                                                                                                                                                                        |
| Monitoring          | `core/tests/monitoring.rs`                  | 4     | ssh-password:2201                          | CPU, memory, disk stats, stats under load                                                                                                                                                                                                                                                                                                                             |
| Agent Deploy SFTP   | `src-tauri/src/utils/remote_exec.rs`        | 1     | ssh-password:2201                          | Uploads a file over SFTP and reads it back, exercising the agent auto-deploy `block_in_place` path from `spawn_blocking` (#828/#837). In the desktop crate: `cargo test -p termihub --lib agent_deploy`. Pinned to password auth; port via `TERMIHUB_TEST_SSH_PASSWORD_PORT` (default 2201) — see [Parallel dev instances](#parallel-dev-instances-agent-deploy-test) |
| SSH Banner (system) | `tests/system/tests/test_ssh_banner.py`     | 2     | ssh-banner:2206                            | Pre-auth banner / MOTD display (ported from `ssh-banner.test.js`)                                                                                                                                                                                                                                                                                                     |
| SSH Keys (system)   | `tests/system/tests/test_ssh_keys.py`       | 4     | ssh-keys:2203                              | Key-based auth flows (ported from `ssh-keys.test.js`)                                                                                                                                                                                                                                                                                                                 |
| SSH Infra (system)  | `tests/system/tests/test_ssh.py`            | 11    | ssh-password:2201, ssh-keys:2203           | Password/key auth, password-prompt modal, connection failure, session output, monitoring show/hide (ported from `ssh.test.js`)                                                                                                                                                                                                                                        |
| Win Shells (system) | `tests/system/tests/test_windows_shells.py` | 13    | none                                       | PowerShell / cmd.exe selection, rendering, input, the shell selector, and WSL sessions (cwd / `/mnt` path translation). Windows-only; WSL cases skip without WSL2 (ported from `windows-shells.test.js`, #975)                                                                                                                                                        |

### Skip Behavior

All Rust integration tests use the `require_docker!` macro which checks TCP port connectivity at runtime. If the required Docker container is not running, the test prints a message and returns early (no failure). This means you can run `cargo test` without Docker and only the tests requiring containers will be skipped.

#### Python system-test harness — cross-platform shells (#886)

The local UI system suites author and clean up files **through the terminal**, and on Windows the local-shell backend defaults to **PowerShell** (no `printf`/`rm -f`/`touch`). File authoring/cleanup therefore goes through `ShellCommands` / `ShellFsUi` (`tests/system/termihub_harness/shell.py`), which emits the POSIX **or** PowerShell command for the host's default shell — so `test_editor.py` and the file-authoring half of `test_file_browser_local.py` run on every platform.

The cwd/`pwd`/path checks are cross-platform too (#902): `ShellCommands` builds the `pwd`-equality markers (POSIX `[ "$(pwd)" = … ]` vs PowerShell `if ((Get-Location).Path -eq …)`), supplies per-platform scratch directories for the cwd-following tests (`/tmp`,`/etc` vs `$env:TEMP`,`$env:WINDIR`) and starting-directory values, and `is_absolute_path()` accepts a POSIX root, a Windows drive, or a UNC path — so `test_local_shell.py` and the cwd-aware `test_file_browser_local.py` tests run on every platform with no `@skip_on_windows` gate.

### Parallel Dev Instances (agent-deploy test)

Several checkouts of termiHub can run side by side, each with its own gitignored
`dev.local.json` (`dev_port`, `dev_agent_port`, `dev_name`). The **Agent Deploy
SFTP** test (`agent_deploy_sftp_upload_round_trips_over_real_ssh`) is pinned to
**password auth** against the `ssh-password` container, and reads its port from
`TERMIHUB_TEST_SSH_PASSWORD_PORT` (default `2201`):

```bash
# default — shared container on 2201
cargo test -p termihub --lib agent_deploy

# point an instance at its own ssh-password container on a distinct port
TERMIHUB_TEST_SSH_PASSWORD_PORT=2231 cargo test -p termihub --lib agent_deploy
```

The test self-skips when the chosen port is unreachable, and every upload uses a
UUID-suffixed remote path, so concurrent runs against the **same** container never
collide on the remote `/tmp` file.

**Recommended usage for parallel checkouts:** the single shared `ssh-password:2201`
container is safe to share across all instances as-is (UUID remote paths prevent
collisions), so by default just run the test in each checkout. For fully isolated
servers, give each checkout its own password container on a distinct host port and
set `TERMIHUB_TEST_SSH_PASSWORD_PORT` to match in that checkout's environment.

> The per-checkout `dev_agent_port` `sshd` that `./scripts/dev.sh` starts is **not**
> used by this test: it is key-auth only (`PasswordAuthentication no`), so it is
> incompatible with the password-auth path the test pins to.

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
- [WebdriverIO Docs](https://webdriver.io/docs/gettingstarted)
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

E2E test coverage: all WebdriverIO specs have been ported to the cross-platform Python bridge harness in `tests/system/` (epic #799), leaving `wdio.conf.js` as an empty scaffold for any future tauri-driver UI specs. The last specs ported and removed include the SSH tunnels editor/list and Network Tools panel-UI suites → `tests/system/tests/test_ssh_tunnels.py` / `test_network_tools.py` (#810), the live-network cases → `test_network_tools_live.py` (#946), the remote-agent and Windows-shells/WSL infrastructure suites (#974, #975), and finally the now-empty `infra` wdio suite itself (#1015).

### Test Environment Setup

- Build the release app with `pnpm tauri build`
- For SSH/Telnet testing: Docker containers from `tests/docker/` (see [tests/docker/README.md](../tests/docker/README.md))
- Pre-generated SSH test keys in `tests/fixtures/ssh-keys/`
- For serial port tests: host-side virtual serial ports via `socat` + echo server, set up by `scripts/test-system-linux.sh` (see also `examples/serial/`)
- Test on each target OS (macOS, Linux, Windows) for cross-platform items

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

| Category              | YAML File                                                                  | ID Prefix  | Tests   |
| --------------------- | -------------------------------------------------------------------------- | ---------- | ------- |
| Local Shell           | [`local-shell.yaml`](../tests/manual/local-shell.yaml)                     | `MT-LOCAL` | 4       |
| SSH                   | [`ssh.yaml`](../tests/manual/ssh.yaml)                                     | `MT-SSH`   | 20      |
| Serial                | [`serial.yaml`](../tests/manual/serial.yaml)                               | `MT-SER`   | 9       |
| Tab Management        | [`tab-management.yaml`](../tests/manual/tab-management.yaml)               | `MT-TAB`   | 14      |
| Connection Management | [`connection-management.yaml`](../tests/manual/connection-management.yaml) | `MT-CONN`  | 12      |
| File Browser + Editor | [`file-browser.yaml`](../tests/manual/file-browser.yaml)                   | `MT-FB`    | 10      |
| UI / Layout           | [`ui-layout.yaml`](../tests/manual/ui-layout.yaml)                         | `MT-UI`    | 27      |
| Remote Agent          | [`remote-agent.yaml`](../tests/manual/remote-agent.yaml)                   | `MT-AGENT` | 23      |
| Credential Store      | [`credential-store.yaml`](../tests/manual/credential-store.yaml)           | `MT-CRED`  | 4       |
| Keyboard Shortcuts    | [`keyboard.yaml`](../tests/manual/keyboard.yaml)                           | `MT-KB`    | 14      |
| Cross-Platform        | [`cross-platform.yaml`](../tests/manual/cross-platform.yaml)               | `MT-XPLAT` | 1       |
| Portable Mode         | [`portable-mode.yaml`](../tests/manual/portable-mode.yaml)                 | `MT-PORT`  | 4       |
| Embedded Services     | [`embedded-services.yaml`](../tests/manual/embedded-services.yaml)         | `MT-SVC`   | 3       |
| Network Tools         | [`network-tools.yaml`](../tests/manual/network-tools.yaml)                 | `MT-NET`   | 13      |
| **Total**             |                                                                            |            | **155** |

When adding new manual tests, add the YAML definition to the appropriate file in `tests/manual/` — the YAML files are the **source of truth** for guided testing.

### E2E Coverage Map

Mapping of manual test IDs that have been automated to their Python harness test files:

| Manual Test IDs                  | E2E Test File                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| MT-LOCAL-01, 07                  | `tests/system/tests/test_local_shell.py`                                                                               |
| MT-LOCAL-09, 10                  | `tests/system/tests/test_cross_platform.py`                                                                            |
| MT-LOCAL-02, 04, 06, 11–20       | `tests/system/tests/test_windows_shells.py` (Windows-only; WSL cases skip without WSL2)                                |
| MT-SSH-04–06, 10–12, 20–33, 35   | `tests/system/tests/test_ssh*.py`                                                                                      |
| MT-SSH-19 (X11 backward-compat)  | `tests/system/tests/test_connection_forms.py`                                                                          |
| MT-SSH-08 (agent-auth warning)   | _dropped_ (`agent` is no longer a selectable SSH auth method)                                                          |
| MT-SSH-13, 17, 34                | `tests/system/tests/test_ssh_extended.py`                                                                              |
| SERIAL-01, 05 + custom path      | `tests/system/tests/test_serial.py`                                                                                    |
| MT-SER-09 (live serial I/O)      | _manual_ (no host socat echo fixture in harness yet, #859)                                                             |
| TELNET-01–03                     | `tests/system/tests/test_telnet.py`                                                                                    |
| MT-TAB-01–05, 15, 18             | `tests/system/tests/test_tab_management.py`                                                                            |
| MT-TAB-08–14, 19–21              | `tests/system/tests/test_tab_horizontal_scroll.py`                                                                     |
| MT-CONN-02–07, 25–30             | `test_connection_crud.py`, `test_connection_forms.py`, `test_connection_editor.py`                                     |
| MT-CONN-10–11, 13                | `tests/system/tests/test_export_import.py`                                                                             |
| MT-CONN-12, 14–16 (enc. import)  | _manual_ (import opens a native OS file picker)                                                                        |
| MT-CONN-20–22, 31                | `tests/system/tests/test_external_files.py`                                                                            |
| MT-FB-01, 02                     | `tests/system/tests/test_file_browser_local.py`                                                                        |
| MT-FB-03, 13, 19                 | `tests/system/tests/test_sftp_infra.py`                                                                                |
| MT-FB-06, 17                     | _manual_ (serial not bridge-selectable; SFTP fault injection)                                                          |
| MT-FB-05, 11, 18                 | `tests/system/tests/test_file_browser_local.py`                                                                        |
| EDITOR-01/STATUS/INDENT/LANG     | `tests/system/tests/test_editor.py`                                                                                    |
| #504 (terminal auto-scroll)      | `tests/system/tests/test_terminal_auto_scroll.py`                                                                      |
| MT-UI-06–08                      | `tests/system/tests/test_ui_state.py`                                                                                  |
| MT-UI-17, 18, 20                 | _manual_ (OS window resize / dev favicon — not bridge-drivable)                                                        |
| MT-UI-21                         | `tests/system/tests/test_sidebar_sections.py`                                                                          |
| MT-UI-22–25                      | _manual_ (separator size/cursor, overflow scroll — visual)                                                             |
| MT-AGENT (create/error/setup)    | `tests/system/tests/test_remote_agent.py` (create, error dialog, setup wizard vs. the password container)              |
| MT-AGENT (live connect/sessions) | _deferred_ (#995 — needs a deployed-agent Docker fixture)                                                              |
| MT-CRED-04–08                    | `tests/system/tests/test_credential_store.py`                                                                          |
| MT-RECOVERY-01–06                | `tests/system/tests/test_config_recovery.py`                                                                           |
| MT-RECOVERY-07–12                | covered by `test_connection_crud.py` / `test_credential_store.py` / `test_export_import.py` / `test_external_files.py` |
| MT-XPLAT-01, 02                  | `tests/system/tests/test_cross_platform.py`                                                                            |
| MT-SVC-01, 02, 03                | `tests/system/tests/test_embedded_services.py` (SVC-01..11)                                                            |
| MT-SVC-04, 05 (transfer)         | `tests/system/tests/test_embedded_services.py` (SVC-12 FTP, SVC-13 TFTP via curl)                                      |
| MT-NET-01–09                     | `tests/system/tests/test_network_tools.py`                                                                             |
| MT-NET-10, 12, 14, 17, 18        | `tests/system/tests/test_network_tools_live.py` (loopback + local stdlib servers; no Docker `network` profile)         |
| MT-NET-13                        | _manual_ (large-range warning is a native `window.confirm()`, no `data-testid`)                                        |
