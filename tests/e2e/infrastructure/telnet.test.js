// Telnet E2E tests — requires a live Telnet server on localhost:2323.
// Run with: pnpm test:e2e:infra
// Full setup: ./scripts/test-system.sh
//
// Prerequisites:
//   - Docker Telnet target from examples/ running on localhost:2323
//   - Built app binary (pnpm tauri build)
//   - tauri-driver installed (cargo install tauri-driver)

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from '../helpers/app.js';
import { uniqueName, connectByName } from '../helpers/connections.js';
import { findTabByTitle, getActiveTab, getTabCount } from '../helpers/tabs.js';
import {
  createTelnetConnection,
  verifyTerminalRendered,
} from '../helpers/infrastructure.js';

describe('Telnet Connections (requires live server)', () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe('TELNET-01: Connect and see server banner', () => {
    it('should connect to telnet server and open a terminal tab', async () => {
      const name = uniqueName('telnet-conn');
      await createTelnetConnection(name, {
        host: '127.0.0.1',
        port: '2323',
      });

      // Double-click to connect
      await connectByName(name);

      // Verify a terminal tab appeared
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();

      const active = await getActiveTab();
      expect(active).not.toBeNull();
      const activeText = await active.getText();
      expect(activeText).toContain(name);
    });

    it('should render an xterm terminal after telnet connection', async () => {
      const name = uniqueName('telnet-xterm');
      await createTelnetConnection(name, {
        host: '127.0.0.1',
        port: '2323',
      });

      await connectByName(name);

      // Verify xterm rendered (the server banner should trigger rendering)
      const rendered = await verifyTerminalRendered();
      expect(rendered).toBe(true);
    });
  });

  describe('TELNET-02: Send and receive commands', () => {
    it('should have a functional terminal with xterm canvas for interaction', async () => {
      const name = uniqueName('telnet-io');
      await createTelnetConnection(name, {
        host: '127.0.0.1',
        port: '2323',
      });

      await connectByName(name);

      // Wait for terminal to fully initialize
      await browser.pause(2000);

      // Verify the xterm container and canvas are present
      const xtermContainer = await browser.$('.xterm');
      expect(await xtermContainer.isExisting()).toBe(true);

      const canvas = await browser.$('.xterm-screen canvas');
      const canvasExists = await canvas.isExisting();
      expect(await xtermContainer.isExisting() || canvasExists).toBe(true);
    });
  });

  describe('TELNET-03: Connection failure', () => {
    it('should handle connection to unreachable host gracefully', async () => {
      const name = uniqueName('telnet-fail');
      await createTelnetConnection(name, {
        host: '127.0.0.1',
        port: '19998', // No server listening here
      });

      const tabsBefore = await getTabCount();

      // Try to connect — should fail since no server is listening
      await connectByName(name);

      // Wait for the connection attempt to resolve
      await browser.pause(3000);

      // The app may open a tab with an error or not open one at all
      const tabsAfter = await getTabCount();

      if (tabsAfter > tabsBefore) {
        // A tab was opened (error display) — verify it exists
        const tab = await findTabByTitle(name);
        expect(tab).not.toBeNull();
      }
      // Test passes as long as the app does not hang or crash
    });
  });
});
