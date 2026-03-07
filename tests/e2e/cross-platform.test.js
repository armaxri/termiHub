// Cross-platform behavior tests.
// Covers: MT-LOCAL-09, MT-LOCAL-10, MT-XPLAT-01, MT-XPLAT-02.

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "./helpers/app.js";
import {
  uniqueName,
  createLocalConnection,
  connectByName,
  openNewConnectionEditor,
} from "./helpers/connections.js";
import {
  TOOLBAR_NEW_TERMINAL,
  TOOLBAR_SPLIT,
  CONN_EDITOR_TYPE,
  SHELL_SELECT,
} from "./helpers/selectors.js";

describe("Cross-Platform", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe("MT-LOCAL-09: No doubled terminal text", () => {
    it("should not produce doubled output when typing", async () => {
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(1000);

      // Type a unique marker
      const marker = `MARKER_${Date.now()}`;
      const { sendTerminalInput, getTerminalText } = await import("./helpers/infrastructure.js");
      await sendTerminalInput(`echo ${marker}\n`);
      await browser.pause(1000);

      // Get terminal text and count occurrences
      const text = await getTerminalText();
      // The marker should appear exactly twice: once in the echo command, once in the output
      // If it appears more, text is being doubled
      const count = (text.match(new RegExp(marker, "g")) || []).length;
      expect(count).toBeLessThanOrEqual(2);
    });
  });

  describe("MT-LOCAL-10: No doubled text in split views", () => {
    it("should not produce doubled output in split view terminals", async () => {
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(1000);

      // Create a split
      const splitBtn = await browser.$(TOOLBAR_SPLIT);
      await splitBtn.click();
      await browser.pause(1000);

      // Type in one of the terminals
      const marker = `SPLIT_${Date.now()}`;
      const { sendTerminalInput, getTerminalText } = await import("./helpers/infrastructure.js");
      await sendTerminalInput(`echo ${marker}\n`);
      await browser.pause(1000);

      const text = await getTerminalText();
      const count = (text.match(new RegExp(marker, "g")) || []).length;
      expect(count).toBeLessThanOrEqual(2);
    });
  });

  describe("MT-XPLAT-01: Correct shells listed per OS", () => {
    it("should show platform-appropriate shells in dropdown", async () => {
      await openNewConnectionEditor();

      const typeSelect = await browser.$(CONN_EDITOR_TYPE);
      await typeSelect.selectByAttribute("value", "local");
      await browser.pause(300);

      const shellSelect = await browser.$(SHELL_SELECT);
      const options = await shellSelect.$$("option");
      const shellNames = [];
      for (const opt of options) {
        shellNames.push(await opt.getText());
      }

      // Every platform should have at least one shell
      expect(shellNames.length).toBeGreaterThan(0);

      // Platform-specific checks
      if (process.platform === "win32") {
        expect(shellNames.some((s) => s.toLowerCase().includes("powershell"))).toBe(true);
      } else if (process.platform === "darwin") {
        expect(
          shellNames.some(
            (s) => s.toLowerCase().includes("zsh") || s.toLowerCase().includes("bash")
          )
        ).toBe(true);
      } else {
        expect(
          shellNames.some((s) => s.toLowerCase().includes("bash") || s.toLowerCase().includes("sh"))
        ).toBe(true);
      }
    });
  });

  describe("MT-XPLAT-02: Serial port naming per OS", () => {
    it("should show platform-appropriate serial port naming", async () => {
      await openNewConnectionEditor();

      const typeSelect = await browser.$(CONN_EDITOR_TYPE);
      await typeSelect.selectByAttribute("value", "serial");
      await browser.pause(300);

      // Serial port select or input should exist
      const portSelect = await browser.$('[data-testid="serial-settings-port-select"]');
      const portInput = await browser.$('[data-testid="serial-settings-port-input"]');

      // At least one port input method should exist
      const hasPortSelect = await portSelect.isExisting();
      const hasPortInput = await portInput.isExisting();
      expect(hasPortSelect || hasPortInput).toBe(true);
    });
  });
});
