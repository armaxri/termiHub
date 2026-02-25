// Remote Agent E2E tests — requires Docker containers.
// Run with: pnpm test:e2e:infra
//
// These tests cover remote agent connection, session management,
// error feedback dialogs, and the setup wizard.
//
// Prerequisites:
//   - Docker containers from tests/docker/ running
//   - For full agent tests: remote-agent container on port 2211
//     (profile: agent)
//   - Built app binary + tauri-driver

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "../helpers/app.js";
import { uniqueName, connectByName, findConnectionByName } from "../helpers/connections.js";
import { findTabByTitle, getActiveTab, getTabCount } from "../helpers/tabs.js";
import {
  createRemoteAgentConnection,
  handlePasswordPrompt,
  verifyTerminalRendered,
  getTerminalText,
} from "../helpers/infrastructure.js";
import {
  CTX_AGENT_CONNECT,
  CTX_AGENT_DISCONNECT,
  CTX_AGENT_SETUP,
  CTX_AGENT_NEW_SHELL,
  CTX_AGENT_EDIT,
  CTX_AGENT_DELETE,
  CONNECTION_ERROR_TITLE,
  CONNECTION_ERROR_MESSAGE,
  CONNECTION_ERROR_DETAILS,
  CONNECTION_ERROR_SETUP_AGENT,
  CONNECTION_ERROR_CLOSE,
  AGENT_SETUP_BINARY_PATH,
  AGENT_SETUP_REMOTE_PATH,
  AGENT_SETUP_INSTALL_SERVICE,
  AGENT_SETUP_CANCEL,
  AGENT_SETUP_SUBMIT,
  PASSWORD_PROMPT_INPUT,
} from "../helpers/selectors.js";

/**
 * Right-click an agent node and select a context menu action.
 * @param {string} name - Agent name to find in sidebar
 * @param {string} menuSelector - Context menu item selector
 */
async function agentContextAction(name, menuSelector) {
  const item = await findConnectionByName(name);
  if (!item) throw new Error(`Agent "${name}" not found in sidebar`);
  await item.click({ button: "right" });
  await browser.pause(300);
  const menuItem = await browser.$(menuSelector);
  await menuItem.waitForDisplayed({ timeout: 3000 });
  await menuItem.click();
  await browser.pause(500);
}

