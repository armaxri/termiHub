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

### Running E2E Tests

```bash
# Run all E2E tests (Linux/Windows only — tauri-driver required)
pnpm test:e2e

# Run specific test file
pnpm test:e2e -- --spec tests/e2e/terminal-creation.test.js

# Run in headless mode (CI)
pnpm test:e2e:ci

# Run with UI (helpful for debugging)
pnpm test:e2e:ui

# Run system tests with infrastructure (SSH, Telnet, serial)
# On macOS: runs inside Docker (Linux) automatically
# On Linux: runs natively with tauri-driver
./scripts/test-system.sh
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
    # NOTE: E2E tests only run on Linux and Windows.
    # tauri-driver does not support macOS (no WKWebView driver).
    # See ADR-5 in architecture.md for details.
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
      - run: npm run test:e2e:ci
```

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
    "test:e2e:ci": "wdio run ./wdio.conf.js --headless",
    "test:e2e:ui": "wdio run ./wdio.conf.js --debug",
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

termiHub includes an automated E2E performance test suite that validates 40 concurrent terminals:

```bash
# Run the performance test suite (requires built app + tauri-driver; Linux/Windows only)
pnpm test:e2e:perf
```

The suite (`tests/e2e/performance.test.js`) covers:

- **PERF-01**: Create 40 terminals via toolbar, verify tab count
- **PERF-02**: UI responsiveness with 40 terminals open (41st creation <5s)
- **PERF-03**: JS heap memory stays under 500 MB
- **PERF-04**: Cleanup after closing all terminals

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
# Start all Docker containers
docker compose -f tests/docker/docker-compose.yml up -d

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

### Test Suites

| Suite                | File                                              | Tests | Docker Containers                          | Description                                                       |
| -------------------- | ------------------------------------------------- | ----- | ------------------------------------------ | ----------------------------------------------------------------- |
| SSH Auth             | `core/tests/ssh_auth.rs`                          | 12    | ssh-password:2201, ssh-keys:2203           | Password, 6 key types, 3 passphrase keys, wrong credentials       |
| SSH Compat           | `core/tests/ssh_compat.rs`                        | 2     | ssh-legacy:2202                            | Legacy OpenSSH 7.x compatibility                                  |
| SSH Advanced         | `core/tests/ssh_advanced.rs`                      | 5     | bastion:2204, restricted:2205, tunnel:2207 | Jump host, restricted shell, TCP tunneling                        |
| Telnet               | `core/tests/telnet.rs`                            | 3     | telnet:2301                                | Connect, output subscribe, login flow                             |
| SFTP Stress          | `core/tests/sftp_stress.rs`                       | 16    | sftp-stress:2210                           | Large files, deep trees, symlinks, special filenames, permissions |
| Network Resilience   | `core/tests/network_resilience.rs`                | 10    | network-fault:2209                         | Latency, packet loss, throttle, disconnect, jitter, corruption    |
| Monitoring           | `core/tests/monitoring.rs`                        | 4     | ssh-password:2201                          | CPU, memory, disk stats, stats under load                         |
| SSH Banner (E2E)     | `tests/e2e/infrastructure/ssh-banner.test.js`     | 2     | ssh-banner:2206                            | Pre-auth banner, MOTD display                                     |
| SSH Keys (E2E)       | `tests/e2e/infrastructure/ssh-keys.test.js`       | 1     | ssh-keys:2203                              | Key auth UI flow                                                  |
| Windows Shells (E2E) | `tests/e2e/infrastructure/windows-shells.test.js` | 5     | none                                       | PowerShell, cmd.exe, WSL (Windows-only)                           |

### Skip Behavior

All Rust integration tests use the `require_docker!` macro which checks TCP port connectivity at runtime. If the required Docker container is not running, the test prints a message and returns early (no failure). This means you can run `cargo test` without Docker and only the tests requiring containers will be skipped.

### Per-Machine Test Scripts

