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

| Area                  | E2E     | E2E/infra | Partial | Manual | Total   |
| --------------------- | ------- | --------- | ------- | ------ | ------- |
| Local Shell           | 13      | 1         | 1       | 21     | 36      |
| SSH                   | 15      | 46        | 4       | 20     | 85      |
| Serial                | 0       | 5         | 0       | 2      | 7       |
| Telnet                | 0       | 3         | 0       | 0      | 3       |
| Tab Management        | 9       | 0         | 6       | 5      | 20      |
| Connection Management | 72      | 0         | 8       | 13     | 93      |
| Split Views           | 4       | 0         | 2       | 0      | 6       |
| File Browser          | 24      | 7         | 0       | 11     | 42      |
| Editor                | 21      | 1         | 1       | 0      | 23      |
| UI / Layout           | 27      | 0         | 6       | 12     | 45      |
| Remote Agent          | 0       | 17        | 3       | 5      | 25      |
| Credential Store      | 9       | 6         | 3       | 5      | 23      |
| Cross-Platform        | 0       | 0         | 0       | 3      | 3       |
| **Total**             | **194** | **86**    | **34**  | **97** | **411** |

**68% of manual tests (280 items) are fully E2E-automatable.** Including partial coverage, 76% (314 items) can benefit from E2E automation. The remaining 24% (97 items) require manual testing.

#### Manual-Only Reasons Breakdown

| Reason                                | Items | Examples                                                                |
| ------------------------------------- | ----- | ----------------------------------------------------------------------- |
| Platform-specific (macOS/Windows/WSL) | ~50   | macOS key repeat, WSL file browser, Windows shell interception          |
| Native OS dialogs (file picker, save) | ~20   | Import/export connections, SSH key browse button, save terminal to file |
| Visual rendering verification         | ~18   | Powerline glyphs, white flash timing, 1px panel borders, black bar fix  |
| External app integration              | ~4    | Open in VS Code                                                         |
| OS-level features                     | ~5    | Keychain integration, custom app icon, key repeat accent picker         |

#### Highest-Value Automation Targets

These areas have the most automatable items and would yield the greatest reduction in manual testing burden:

1. **Connection Management** (72 E2E items) — SSH key suggestions, default user/key, port extraction, schema-driven forms, storage file selector, folder handling
2. **UI / Layout** (27 E2E items) — Horizontal activity bar, theme switching, customize layout dialog, tab accent borders, sidebar toggle, split resize handles
3. **File Browser** (24 E2E + 7 infra items) — CWD tracking, context menus, new file creation, double-click editing, stuck-at-root fix
4. **Editor** (21 E2E items) — Monaco editor lifecycle, status bar fields, indent/language selectors
5. **SSH with infrastructure** (46 E2E/infra items) — Monitoring, SFTP CWD, optional settings, tunneling UI, env var expansion

### Test Environment Setup

- Build the release app with `pnpm tauri build`
- For SSH/Telnet/serial testing: Docker containers from `tests/docker/` (see [tests/docker/README.md](../tests/docker/README.md))
- Pre-generated SSH test keys in `tests/fixtures/ssh-keys/`
- For serial port tests: virtual serial ports via `socat` (see `tests/docker/serial-echo/`)
- Test on each target OS (macOS, Linux, Windows) for cross-platform items

---

### Local Shell

#### Baseline

> **E2E coverage:** 3 E2E, 1 partial (resize visual), 0 manual

- [ ] Open connection editor, select Local type — shell dropdown shows shells available on current OS (zsh/bash/sh on macOS/Linux; PowerShell/cmd on Windows)
- [ ] Create and connect a local shell connection — terminal opens, shell prompt appears, commands execute
- [ ] Resize the app window or drag a split divider with a running local shell — terminal re-renders correctly, no garbled output, `tput cols`/`tput lines` reports new size
- [ ] Type `exit` in a running local shell — terminal shows "[Process exited with code 0]"

#### Terminal input works on new connections (PR #198)

> **E2E coverage:** 3 E2E, 1 E2E/infra (SSH), 1 manual (PowerShell-only)

- [ ] Open a new local PowerShell terminal — verify keyboard input works immediately without needing to click the terminal area
- [ ] Rapidly create 3–4 local terminals in a row — verify all accept keyboard input when switched to
- [ ] Switch between multiple terminal tabs — verify the active terminal receives keyboard input each time
- [ ] Create an SSH connection to a remote host — verify keyboard input works immediately
- [ ] Split the panel and create a terminal in each split — verify input works in both

#### No initial output flash for WSL/SSH terminals (PR #175)

> **E2E coverage:** 0 E2E — all 4 manual (WSL/Windows-specific, visual timing)

- [ ] Create a WSL connection — verify no welcome banner or setup commands flash before the prompt appears
- [ ] Rapidly create two WSL connections after app startup — verify both terminals show a clean prompt with no strange output
- [ ] Create an SSH connection — verify no setup command flash before the prompt appears
- [ ] Create a local PowerShell or CMD connection — verify startup output is not delayed (no regression)

#### Configurable starting directory (PR #148)

> **E2E coverage:** 5/5 E2E (set dir, verify pwd output)

- [ ] Create a local shell with no starting directory — verify it opens in home directory
- [ ] Create a local shell with starting directory set to `/tmp` — verify it opens in `/tmp`
- [ ] Create a local shell with `~/work` — verify tilde expansion works
- [ ] Create a local shell with `${env:HOME}/Desktop` — verify env var expansion works
- [ ] Edit an existing connection, add a starting directory, save and connect — verify it uses the new directory

#### New tabs open in home directory (PR #66)

> **E2E coverage:** 2 E2E, 1 manual (multi-OS verification)

- [ ] Open the app and create a new local shell tab — verify it starts in `~`
- [ ] Verify the file browser shows the home directory after the first prompt
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

#### Baseline

