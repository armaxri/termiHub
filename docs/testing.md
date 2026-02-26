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

---

### Local Shell

#### Terminal input works on new connections (PR #198)

> **Remaining:** 1 E2E/infra (SSH), 1 manual (PowerShell-only)

- [ ] Open a new local PowerShell terminal — verify keyboard input works immediately without needing to click the terminal area
- [ ] Create an SSH connection to a remote host — verify keyboard input works immediately

#### No initial output flash for WSL/SSH terminals (PR #175)

> **E2E coverage:** 0 E2E — all 4 manual (WSL/Windows-specific, visual timing)

- [ ] Create a WSL connection — verify no welcome banner or setup commands flash before the prompt appears
- [ ] Rapidly create two WSL connections after app startup — verify both terminals show a clean prompt with no strange output
- [ ] Create an SSH connection — verify no setup command flash before the prompt appears
- [ ] Create a local PowerShell or CMD connection — verify startup output is not delayed (no regression)

#### New tabs open in home directory (PR #66)

> **Remaining:** 1 manual (multi-OS verification)

- [ ] Test on macOS/Linux (uses `$HOME`) and Windows (uses `%USERPROFILE%`) if possible

#### macOS key repeat fix (PR #48)

> **E2E coverage:** 0 E2E — all 3 manual (macOS-specific behavior)

- [ ] Launch termiHub on macOS — open a local shell terminal
- [ ] Hold any letter key (e.g., `k`) — verify key repeats continuously
- [ ] Verify accent picker no longer appears when holding letter keys

#### Doubled terminal text fix on macOS (PR #108)

> **E2E coverage:** 0 E2E — all 2 manual (macOS-specific)

- [ ] Open a terminal — verify prompt appears once, typing shows single characters, command output is not duplicated
- [ ] Open multiple terminals / split views — each terminal shows single output

#### WSL shell detection on Windows (PR #139)

> **E2E coverage:** 0 E2E — all 2 manual (Windows/WSL-specific)

- [ ] Open connection editor — shell dropdown shows WSL distros (if WSL is installed)
- [ ] Select a WSL distro — WSL shell launches correctly in a new tab

#### Windows shell WSL interception fix (PR #129)

> **E2E coverage:** 0 E2E — all 4 manual (Windows-specific)

- [ ] Create new local shell connection — verify shell dropdown defaults to PowerShell on Windows
- [ ] Open saved PowerShell connection — verify it launches PowerShell (not WSL)
- [ ] Open saved Git Bash connection — verify it launches Git Bash
- [ ] Press Ctrl+Shift+`` ` `` for new terminal — verify platform default shell opens

#### WSL file browser follows CWD with OSC 7 injection (PR #154)

> **E2E coverage:** 0 E2E — all 4 manual (WSL-specific)

- [ ] Open WSL Ubuntu tab — file browser shows `//wsl$/Ubuntu/home/<user>`
- [ ] `cd /tmp` — file browser follows to `//wsl$/Ubuntu/tmp`
- [ ] `cd /mnt/c/Users` — file browser shows `C:/Users`
- [ ] Open WSL Fedora tab — no `clear: command not found`

---

### SSH

#### Agnoster/Powerline theme rendering (PR #197)

> **E2E coverage:** 0 E2E — all 3 manual (visual font/color rendering)

- [ ] Connect via SSH to a Linux machine with zsh + Agnoster theme — the `user@machine` prompt segment should blend with the terminal background (no visible black rectangle)
- [ ] Connect via SSH to a machine with a default bash prompt — verify no visual regression in prompt rendering
- [ ] Open a local shell terminal — verify ANSI color rendering is unaffected

#### SSH key authentication on Windows (PR #160)

> **E2E coverage:** 0 E2E — all 4 manual (Windows-specific)

- [ ] SSH key auth with Ed25519 key on Windows connects successfully
- [ ] SSH key auth with RSA key still works
- [ ] SSH password auth still works
- [ ] SSH agent auth still works

#### SSH agent setup guidance (PR #133)

> **E2E coverage:** 1 E2E/infra (error message), 1 partial (agent status dependent), 1 manual (PowerShell elevation)

- [ ] Open connection editor, select SSH + Agent auth — warning appears if agent is stopped, normal hint if running
- [ ] Click "Setup SSH Agent" button — local PowerShell tab opens with elevation command

#### Password prompt at connect (PR #38)

> **Remaining:** 2 E2E/infra (key no dialog, SFTP dialog), 2 manual (native export dialog, startup strip)