Platform-specific orchestration scripts that start Docker containers, run all applicable tests, and tear down infrastructure:

```bash
# macOS (no E2E — tauri-driver unsupported)
./scripts/test-system-mac.sh
./scripts/test-system-mac.sh --with-all --keep-infra

# Linux (full suite including E2E if tauri-driver installed)
./scripts/test-system-linux.sh
./scripts/test-system-linux.sh --with-fault --with-stress

# Windows (via WSL or Git Bash)
./scripts/test-system-windows.sh
```

Common flags: `--skip-build`, `--skip-unit`, `--skip-serial`, `--with-fault`, `--with-stress`, `--with-all`, `--keep-infra`.

### Network Resilience Tests

The network resilience suite (`network_resilience.rs`) must run single-threaded because tests modify shared container state via `docker exec`:

```bash
cargo test -p termihub-core --all-features --test network_resilience -- --nocapture --test-threads=1
```

Each test uses a `FaultGuard` that automatically resets faults on drop (including panics).

## Next Steps

1. **Phase 1** (Now): Add `data-testid` attributes to all components
2. **Phase 2**: Write E2E tests for critical paths
3. **Phase 3**: Add component tests for complex components
4. **Phase 4**: Integrate into CI/CD
5. **Phase 5**: Add visual regression tests

## Related Documentation

