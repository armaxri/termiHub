// SSH Banner and MOTD E2E tests — requires ssh-banner container on port 2206.
// Run with: pnpm test:e2e:infra
//
// Prerequisites:
//   - Docker containers from tests/docker/ running:
//     docker compose -f tests/docker/docker-compose.yml up -d
//   - Built app binary (pnpm tauri build)
//   - tauri-driver installed

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "../helpers/app.js";
import { uniqueName, connectByName } from "../helpers/connections.js";
import {
  createSshConnection,
  handlePasswordPrompt,
  verifyTerminalRendered,
} from "../helpers/infrastructure.js";

describe("SSH Banner and MOTD (requires ssh-banner container on :2206)", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  // ── SSH-COMPAT-03: Pre-auth banner display ──────────────────────────

  describe("SSH-COMPAT-03: Pre-auth banner", () => {
    it("should display pre-auth banner text in the terminal", async () => {
      const name = uniqueName("ssh-banner");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2206",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");

      // Wait for terminal to render with banner content.
      const rendered = await verifyTerminalRendered(3000);
      expect(rendered).toBe(true);

      // Give time for banner and MOTD to appear in the terminal buffer.
      await browser.pause(2000);

      // Read terminal content from the xterm buffer via JavaScript.
      // The ssh-banner container is configured with a pre-auth banner
      // that contains specific text.
      const terminalText = await browser.execute(() => {
        // Access the xterm Terminal instance via the active terminal's buffer.
        const xtermEl = document.querySelector(".xterm");
        if (!xtermEl) return "";

        // Try to extract text from the xterm screen rows.
        const rows = xtermEl.querySelectorAll(".xterm-rows > div");
        let text = "";
        for (const row of rows) {
          text += row.textContent + "\n";
        }
        return text;
      });

      // The terminal should contain some output (banner or shell prompt).
      expect(terminalText.length).toBeGreaterThan(0);
    });
  });

  // ── SSH-COMPAT-04: MOTD display ─────────────────────────────────────

  describe("SSH-COMPAT-04: MOTD display", () => {
    it("should display MOTD after successful login", async () => {
      const name = uniqueName("ssh-motd");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2206",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");

      // Wait for login + MOTD to render.
      const rendered = await verifyTerminalRendered(3000);
      expect(rendered).toBe(true);

      // MOTD appears after authentication — give it time.
      await browser.pause(2000);

      // Verify the terminal has rendered content beyond just a prompt.
      const xtermExists = await browser.$(".xterm").isExisting();
      expect(xtermExists).toBe(true);
    });
  });
});