- [ ] SSH key-auth connections — no password dialog, connects directly
- [ ] SFTP connect to password-auth SSH — password dialog appears
- [ ] Export connections — no passwords in exported JSON
- [ ] Existing connections with stored passwords — passwords stripped on app startup

#### X11 forwarding (PR #69)

> **E2E coverage:** 0 E2E — all 6 manual (requires X server)

- [ ] Connect via "Docker SSH + X11" example connection
- [ ] Run `xclock` or `xeyes` — window appears on local display
- [ ] Verify `echo $DISPLAY` shows `localhost:N.0` on remote
- [ ] Connect without X11 enabled — SSH works normally
- [ ] Enable X11 without local X server — SSH connects with graceful degradation
- [ ] Existing saved connections without the new field load correctly

#### SSH monitoring in status bar (PR #114, #115)

> **Remaining:** 7 E2E/infra (stats, buttons, dropdown), 1 partial (high-value colors need specific load)

- [ ] Selecting a connection connects monitoring, shows inline stats
- [ ] Stats auto-refresh every 5 seconds
- [ ] Refresh and disconnect icon buttons work
- [ ] High values show warning (yellow >= 70%) and critical (red >= 90%) colors
- [ ] Save & Connect button saves and opens terminal in one action
- [ ] After connecting, status bar displays: hostname, CPU%, Mem%, Disk%
- [ ] Clicking hostname opens detail dropdown with system info, refresh, and disconnect
- [ ] Disconnecting returns to the "Monitor" button state

#### SSH tunneling (PR #225)

> **Remaining:** 5 E2E/infra (start/stop, traffic, forwarding), 2 partial (app restart persistence), 1 manual (auto-start on launch)

- [ ] Verify the tunnel config persists across app restarts (check `tunnels.json` in the config directory)
- [ ] Edit a tunnel and click "Save" — verify changes are persisted
- [ ] Click the Play button on a tunnel in the sidebar — verify the status indicator turns green (connected)
- [ ] Click the Stop button on an active tunnel — verify the status indicator turns grey (disconnected)
- [ ] Click "Save & Start" in the tunnel editor — verify the tunnel is saved and started in one action
- [ ] Create a local forward tunnel (e.g., local port 18080 → remote localhost:80) — start it — verify `curl http://127.0.0.1:18080` reaches the remote service
- [ ] Enable "Auto-start when app launches" on a tunnel — restart the app — verify the tunnel starts automatically
- [ ] Verify traffic stats (bytes sent/received, active connections) update in the sidebar for active tunnels

---

### Serial

#### Nerd Font / Powerline glyph support (PR #131)

> **E2E coverage:** 0 E2E — all 2 manual (visual glyph rendering)

- [ ] SSH to a host running zsh with the agnoster theme — Powerline glyphs render correctly instead of boxes
- [ ] Verify on a clean Windows machine without any Nerd Font installed locally

---

### Tab Management

#### Baseline

> **Remaining:** 2 partial (drag reorder limited in WebDriver)

- [ ] Drag a tab to a new position in the tab bar with multiple tabs open — tab moves to new position, order persists
- [ ] Drag-and-drop tabs still works correctly

#### Save terminal content to file (PR #35)

> **E2E coverage:** 0 E2E — all 3 manual (native file save dialog)

- [ ] Click "Save to File" — native save dialog opens with default filename `terminal-output.txt`
- [ ] Choose a location — file is written with the terminal's text content
- [ ] Cancel the dialog — nothing happens

#### Per-connection horizontal scrolling (PR #45)

> **Remaining:** 2 partial (visual scroll check), 1 manual (key repeat timing)

- [ ] Create connection with horizontal scrolling enabled — connect — run `echo $(python3 -c "print('A'*300)")` — line should not wrap, horizontal scrollbar appears
- [ ] Create connection without horizontal scrolling — same command — line wraps normally
- [ ] Hold a key down — key repeat works normally in horizontal scroll mode
- [ ] Close and reopen app — connection setting persists
- [ ] Resize window/panels — scroll area adjusts correctly

#### Dynamic horizontal scroll width update (PR #49)

> **E2E coverage:** 1 E2E (clear resets width), 2 partial (output + scroll interaction), 1 manual (key repeat)

- [ ] Open terminal — enable horizontal scrolling — run a command producing wide output (e.g. `ls -la /usr/bin`) — scrollbar should expand automatically after output settles
- [ ] Hold a key (e.g. `k`) — key should repeat without interruption
- [ ] Run `clear` — scroll width should shrink back to viewport width
- [ ] Toggle horizontal scrolling off/on — still works as before