- [Contributing](contributing.md) — Development setup, building, workflow, coding standards, and performance profiling
- [WebdriverIO Docs](https://webdriver.io/docs/gettingstarted)
- [Tauri Testing Guide](https://tauri.app/v1/guides/testing/)
- [React Testing Library](https://testing-library.com/react)
- [Vitest](https://vitest.dev/)

---

## Manual Testing

Manual test procedures for verifying user-facing features before releases and after major changes. Tests already covered by automated suites (unit, integration, E2E) have been removed from this list.

### E2E Automation Coverage Analysis

Analysis of which manual test items can be covered by WebdriverIO E2E tests (tauri-driver on Linux/Windows, Docker on macOS). Each subsection below is annotated with a `> E2E coverage` note.

#### Feasibility Categories

- **E2E** — Fully automatable with the existing WebdriverIO + tauri-driver infrastructure
- **E2E/infra** — Automatable but requires Docker test containers (SSH, serial, telnet, agent)
- **Partial** — Some aspects automatable (e.g., element visibility), others need manual verification (visual rendering, drag-and-drop precision)
- **Manual** — Cannot be automated: platform-specific (macOS/Windows/WSL), native OS dialogs, visual rendering, external app integration, OS-level features

#### Summary

| Area                  | Automated | Pending E2E | E2E/infra | Partial | Manual | Total   |
| --------------------- | --------- | ----------- | --------- | ------- | ------ | ------- |
| Local Shell           | 14        | 0           | 1         | 0       | 21     | 36      |
| SSH                   | 58        | 3           | 0         | 4       | 20     | 85      |
| Serial                | 5         | 0           | 0         | 0       | 2      | 7       |
| Telnet                | 3         | 0           | 0         | 0       | 0      | 3       |
| Tab Management        | 8         | 1           | 0         | 6       | 5      | 20      |
| Connection Management | 54        | 18          | 0         | 8       | 13     | 93      |
| Split Views           | 4         | 0           | 0         | 2       | 0      | 6       |
| File Browser          | 31        | 0           | 0         | 0       | 11     | 42      |
| Editor                | 22        | 0           | 0         | 1       | 0      | 23      |
| UI / Layout           | 27        | 0           | 0         | 6       | 12     | 45      |
| Remote Agent          | 10        | 0           | 7         | 3       | 5      | 25      |
| Credential Store      | 15        | 0           | 0         | 3       | 5      | 23      |
| Cross-Platform        | 0         | 0           | 0         | 0       | 3      | 3       |
| **Total**             | **251**   | **22**      | **8**     | **33**  | **97** | **411** |

**251 test items (61%) are now covered by automated E2E tests** across 28 test files. An additional 30 items are fully automatable (22 pending E2E, 8 requiring Docker infrastructure with a live remote agent). The remaining 97 items (24%) require manual testing.

#### Manual-Only Reasons Breakdown

| Reason                                | Items | Examples                                                                |
| ------------------------------------- | ----- | ----------------------------------------------------------------------- |
| Platform-specific (macOS/Windows/WSL) | ~50   | macOS key repeat, WSL file browser, Windows shell interception          |
| Native OS dialogs (file picker, save) | ~20   | Import/export connections, SSH key browse button, save terminal to file |
| Visual rendering verification         | ~18   | Powerline glyphs, white flash timing, 1px panel borders, black bar fix  |
| External app integration              | ~4    | Open in VS Code                                                         |
| OS-level features                     | ~5    | Keychain integration, custom app icon, key repeat accent picker         |

#### Highest-Value Remaining Automation Targets

These areas have the most remaining automatable items:

1. **Connection Management** (18 pending E2E items) — External connection files, storage file selector
2. **Remote Agent with live agent** (7 E2E/infra items) — Agent connect, shell sessions, reconnect, context menu with connected agent (requires pre-installed agent binary in Docker)
3. **Local Shell** (1 E2E/infra item) — Remaining infrastructure test

### Test Environment Setup

- Build the release app with `pnpm tauri build`
- For SSH/Telnet/serial testing: Docker containers from `tests/docker/` (see [tests/docker/README.md](../tests/docker/README.md))
- Pre-generated SSH test keys in `tests/fixtures/ssh-keys/`
- For serial port tests: virtual serial ports via `socat` (see `tests/docker/serial-echo/`)
- Test on each target OS (macOS, Linux, Windows) for cross-platform items

### Guided Manual Test Runner

All manual test items are defined as machine-readable YAML in [`tests/manual/*.yaml`](../tests/manual/). The **guided test runner** presents applicable tests one at a time, manages infrastructure, and generates a JSON report:

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

| Category               | YAML File                                                          | ID Prefix     | Tests |
| ---------------------- | ------------------------------------------------------------------ | ------------- | ----- |
| Local Shell            | [`local-shell.yaml`](../tests/manual/local-shell.yaml)            | `MT-LOCAL`    | 20    |
| SSH                    | [`ssh.yaml`](../tests/manual/ssh.yaml)                            | `MT-SSH`      | 35    |
| Serial                 | [`serial.yaml`](../tests/manual/serial.yaml)                      | `MT-SER`      | 2     |
| Tab Management         | [`tab-management.yaml`](../tests/manual/tab-management.yaml)      | `MT-TAB`      | 17    |
| Connection Management  | [`connection-management.yaml`](../tests/manual/connection-management.yaml) | `MT-CONN` | 31 |
| File Browser + Editor  | [`file-browser.yaml`](../tests/manual/file-browser.yaml)          | `MT-FB`       | 20    |
| UI / Layout            | [`ui-layout.yaml`](../tests/manual/ui-layout.yaml)                | `MT-UI`       | 20    |
| Remote Agent           | [`remote-agent.yaml`](../tests/manual/remote-agent.yaml)          | `MT-AGENT`    | 8     |
| Credential Store       | [`credential-store.yaml`](../tests/manual/credential-store.yaml)  | `MT-CRED`     | 8     |
| Cross-Platform         | [`cross-platform.yaml`](../tests/manual/cross-platform.yaml)      | `MT-XPLAT`    | 3     |
| Configuration Recovery | [`config-recovery.yaml`](../tests/manual/config-recovery.yaml)    | `MT-RECOVERY` | 12    |
| **Total**              |                                                                    |               | **176** |

When adding new manual tests, add the YAML definition to the appropriate file in `tests/manual/` — the YAML files are the **source of truth** for guided testing.
