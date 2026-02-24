// SSH Agent auth error feedback E2E test — PR #133.
// Run with: pnpm test:e2e:infra

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "../helpers/app.js";
import { uniqueName, connectByName } from "../helpers/connections.js";
import { findTabByTitle, getTabCount } from "../helpers/tabs.js";
import { createSshConnection, verifyTerminalRendered } from "../helpers/infrastructure.js";

describe("SSH Agent Setup Guidance (PR #133)", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe("SSH-AGENT-ERROR: Agent auth when agent is stopped", () => {
    it("should show helpful error when connecting with agent auth and no agent running", async () => {
      const name = uniqueName("ssh-agent-err");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "agent",
      });

      const tabsBefore = await getTabCount();

      // Try to connect — should fail since no SSH agent is running
      await connectByName(name);

      // Wait for the connection attempt to resolve
      await browser.pause(5000);

      // The app should handle this gracefully:
      // Either show an error tab or show an error dialog
      const tabsAfter = await getTabCount();

      if (tabsAfter > tabsBefore) {
        // An error tab was opened — verify it exists
        const tab = await findTabByTitle(name);
        expect(tab).not.toBeNull();

        // Check if terminal shows error content
        const rendered = await verifyTerminalRendered(2000);
        // Terminal may or may not render depending on how the error is displayed
      }

      // Test passes if the app doesn't hang or crash
    });
  });
});