> **E2E coverage:** 6 E2E/infra (password auth, key auth, error handling, resize, commands, disconnect — all via Docker SSH)

- [ ] Create SSH connection with password auth, connect — password prompt appears, connection succeeds after entering password
- [ ] Create SSH connection with key auth, set key path, connect — connection succeeds without password prompt
- [ ] Create SSH connection to non-existent host, connect — error message displayed in terminal within reasonable timeout
- [ ] Resize the app window with a connected SSH session — remote shell reports updated dimensions
- [ ] Run commands that produce output (e.g. `ls -la`, `top`) in a connected SSH session — output renders correctly in terminal
- [ ] Kill the SSH server or disconnect network during an SSH session — terminal shows disconnection message

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

#### OpenSSH-format private keys / Ed25519 (PR #134)

> **E2E coverage:** 3 E2E/infra (Ed25519, passphrase, PEM — test keys in fixtures, Docker SSH containers)

- [ ] SSH connect with Ed25519 key in OpenSSH format
- [ ] SSH connect with passphrase-protected key
- [ ] Legacy PEM-format key still works (no regression)

#### SSH agent setup guidance (PR #133)

> **E2E coverage:** 1 E2E/infra (error message), 1 partial (agent status dependent), 1 manual (PowerShell elevation)

- [ ] Open connection editor, select SSH + Agent auth — warning appears if agent is stopped, normal hint if running
- [ ] Click "Setup SSH Agent" button — local PowerShell tab opens with elevation command
- [ ] SSH connect with agent auth when agent is stopped — helpful error in terminal

#### Password prompt at connect (PR #38)

> **E2E coverage:** 1 E2E (no password in JSON), 2 E2E/infra (key no dialog, SFTP dialog), 2 manual (native export dialog, startup strip)

- [ ] SSH key-auth connections — no password dialog, connects directly
- [ ] SFTP connect to password-auth SSH — password dialog appears
- [ ] Inspect `connections.json` — no `password` field present for any SSH connection
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

#### SFTP file browser follows SSH terminal CWD (PR #186)

> **E2E coverage:** 5 E2E/infra (Docker SSH + file browser panel verification)

- [ ] SSH to a Linux host — open Files sidebar — run `cd /tmp` in the terminal — SFTP browser navigates to `/tmp`
- [ ] Run `cd ~` — SFTP browser navigates back to home directory
- [ ] Run `cd /var/log` — SFTP browser navigates to `/var/log`
- [ ] Open a second SSH tab to a different host — file browser follows the active tab's CWD independently
- [ ] Switch between SSH tabs — file browser updates to each tab's last known CWD

#### Auto-connect monitoring on SSH tab switch (PR #163)

> **E2E coverage:** 3 E2E/infra (Docker SSH + status bar checks)

- [ ] Open an SSH terminal tab — monitoring stats appear automatically in the status bar
- [ ] Switch between two SSH tabs connected to different hosts — monitoring switches hosts
- [ ] Manual "Monitor" dropdown still works as a fallback

#### Optional monitoring and file browser settings (PR #199)

> **E2E coverage:** 11 E2E/infra (settings toggles + SSH connection verification)

- [ ] Open Settings > Advanced — verify "Power Monitoring" and "File Browser" toggles are visible and enabled by default
- [ ] Disable "Power Monitoring" globally — connect to an SSH host — verify no monitoring stats appear in the status bar
- [ ] Re-enable "Power Monitoring" globally — connect to an SSH host — verify monitoring stats appear again
- [ ] Disable "File Browser" globally — switch to Files sidebar — verify SFTP file browser does not activate for SSH tabs
- [ ] Re-enable "File Browser" globally — verify SFTP file browser works again for SSH tabs
- [ ] Edit an SSH connection — verify "Power Monitoring" and "File Browser" dropdowns appear with Default/Enabled/Disabled options
- [ ] Set per-connection monitoring to "Disabled" while global is enabled — connect — verify no monitoring for that connection
- [ ] Set per-connection monitoring to "Enabled" while global is disabled — connect — verify monitoring works for that connection
- [ ] Set per-connection monitoring to "Default" — verify it follows the global setting
- [ ] Repeat the above three tests for the file browser per-connection override
- [ ] Save a connection with per-connection overrides, close and reopen the app — verify settings persist

#### Monitoring hides on non-SSH tab (PR #165)

> **E2E coverage:** 5 E2E/infra (tab switching + status bar visibility)

- [ ] Open an SSH terminal tab — monitoring stats appear in the status bar
- [ ] Switch to a local shell tab — monitoring section disappears from status bar
- [ ] Switch back to the SSH tab — monitoring stats reappear immediately (no reconnect delay)
- [ ] Open a settings tab — monitoring hides
- [ ] Close all tabs — monitoring hides

#### SSH monitoring in status bar (PR #114, #115)

> **E2E coverage:** 1 E2E (sidebar check), 7 E2E/infra (stats, buttons, dropdown), 1 partial (high-value colors need specific load)

- [ ] Selecting a connection connects monitoring, shows inline stats
- [ ] Stats auto-refresh every 5 seconds
- [ ] Refresh and disconnect icon buttons work
- [ ] High values show warning (yellow >= 70%) and critical (red >= 90%) colors
- [ ] Sidebar no longer has monitoring view
- [ ] Save & Connect button saves and opens terminal in one action
- [ ] After connecting, status bar displays: hostname, CPU%, Mem%, Disk%
- [ ] Clicking hostname opens detail dropdown with system info, refresh, and disconnect
- [ ] Disconnecting returns to the "Monitor" button state

#### Environment variable expansion in connections (PR #68)

> **E2E coverage:** 2 E2E (local checks, config inspection), 2 E2E/infra (SSH username resolution)

- [ ] Create an SSH connection with username `${env:USER}` — connect — resolves to actual username
- [ ] Create a local shell with initial command `echo ${env:HOME}` — prints home directory
- [ ] Use an undefined variable `${env:NONEXISTENT}` — left as-is, no crash
- [ ] Verify saved connection JSON still contains literal `${env:USER}` (not expanded)

