// Settings and color picker tests.
// Covers: SET-01, SET-04 (tab coloring).

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from './helpers/app.js';
import { openSettingsTab } from './helpers/sidebar.js';
import {
  uniqueName,
  createLocalConnection,
  openNewConnectionEditor,
  connectByName,
  findConnectionByName,
  connectionContextAction,
  CTX_CONNECTION_EDIT,
} from './helpers/connections.js';
import { findTabByTitle } from './helpers/tabs.js';
import {
  CONN_EDITOR_COLOR_PICKER,
  CONN_EDITOR_SAVE,
  CONN_EDITOR_NAME,
  COLOR_PICKER_APPLY,
  COLOR_PICKER_HEX_INPUT,
  colorPickerSwatch,
} from './helpers/selectors.js';

describe('Settings & Color Picker', () => {
  before(async () => {
    await waitForAppReady();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe('SET-01: Settings tab', () => {
    it('should open a Settings tab when clicking gear > Settings', async () => {
      await openSettingsTab();

      // A "Settings" tab should now be visible
      const settingsTab = await findTabByTitle('Settings');
      expect(settingsTab).not.toBeNull();
      expect(await settingsTab.isDisplayed()).toBe(true);
    });

    it('should reuse existing Settings tab if already open', async () => {
      await openSettingsTab();
      await openSettingsTab();

      // There should still only be one Settings tab
      const allTabs = await browser.$$('[data-testid^="tab-"]');
      let settingsCount = 0;
      for (const t of allTabs) {
        const text = await t.getText();
        const testId = await t.getAttribute('data-testid');
        if (text.includes('Settings') && testId && testId.startsWith('tab-') && !testId.startsWith('tab-close-') && !testId.startsWith('tab-context-')) {
          settingsCount++;
        }
      }
      expect(settingsCount).toBe(1);
    });
  });

  describe('SET-04: Tab coloring', () => {
    it('should apply tab color when a colored connection is opened', async () => {
      await ensureConnectionsSidebar();

      const name = uniqueName('color');

      // Create a connection
      await createLocalConnection(name);

      // Edit it to set a color
      await connectionContextAction(name, CTX_CONNECTION_EDIT);
      await browser.pause(300);

      // Open color picker
      const colorPickerBtn = await browser.$(CONN_EDITOR_COLOR_PICKER);
      await colorPickerBtn.click();
      await browser.pause(300);

      // Pick a swatch color (red = #ef4444)
      const swatch = await browser.$(colorPickerSwatch('#ef4444'));
      if (await swatch.isExisting() && await swatch.isDisplayed()) {
        await swatch.click();
      } else {
        // Fall back to typing a hex value
        const hexInput = await browser.$(COLOR_PICKER_HEX_INPUT);
        await hexInput.clearValue();
        await hexInput.setValue('#ef4444');
      }

      const applyBtn = await browser.$(COLOR_PICKER_APPLY);
      await applyBtn.click();
      await browser.pause(300);

      // Save the connection
      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(300);

      // Connect to it
      await connectByName(name);

      // Check the tab has a border-left style (our color indicator)
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();
      const style = await tab.getAttribute('style');
      expect(style).toContain('border-left');
    });
  });
});
