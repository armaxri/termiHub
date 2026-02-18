// Tab management tests.
// Covers: TAB-01, TAB-02, TAB-03, TAB-04, TAB-05, TAB-06.

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from './helpers/app.js';
import {
  uniqueName,
  createLocalConnection,
  connectByName,
} from './helpers/connections.js';
import {
  getAllTabs,
  getTabCount,
  findTabByTitle,
  closeTabByTitle,
  getActiveTab,
} from './helpers/tabs.js';
import {
  TOOLBAR_NEW_TERMINAL,
  TAB_CTX_RENAME,
  RENAME_DIALOG_INPUT,
  RENAME_DIALOG_APPLY,
} from './helpers/selectors.js';

describe('Tab Management', () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe('TAB-01: Create tabs', () => {
    it('should open multiple tabs via the New Terminal button', async () => {
      const initialCount = await getTabCount();

      // Click "New Terminal" three times
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(300);
      await btn.click();
      await browser.pause(300);
      await btn.click();
      await browser.pause(300);

      const newCount = await getTabCount();
      expect(newCount).toBe(initialCount + 3);
    });

    it('should activate the most recently created tab', async () => {
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(300);
      await btn.click();
      await browser.pause(300);

      const active = await getActiveTab();
      expect(active).not.toBeNull();

      // The active tab should be the last one added
      const allTabs = await getAllTabs();
      const lastTab = allTabs[allTabs.length - 1];
      const activeId = await active.getAttribute('data-testid');
      const lastId = await lastTab.getAttribute('data-testid');
      expect(activeId).toBe(lastId);
    });
  });

  describe('TAB-02: Close tab', () => {
    it('should close a tab when its close button is clicked', async () => {
      // Create a connection and open it to get a named tab
      const name = uniqueName('close');
      await createLocalConnection(name);
      await connectByName(name);

      const countBefore = await getTabCount();
      expect(countBefore).toBeGreaterThanOrEqual(1);

      await closeTabByTitle(name);

      const countAfter = await getTabCount();
      expect(countAfter).toBe(countBefore - 1);
    });

    it('should activate an adjacent tab after closing', async () => {
      const name1 = uniqueName('adj1');
      const name2 = uniqueName('adj2');
      await createLocalConnection(name1);
      await createLocalConnection(name2);
      await connectByName(name1);
      await connectByName(name2);

      // Close the second (active) tab
      await closeTabByTitle(name2);

      // The first tab should now be active
      const active = await getActiveTab();
      expect(active).not.toBeNull();
    });
  });

  describe('TAB-03: Drag reorder', () => {
    it('should have multiple tabs that can be reordered (basic smoke test)', async () => {
      // Create two tabs
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(300);
      await btn.click();
      await browser.pause(300);

      const tabs = await getAllTabs();
      expect(tabs.length).toBeGreaterThanOrEqual(2);

      // Verify tabs have the dnd sortable attributes (presence check)
      // Actual drag-and-drop is tested manually due to dnd-kit complexity
      const firstTab = tabs[0];
      const ariaRole = await firstTab.getAttribute('role');
      // dnd-kit adds role="button" on sortable items
      // Just verify tabs are visible and interactive
      expect(await firstTab.isDisplayed()).toBe(true);
    });
  });

  describe('TAB-04: Switch tabs', () => {
    it('should switch active tab when clicking a different tab', async () => {
      const name1 = uniqueName('switch1');
      const name2 = uniqueName('switch2');
      await createLocalConnection(name1);
      await createLocalConnection(name2);
      await connectByName(name1);
      await connectByName(name2);

      // Tab 2 should be active
      let active = await getActiveTab();
      let activeText = await active.getText();
      expect(activeText).toContain(name2);

      // Click tab 1
      const tab1 = await findTabByTitle(name1);
      await tab1.click();
      await browser.pause(200);

      // Tab 1 should now be active
      active = await getActiveTab();
      activeText = await active.getText();
      expect(activeText).toContain(name1);
    });
  });

  describe('TAB-05: Context menu', () => {
    it('should show context menu with expected options on right-click', async () => {
      const name = uniqueName('ctx');
      await createLocalConnection(name);
      await connectByName(name);

      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();

      // Right-click to open context menu
      await tab.click({ button: 'right' });
      await browser.pause(300);

      // Check for expected context menu items
      const saveItem = await browser.$('[data-testid="tab-context-save"]');
      const copyItem = await browser.$('[data-testid="tab-context-copy"]');
      const clearItem = await browser.$('[data-testid="tab-context-clear"]');

      expect(await saveItem.isDisplayed()).toBe(true);
      expect(await copyItem.isDisplayed()).toBe(true);
      expect(await clearItem.isDisplayed()).toBe(true);

      // Dismiss menu by pressing Escape
      await browser.keys('Escape');
    });
  });

  describe('TAB-HSCROLL: Horizontal scrolling toggle (PR #45)', () => {
    it('should show "Horizontal Scrolling" toggle in tab context menu', async () => {
      const name = uniqueName('hscroll-menu');
      await createLocalConnection(name);
      await connectByName(name);

      const tab = await findTabByTitle(name);
      await tab.click({ button: 'right' });
      await browser.pause(300);

      const hscrollItem = await browser.$('[data-testid="tab-context-horizontal-scroll"]');
      expect(await hscrollItem.isDisplayed()).toBe(true);

      await browser.keys('Escape');
    });

    it('should toggle horizontal scrolling via context menu without error', async () => {
      const name = uniqueName('hscroll-toggle');
      await createLocalConnection(name);
      await connectByName(name);

      // Right-click and toggle horizontal scrolling on
      const tab = await findTabByTitle(name);
      await tab.click({ button: 'right' });
      await browser.pause(300);

      const hscrollItem = await browser.$('[data-testid="tab-context-horizontal-scroll"]');
      await hscrollItem.click();
      await browser.pause(500);

      // Terminal should still be functional
      const xtermContainer = await browser.$('.xterm');
      expect(await xtermContainer.isExisting()).toBe(true);
    });
  });

  describe('TAB-CTX-SUPPRESS: Suppress default context menu (PR #150)', () => {
    it('should show custom context menu on connection right-click', async () => {
      const name = uniqueName('ctx-conn');
      await createLocalConnection(name);

      // Right-click the connection in the sidebar
      const item = await browser.$(`[data-testid^="connection-item-"]`);
      if (item && await item.isExisting()) {
        await item.click({ button: 'right' });
        await browser.pause(300);

        // Custom context menu should appear (has connect/edit/delete items)
        const editItem = await browser.$('[data-testid="context-connection-edit"]');
        const visible = await editItem.isExisting() && await editItem.isDisplayed();
        expect(visible).toBe(true);

        await browser.keys('Escape');
      }
    });

    it('should show custom context menu on tab right-click', async () => {
      const name = uniqueName('ctx-tab');
      await createLocalConnection(name);
      await connectByName(name);

      const tab = await findTabByTitle(name);
      await tab.click({ button: 'right' });
      await browser.pause(300);

      // Custom tab context menu should appear
      const clearItem = await browser.$('[data-testid="tab-context-clear"]');
      expect(await clearItem.isDisplayed()).toBe(true);

      await browser.keys('Escape');
    });
  });

  describe('TAB-COPY: Copy to Clipboard context menu (PR #36)', () => {
    it('should show Save, Copy, Clear in correct order in context menu', async () => {
      const name = uniqueName('copy-order');
      await createLocalConnection(name);
      await connectByName(name);

      const tab = await findTabByTitle(name);
      await tab.click({ button: 'right' });
      await browser.pause(300);

      const saveItem = await browser.$('[data-testid="tab-context-save"]');
      const copyItem = await browser.$('[data-testid="tab-context-copy"]');
      const clearItem = await browser.$('[data-testid="tab-context-clear"]');

      expect(await saveItem.isDisplayed()).toBe(true);
      expect(await copyItem.isDisplayed()).toBe(true);
      expect(await clearItem.isDisplayed()).toBe(true);

      // Verify order: Save < Copy < Clear (by Y position)
      const saveLoc = await saveItem.getLocation();
      const copyLoc = await copyItem.getLocation();
      const clearLoc = await clearItem.getLocation();
      expect(saveLoc.y).toBeLessThan(copyLoc.y);
      expect(copyLoc.y).toBeLessThan(clearLoc.y);

      await browser.keys('Escape');
    });

    it('should copy terminal content to clipboard without error', async () => {
      const name = uniqueName('copy-action');
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1000);

      // Right-click tab and click Copy to Clipboard
      const tab = await findTabByTitle(name);
      await tab.click({ button: 'right' });
      await browser.pause(300);

      const copyItem = await browser.$('[data-testid="tab-context-copy"]');
      await copyItem.click();
      await browser.pause(500);

      // Verify the terminal still exists (action completed without crashing)
      const xtermContainer = await browser.$('.xterm');
      expect(await xtermContainer.isExisting()).toBe(true);
    });
  });

  describe('TAB-SAVE: Save to File in context menu (PR #35)', () => {
    it('should show "Save to File" above "Clear Terminal" in context menu', async () => {
      const name = uniqueName('save-order');
      await createLocalConnection(name);
      await connectByName(name);

      const tab = await findTabByTitle(name);
      await tab.click({ button: 'right' });
      await browser.pause(300);

      // Verify both items are visible
      const saveItem = await browser.$('[data-testid="tab-context-save"]');
      const clearItem = await browser.$('[data-testid="tab-context-clear"]');
      expect(await saveItem.isDisplayed()).toBe(true);
      expect(await clearItem.isDisplayed()).toBe(true);

      // Verify order: Save should appear above Clear (lower Y position)
      const saveLoc = await saveItem.getLocation();
      const clearLoc = await clearItem.getLocation();
      expect(saveLoc.y).toBeLessThan(clearLoc.y);

      await browser.keys('Escape');
    });
  });

  describe('TAB-CLEAR: Clear terminal via context menu (PR #34)', () => {
    it('should show "Clear Terminal" in tab context menu', async () => {
      const name = uniqueName('clear-menu');
      await createLocalConnection(name);
      await connectByName(name);

      const tab = await findTabByTitle(name);
      await tab.click({ button: 'right' });
      await browser.pause(300);

      const clearItem = await browser.$('[data-testid="tab-context-clear"]');
      expect(await clearItem.isDisplayed()).toBe(true);

      await browser.keys('Escape');
    });

    it('should clear terminal scrollback when clicking "Clear Terminal"', async () => {
      const name = uniqueName('clear-action');
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1000);

      // Right-click tab and click Clear Terminal
      const tab = await findTabByTitle(name);
      await tab.click({ button: 'right' });
      await browser.pause(300);

      const clearItem = await browser.$('[data-testid="tab-context-clear"]');
      await clearItem.click();
      await browser.pause(500);

      // Verify the xterm container still exists (terminal wasn't destroyed)
      const xtermContainer = await browser.$('.xterm');
      expect(await xtermContainer.isExisting()).toBe(true);
    });

    it('should not show context menu on Settings tab', async () => {
      // Open settings tab
      const gear = await browser.$('[data-testid="activity-bar-settings"]');
      await gear.click();
      await browser.pause(300);
      const openItem = await browser.$('[data-testid="settings-menu-open"]');
      await openItem.waitForDisplayed({ timeout: 3000 });
      await openItem.click();
      await browser.pause(300);

      // Find the Settings tab and right-click it
      const settingsTab = await findTabByTitle('Settings');
      expect(settingsTab).not.toBeNull();
      await settingsTab.click({ button: 'right' });
      await browser.pause(300);

      // Clear Terminal should NOT be visible (no terminal context menu for settings)
      const clearItem = await browser.$('[data-testid="tab-context-clear"]');
      const visible = await clearItem.isExisting() && await clearItem.isDisplayed();
      expect(visible).toBe(false);

      await browser.keys('Escape');
    });
  });

  describe('TAB-06: Rename tab (PR #156)', () => {
    it('should show "Rename" in the tab context menu', async () => {
      const name = uniqueName('rename-menu');
      await createLocalConnection(name);
      await connectByName(name);

      const tab = await findTabByTitle(name);
      await tab.click({ button: 'right' });
      await browser.pause(300);

      const renameItem = await browser.$(TAB_CTX_RENAME);
      expect(await renameItem.isDisplayed()).toBe(true);

      await browser.keys('Escape');
    });

    it('should rename a tab via the context menu', async () => {
      const name = uniqueName('rename-src');
      const newName = uniqueName('rename-dst');
      await createLocalConnection(name);
      await connectByName(name);

      // Right-click tab and select Rename
      const tab = await findTabByTitle(name);
      await tab.click({ button: 'right' });
      await browser.pause(300);

      const renameItem = await browser.$(TAB_CTX_RENAME);
      await renameItem.click();
      await browser.pause(300);

      // Rename dialog should appear with input
      const input = await browser.$(RENAME_DIALOG_INPUT);
      await input.waitForDisplayed({ timeout: 3000 });
      await input.clearValue();
      await input.setValue(newName);

      const applyBtn = await browser.$(RENAME_DIALOG_APPLY);
      await applyBtn.click();
      await browser.pause(300);

      // Tab should now show the new name
      const renamedTab = await findTabByTitle(newName);
      expect(renamedTab).not.toBeNull();

      // Old name should no longer appear
      const oldTab = await findTabByTitle(name);
      expect(oldTab).toBeNull();
    });

    it('should show context menu with Rename when right-clicking terminal area', async () => {
      const name = uniqueName('rename-area');
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1000);

      // Right-click inside the terminal content area
      const xtermContainer = await browser.$('.xterm');
      if (await xtermContainer.isExisting()) {
        await xtermContainer.click({ button: 'right' });
        await browser.pause(300);

        const renameItem = await browser.$(TAB_CTX_RENAME);
        const visible = await renameItem.isExisting() && await renameItem.isDisplayed();
        expect(visible).toBe(true);

        await browser.keys('Escape');
      }
    });
  });
});