#### SSH tunneling (PR #225)

> **E2E coverage:** 10 E2E (tunnel UI CRUD, type selector, diagram, duplicate, delete), 5 E2E/infra (start/stop, traffic, actual forwarding), 2 partial (app restart persistence), 1 manual (auto-start on launch)

- [ ] Click "SSH Tunnels" in the activity bar — verify the tunnels sidebar panel opens with "No SSH tunnels configured" message and a "+ New Tunnel" button
- [ ] Click "+ New Tunnel" — verify a tunnel editor tab opens with name field, SSH connection dropdown, type selector (Local/Remote/Dynamic), and visual diagram
- [ ] Select "Local" type — verify the diagram shows "Your PC → SSH → SSH Server → Target" and local/remote host/port fields appear
- [ ] Select "Remote" type — verify the diagram shows "Local Target ← SSH ← SSH Server ← Remote Clients" and corresponding fields appear
- [ ] Select "Dynamic" type — verify the diagram shows "Your PC → SSH → SSH Server → Internet" and only local host/port fields appear
- [ ] Change port numbers — verify the visual diagram updates reactively with the new values
- [ ] Fill in name, select an SSH connection, configure ports, click "Save" — verify the tunnel appears in the sidebar list and the editor tab closes
- [ ] Verify the tunnel config persists across app restarts (check `tunnels.json` in the config directory)
- [ ] Double-click a tunnel in the sidebar — verify the editor tab opens with the saved configuration pre-filled
- [ ] Edit a tunnel and click "Save" — verify changes are persisted
- [ ] Click the Play button on a tunnel in the sidebar — verify the status indicator turns green (connected)
- [ ] Click the Stop button on an active tunnel — verify the status indicator turns grey (disconnected)
- [ ] Click "Save & Start" in the tunnel editor — verify the tunnel is saved and started in one action
- [ ] Create a local forward tunnel (e.g., local port 18080 → remote localhost:80) — start it — verify `curl http://127.0.0.1:18080` reaches the remote service
- [ ] Click the Duplicate button on a tunnel — verify a "Copy of ..." tunnel appears in the sidebar
- [ ] Click the Delete button on a tunnel — verify it is removed from the sidebar
- [ ] Enable "Auto-start when app launches" on a tunnel — restart the app — verify the tunnel starts automatically
- [ ] Verify traffic stats (bytes sent/received, active connections) update in the sidebar for active tunnels

---

### Serial

#### Baseline

> **E2E coverage:** 5 E2E/infra (virtual serial ports via socat in Docker)

- [ ] Open connection editor, select Serial type with a serial port or virtual port via socat available — port dropdown lists available serial ports
- [ ] Create serial connection at 9600 and 115200 baud with a serial device or virtual port, connect — connection opens, data exchange works
- [ ] Type characters in a connected serial session — characters sent to device and echoed back (if device echoes)
- [ ] Disconnect the serial device during a connected serial session — terminal shows error/disconnect message
- [ ] Set non-default data bits, stop bits, parity, flow control on a serial connection — connection works with configured parameters

#### Nerd Font / Powerline glyph support (PR #131)

> **E2E coverage:** 0 E2E — all 2 manual (visual glyph rendering)

- [ ] SSH to a host running zsh with the agnoster theme — Powerline glyphs render correctly instead of boxes
- [ ] Verify on a clean Windows machine without any Nerd Font installed locally

---

### Telnet

#### Baseline

> **E2E coverage:** 3 E2E/infra (Docker telnet container)

- [ ] Create Telnet connection to a server (e.g. Docker example), connect — connection established, server banner displayed
- [ ] Type commands in a connected Telnet session — commands execute and output displays
- [ ] Create Telnet connection to non-existent host — error message displayed within reasonable timeout

---

### Tab Management

#### Baseline

> **E2E coverage:** 5 E2E (new tabs, close, switch, context menu, close last in split), 2 partial (drag reorder limited in WebDriver)

- [ ] Click New Terminal multiple times — multiple tabs appear in tab bar, most recent is active
- [ ] Click X on a tab or use Ctrl+W with multiple tabs open — tab removed, adjacent tab becomes active
- [ ] Drag a tab to a new position in the tab bar with multiple tabs open — tab moves to new position, order persists
- [ ] Click different tabs, use Ctrl+Tab / Ctrl+Shift+Tab — correct terminal displayed for each tab
- [ ] Right-click a tab — context menu with Close, Copy, Save, Clear options
- [ ] Close the last tab in a split panel — panel removed (if other panels exist) or empty panel remains
- [ ] Drag-and-drop tabs still works correctly

#### Save terminal content to file (PR #35)

> **E2E coverage:** 0 E2E — all 3 manual (native file save dialog)

- [ ] Click "Save to File" — native save dialog opens with default filename `terminal-output.txt`
- [ ] Choose a location — file is written with the terminal's text content
- [ ] Cancel the dialog — nothing happens

#### Suppress browser default context menu (PR #150)

> **E2E coverage:** 1 E2E (context menu verification)

- [ ] Right-click on empty areas (sidebar whitespace, terminal, activity bar) — no menu appears

#### Per-connection horizontal scrolling (PR #45)

> **E2E coverage:** 2 E2E (toggle, persistence), 2 partial (visual scroll check), 1 manual (key repeat timing)

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

#### Baseline

> **E2E coverage:** 4 E2E (create, edit, delete, duplicate — all UI interactions)

- [ ] Click + in connection list, fill form, save — connection appears in list
- [ ] Right-click a connection > Edit, modify fields, save — changes persisted, visible on next app restart
- [ ] Right-click a connection > Delete — connection removed from list
- [ ] Right-click a connection > Duplicate — "Copy of <name>" appears in same folder

#### Remove folder selector from editor (PR #146)

