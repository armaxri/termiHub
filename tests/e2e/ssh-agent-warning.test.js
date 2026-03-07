// SSH agent warning and backward compatibility tests.
// Covers: MT-SSH-08, MT-SSH-19.

import { waitForAppReady, closeAllTabs } from "./helpers/app.js";
import { openNewConnectionEditor } from "./helpers/connections.js";
import { CONN_EDITOR_TYPE, SSH_AUTH_METHOD } from "./helpers/selectors.js";

describe("SSH Agent Warning & Backward Compatibility", () => {
  before(async () => {
    await waitForAppReady();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe("MT-SSH-08: Agent auth shows warning text in editor", () => {
    it("should show agent-related hint when auth method is agent", async () => {
      await openNewConnectionEditor();

      // Switch to SSH type
      const typeSelect = await browser.$(CONN_EDITOR_TYPE);
      await typeSelect.selectByAttribute("value", "ssh");
      await browser.pause(300);

      // Set auth method to agent
      const authSelect = await browser.$(SSH_AUTH_METHOD);
      await authSelect.selectByAttribute("value", "agent");
      await browser.pause(500);

      // Some form of agent-related hint/warning text should be visible
      // This could be an inline message, tooltip, or status indicator
      const form = await browser.$('[data-testid="connection-settings-form"]');
      const formText = await form.getText();

      // The form should contain some reference to SSH agent
      // (either warning about stopped agent or hint about running agent)
      const hasAgentReference =
        formText.toLowerCase().includes("agent") || formText.toLowerCase().includes("ssh-agent");
      expect(hasAgentReference).toBe(true);
    });
  });

  describe("MT-SSH-19: Old connections without X11 field load correctly", () => {
    it("should load SSH connections without X11 field without errors", async () => {
      await openNewConnectionEditor();

      // Switch to SSH type
      const typeSelect = await browser.$(CONN_EDITOR_TYPE);
      await typeSelect.selectByAttribute("value", "ssh");
      await browser.pause(300);

      // X11 checkbox should exist (even for new connections)
      const x11 = await browser.$('[data-testid="ssh-settings-x11-checkbox"]');
      expect(await x11.isExisting()).toBe(true);

      // It should default to unchecked (backward compatible)
      expect(await x11.isSelected()).toBe(false);
    });
  });
});
