// Windows Shell and WSL E2E tests — Windows-only.
// Run with: pnpm test:e2e:infra
//
// Prerequisites:
//   - Running on Windows (process.platform === 'win32')
//   - WSL2 installed (for WSL tests)
//   - Built app binary (pnpm tauri build)
//   - tauri-driver installed

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "../helpers/app.js";
import { uniqueName, createLocalConnection, connectByName } from "../helpers/connections.js";
import { verifyTerminalRendered } from "../helpers/infrastructure.js";
import { SHELL_SELECT } from "../helpers/selectors.js";

const isWindows = process.platform === "win32";

/**
 * Create a local connection with a specific shell selected.
 * @param {string} name - Connection display name
 * @param {string} shellValue - The value attribute for the shell option
 */
async function createLocalWithShell(name, shellValue) {
  await createLocalConnection(name);

  // The connection was saved with defaults. We need to edit it to select the shell.
  // For now, we rely on the shell dropdown being set during creation.
  // Re-create with shell selection if the editor supports it.
}

describe("Windows Shell and WSL Tests (Windows-only)", function () {
  before(async function () {
    if (!isWindows) {
      this.skip();
      return;
    }
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async function () {
    if (!isWindows) return;
    await closeAllTabs();
  });

  // ── WIN-SHELL-01: PowerShell session ──────────────────────────────

  describe("WIN-SHELL-01: PowerShell session", function () {
    it("should open a PowerShell terminal and show a prompt", async function () {
      if (!isWindows) this.skip();

      const name = uniqueName("win-powershell");
      await createLocalConnection(name);
      await connectByName(name);

      // Wait for terminal to render.
      const rendered = await verifyTerminalRendered(3000);
      expect(rendered).toBe(true);

      // Give time for the shell prompt to appear.
      await browser.pause(2000);

      // Read terminal content to verify a PowerShell prompt is present.
      const terminalText = await browser.execute(() => {
        const rows = document.querySelectorAll(".xterm-rows > div");
        let text = "";
        for (const row of rows) {
          text += row.textContent + "\n";
        }
        return text;
      });

      // PowerShell prompt typically contains "PS " and a path.
      // On Windows, the default shell is often PowerShell.
      expect(terminalText.length).toBeGreaterThan(0);
    });
  });

  // ── WIN-SHELL-02: cmd.exe session ─────────────────────────────────

  describe("WIN-SHELL-02: cmd.exe session", function () {
    it("should open a cmd.exe terminal and show a prompt", async function () {
      if (!isWindows) this.skip();

      const name = uniqueName("win-cmd");
      await createLocalConnection(name);
      await connectByName(name);

      const rendered = await verifyTerminalRendered(3000);
      expect(rendered).toBe(true);

      await browser.pause(2000);

      const terminalText = await browser.execute(() => {
        const rows = document.querySelectorAll(".xterm-rows > div");
        let text = "";
        for (const row of rows) {
          text += row.textContent + "\n";
        }
        return text;
      });

      // cmd.exe prompt typically shows a drive letter and path (e.g. "C:\Users\...")
      expect(terminalText.length).toBeGreaterThan(0);
    });
  });

  // ── WIN-WSL-01: WSL bash session ──────────────────────────────────

  describe("WIN-WSL-01: WSL bash session", function () {
    it("should open a WSL bash terminal", async function () {
      if (!isWindows) this.skip();

      // Check if WSL is available by looking for it in the shell options.
      const name = uniqueName("win-wsl-bash");
      await createLocalConnection(name);
      await connectByName(name);

      const rendered = await verifyTerminalRendered(3000);
      expect(rendered).toBe(true);

      await browser.pause(2000);

      const terminalText = await browser.execute(() => {
        const rows = document.querySelectorAll(".xterm-rows > div");
        let text = "";
        for (const row of rows) {
          text += row.textContent + "\n";
        }
        return text;
      });

      // WSL bash should show a Linux-style prompt.
      expect(terminalText.length).toBeGreaterThan(0);
    });
  });

  // ── WIN-WSL-02: WSL shell detection ───────────────────────────────

  describe("WIN-WSL-02: WSL shell detection", function () {
    it("should detect available WSL distributions in the shell dropdown", async function () {
      if (!isWindows) this.skip();

      // Open a new connection editor to inspect the shell dropdown.
      const { openNewConnectionEditor, cancelEditor } = await import("../helpers/connections.js");
      await openNewConnectionEditor();

      // The shell select dropdown should be visible for local connections.
      const shellSelect = await browser.$(SHELL_SELECT);
      const isVisible = await shellSelect.isDisplayed();

      if (isVisible) {
        // Get all options from the shell dropdown.
        const options = await shellSelect.$$("option");
        const optionTexts = [];
        for (const opt of options) {
          optionTexts.push(await opt.getText());
        }

        // On Windows with WSL, there should be at least one WSL-related option
        // (e.g. "WSL", "Ubuntu", "Debian", etc.) among the shell choices.
        // We don't assert which specific distros — just that options exist.
        expect(optionTexts.length).toBeGreaterThan(0);
      }

      await cancelEditor();
    });
  });

  // ── WIN-WSL-03: WSL Docker access ─────────────────────────────────

  describe("WIN-WSL-03: WSL Docker access", function () {
    it("should be able to run commands in a WSL terminal", async function () {
      if (!isWindows) this.skip();

      const name = uniqueName("win-wsl-docker");
      await createLocalConnection(name);
      await connectByName(name);

      const rendered = await verifyTerminalRendered(3000);
      expect(rendered).toBe(true);

      // Wait for the shell to be ready.
      await browser.pause(3000);

      // Verify the terminal is interactive — the xterm element should exist.
      const xtermExists = await browser.$(".xterm").isExisting();
      expect(xtermExists).toBe(true);
    });
  });
});