> **E2E coverage:** 3 E2E (no dropdown, folder right-click, in-folder edit), 1 partial (drag onto folder)

- [ ] Open connection editor — verify no "Folder" dropdown is shown
- [ ] Right-click a folder — "New Connection" — save — verify connection is placed in that folder
- [ ] Drag a connection onto a folder in the sidebar — verify it moves correctly
- [ ] Edit an existing connection in a folder — save — verify it stays in the same folder

#### Shell-specific icons and icon picker (PR #157)

> **E2E coverage:** 6 partial (can verify icon element existence via data-testid, but visual icon correctness needs manual check)

- [ ] Open a PowerShell tab — verify biceps icon appears in tab bar and drag overlay
- [ ] Open a Git Bash tab — verify git branch icon appears
- [ ] Open a WSL tab — verify penguin icon appears
- [ ] Edit a saved connection — click "Set Icon" — search for an icon — apply — verify icon shows in sidebar and tab
- [ ] Search "arm" in the icon picker — verify BicepsFlexed appears
- [ ] Clear a custom icon — verify default icon is restored

#### Save & Connect button (PR #112)

> **E2E coverage:** 2 E2E (save+connect flow, separate save/cancel)

- [ ] Edit existing SSH connection — click "Save & Connect" — password prompt appears — connection opens after password entry
- [ ] Click "Save & Connect" with password auth, cancel password prompt — editor tab stays open (connect aborted, but save already completed)

#### Import/export connections (PR #33)

> **E2E coverage:** 0 E2E — all 2 manual (native file dialogs)

- [ ] Click "Import Connections" — file open dialog, imports JSON, connection list refreshes
- [ ] Click "Export Connections" — file save dialog, saves JSON

#### Encrypted export/import of connections with credentials (PR #322)

> **E2E coverage:** 4 E2E (in-app dialog UI: default selection, password/confirm fields, validation errors), 7 manual (native file picker for actual export/import)

- [ ] Click "Export Connections" — Export dialog opens with "Without credentials" selected by default
- [ ] Select "With credentials (encrypted)" — password and confirm fields appear with warning text
- [ ] Type a password shorter than 8 characters — verify "Password must be at least 8 characters" error shown
- [ ] Type mismatched passwords — verify "Passwords do not match" error shown
- [ ] Enter matching passwords (8+ chars), click Export — file save dialog opens, JSON file is saved with `$encrypted` section
- [ ] Export "Without credentials" — verify saved JSON has no `$encrypted` section (no regression)
- [ ] Click "Import Connections", select a file with encrypted credentials — Import dialog shows connection count and password field
- [ ] Enter correct export password, click "Import with Credentials" — verify success message shows connections and credentials imported
- [ ] Enter wrong password — verify "Wrong password" error, password field remains for retry
- [ ] Click "Skip Credentials" on an encrypted import — verify connections imported without credentials
- [ ] Import a plain (non-encrypted) export file — verify simple Import button shown (no password prompt), connections imported normally

#### SSH key file validation (PR #204)

> **E2E coverage:** 8 E2E (type paths, verify hint text, debounce behavior — all UI interactions on connection editor)

- [ ] Open connection editor, select SSH type, set auth method to "SSH Key" — select a `.pub` file via browse — verify a warning hint appears: "This looks like a public key (.pub)..."
- [ ] Type or paste a path to a valid OpenSSH private key — verify a green success hint appears: "OpenSSH private key detected."
- [ ] Type or paste a path to a valid RSA PEM private key — verify a green success hint appears: "RSA (PEM) private key detected."
- [ ] Type a nonexistent path (e.g., `/no/such/key`) — verify a red error hint appears: "File not found."
- [ ] Select a PuTTY PPK file — verify a warning hint appears mentioning `puttygen` conversion
- [ ] Select a random non-key file (e.g., a `.txt` file) — verify a warning hint appears: "Not a recognized SSH private key format."
- [ ] Clear the key path field — verify the hint disappears
- [ ] Type a path character by character — verify the hint updates after a short debounce delay (no flickering on every keystroke)

#### SSH key path browse button (PR #205)

> **E2E coverage:** 0 E2E — all 5 manual (native file dialog)

- [ ] Create or edit an SSH connection, set auth method to "Key", click "..." button — verify a native file dialog opens defaulting to `~/.ssh`
- [ ] Select a key file — verify the path populates in the input field
- [ ] Cancel the dialog — verify the input field remains unchanged
- [ ] Repeat the above for Agent connection settings
- [ ] Manually type a path in the input field — verify it still works as before

#### SSH key path file suggestions (PR #118)

> **E2E coverage:** 10 E2E (dropdown display, filtering, keyboard nav, Tab/Enter/Escape, browse fallback, agent field)

- [ ] Open connection editor, select SSH type, set auth method to "SSH Key" — focus the Key Path field — verify a dropdown appears listing private key files from `~/.ssh/`
- [ ] Verify `.pub` files, `known_hosts`, `authorized_keys`, and `config` are NOT shown in the dropdown
- [ ] Type part of a key name to filter — verify the dropdown filters in real time (case-insensitive)
- [ ] Use arrow keys to navigate the dropdown — verify the highlighted item changes
- [ ] Press Tab or Enter on a highlighted item — verify the path is accepted and the dropdown closes
- [ ] Press Tab with no highlight but exactly one match — verify it auto-accepts that match
- [ ] Press Escape — verify the dropdown closes without changing the value
- [ ] Click the "..." browse button — verify the native file dialog still works
- [ ] Repeat all of the above for the Agent settings Key Path field
- [ ] Test with no `~/.ssh/` directory (or empty directory) — verify no dropdown appears and no error occurs

#### Default user and SSH key applied to new connections (PR #201)

> **E2E coverage:** 7 E2E (settings defaults, form pre-fill, auth method, edit preserves values, suggestion dropdown)

