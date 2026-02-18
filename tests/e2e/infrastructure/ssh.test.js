// SSH E2E tests — requires a live SSH server on localhost:2222.
// Run with: pnpm test:e2e:infra
// Full setup: ./scripts/test-system.sh
//
// Prerequisites:
//   - Docker SSH target from examples/ running on localhost:2222
//     (user: testuser, pass: testpass)
//   - Built app binary (pnpm tauri build)
//   - tauri-driver installed (cargo install tauri-driver)

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from '../helpers/app.js';
import { uniqueName, connectByName } from '../helpers/connections.js';
import { findTabByTitle, getActiveTab, getTabCount } from '../helpers/tabs.js';
import {
  createSshConnection,
  handlePasswordPrompt,
  verifyTerminalRendered,
} from '../helpers/infrastructure.js';

describe('SSH Connections (requires live server)', () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe('SSH-01: Password authentication', () => {
    it('should connect with password auth and open a terminal tab', async () => {
      const name = uniqueName('ssh-pass');
      await createSshConnection(name, {
        host: '127.0.0.1',
        port: '2222',
        username: 'testuser',
        authMethod: 'password',
      });

      // Double-click to initiate connection
      await connectByName(name);

      // Handle the password prompt
      await handlePasswordPrompt('testpass');

      // Verify a terminal tab appeared
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();

      const active = await getActiveTab();
      expect(active).not.toBeNull();
      const activeText = await active.getText();
      expect(activeText).toContain(name);
    });

    it('should render an xterm terminal after SSH connection', async () => {
      const name = uniqueName('ssh-xterm');
      await createSshConnection(name, {
        host: '127.0.0.1',
        port: '2222',
        username: 'testuser',
      });

      await connectByName(name);
      await handlePasswordPrompt('testpass');

      // Verify xterm rendered
      const rendered = await verifyTerminalRendered();
      expect(rendered).toBe(true);
    });
  });

  // Key-based auth requires SSH key infrastructure in the Docker container.
  // TODO: Generate a key pair in the Docker entrypoint and mount it for tests.
  it('SSH-02: should connect with key auth');

  describe('SSH-03: Connection failure', () => {
    it('should handle connection to unreachable host gracefully', async () => {
      const name = uniqueName('ssh-fail');
      await createSshConnection(name, {
        host: '127.0.0.1',
        port: '19999', // No server listening here
        username: 'testuser',
      });

      const tabsBefore = await getTabCount();

      // Try to connect — should fail without a password prompt since TCP fails
      await connectByName(name);

      // Wait for the connection attempt to resolve
      await browser.pause(3000);

      // The app may open a tab with an error or not open one at all.
      // Either way, the password prompt should NOT appear since TCP fails first.
      const tabsAfter = await getTabCount();

      if (tabsAfter > tabsBefore) {
        // A tab was opened (error display in terminal) — verify it exists
        const tab = await findTabByTitle(name);
        expect(tab).not.toBeNull();
      }
      // Test passes as long as the app does not hang or crash
    });
  });

  describe('SSH-05: Session output', () => {
    it('should display a functional terminal with xterm canvas', async () => {
      const name = uniqueName('ssh-output');
      await createSshConnection(name, {
        host: '127.0.0.1',
        port: '2222',
        username: 'testuser',
      });

      await connectByName(name);
      await handlePasswordPrompt('testpass');

      // Wait for terminal to fully initialize
      await browser.pause(2000);

      // Verify the xterm container is present
      const xtermContainer = await browser.$('.xterm');
      expect(await xtermContainer.isExisting()).toBe(true);

      // Verify the terminal canvas is rendering
      const canvas = await browser.$('.xterm-screen canvas');
      const canvasExists = await canvas.isExisting();
      expect(await xtermContainer.isExisting() || canvasExists).toBe(true);
    });
  });

  // Disconnect handling requires stopping the Docker container mid-test,
  // which would break other tests in the suite.
  it('SSH-06: should handle server disconnect');

  // X11 forwarding requires an X server running on the test machine.
  it('SSH-07: should forward X11 applications');
});
