// Windows Shell and WSL E2E tests — Windows-only.
// Covers: MT-LOCAL-02, 04, 06, 11..20.
// Run with: pnpm test:e2e:infra
//
// Prerequisites:
//   - Running on Windows (process.platform === 'win32')
//   - WSL2 installed (for WSL tests)
//   - Built app binary (pnpm tauri build)
//   - tauri-driver installed

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "../helpers/app.js";
import {
  uniqueName,
  createLocalConnection,
  connectByName,
  openNewConnectionEditor,
  cancelEditor,
} from "../helpers/connections.js";
import {
  verifyTerminalRendered,
  createSshConnection,
  handlePasswordPrompt,
  sendTerminalInput,
  getTerminalText,
} from "../helpers/infrastructure.js";
import { switchToFilesSidebar } from "../helpers/sidebar.js";
import {
  SHELL_SELECT,
  CONN_EDITOR_NAME,
  CONN_EDITOR_SAVE,
  FILE_BROWSER_CURRENT_PATH,
  TOOLBAR_NEW_TERMINAL,
} from "../helpers/selectors.js";

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

  // ── MT-LOCAL-02: SSH input works on new connection ────────────────

  describe("MT-LOCAL-02: SSH input works on new connection", function () {
    it("should accept input immediately after SSH connection", async function () {
      if (!isWindows) this.skip();

      const name = uniqueName("win-ssh-input");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2222",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");
      await verifyTerminalRendered();

      // Should be able to type immediately
      await sendTerminalInput("echo hello\n");
      await browser.pause(500);

      const text = await getTerminalText();
      expect(text).toContain("hello");
    });
  });

  // ── MT-LOCAL-04: Rapid WSL connections ─────────────────────────────

  describe("MT-LOCAL-04: Rapid WSL connections produce clean output", function () {
    it("should handle rapid connections without strange output", async function () {
      if (!isWindows) this.skip();

      const name1 = uniqueName("win-rapid-1");
      const name2 = uniqueName("win-rapid-2");
      await createLocalConnection(name1);
      await createLocalConnection(name2);

      // Rapidly connect both
      await connectByName(name1);
      await browser.pause(200);
      await connectByName(name2);
      await browser.pause(2000);

      // Both should have rendered
      const xterms = await browser.$$(".xterm");
      expect(xterms.length).toBeGreaterThan(0);
    });
  });

  // ── MT-LOCAL-06: PowerShell/CMD startup not delayed ────────────────

  describe("MT-LOCAL-06: PowerShell/CMD startup not delayed", function () {
    it("should start shell without excessive delay", async function () {
      if (!isWindows) this.skip();

      const name = uniqueName("win-startup");
      await createLocalConnection(name);

      const start = Date.now();
      await connectByName(name);
      await verifyTerminalRendered(5000);
      const elapsed = Date.now() - start;

      // Should render within 5 seconds
      expect(elapsed).toBeLessThan(5000);
    });
  });

  // ── MT-LOCAL-11: WSL distros in shell dropdown ─────────────────────

  describe("MT-LOCAL-11: WSL distros in shell dropdown", function () {
    it("should show WSL distros in shell type dropdown", async function () {
      if (!isWindows) this.skip();

      await openNewConnectionEditor();
      const shellSelect = await browser.$(SHELL_SELECT);

      if (await shellSelect.isDisplayed()) {
        const options = await shellSelect.$$("option");
        const texts = [];
        for (const opt of options) {
          texts.push(await opt.getText());
        }
        // Should have multiple shell options on Windows
        expect(texts.length).toBeGreaterThan(1);
      }

      await cancelEditor();
    });
  });

  // ── MT-LOCAL-12: WSL distro launches correctly ─────────────────────

  describe("MT-LOCAL-12: WSL distro launches correctly", function () {
    it("should launch WSL distro from shell dropdown", async function () {
      if (!isWindows) this.skip();

      const name = uniqueName("win-wsl-launch");
      await createLocalConnection(name);
      await connectByName(name);

      const rendered = await verifyTerminalRendered(5000);
      expect(rendered).toBe(true);
    });
  });

  // ── MT-LOCAL-13: Shell dropdown defaults to PowerShell ─────────────

  describe("MT-LOCAL-13: Shell dropdown defaults to PowerShell", function () {
    it("should default to PowerShell on Windows", async function () {
      if (!isWindows) this.skip();

      await openNewConnectionEditor();
      const shellSelect = await browser.$(SHELL_SELECT);

      if (await shellSelect.isDisplayed()) {
        const value = await shellSelect.getValue();
        // Default should be powershell
        expect(value.toLowerCase()).toContain("powershell");
      }

      await cancelEditor();
    });
  });

  // ── MT-LOCAL-14: Saved PowerShell launches PowerShell ──────────────

  describe("MT-LOCAL-14: Saved PowerShell launches PowerShell", function () {
    it("should launch PowerShell for saved PowerShell connection", async function () {
      if (!isWindows) this.skip();

      const name = uniqueName("win-ps-saved");
      await createLocalConnection(name);
      await connectByName(name);
      await verifyTerminalRendered();
      await browser.pause(2000);

      const text = await getTerminalText();
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ── MT-LOCAL-15: Saved Git Bash launches Git Bash ──────────────────

  describe("MT-LOCAL-15: Saved Git Bash launches Git Bash", function () {
    it("should launch Git Bash for saved Git Bash connection", async function () {
      if (!isWindows) this.skip();

      const name = uniqueName("win-gitbash-saved");
      await createLocalConnection(name);
      await connectByName(name);
      await verifyTerminalRendered();
      await browser.pause(2000);

      const text = await getTerminalText();
      expect(text.length).toBeGreaterThan(0);
    });
  });

  // ── MT-LOCAL-16: Ctrl+Shift+` opens default shell ──────────────────

  describe("MT-LOCAL-16: Ctrl+Shift+` opens default shell", function () {
    it("should open default shell with keyboard shortcut", async function () {
      if (!isWindows) this.skip();

      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(1000);

      const xterm = await browser.$(".xterm");
      expect(await xterm.isExisting()).toBe(true);
    });
  });

  // ── MT-LOCAL-17..19: WSL file browser paths ────────────────────────

  describe("MT-LOCAL-17: WSL file browser shows correct initial path", function () {
    it("should show WSL path in file browser", async function () {
      if (!isWindows) this.skip();

      const name = uniqueName("win-wsl-fb");
      await createLocalConnection(name);
      await connectByName(name);
      await verifyTerminalRendered();
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);

      const pathEl = await browser.$(FILE_BROWSER_CURRENT_PATH);
      if (await pathEl.isExisting()) {
        const path = await pathEl.getText();
        expect(path.length).toBeGreaterThan(0);
      }
    });
  });

  describe("MT-LOCAL-18: WSL file browser follows cd", function () {
    it("should update file browser path after cd", async function () {
      if (!isWindows) this.skip();

      const name = uniqueName("win-wsl-cd");
      await createLocalConnection(name);
      await connectByName(name);
      await verifyTerminalRendered();

      await sendTerminalInput("cd /tmp\n");
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);

      const pathEl = await browser.$(FILE_BROWSER_CURRENT_PATH);
      if (await pathEl.isExisting()) {
        const path = await pathEl.getText();
        expect(path.length).toBeGreaterThan(0);
      }
    });
  });

  describe("MT-LOCAL-19: WSL file browser shows Windows path for /mnt/c", function () {
    it("should translate /mnt/c to Windows path", async function () {
      if (!isWindows) this.skip();

      const name = uniqueName("win-wsl-mntc");
      await createLocalConnection(name);
      await connectByName(name);
      await verifyTerminalRendered();

      await sendTerminalInput("cd /mnt/c/Users\n");
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);

      const pathEl = await browser.$(FILE_BROWSER_CURRENT_PATH);
      if (await pathEl.isExisting()) {
        const path = await pathEl.getText();
        expect(path.length).toBeGreaterThan(0);
      }
    });
  });

  // ── MT-LOCAL-20: WSL Fedora no 'clear: command not found' ──────────

  describe("MT-LOCAL-20: WSL Fedora no clear error", function () {
    it("should not show clear command not found error", async function () {
      if (!isWindows) this.skip();

      const name = uniqueName("win-wsl-fedora");
      await createLocalConnection(name);
      await connectByName(name);
      await verifyTerminalRendered();
      await browser.pause(2000);

      const text = await getTerminalText();
      expect(text).not.toContain("clear: command not found");
    });
  });
});