- [ ] Open Settings > General — set "Default User" to `admin` and "Default SSH Key Path" to a valid path — save
- [ ] Create a new SSH connection — verify the username is pre-filled with `admin`, auth method is set to "Key", and key path is pre-filled
- [ ] Clear "Default SSH Key Path" in settings — create a new SSH connection — verify auth method defaults to "Password" and key path is empty
- [ ] Set only "Default User" — create a new SSH connection — verify username is pre-filled but auth method is "Password"
- [ ] Create a new Remote Agent — verify username and key path are pre-filled from settings
- [ ] Edit an existing SSH connection — verify it retains its own values (not overwritten by defaults)
- [ ] Verify the "Default SSH Key Path" field in General Settings shows the `~/.ssh/` file suggestion dropdown

#### Auto-extract port from host field (PR #195)

> **E2E coverage:** 5 E2E (type host:port, verify field splitting — pure UI interaction)

- [ ] Enter `192.168.0.2:2222` in the SSH host field, tab out — verify host becomes `192.168.0.2` and port becomes `2222`
- [ ] Enter `[::1]:22` in the host field, tab out — verify host becomes `::1` and port becomes `22`
- [ ] Enter `myhost.example.com` (no port) — verify host stays unchanged and port is not modified
- [ ] Enter a bare IPv6 address `::1` — verify it is left untouched
- [ ] Verify the same behavior works in Telnet and Agent settings

#### External connection file support (PR #50, redesigned in PR #210)

> **E2E coverage:** 7 E2E (toggle, context menu, tree display — with programmatic file setup), 1 partial (drag-and-drop), 2 manual (native file picker for Create/Add)

- [ ] Settings tab — "External Connection Files" section visible
- [ ] "Create File" — enter name — save dialog — empty JSON file created and auto-added to list
- [ ] "Add File" — native file picker — select JSON — path appears in list with toggle
- [ ] External connections appear in the unified "Connections" tree alongside local connections
- [ ] External connections: edit, duplicate, delete via context menu
- [ ] Drag-and-drop external connections into local folders — folder assignment persists correctly
- [ ] Toggle file disabled in Settings — external connections disappear from the unified tree
- [ ] Re-enable file — connections reappear
- [ ] Remove file from Settings — connections disappear
- [ ] Local connections still fully editable/draggable/deletable (no regressions)

#### Storage File selector in connection editor (PR #210)

> **E2E coverage:** 7 E2E (dropdown options, save to different files, move between files), 1 partial (requires external file setup)

- [ ] Add an external connection file in Settings and enable it
- [ ] Open connection editor — click "Advanced" — verify "Storage File" dropdown appears
- [ ] Dropdown shows "Default (connections.json)" and the enabled external file paths
- [ ] Create a new connection with "Default" storage file — verify it persists to connections.json
- [ ] Create a new connection with an external file selected — verify it persists to that external file
- [ ] Edit an existing local connection — change storage file to an external file — save — verify the connection moved (appears in external file, removed from connections.json)
- [ ] Edit an external connection — change storage file to "Default" — save — verify it moved to connections.json
- [ ] Advanced section does not appear when no external files are configured in Settings

#### Schema-driven connection settings (PR #362)

> **E2E coverage:** 11 E2E (form rendering per type, field switching, conditional fields, capabilities — all UI verification)

- [ ] Open connection editor → switch between all connection types (Local, SSH, Serial, Telnet, Docker) — verify each type shows the correct settings fields matching the previous hardcoded UI
- [ ] Create a new SSH connection — verify host, port, username, auth method fields appear; switching auth method toggles key path / password visibility
- [ ] Create a new Docker connection — verify env vars editor works (add/remove key-value rows) and volumes editor works (add/remove rows with host path, container path, read-only toggle)
- [ ] SSH key path field shows the combobox with available key files (not a plain text input)
- [ ] Create a new Serial connection — verify port, baud rate, data bits, stop bits, parity, flow control fields appear with correct dropdown options
- [ ] Edit an existing connection — verify saved values load correctly into the schema-driven form
- [ ] "Save & Connect" with SSH password auth (no saved password) — verify password prompt appears
- [ ] Conditional fields work: SSH auth method "Key" shows key path, "Password" shows password field, "Agent" hides both
- [ ] Switch connection type in the editor — verify fields reset to defaults for the new type
- [ ] Monitoring toggle respects capabilities — monitoring panel only appears for connection types that support it (e.g., SSH), not for local/serial/telnet
- [ ] File browser respects capabilities — SFTP file browser only activates for connection types with file browser capability

---

### Split Views

#### Baseline

> **E2E coverage:** 4 E2E (split, close, nested), 2 partial (drag divider, drag tab to edge — limited in WebDriver)

- [ ] Click split button or use toolbar with a terminal open — panel splits horizontally, new empty panel appears
- [ ] Hold Shift + click split (or toolbar option) — panel splits vertically
- [ ] Close all tabs in one panel with multiple panels — panel removed, remaining panels resize
- [ ] Drag the divider between split panels — panels resize, terminals re-fit
- [ ] Drag a tab to the edge of another panel — new split created, tab moves to new panel
- [ ] Create horizontal split, then split one panel vertically — both horizontal and vertical splits coexist

---

### File Browser

#### Baseline

> **E2E coverage:** 2 E2E (files view switch, double-click edit), 1 E2E/infra (SFTP connect), 3 manual (upload/OS drag, download dialog, VS Code)

- [ ] Switch to Files view, select Local mode — local filesystem tree displayed
- [ ] Connect SFTP via picker with an SSH connection — remote filesystem tree displayed
- [ ] Right-click remote file > Upload or drag file from OS in SFTP mode — file appears in remote listing
- [ ] Right-click remote file > Download in SFTP mode — file saved to local filesystem
- [ ] Open in editor: double-click a text file in the browser — file opens in built-in editor tab
- [ ] Right-click file > Open in VS Code (when VS Code installed) — file opens in VS Code

#### CWD-aware file browser (PR #39)