---

### Connection Management

#### Remove folder selector from editor (PR #146)

> **Remaining:** 1 partial (drag onto folder)

- [ ] Drag a connection onto a folder in the sidebar — verify it moves correctly

#### Shell-specific icons and icon picker (PR #157)

> **E2E coverage:** 6 partial (can verify icon element existence via data-testid, but visual icon correctness needs manual check)

- [ ] Open a PowerShell tab — verify biceps icon appears in tab bar and drag overlay
- [ ] Open a Git Bash tab — verify git branch icon appears
- [ ] Open a WSL tab — verify penguin icon appears
- [ ] Edit a saved connection — click "Set Icon" — search for an icon — apply — verify icon shows in sidebar and tab
- [ ] Search "arm" in the icon picker — verify BicepsFlexed appears
- [ ] Clear a custom icon — verify default icon is restored

#### Import/export connections (PR #33)

> **E2E coverage:** 0 E2E — all 2 manual (native file dialogs)

- [ ] Click "Import Connections" — file open dialog, imports JSON, connection list refreshes
- [ ] Click "Export Connections" — file save dialog, saves JSON

#### Encrypted export/import of connections with credentials (PR #322)

> **Remaining:** 7 manual (native file picker for actual export/import)

- [ ] Enter matching passwords (8+ chars), click Export — file save dialog opens, JSON file is saved with `$encrypted` section
- [ ] Export "Without credentials" — verify saved JSON has no `$encrypted` section (no regression)
- [ ] Click "Import Connections", select a file with encrypted credentials — Import dialog shows connection count and password field
- [ ] Enter correct export password, click "Import with Credentials" — verify success message shows connections and credentials imported
- [ ] Enter wrong password — verify "Wrong password" error, password field remains for retry
- [ ] Click "Skip Credentials" on an encrypted import — verify connections imported without credentials
- [ ] Import a plain (non-encrypted) export file — verify simple Import button shown (no password prompt), connections imported normally

#### SSH key path browse button (PR #205)

> **E2E coverage:** 0 E2E — all 5 manual (native file dialog)

- [ ] Create or edit an SSH connection, set auth method to "Key", click "..." button — verify a native file dialog opens defaulting to `~/.ssh`
- [ ] Select a key file — verify the path populates in the input field
- [ ] Cancel the dialog — verify the input field remains unchanged
- [ ] Repeat the above for Agent connection settings
- [ ] Manually type a path in the input field — verify it still works as before

#### External connection file support (PR #50, redesigned in PR #210)

> **E2E coverage:** 7 E2E (toggle, context menu, tree display — with programmatic file setup), 1 partial (drag-and-drop), 2 manual (native file picker for Create/Add)

- [ ] "Create File" — enter name — save dialog — empty JSON file created and auto-added to list
- [ ] "Add File" — native file picker — select JSON — path appears in list with toggle
- [ ] Drag-and-drop external connections into local folders — folder assignment persists correctly

#### Storage File selector in connection editor (PR #210)

> **E2E coverage:** 7 E2E (dropdown options, save to different files, move between files), 1 partial (requires external file setup)

- [ ] Add an external connection file in Settings and enable it (prerequisite for testing external file behavior end-to-end)

---

### Split Views

#### Baseline

> **Remaining:** 2 partial (drag divider, drag tab to edge — limited in WebDriver)

- [ ] Hold Shift + click split (or toolbar option) — panel splits vertically
- [ ] Drag the divider between split panels — panels resize, terminals re-fit
- [ ] Drag a tab to the edge of another panel — new split created, tab moves to new panel

---

### File Browser

#### Baseline

> **Remaining:** 1 E2E/infra (SFTP connect), 3 manual (upload/OS drag, download dialog, VS Code)

- [ ] Connect SFTP via picker with an SSH connection — remote filesystem tree displayed
- [ ] Right-click remote file > Upload or drag file from OS in SFTP mode — file appears in remote listing
- [ ] Right-click remote file > Download in SFTP mode — file saved to local filesystem
- [ ] Right-click file > Open in VS Code (when VS Code installed) — file opens in VS Code

#### CWD-aware file browser (PR #39)

> **Remaining:** 2 E2E/infra (SSH SFTP auto-connect)

- [ ] Open an SSH terminal — file browser auto-connects SFTP (with password prompt) and shows remote CWD
- [ ] Open a serial terminal — file browser shows "no filesystem" placeholder

#### File browser follows tab switch from WSL to PowerShell (PR #167)

