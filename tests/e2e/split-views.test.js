// Split view tests.
// Covers: SPLIT-01, SPLIT-03, SPLIT-06.

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from './helpers/app.js';
import { uniqueName, createLocalConnection, connectByName } from './helpers/connections.js';
import { getTabCount } from './helpers/tabs.js';
import {
  TOOLBAR_SPLIT,
  TOOLBAR_CLOSE_PANEL,
  TOOLBAR_NEW_TERMINAL,
} from './helpers/selectors.js';

describe('Split Views', () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe('SPLIT-01: Split horizontal', () => {
    it('should create a second panel when clicking split', async () => {
      // Open a terminal first
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(500);

      // Count panels before split (look for resizable panel groups)
      const splitBtn = await browser.$(TOOLBAR_SPLIT);
      await splitBtn.waitForDisplayed({ timeout: 3000 });
      await splitBtn.click();
      await browser.pause(500);

      // After splitting, the close panel button should appear (only visible with >1 panel)
      const closePanel = await browser.$(TOOLBAR_CLOSE_PANEL);
      expect(await closePanel.isDisplayed()).toBe(true);
    });
  });

  describe('SPLIT-03: Close panel', () => {
    it('should remove a panel when close panel is clicked', async () => {
      // Create a terminal and split
      const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await newBtn.click();
      await browser.pause(500);

      const splitBtn = await browser.$(TOOLBAR_SPLIT);
      await splitBtn.click();
      await browser.pause(500);

      // Close panel button should be visible
      let closePanel = await browser.$(TOOLBAR_CLOSE_PANEL);
      expect(await closePanel.isDisplayed()).toBe(true);

      // Click close panel
      await closePanel.click();
      await browser.pause(500);

      // Close panel button should disappear (only 1 panel left)
      closePanel = await browser.$(TOOLBAR_CLOSE_PANEL);
      expect(await closePanel.isExisting()).toBe(false);
    });
  });

  describe('SPLIT-06: Nested splits', () => {
    it('should allow multiple splits creating nested layout', async () => {
      // Create a terminal
      const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await newBtn.click();
      await browser.pause(500);

      // Split once
      const splitBtn = await browser.$(TOOLBAR_SPLIT);
      await splitBtn.click();
      await browser.pause(500);

      // Add a terminal to the new panel
      await newBtn.click();
      await browser.pause(500);

      // Split again
      await splitBtn.click();
      await browser.pause(500);

      // Should have the close panel button (indicating >1 panel)
      const closePanel = await browser.$(TOOLBAR_CLOSE_PANEL);
      expect(await closePanel.isDisplayed()).toBe(true);

      // There should be at least 3 tab areas (3 panels)
      // We verify by checking that we can close panels multiple times
      await closePanel.click();
      await browser.pause(300);

      // Should still have close panel button (2 panels remain)
      const closePanelStill = await browser.$(TOOLBAR_CLOSE_PANEL);
      expect(await closePanelStill.isDisplayed()).toBe(true);
    });
  });
});