> **E2E coverage:** 5 E2E (local cd tracking, tab switch, sidebar switch, rename/delete, create dir), 2 E2E/infra (SSH SFTP auto-connect)

- [ ] Open a local zsh terminal — `cd /tmp` — sidebar file browser shows `/tmp` contents
- [ ] Open a second local shell tab — switch between tabs — file browser follows each tab's CWD
- [ ] Open an SSH terminal — file browser auto-connects SFTP (with password prompt) and shows remote CWD
- [ ] Open a serial terminal — file browser shows "no filesystem" placeholder
- [ ] Switch sidebar to connections view — switch tabs — switch back to files — correct CWD shown
- [ ] Right-click rename/delete on local files — operations work and list refreshes
- [ ] Create directory via toolbar button — works for both local and SFTP modes

#### File browser follows tab switch from WSL to PowerShell (PR #167)

> **E2E coverage:** 0 E2E — all 4 manual (WSL-specific)

- [ ] Open a WSL tab — file browser shows `//wsl$/<distro>/home/<user>`
- [ ] Open a PowerShell tab — file browser switches to Windows home directory
- [ ] Switch back to WSL tab — file browser returns to WSL path
- [ ] Open a bash tab (no OSC 7) — file browser shows home directory, not previous tab's path

#### Local file explorer stuck at root fix (PR #110)

> **E2E coverage:** 3 E2E (home dir on open, bash fallback, navigation caching)

- [ ] Open a local terminal, click Files sidebar — file list shows home directory contents
- [ ] Test with bash (no OSC 7) — still loads home directory
- [ ] Navigate away and back — does not re-navigate if entries already loaded

#### File browser stays active when editing (PR #57)

> **E2E coverage:** 3 E2E (local file, tab switch, settings), 1 E2E/infra (remote SFTP file)

- [ ] Open a local file for editing — file browser shows the file's parent directory
- [ ] Open a remote (SFTP) file for editing — file browser shows the remote parent directory
- [ ] Switch between editor and terminal tabs — file browser updates correctly
- [ ] Settings tab still shows "No filesystem available" as before

#### New File button (PR #58)

> **E2E coverage:** 4 E2E (create, escape cancel, local mode, new folder), 1 E2E/infra (SFTP mode)

- [ ] Click "New File" button — inline input appears — type name — Enter — file created and list refreshes
- [ ] Press Escape in the input — cancels without creating
- [ ] Works in local file browser mode
- [ ] Works in SFTP file browser mode
- [ ] "New Folder" still works as before

#### Right-click context menu (PR #59)

> **E2E coverage:** 5 E2E (file menu, dir menu, three-dots, actions, styling), 1 E2E/infra (SFTP download option)

- [ ] Right-click a file — context menu appears with Edit, Open in VS Code, Rename, Delete
- [ ] Right-click a directory — context menu appears with Open, Rename, Delete
- [ ] Right-click in SFTP mode — Download option appears for files
- [ ] Three-dots menu still works as before
- [ ] Context menu actions (edit, rename, delete, etc.) all function correctly
- [ ] Menu styling matches connection list context menus

#### Open in VS Code (PR #51)

> **E2E coverage:** 0 E2E — all 4 manual (external VS Code app integration)

- [ ] File browser (local mode) — right-click file — "Open in VS Code" visible — opens file in VS Code
- [ ] File browser (SFTP mode) — right-click file — "Open in VS Code" — file opens — edit and close tab — file re-uploaded (verify content changed on remote)
- [ ] VS Code not installed — "Open in VS Code" menu item does not appear
- [ ] SFTP session lost during edit — error event emitted, no crash

#### Double-click file to open in editor (PR #61)

> **E2E coverage:** 2 E2E (local file, directory), 1 E2E/infra (SFTP file)

- [ ] Double-click a file in local file browser — opens in editor tab
- [ ] Double-click a file in SFTP file browser — opens in editor tab
- [ ] Double-click a directory — navigates into it (unchanged behavior)

---

### Editor

#### Built-in file editor with Monaco (PR #54)

> **E2E coverage:** 7 E2E (open, edit+save, toolbar save, dirty/clean close, reuse tab, binary error), 1 E2E/infra (SFTP edit), 1 partial (drag between panels)

- [ ] Right-click a file in the local file browser — "Edit" — file opens in editor tab with syntax highlighting
- [ ] Edit content — tab shows dirty dot — Ctrl+S — saves — dirty dot clears
- [ ] Click Save button in toolbar — same behavior as Ctrl+S
- [ ] Close dirty tab — confirmation dialog appears — Cancel keeps tab open, OK closes it
- [ ] Close clean tab — no confirmation dialog
- [ ] Open same file twice — reuses existing editor tab instead of creating a new one
- [ ] SFTP file browser — right-click file — "Edit" — remote file loads with [Remote] badge — edit + save works
- [ ] Binary/non-UTF-8 file — graceful error message displayed
- [ ] Editor tab drag-and-drop between panels works correctly

#### Editor status bar (PR #65)

> **E2E coverage:** 7 E2E (all status bar fields: Ln/Col, Spaces, encoding, EOL, language, show/hide on tab switch)

- [ ] Open a `.ts` file — status bar shows: `Ln 1, Col 1  Spaces: 4  UTF-8  LF  typescript`
- [ ] Move cursor — Ln/Col updates in real-time
- [ ] Click "Spaces: 4" — changes to "Spaces: 2", editor indentation updates
- [ ] Click "LF" — changes to "CRLF"
- [ ] Switch to a terminal tab — status bar items disappear
- [ ] Switch back to editor tab — items reappear with correct values
- [ ] Close editor tab — status bar clears

#### Indent selection in status bar (PR #111)

> **E2E coverage:** 3 E2E (dropdown, option selection, label update)