> **E2E coverage:** 0 E2E — all 4 manual (WSL-specific)

- [ ] Open a WSL tab — file browser shows `//wsl$/<distro>/home/<user>`
- [ ] Open a PowerShell tab — file browser switches to Windows home directory
- [ ] Switch back to WSL tab — file browser returns to WSL path
- [ ] Open a bash tab (no OSC 7) — file browser shows home directory, not previous tab's path

#### File browser stays active when editing (PR #57)

> **Remaining:** 1 E2E/infra (remote SFTP file)

- [ ] Open a remote (SFTP) file for editing — file browser shows the remote parent directory

#### New File button (PR #58)

> **Remaining:** 1 E2E/infra (SFTP mode)

- [ ] Works in SFTP file browser mode

#### Right-click context menu (PR #59)

> **Remaining:** 1 E2E/infra (SFTP download option)

- [ ] Right-click in SFTP mode — Download option appears for files

#### Open in VS Code (PR #51)

> **E2E coverage:** 0 E2E — all 4 manual (external VS Code app integration)

- [ ] File browser (local mode) — right-click file — "Open in VS Code" visible — opens file in VS Code
- [ ] File browser (SFTP mode) — right-click file — "Open in VS Code" — file opens — edit and close tab — file re-uploaded (verify content changed on remote)
- [ ] VS Code not installed — "Open in VS Code" menu item does not appear
- [ ] SFTP session lost during edit — error event emitted, no crash

#### Double-click file to open in editor (PR #61)

> **Remaining:** 1 E2E/infra (SFTP file)

- [ ] Double-click a file in SFTP file browser — opens in editor tab

---

### Editor

#### Built-in file editor with Monaco (PR #54)

> **Remaining:** 1 E2E/infra (SFTP edit), 1 partial (drag between panels)

- [ ] SFTP file browser — right-click file — "Edit" — remote file loads with [Remote] badge — edit + save works
- [ ] Editor tab drag-and-drop between panels works correctly

---

### UI / Layout

#### No white flash on startup (PR #192)

> **Remaining:** 3 manual (visual startup timing, app restart)

