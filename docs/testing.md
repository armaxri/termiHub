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
> **On macOS**, E2E tests run inside a Docker container with a Linux environment (Xvfb + WebKitGTK + tauri-driver). This tests the Linux build of the app, which shares the same React UI and Rust backend logic. macOS-specific rendering behavior (WKWebView quirks) must be verified via [manual testing](manual-testing.md).
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
describe('Terminal Creation Flow', () => {
  it('should create a new local bash terminal', async () => {
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
    await nameInput.setValue('Test Bash Terminal');

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

  it('should create SSH connection with X11 forwarding', async () => {
    // Similar flow for SSH
    await browser.$('[data-testid="connection-type-ssh"]').click();

    // Fill SSH details
    await browser.$('[data-testid="ssh-host"]').setValue('192.168.1.100');
    await browser.$('[data-testid="ssh-port"]').setValue('22');
    await browser.$('[data-testid="ssh-username"]').setValue('testuser');

    // Enable X11
    await browser.$('[data-testid="ssh-enable-x11"]').click();

    // Verify X11 status indicator
    const x11Status = await browser.$('[data-testid="x11-status"]');
    await expect(x11Status).toHaveText('X Server Running');
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
import { test, expect } from '@playwright/test';

test('terminal UI should match baseline', async ({ page }) => {
  await page.goto('http://localhost:1420');

  // Wait for app to load
  await page.waitForSelector('[data-testid="terminal-view"]');

  // Take screenshot and compare
  await expect(page).toHaveScreenshot('terminal-view.png', {
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
it('should create local bash terminal when user clicks new connection')

// Bad
it('test1')
```

### 3. AAA Pattern (Arrange, Act, Assert)

```javascript
it('should send terminal input to backend', async () => {
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
vi.mock('@tauri-apps/api/tauri', () => ({
  invoke: vi.fn(),
}));

// Mock file system
vi.mock('@tauri-apps/api/fs', () => ({
  readTextFile: vi.fn().mockResolvedValue('mock content'),
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

For detailed profiling instructions, baseline metrics, and memory leak detection, see the [Performance Profiling Guide](performance.md).

## Accessibility Testing

```javascript
import { axe, toHaveNoViolations } from 'jest-axe';
expect.extend(toHaveNoViolations);

it('should have no accessibility violations', async () => {
  const { container } = render(<Terminal />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

## Next Steps

1. **Phase 1** (Now): Add `data-testid` attributes to all components
2. **Phase 2**: Write E2E tests for critical paths
3. **Phase 3**: Add component tests for complex components
4. **Phase 4**: Integrate into CI/CD
5. **Phase 5**: Add visual regression tests

## Related Documentation

- [Manual Testing](manual-testing.md) — Manual test procedures, baseline tests, and PR regression checklist
- [Performance Profiling Guide](performance.md) — How to profile with DevTools, baseline metrics, memory leak detection
- [Contributing](contributing.md) — Development workflow and coding standards
- [Building](building.md) — Build and development setup instructions

## Resources

- [WebdriverIO Docs](https://webdriver.io/docs/gettingstarted)
- [Tauri Testing Guide](https://tauri.app/v1/guides/testing/)
- [React Testing Library](https://testing-library.com/react)
- [Vitest](https://vitest.dev/)

---

**Author**: Arne Maximilian Richter (armaxri@gmail.com)
**Last Updated**: 2026-02-13