- [ ] Open a file in the editor, click the indent indicator in the status bar — dropdown appears with "Indent Using Spaces" (1/2/4/8) and "Indent Using Tabs" (1/2/4/8)
- [ ] Selecting an option updates the editor behavior and the status bar label
- [ ] Label correctly shows "Spaces: N" or "Tab Size: N"

#### Language mode selector (PR #113)

> **E2E coverage:** 4 E2E (dropdown, search filter, language selection, close behavior)

- [ ] Open a file in the editor, click the language name in the status bar — dropdown appears with search input and all available languages
- [ ] Typing filters the list in real-time
- [ ] Selecting a language updates syntax highlighting and the status bar label
- [ ] Dropdown closes on selection or clicking outside

---

### UI / Layout

#### No white flash on startup (PR #192)

> **E2E coverage:** 1 E2E (theme switching works), 3 manual (visual startup timing, app restart)

- [ ] Launch the app — verify the window starts with a dark background (#1e1e1e) instead of flashing white
- [ ] Observe the full startup sequence — there should be no white → dark → white transitions
- [ ] Open Settings > Appearance > Theme — switch to Light, then back to Dark — verify theming still works correctly
- [ ] Restart the app with Dark theme selected — verify no white flash on launch

#### Color theme switching (PR #220)

> **E2E coverage:** 4 E2E (select Light/Dark, terminal re-theme, activity bar dark), 2 partial (System mode, state dots), 3 manual (OS toggle, app restart, ErrorBoundary)

- [ ] Open Settings > Appearance > Theme — select "Light" — verify all UI elements update: sidebar becomes light gray, tabs become light, text becomes dark, borders lighten
- [ ] Select "Dark" — verify all UI elements revert to the dark color scheme
- [ ] Select "System" — verify the app follows the current OS dark/light mode preference
- [ ] In "System" mode, toggle OS dark/light mode — verify the app switches themes automatically without a restart
- [ ] Open multiple terminal tabs — switch theme — verify all terminal instances re-theme live (background, foreground, ANSI colors all change)
- [ ] Verify the activity bar stays dark in both Light and Dark themes (visual anchor)
- [ ] Verify state dots (connected/connecting/disconnected) are visible in both themes on terminal tabs and agent sidebar nodes
- [ ] Close and reopen the app — verify the selected theme persists across restarts
- [ ] Trigger an error (e.g., throw in a component) to see the ErrorBoundary — verify it renders with theme-appropriate colors

#### Theme switching applies immediately (PR #224)

> **E2E coverage:** 3 E2E (Dark-to-Light, Light-to-Dark, rapid toggle), 1 partial (System mode follows OS)

- [ ] Open Settings > Appearance > Theme — switch from Dark to Light — verify the UI changes immediately without needing an app restart
- [ ] Switch from Light to Dark — verify immediate visual change
- [ ] Switch to System — verify the theme matches the current OS preference immediately
- [ ] Rapidly toggle between Dark and Light several times — verify each switch is applied instantly with no delay

#### Settings as tab (PR #32)

> **E2E coverage:** 1 partial (drag between panels — limited in WebDriver)

- [ ] Drag the settings tab between panels — works with correct Settings icon

#### Horizontal Activity Bar mode (PR #264)

> **E2E coverage:** 6 E2E (position, icon layout, active indicator, dropdown direction, space fill, position switch)

- [ ] Set `activityBarPosition` to `"top"` — verify the Activity Bar renders horizontally above the main content area
- [ ] Verify icons display in a row: Connections, File Browser, SSH Tunnels on the left; Log Viewer, Settings on the right
- [ ] Verify the active indicator bar appears at the bottom edge of the active icon (not the left side)
- [ ] Click the Settings gear icon — verify the dropdown opens downward (not to the right)
- [ ] Verify the sidebar + terminal area fills the remaining vertical space below the Activity Bar
- [ ] Switch back to `"left"` / `"right"` positions — verify they still work correctly

#### Customize Layout dialog (PR #242)

> **E2E coverage:** 2 E2E (dialog open via gear, Escape closes)

- [ ] Click the Settings gear in the Activity Bar — click "Customize Layout..." — verify the dialog opens with title "Customize Layout"
- [ ] Press Escape — verify the dialog closes

#### Sidebar toggle button and Ctrl+B shortcut (PR #194)

> **E2E coverage:** 2 E2E (Ctrl+B/Cmd+B shortcut, tooltip text)

- [ ] Press Ctrl+B (Cmd+B on Mac) — sidebar toggles
- [ ] Hover the button — tooltip shows "Toggle Sidebar (Ctrl+B)" (or "Cmd+B" on Mac)

#### Highlight selected tab with top border accent (PR #190)

> **E2E coverage:** 4 E2E (active border, focus/unfocus dimming, panel switch, close panel — via CSS class checks)

- [ ] Open multiple tabs in a single panel — active tab should have a blue top border, inactive tabs should have no top border
- [ ] Split the view into two panels — focused panel's active tab has a bright blue border, unfocused panel's active tab has a dimmer (gray) border
- [ ] Click between panels to switch focus — borders update: focused panel gets bright blue, previously focused panel dims
- [ ] Close all tabs in one panel — remaining panel's active tab still shows bright blue border

#### Vertical split resize handle (PR #213)

> **E2E coverage:** 3 E2E (handle visibility for vertical, horizontal, nested), 1 partial (drag to resize)

- [ ] Split a terminal vertically (top/bottom) — verify the resize handle between panels is visible
- [ ] Drag the vertical resize handle — verify panels resize smoothly
- [ ] Split a terminal horizontally (left/right) — verify no regression, resize handle still works
- [ ] Create nested splits (horizontal inside vertical and vice versa) — verify all resize handles are visible and draggable

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

#### Redesign remote agent as parent folder with child sessions (PR #164)

> **E2E coverage:** 4 E2E/infra (connect, shell session, reconnect, context menu — requires agent infrastructure)

- [ ] Create a remote agent entry — connect — see available shells/ports in expanded folder
- [ ] Create a shell session under agent — terminal tab opens
- [ ] Disconnect agent — reconnect — persistent sessions re-attach
- [ ] Agent context menu actions all work (connect/disconnect/new session/edit/delete)

#### Wire RemoteBackend into TerminalManager and UI (PR #106)

> **E2E coverage:** 1 E2E/infra (create connection, verify form/output)

- [ ] Create a "Remote Agent" connection in the UI, verify settings form renders, verify connection attempt produces terminal output or error (not a crash)

#### RemoteBackend and session reconnect (PR #87)

> **E2E coverage:** 3 E2E/infra (connect, output, reconnect), 1 manual (cleanup verification)

- [ ] Connect to a remote host running the agent
- [ ] Verify terminal output appears for shell and serial sessions
- [ ] Kill SSH connection, verify "reconnecting" indicator and auto-reconnect
- [ ] Close tab, verify cleanup (no orphan threads)

#### Connection error feedback dialog

> **E2E coverage:** 5 E2E/infra (invalid host, wrong password, agent not installed, technical details, close button), 1 manual (agent binary state)

- [ ] Create a remote agent with an invalid hostname — click "Connect" — verify "Could Not Reach Host" dialog appears with Close button
- [ ] Create a remote agent with valid host but wrong password — click "Connect" — verify "Authentication Failed" dialog appears with Close button
- [ ] Create a remote agent with valid SSH credentials but no agent binary installed — click "Connect" — verify "Agent Not Installed" dialog appears with "Setup Agent" and Close buttons
- [ ] In the "Agent Not Installed" dialog, click "Setup Agent" — verify the Agent Setup dialog opens
- [ ] In any error dialog, click "Technical details" — verify the raw backend error message is shown
- [ ] In any error dialog, click Close — verify the dialog closes and the agent remains in disconnected state

#### Agent setup wizard (PR #137)

> **E2E coverage:** 4 E2E/infra (context menu, dialog, terminal, commands), 3 partial (file picker, binary upload), 3 manual (systemd, error case, connect after)

- [ ] Create a remote agent entry pointing to Docker SSH container (127.0.0.1:2222, testuser/testpass)
- [ ] Right-click the disconnected agent — verify "Setup Agent..." appears in context menu
- [ ] Click "Setup Agent..." — verify dialog opens with binary path, remote path, and service checkbox
- [ ] Browse for a pre-built `termihub-agent` binary (Linux x86_64) — verify file picker works
- [ ] Click "Start Setup" — verify SSH terminal tab opens with the shell prompt
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

> **E2E coverage:** 7 E2E (correct/incorrect password, skip, status bar indicator, lock/unlock, no indicator in other modes), 1 manual (startup auto-open requires pre-config)

- [ ] Configure credential store to master_password mode and lock it — on app startup, the unlock dialog should appear automatically
- [ ] Enter the correct master password in the unlock dialog — dialog closes and credential store becomes unlocked
- [ ] Enter an incorrect master password — error message "Incorrect master password." is shown, password field is cleared
- [ ] Click "Skip" on the unlock dialog — dialog closes, credential store remains locked
- [ ] With master_password mode active, verify the status bar shows a lock icon with "Locked" or "Unlocked" text
- [ ] Click the "Locked" indicator in the status bar — unlock dialog opens
- [ ] Click the "Unlocked" indicator in the status bar — credential store locks, indicator changes to "Locked"
- [ ] With keychain or none mode active — no credential store indicator is shown in the status bar

#### Credential store auto-fill on connect (PR #258)

> **E2E coverage:** 6 E2E/infra (save+auto-fill, stale credential, passphrase, no-lookup cases — via Docker SSH), 1 manual (remote agent)

- [ ] Create an SSH connection with `savePassword` enabled, connect once (enter password when prompted) — verify the password is saved to the credential store
- [ ] Disconnect and reconnect the same SSH connection — verify the stored credential is used automatically without prompting
- [ ] Change the remote password, then reconnect — verify the stale credential is detected (auth failure), cleared from the store, and the user is re-prompted for the new password
- [ ] Create an SSH connection using key auth with `savePassword` enabled and a passphrase-protected key — verify the stored passphrase is used automatically on reconnect
- [ ] Create an SSH connection using agent auth — verify no credential store lookup occurs and connection proceeds normally
- [ ] Create an SSH connection with `savePassword` disabled — verify no credential store lookup occurs and the user is prompted as before
- [ ] Connect a remote agent with `savePassword` enabled — verify stored credentials are used automatically, and stale credentials trigger re-prompt after removal

#### Auto-lock timeout for master password credential store (PR #263)

> **E2E coverage:** 2 E2E (setting persistence, Never option), 3 partial (timeout timing, timer reset, immediate effect)

- [ ] In Settings > Security, set auto-lock timeout to 5 minutes — verify the dropdown saves and the setting persists after restarting the app
- [ ] With master password mode active and store unlocked, wait for the configured timeout to elapse — verify the store auto-locks and the unlock dialog appears
- [ ] While the store is unlocked, perform credential operations (connect with saved password, browse credentials) — verify each operation resets the inactivity timer (store does not lock prematurely)
- [ ] Set auto-lock to "Never" — verify the store does not auto-lock regardless of inactivity
- [ ] Change the auto-lock timeout while the store is unlocked — verify the new timeout takes effect immediately without requiring a lock/unlock cycle

---

### Cross-Platform

#### Baseline

> **E2E coverage:** 0 E2E — all 3 manual (per-OS verification needed on each target platform)

- [ ] Check available shells in connection editor on each target OS — correct shells listed (zsh/bash/sh on Unix, PowerShell/cmd/Git Bash on Windows)
- [ ] Open serial port dropdown on each target OS — correct port naming convention (/dev/tty\* on Unix, COM\* on Windows)
- [ ] Enable X11 forwarding on an SSH connection on macOS or Linux with X server — X11 forwarding works (not available on Windows)
