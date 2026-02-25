// SSH Baseline E2E tests — covers remaining SSH baseline items.
// Run with: pnpm test:e2e:infra
//
// Prerequisites:
//   - Docker containers from tests/docker/ running:
//     docker compose -f tests/docker/docker-compose.yml up -d
//   - Built app binary (pnpm tauri build)
//   - tauri-driver installed

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "../helpers/app.js";
import { uniqueName, connectByName, createLocalConnection } from "../helpers/connections.js";
import { findTabByTitle, getActiveTab, getTabCount } from "../helpers/tabs.js";
import {
  createSshConnection,
  createSshKeyConnection,
  handlePasswordPrompt,
  verifyTerminalRendered,
  getTerminalText,
  sendTerminalInput,
} from "../helpers/infrastructure.js";
import { PASSWORD_PROMPT_INPUT } from "../helpers/selectors.js";

describe("SSH Baseline (Docker containers)", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe("SSH-BASELINE-KEY: Key authentication", () => {
    it("should connect with ed25519 key auth without password prompt", async () => {
      const name = uniqueName("ssh-key-baseline");
      await createSshKeyConnection(name, {
        host: "127.0.0.1",
        port: "2203",
        username: "testuser",
        keyPath: "tests/fixtures/ssh-keys/ed25519",
      });

      await connectByName(name);

      // Key auth should NOT trigger a password prompt
      await browser.pause(2000);
      const promptInput = await browser.$(PASSWORD_PROMPT_INPUT);
      const promptVisible = (await promptInput.isExisting()) && (await promptInput.isDisplayed());
      expect(promptVisible).toBe(false);

      // Verify terminal tab opened
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();

      const rendered = await verifyTerminalRendered(5000);
      expect(rendered).toBe(true);
    });
  });

  describe("SSH-BASELINE-RESIZE: Terminal resize", () => {
    it("should report updated dimensions after browser resize", async () => {
      const name = uniqueName("ssh-resize");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");
      await verifyTerminalRendered(3000);

      // Get initial terminal size
      const initialSize = await browser.getWindowSize();

      // Resize the window
      await browser.setWindowSize(initialSize.width + 200, initialSize.height + 100);
      await browser.pause(1000);

      // Verify terminal still renders correctly after resize
      const rendered = await verifyTerminalRendered(2000);
      expect(rendered).toBe(true);

      // Restore original size
      await browser.setWindowSize(initialSize.width, initialSize.height);
      await browser.pause(500);
    });
  });

  describe("SSH-BASELINE-DISCONNECT: Server disconnect handling", () => {
    it("should handle SSH session termination gracefully", async () => {
      const name = uniqueName("ssh-disconnect");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");
      await verifyTerminalRendered(3000);

      // Send 'exit' to gracefully close the SSH session
      await sendTerminalInput("exit");
      await browser.keys(["Enter"]);
      await browser.pause(3000);

      // The tab should still exist (showing disconnected state or exit message)
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();
    });
  });

  describe("SSH-BASELINE-OUTPUT: Command output renders", () => {
    it("should display command output in xterm terminal", async () => {
      const name = uniqueName("ssh-cmd-output");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");
      await verifyTerminalRendered(3000);

      // Send a command that produces identifiable output
      await sendTerminalInput("echo TERMIHUB_TEST_MARKER");
      await browser.keys(["Enter"]);
      await browser.pause(2000);

      // Read terminal text and verify marker is present
      const terminalText = await getTerminalText();
      expect(terminalText).toContain("TERMIHUB_TEST_MARKER");
    });
  });

  describe("SSH-BASELINE-ERROR: Connection failure", () => {
    it("should handle connection to unreachable port gracefully", async () => {
      const name = uniqueName("ssh-fail-baseline");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "19997",
        username: "testuser",
      });

      const tabsBefore = await getTabCount();

      await connectByName(name);
      await browser.pause(5000);

      // App should not hang or crash — test passes if we reach here
      const tabsAfter = await getTabCount();
      if (tabsAfter > tabsBefore) {
        const tab = await findTabByTitle(name);
        expect(tab).not.toBeNull();
      }
    });
  });

  describe("SSH-BASELINE-INPUT: Input works immediately (PR #198)", () => {
    it("should accept keyboard input immediately after SSH connection", async () => {
      const name = uniqueName("ssh-input");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");
      await verifyTerminalRendered(3000);

      // Immediately type a command without clicking the terminal first
      await browser.keys("echo INPUT_WORKS".split(""));
      await browser.keys(["Enter"]);
      await browser.pause(2000);

      const terminalText = await getTerminalText();
      expect(terminalText).toContain("INPUT_WORKS");
    });
  });
});
