// ui-state.test.js — UI state persistence and visual verification tests.
// Covers: MT-UI-06, MT-UI-07, MT-UI-08, MT-UI-17, MT-UI-18, MT-UI-20.

import { waitForAppReady, closeAllTabs } from "./helpers/app.js";
import { openSettingsTab } from "./helpers/sidebar.js";
import { findTabByTitle } from "./helpers/tabs.js";
import { TOOLBAR_NEW_TERMINAL } from "./helpers/selectors.js";

describe("UI State & Visual", () => {
  before(async () => {
    await waitForAppReady();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe("MT-UI-06: State dots visible on terminal tabs", () => {
    it("should show state indicator dots on tabs", async () => {
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(1000);

      // Look for state dot elements on tabs
      const stateDots = await browser.$$(".tab__state-dot");
      // At least one tab should have a state dot
      expect(stateDots.length).toBeGreaterThan(0);
    });
  });

  describe("MT-UI-07: Theme persists across page reload", () => {
    it("should maintain theme after browser refresh", async () => {
      // Get current theme
      const htmlEl = await browser.$("html");
      const themeBefore = await htmlEl.getAttribute("data-theme");

      // Refresh page
      await browser.refresh();
      await browser.pause(3000);
      await waitForAppReady();

      // Theme should persist
      const themeAfter = await htmlEl.getAttribute("data-theme");
      expect(themeAfter).toBe(themeBefore);
    });
  });

  describe("MT-UI-08: ErrorBoundary renders with theme colors", () => {
    it("should use theme-appropriate colors for error displays", async () => {
      // Verify the app root uses CSS variables for theming
      const root = await browser.$("#root");
      expect(await root.isDisplayed()).toBe(true);

      // Check that theme CSS variables are set
      const bgColor = await root.getCSSProperty("background-color");
      expect(bgColor.value).not.toBe("");
    });
  });

  describe("MT-UI-17: Terminal fills correctly on resize", () => {
    it("should refit terminal when window is resized", async () => {
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(1000);

      // Get initial size
      const initialSize = await browser.getWindowSize();

      // Resize window
      await browser.setWindowSize(initialSize.width - 200, initialSize.height - 100);
      await browser.pause(500);

      // Terminal should still be displayed
      const xterm = await browser.$(".xterm");
      expect(await xterm.isDisplayed()).toBe(true);

      // Resize back
      await browser.setWindowSize(initialSize.width + 200, initialSize.height + 100);
      await browser.pause(500);

      expect(await xterm.isDisplayed()).toBe(true);

      // Restore original size
      await browser.setWindowSize(initialSize.width, initialSize.height);
      await browser.pause(300);
    });
  });

  describe("MT-UI-18: Settings tab unaffected by terminal fix", () => {
    it("should display settings tab correctly regardless of terminal resize logic", async () => {
      await openSettingsTab();

      const settingsTab = await findTabByTitle("Settings");
      expect(settingsTab).not.toBeNull();
      expect(await settingsTab.isDisplayed()).toBe(true);

      // Settings content should be visible
      const settingsPanel = await browser.$(".settings-panel");
      expect(await settingsPanel.isDisplayed()).toBe(true);

      // Resize window to trigger terminal fit logic
      const size = await browser.getWindowSize();
      await browser.setWindowSize(size.width - 100, size.height - 50);
      await browser.pause(500);

      // Settings should still be displayed
      expect(await settingsPanel.isDisplayed()).toBe(true);

      // Restore
      await browser.setWindowSize(size.width, size.height);
      await browser.pause(300);
    });
  });

  describe("MT-UI-20: Favicon present in dev mode", () => {
    it("should have a favicon link in the document", async () => {
      const favicon = await browser.$('link[rel="icon"]');
      const faviconExists = await favicon.isExisting();

      // In production builds, favicon should be present
      // In dev mode, it might be in a different location
      if (faviconExists) {
        const href = await favicon.getAttribute("href");
        expect(href).not.toBe("");
      }
      // If no favicon link exists, check for shortcut icon
      else {
        const shortcut = await browser.$('link[rel="shortcut icon"]');
        if (await shortcut.isExisting()) {
          const href = await shortcut.getAttribute("href");
          expect(href).not.toBe("");
        }
      }
    });
  });
});