- [ ] Launch the app — verify the window starts with a dark background (#1e1e1e) instead of flashing white
- [ ] Observe the full startup sequence — there should be no white → dark → white transitions
- [ ] Restart the app with Dark theme selected — verify no white flash on launch

#### Color theme switching (PR #220)

> **Remaining:** 2 partial (System mode, state dots), 3 manual (OS toggle, app restart, ErrorBoundary)

- [ ] Select "System" — verify the app follows the current OS dark/light mode preference
- [ ] In "System" mode, toggle OS dark/light mode — verify the app switches themes automatically without a restart
- [ ] Verify state dots (connected/connecting/disconnected) are visible in both themes on terminal tabs and agent sidebar nodes
- [ ] Close and reopen the app — verify the selected theme persists across restarts
- [ ] Trigger an error (e.g., throw in a component) to see the ErrorBoundary — verify it renders with theme-appropriate colors

#### Theme switching applies immediately (PR #224)

> **Remaining:** 1 partial (System mode follows OS)

- [ ] Switch to System — verify the theme matches the current OS preference immediately

#### Settings as tab (PR #32)

> **E2E coverage:** 1 partial (drag between panels — limited in WebDriver)

- [ ] Drag the settings tab between panels — works with correct Settings icon

#### Vertical split resize handle (PR #213)

> **Remaining:** 1 partial (drag to resize)

- [ ] Drag the vertical resize handle — verify panels resize smoothly

#### Clear separation between split view panels (PR #189)

> **E2E coverage:** 0 E2E — all 4 manual (1px visual border verification)

- [ ] Open a split view (drag a tab to the edge of a panel) — verify a visible 1px line appears between adjacent panels
- [ ] Single-panel mode — verify the left border blends naturally against the sidebar edge
- [ ] Test horizontal splits — verify border appears between left and right panels
- [ ] Test vertical splits — verify border appears between top and bottom panels

#### Black bar at bottom of terminal fix (PR #130)

> **E2E coverage:** 0 E2E — all 3 manual (visual pixel-level verification)

- [ ] Terminal tabs no longer show a black bar at the bottom
- [ ] Resizing window/split panels — terminal fills correctly
- [ ] Settings tab unaffected

#### Custom app icon (PR #70)

> **E2E coverage:** 0 E2E — all 2 manual (OS-level dock/taskbar icon, favicon)

- [ ] App icon in dock/taskbar is the custom termiHub icon
- [ ] Favicon in browser dev mode is termiHub icon

---

### Remote Agent

#### RemoteBackend and session reconnect (PR #87)

> **E2E coverage:** 3 E2E/infra (connect, output, reconnect), 1 manual (cleanup verification)

- [ ] Close tab, verify cleanup (no orphan threads)

#### Connection error feedback dialog

> **E2E coverage:** 5 E2E/infra (invalid host, wrong password, agent not installed, technical details, close button), 1 manual (agent binary state)

- [ ] In the "Agent Not Installed" dialog, click "Setup Agent" — verify the Agent Setup dialog opens

#### Agent setup wizard (PR #137)

> **E2E coverage:** 4 E2E/infra (context menu, dialog, terminal, commands), 3 partial (file picker, binary upload), 3 manual (systemd, error case, connect after)

- [ ] Browse for a pre-built `termihub-agent` binary (Linux x86_64) — verify file picker works
- [ ] Verify setup commands are injected into the terminal (mv, chmod, --version)
- [ ] Verify the binary is uploaded and `termihub-agent --version` runs successfully
- [ ] Test with "Install systemd service" checked — verify systemd commands are injected
- [ ] After setup, right-click agent → "Connect" — verify agent connects successfully
- [ ] Test error case: select a non-existent binary path — verify error is shown

---

### Credential Store

#### KeychainStore integration with OS keychain (PR #250)

> **E2E coverage:** 0 E2E — all 3 manual (OS-specific keychain verification)

- [ ] On Windows: verify credentials are stored in Windows Credential Manager (search for "termihub" entries)
- [ ] On macOS: verify credentials are stored in Keychain Access (search for "termihub" entries)
- [ ] On Linux: verify credentials are stored via Secret Service / D-Bus (if available)

#### Master password unlock dialog and status bar indicator (PR #257)

> **Remaining:** 1 manual (startup auto-open requires pre-config)

- [ ] Configure credential store to master_password mode and lock it — on app startup, the unlock dialog should appear automatically

#### Credential store auto-fill on connect (PR #258)

> **E2E coverage:** 6 E2E/infra (save+auto-fill, stale credential, passphrase, no-lookup cases — via Docker SSH), 1 manual (remote agent)

- [ ] Connect a remote agent with `savePassword` enabled — verify stored credentials are used automatically, and stale credentials trigger re-prompt after removal

#### Auto-lock timeout for master password credential store (PR #263)

> **Remaining:** 3 partial (timeout timing, timer reset, immediate effect)

- [ ] With master password mode active and store unlocked, wait for the configured timeout to elapse — verify the store auto-locks and the unlock dialog appears
- [ ] While the store is unlocked, perform credential operations (connect with saved password, browse credentials) — verify each operation resets the inactivity timer (store does not lock prematurely)
- [ ] Change the auto-lock timeout while the store is unlocked — verify the new timeout takes effect immediately without requiring a lock/unlock cycle

---

### Configuration Recovery

#### Corrupt settings file recovery (PR #383)

> **E2E coverage:** 0 E2E — all 5 manual (requires manually corrupting config files on disk)

- [ ] Corrupt `settings.json` with invalid JSON (e.g., `{broken`) — launch the app — verify it starts normally, shows a recovery dialog listing "settings.json" with a recovery message, and creates a `settings.json.bak` backup
- [ ] Corrupt `connections.json` with completely invalid JSON — launch the app — verify it starts with an empty connection list, shows a recovery dialog, and creates a `connections.json.bak` backup
- [ ] Corrupt a single connection entry in `connections.json` (valid JSON structure but one malformed connection object) — launch the app — verify good connections are preserved, the bad entry is dropped, and the recovery dialog shows per-entry details
- [ ] Corrupt `tunnels.json` with invalid JSON — launch the app — verify it starts normally without tunnels, shows a recovery dialog, and creates a `tunnels.json.bak` backup
- [ ] Dismiss the recovery dialog by clicking "OK" — verify the dialog closes and the app functions normally

---

### Cross-Platform

#### Baseline

> **E2E coverage:** 0 E2E — all 3 manual (per-OS verification needed on each target platform)

- [ ] Check available shells in connection editor on each target OS — correct shells listed (zsh/bash/sh on Unix, PowerShell/cmd/Git Bash on Windows)
- [ ] Open serial port dropdown on each target OS — correct port naming convention (/dev/tty\* on Unix, COM\* on Windows)
- [ ] Enable X11 forwarding on an SSH connection on macOS or Linux with X server — X11 forwarding works (not available on Windows)