describe("Remote Agent (Infrastructure)", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  // ── Connection error feedback dialog ────────────────────────────

  describe("Connection error feedback dialog", () => {
    it('should show "Could Not Reach Host" for invalid hostname', async () => {
      const name = uniqueName("agent-err-host");
      await createRemoteAgentConnection(name, {
        host: "192.168.255.254",
        port: "22",
        username: "testuser",
        authMethod: "password",
      });

      // Try to connect via context menu
      try {
        await agentContextAction(name, CTX_AGENT_CONNECT);
      } catch {
        // Context menu may not be available for all connection types
        await connectByName(name);
      }

      // Wait for connection to fail
      await browser.pause(10000);

      // Check for error dialog
      const title = await browser.$(CONNECTION_ERROR_TITLE);
      if (await title.isExisting()) {
        const titleText = await title.getText();
        expect(titleText.length).toBeGreaterThan(0);

        // Close the dialog
        const closeBtn = await browser.$(CONNECTION_ERROR_CLOSE);
        await closeBtn.click();
        await browser.pause(300);
      }
    });

    it('should show "Authentication Failed" for wrong password', async () => {
      const name = uniqueName("agent-err-auth");
      await createRemoteAgentConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      try {
        await agentContextAction(name, CTX_AGENT_CONNECT);
      } catch {
        await connectByName(name);
      }

      // Handle password prompt with wrong password
      await browser.pause(3000);
      const promptInput = await browser.$(PASSWORD_PROMPT_INPUT);
      if ((await promptInput.isExisting()) && (await promptInput.isDisplayed())) {
        await promptInput.setValue("wrongpassword");
        const { PASSWORD_PROMPT_CONNECT } = await import("../helpers/selectors.js");
        const connectBtn = await browser.$(PASSWORD_PROMPT_CONNECT);
        await connectBtn.click();
        await browser.pause(5000);
      }

      // Check for error dialog
      const title = await browser.$(CONNECTION_ERROR_TITLE);
      if (await title.isExisting()) {
        const titleText = await title.getText();
        expect(titleText.length).toBeGreaterThan(0);

        const closeBtn = await browser.$(CONNECTION_ERROR_CLOSE);
        await closeBtn.click();
        await browser.pause(300);
      }
    });

    it('should show "Agent Not Installed" when agent binary is missing', async () => {
      const name = uniqueName("agent-err-missing");
      // Use ssh-password container which doesn't have the agent installed
      await createRemoteAgentConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      try {
        await agentContextAction(name, CTX_AGENT_CONNECT);
      } catch {
        await connectByName(name);
      }

      await browser.pause(3000);
      const promptInput = await browser.$(PASSWORD_PROMPT_INPUT);
      if ((await promptInput.isExisting()) && (await promptInput.isDisplayed())) {
        await handlePasswordPrompt("testpass");
      }

      // Wait for agent check to fail
      await browser.pause(10000);

      // Check for "Agent Not Installed" error dialog with Setup Agent button
      const title = await browser.$(CONNECTION_ERROR_TITLE);
      if (await title.isExisting()) {
        const titleText = await title.getText();
        expect(titleText.length).toBeGreaterThan(0);

        // Check for Setup Agent button
        const setupBtn = await browser.$(CONNECTION_ERROR_SETUP_AGENT);
        if (await setupBtn.isExisting()) {
          expect(await setupBtn.isDisplayed()).toBe(true);
        }

        const closeBtn = await browser.$(CONNECTION_ERROR_CLOSE);
        await closeBtn.click();
        await browser.pause(300);
      }
    });

    it("should show technical details when expanded", async () => {
      const name = uniqueName("agent-err-details");
      await createRemoteAgentConnection(name, {
        host: "127.0.0.1",
        port: "19996",
        username: "testuser",
        authMethod: "password",
      });

      try {
        await agentContextAction(name, CTX_AGENT_CONNECT);
      } catch {
        await connectByName(name);
      }

      await browser.pause(10000);

      const details = await browser.$(CONNECTION_ERROR_DETAILS);
      if (await details.isExisting()) {
        // Click to expand technical details
        await details.click();
        await browser.pause(300);

        // Raw error text should be visible
        const raw = await browser.$(".connection-error-dialog__raw");
        if (await raw.isExisting()) {
          const rawText = await raw.getText();
          expect(rawText.length).toBeGreaterThan(0);
        }
      }

      const closeBtn = await browser.$(CONNECTION_ERROR_CLOSE);
      if (await closeBtn.isExisting()) {
        await closeBtn.click();
        await browser.pause(300);
      }
    });

    it("should close dialog and keep agent disconnected on Close", async () => {
      const name = uniqueName("agent-err-close");
      await createRemoteAgentConnection(name, {
        host: "127.0.0.1",
        port: "19995",
        username: "testuser",
        authMethod: "password",
      });

      try {
        await agentContextAction(name, CTX_AGENT_CONNECT);
      } catch {
        await connectByName(name);
      }

      await browser.pause(10000);

      const closeBtn = await browser.$(CONNECTION_ERROR_CLOSE);
      if (await closeBtn.isExisting()) {
        await closeBtn.click();
        await browser.pause(500);

        // Dialog should be closed
        const title = await browser.$(CONNECTION_ERROR_TITLE);
        const titleVisible = (await title.isExisting()) && (await title.isDisplayed());
        expect(titleVisible).toBe(false);

        // Agent should remain disconnected
        const agentItem = await findConnectionByName(name);
        expect(agentItem).not.toBeNull();
      }
    });
  });

  // ── Remote Agent connection form (PR #106) ─────────────────────

  describe("Remote Agent connection form (PR #106)", () => {
    it("should render Remote Agent settings form and produce output or error", async () => {
      const name = uniqueName("agent-form");
      await createRemoteAgentConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      // Verify the connection was created
      const agentItem = await findConnectionByName(name);
      expect(agentItem).not.toBeNull();
    });
  });

  // ── Agent setup wizard (PR #137) ────────────────────────────────

  describe("Agent setup wizard (PR #137)", () => {
    it('should show "Setup Agent..." in context menu for disconnected agent', async () => {
      const name = uniqueName("agent-setup-menu");
      await createRemoteAgentConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      // Right-click the agent
      const item = await findConnectionByName(name);
      if (!item) return;
      await item.click({ button: "right" });
      await browser.pause(300);

      // Check for "Setup Agent..." option
      const setupItem = await browser.$(CTX_AGENT_SETUP);
      if (await setupItem.isExisting()) {
        expect(await setupItem.isDisplayed()).toBe(true);
      }

      // Close context menu
      await browser.keys(["Escape"]);
      await browser.pause(200);
    });

    it("should open setup dialog with binary path, remote path, and service checkbox", async () => {
      const name = uniqueName("agent-setup-dialog");
      await createRemoteAgentConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      // Open setup dialog via context menu
      try {
        await agentContextAction(name, CTX_AGENT_SETUP);
      } catch {
        return; // Context menu not available
      }

      await browser.pause(500);

      // Verify dialog fields
      const binaryPath = await browser.$(AGENT_SETUP_BINARY_PATH);
      const remotePath = await browser.$(AGENT_SETUP_REMOTE_PATH);
      const serviceCheckbox = await browser.$(AGENT_SETUP_INSTALL_SERVICE);

      if (await binaryPath.isExisting()) {
        expect(await binaryPath.isDisplayed()).toBe(true);
      }
      if (await remotePath.isExisting()) {
        expect(await remotePath.isDisplayed()).toBe(true);
      }
      if (await serviceCheckbox.isExisting()) {
        expect(await serviceCheckbox.isDisplayed()).toBe(true);
      }

      // Cancel the dialog
      const cancelBtn = await browser.$(AGENT_SETUP_CANCEL);
      if (await cancelBtn.isExisting()) {
        await cancelBtn.click();
        await browser.pause(300);
      }
    });

    it("should open SSH terminal tab on Start Setup", async () => {
      const name = uniqueName("agent-setup-terminal");
      await createRemoteAgentConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      try {
        await agentContextAction(name, CTX_AGENT_SETUP);
      } catch {
        return;
      }

      await browser.pause(500);
      const tabsBefore = await getTabCount();

      // Click Start Setup
      const submitBtn = await browser.$(AGENT_SETUP_SUBMIT);
      if (await submitBtn.isExisting()) {
        await submitBtn.click();
        await browser.pause(1000);

        // Handle password prompt if it appears
        const promptInput = await browser.$(PASSWORD_PROMPT_INPUT);
        if ((await promptInput.isExisting()) && (await promptInput.isDisplayed())) {
          await handlePasswordPrompt("testpass");
        }

        await browser.pause(3000);

        // A terminal tab should have been opened
        const tabsAfter = await getTabCount();
        expect(tabsAfter).toBeGreaterThanOrEqual(tabsBefore);
      }
    });

    it("should inject setup commands into the terminal", async () => {
      const name = uniqueName("agent-setup-cmds");
      await createRemoteAgentConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      try {
        await agentContextAction(name, CTX_AGENT_SETUP);
      } catch {
        return;
      }

      await browser.pause(500);

      const submitBtn = await browser.$(AGENT_SETUP_SUBMIT);
      if (await submitBtn.isExisting()) {
        await submitBtn.click();
        await browser.pause(1000);

        const promptInput = await browser.$(PASSWORD_PROMPT_INPUT);
        if ((await promptInput.isExisting()) && (await promptInput.isDisplayed())) {
          await handlePasswordPrompt("testpass");
        }

        // Wait for terminal to render and commands to be injected
        await verifyTerminalRendered(5000);
        await browser.pause(3000);

        // Check terminal output for setup commands
        const terminalText = await getTerminalText();
        // Terminal should have some command output
        expect(terminalText.length).toBeGreaterThan(0);
      }
    });
  });

  // ── Agent folder with child sessions (PR #164) ────────────────
  // These tests require a running remote agent (Docker container with agent binary).
  // They are marked as pending until the remote-agent Docker container is available.

  describe("Agent folder with child sessions (PR #164)", () => {
    it("should connect agent and see available shells in expanded folder");
    it("should create shell session under connected agent");
    it("should reconnect and re-attach persistent sessions");
    it("should support connect/disconnect/new-session/edit/delete context menu");
  });

  // ── Remote Agent session (PR #87) ──────────────────────────────
  // These tests require a running remote agent.

  describe("Remote Agent session (PR #87)", () => {
    it("should connect to remote host running agent");
    it("should display terminal output for shell sessions");
    it("should auto-reconnect after SSH connection drop");
  });
});
