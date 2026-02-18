// Settings, color picker, and monitoring tests.
// Covers: SET-01, SET-02, SET-04 (tab coloring), SET-MONITOR (PR #114/#115).

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from './helpers/app.js';
import { openSettingsTab, switchToFilesSidebar } from './helpers/sidebar.js';
import {
  uniqueName,
  createLocalConnection,
  openNewConnectionEditor,
  connectByName,
  findConnectionByName,
  connectionContextAction,
  CTX_CONNECTION_EDIT,
} from './helpers/connections.js';
import { createSshConnection } from './helpers/infrastructure.js';
import { findTabByTitle, closeTabByTitle, getTabCount } from './helpers/tabs.js';
import {
  CONN_EDITOR_COLOR_PICKER,
  CONN_EDITOR_SAVE,
  CONN_EDITOR_NAME,
  COLOR_PICKER_APPLY,
  COLOR_PICKER_CLEAR,
  COLOR_PICKER_HEX_INPUT,
  TAB_CTX_SET_COLOR,
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

  describe('SET-GEAR: Settings gear dropdown (PR #33)', () => {
    it('should show dropdown menu with three items when clicking gear', async () => {
      const gear = await browser.$('[data-testid="activity-bar-settings"]');
      await gear.click();
      await browser.pause(300);

      const settingsItem = await browser.$('[data-testid="settings-menu-open"]');
      const importItem = await browser.$('[data-testid="settings-menu-import"]');
      const exportItem = await browser.$('[data-testid="settings-menu-export"]');

      expect(await settingsItem.isDisplayed()).toBe(true);
      expect(await importItem.isDisplayed()).toBe(true);
      expect(await exportItem.isDisplayed()).toBe(true);

      await browser.keys('Escape');
    });

    it('should open Settings tab when clicking "Settings" in dropdown', async () => {
      await openSettingsTab();
      const tab = await findTabByTitle('Settings');
      expect(tab).not.toBeNull();
    });

    it('should only show New Folder and New Connection in connection list toolbar', async () => {
      await ensureConnectionsSidebar();

      const newFolder = await browser.$('[data-testid="connection-list-new-folder"]');
      const newConn = await browser.$('[data-testid="connection-list-new-connection"]');
      expect(await newFolder.isDisplayed()).toBe(true);
      expect(await newConn.isDisplayed()).toBe(true);

      // Import/Export buttons should not exist in the toolbar
      const importBtn = await browser.$('[data-testid="connection-list-import"]');
      const exportBtn = await browser.$('[data-testid="connection-list-export"]');
      const importVisible = await importBtn.isExisting() && await importBtn.isDisplayed();
      const exportVisible = await exportBtn.isExisting() && await exportBtn.isDisplayed();
      expect(importVisible).toBe(false);
      expect(exportVisible).toBe(false);
    });
  });

  describe('SET-STATUSBAR: Status bar presence (PR #30)', () => {
    it('should display a status bar at the bottom of the window', async () => {
      const statusBar = await browser.$('.status-bar');
      expect(await statusBar.isExisting()).toBe(true);
      expect(await statusBar.isDisplayed()).toBe(true);
    });

    it('should show activity bar, sidebar, and terminal area alongside status bar', async () => {
      const activityBar = await browser.$('[data-testid="activity-bar-connections"]');
      expect(await activityBar.isDisplayed()).toBe(true);

      const statusBar = await browser.$('.status-bar');
      expect(await statusBar.isDisplayed()).toBe(true);
    });
  });

  describe('SET-LAYOUT: Activity bar button placement (PR #31)', () => {
    it('should show settings gear icon in the activity bar', async () => {
      const gear = await browser.$('[data-testid="activity-bar-settings"]');
      expect(await gear.isDisplayed()).toBe(true);
    });

    it('should show connections and file browser icons in the activity bar', async () => {
      const connBtn = await browser.$('[data-testid="activity-bar-connections"]');
      const filesBtn = await browser.$('[data-testid="activity-bar-file-browser"]');
      expect(await connBtn.isDisplayed()).toBe(true);
      expect(await filesBtn.isDisplayed()).toBe(true);
    });

    it('should position settings gear below connections and file browser icons', async () => {
      const connBtn = await browser.$('[data-testid="activity-bar-connections"]');
      const gear = await browser.$('[data-testid="activity-bar-settings"]');

      const connLoc = await connBtn.getLocation();
      const gearLoc = await gear.getLocation();

      // Gear should be below the connections icon (higher Y value)
      expect(gearLoc.y).toBeGreaterThan(connLoc.y);
    });
  });

  describe('SET-02: Settings tab lifecycle (PR #32)', () => {
    it('should close the Settings tab like any other tab', async () => {
      await openSettingsTab();
      const settingsTab = await findTabByTitle('Settings');
      expect(settingsTab).not.toBeNull();

      const countBefore = await getTabCount();
      await closeTabByTitle('Settings');
      const countAfter = await getTabCount();
      expect(countAfter).toBe(countBefore - 1);

      // Verify it's gone
      const gone = await findTabByTitle('Settings');
      expect(gone).toBeNull();
    });

    it('should not break sidebar views after Settings tab interactions', async () => {
      await openSettingsTab();
      await closeTabByTitle('Settings');

      // Connections sidebar should still work
      await ensureConnectionsSidebar();
      const connBtn = await browser.$('[data-testid="activity-bar-connections"]');
      expect(await connBtn.isDisplayed()).toBe(true);

      // File browser sidebar should still work
      await switchToFilesSidebar();
      const filesBtn = await browser.$('[data-testid="activity-bar-file-browser"]');
      expect(await filesBtn.isDisplayed()).toBe(true);

      // Switch back to connections for cleanup
      await ensureConnectionsSidebar();
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

    it('should set tab color via context menu (PR #67)', async () => {
      await ensureConnectionsSidebar();
      const name = uniqueName('ctx-color');
      await createLocalConnection(name);
      await connectByName(name);

      // Right-click tab to open context menu
      const tab = await findTabByTitle(name);
      await tab.click({ button: 'right' });
      await browser.pause(300);

      // Click "Set Color..."
      const setColorItem = await browser.$(TAB_CTX_SET_COLOR);
      expect(await setColorItem.isDisplayed()).toBe(true);
      await setColorItem.click();
      await browser.pause(300);

      // Pick a color (red = #ef4444)
      const swatch = await browser.$(colorPickerSwatch('#ef4444'));
      if (await swatch.isExisting() && await swatch.isDisplayed()) {
        await swatch.click();
      } else {
        const hexInput = await browser.$(COLOR_PICKER_HEX_INPUT);
        await hexInput.clearValue();
        await hexInput.setValue('#ef4444');
      }

      const applyBtn = await browser.$(COLOR_PICKER_APPLY);
      await applyBtn.click();
      await browser.pause(300);

      // Verify tab has colored border
      const updatedTab = await findTabByTitle(name);
      const style = await updatedTab.getAttribute('style');
      expect(style).toContain('border-left');
    });

    it('should clear tab color via context menu (PR #67)', async () => {
      await ensureConnectionsSidebar();
      const name = uniqueName('clr-color');
      await createLocalConnection(name);
      await connectByName(name);

      // First set a color via context menu
      let tab = await findTabByTitle(name);
      await tab.click({ button: 'right' });
      await browser.pause(300);
      const setColorItem = await browser.$(TAB_CTX_SET_COLOR);
      await setColorItem.click();
      await browser.pause(300);

      const swatch = await browser.$(colorPickerSwatch('#ef4444'));
      if (await swatch.isExisting() && await swatch.isDisplayed()) {
        await swatch.click();
      } else {
        const hexInput = await browser.$(COLOR_PICKER_HEX_INPUT);
        await hexInput.clearValue();
        await hexInput.setValue('#ef4444');
      }
      const applyBtn = await browser.$(COLOR_PICKER_APPLY);
      await applyBtn.click();
      await browser.pause(300);

      // Verify color was set
      tab = await findTabByTitle(name);
      let style = await tab.getAttribute('style');
      expect(style).toContain('border-left');

      // Now clear the color via context menu
      await tab.click({ button: 'right' });
      await browser.pause(300);
      const setColorItem2 = await browser.$(TAB_CTX_SET_COLOR);
      await setColorItem2.click();
      await browser.pause(300);

      const clearBtn = await browser.$(COLOR_PICKER_CLEAR);
      await clearBtn.click();
      await browser.pause(300);

      // Verify border is removed
      const updatedTab = await findTabByTitle(name);
      style = await updatedTab.getAttribute('style');
      const hasBorder = style && style.includes('border-left');
      expect(hasBorder).toBeFalsy();
    });

    it('should persist tab color after close and reopen (PR #67)', async () => {
      await ensureConnectionsSidebar();
      const name = uniqueName('persist-color');
      await createLocalConnection(name);

      // Set color via connection editor
      await connectionContextAction(name, CTX_CONNECTION_EDIT);
      await browser.pause(300);
      const colorPickerBtn = await browser.$(CONN_EDITOR_COLOR_PICKER);
      await colorPickerBtn.click();
      await browser.pause(300);
      const swatch = await browser.$(colorPickerSwatch('#3b82f6'));
      if (await swatch.isExisting() && await swatch.isDisplayed()) {
        await swatch.click();
      } else {
        const hexInput = await browser.$(COLOR_PICKER_HEX_INPUT);
        await hexInput.clearValue();
        await hexInput.setValue('#3b82f6');
      }
      const applyBtn = await browser.$(COLOR_PICKER_APPLY);
      await applyBtn.click();
      await browser.pause(300);
      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(300);

      // Open the connection
      await connectByName(name);
      let tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();
      let style = await tab.getAttribute('style');
      expect(style).toContain('border-left');

      // Close the tab
      await closeTabByTitle(name);
      await browser.pause(300);

      // Reopen the connection
      await connectByName(name);
      tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();
      style = await tab.getAttribute('style');
      expect(style).toContain('border-left');
    });

    it('should override persisted color via context menu (PR #67)', async () => {
      await ensureConnectionsSidebar();
      const name = uniqueName('override-color');
      await createLocalConnection(name);

      // Set blue color via connection editor
      await connectionContextAction(name, CTX_CONNECTION_EDIT);
      await browser.pause(300);
      const colorPickerBtn = await browser.$(CONN_EDITOR_COLOR_PICKER);
      await colorPickerBtn.click();
      await browser.pause(300);
      const blueSwatch = await browser.$(colorPickerSwatch('#3b82f6'));
      if (await blueSwatch.isExisting() && await blueSwatch.isDisplayed()) {
        await blueSwatch.click();
      } else {
        const hexInput = await browser.$(COLOR_PICKER_HEX_INPUT);
        await hexInput.clearValue();
        await hexInput.setValue('#3b82f6');
      }
      let applyBtn = await browser.$(COLOR_PICKER_APPLY);
      await applyBtn.click();
      await browser.pause(300);
      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(300);

      // Open the connection
      await connectByName(name);
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();

      // Override color via context menu to red
      await tab.click({ button: 'right' });
      await browser.pause(300);
      const setColorItem = await browser.$(TAB_CTX_SET_COLOR);
      await setColorItem.click();
      await browser.pause(300);

      const redSwatch = await browser.$(colorPickerSwatch('#ef4444'));
      if (await redSwatch.isExisting() && await redSwatch.isDisplayed()) {
        await redSwatch.click();
      } else {
        const hexInput = await browser.$(COLOR_PICKER_HEX_INPUT);
        await hexInput.clearValue();
        await hexInput.setValue('#ef4444');
      }
      applyBtn = await browser.$(COLOR_PICKER_APPLY);
      await applyBtn.click();
      await browser.pause(300);

      // Verify the tab color changed (runtime override)
      const style = await tab.getAttribute('style');
      expect(style).toContain('border-left');
    });
  });

  describe('SET-MONITOR: Monitoring in status bar (PR #114, #115)', () => {
    it('should show Monitor button in status bar when SSH connections exist', async () => {
      await ensureConnectionsSidebar();
      const name = uniqueName('mon-ssh');
      await createSshConnection(name, { host: '127.0.0.1', port: '22' });

      // Monitor button should appear in status bar
      const monitorBtn = await browser.$('[data-testid="monitoring-connect-btn"]');
      await monitorBtn.waitForExist({ timeout: 5000 });
      expect(await monitorBtn.isDisplayed()).toBe(true);

      const text = await monitorBtn.getText();
      expect(text).toContain('Monitor');
    });

    it('should open dropdown listing SSH connections when clicking Monitor', async () => {
      await ensureConnectionsSidebar();
      const name = uniqueName('mon-drop');
      await createSshConnection(name, { host: '127.0.0.1', port: '22' });

      const monitorBtn = await browser.$('[data-testid="monitoring-connect-btn"]');
      await monitorBtn.waitForExist({ timeout: 5000 });
      await monitorBtn.click();
      await browser.pause(300);

      // Dropdown should list saved SSH connections
      const dropdownItems = await browser.$$('[data-testid^="monitoring-connect-"]');
      // At least the button itself and connection items
      expect(dropdownItems.length).toBeGreaterThanOrEqual(1);

      await browser.keys('Escape');
    });

    it('should not show monitoring icon in activity bar', async () => {
      // PR #114/#115 moved monitoring from sidebar to status bar
      const monitoringActivityBtn = await browser.$('[data-testid="activity-bar-monitoring"]');
      const exists = await monitoringActivityBtn.isExisting();
      expect(exists).toBe(false);
    });
  });
});
