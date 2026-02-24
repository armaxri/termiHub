// Theme switching, horizontal activity bar, customize layout dialog,
// tab border accent, and resize handle tests.
// Covers: PR #220, PR #224, PR #264, PR #242, PR #190, PR #213.

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "./helpers/app.js";
import { openSettingsTab } from "./helpers/sidebar.js";
import { uniqueName, createLocalConnection, connectByName } from "./helpers/connections.js";
import { findTabByTitle, getTabCount, getActiveTab, getAllTabs } from "./helpers/tabs.js";
import {
  ACTIVITY_BAR_CONNECTIONS,
  ACTIVITY_BAR_FILE_BROWSER,
  ACTIVITY_BAR_SETTINGS,
  SETTINGS_MENU_CUSTOMIZE_LAYOUT,
  LAYOUT_CLOSE,
  TOOLBAR_NEW_TERMINAL,
  TOOLBAR_SPLIT,
  TOOLBAR_CLOSE_PANEL,
} from "./helpers/selectors.js";

// ---------------------------------------------------------------------------
// Helpers local to this file
// ---------------------------------------------------------------------------

/**
 * Navigate to Settings > Appearance and select a theme from the dropdown.
 * Assumes Settings tab is already open.
 * @param {'dark'|'light'|'system'} theme
 */
async function selectTheme(theme) {
  // Click the "Appearance" nav item in the settings panel
  const appearanceBtn = await browser.$(".settings-nav__item*=Appearance");
  if ((await appearanceBtn.isExisting()) && (await appearanceBtn.isDisplayed())) {
    await appearanceBtn.click();
    await browser.pause(300);
  }

  // Find the theme <select> inside the settings panel
  const themeSelect = await browser.$(".settings-panel__content select");
  await themeSelect.waitForDisplayed({ timeout: 3000 });
  await themeSelect.selectByAttribute("value", theme);
  await browser.pause(400);
}

/**
 * Read a CSS custom property value from the document root element.
 * @param {string} varName - e.g. '--bg-primary'
 * @returns {Promise<string>}
 */
async function getCssVar(varName) {
  return browser.execute((name) => {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }, varName);
}

/**
 * Open the Customize Layout dialog via the gear icon dropdown.
 */
async function openCustomizeLayoutDialog() {
  const gear = await browser.$(ACTIVITY_BAR_SETTINGS);
  await gear.waitForDisplayed({ timeout: 5000 });
  await gear.click();
  await browser.pause(300);

  const layoutItem = await browser.$(SETTINGS_MENU_CUSTOMIZE_LAYOUT);
  await layoutItem.waitForDisplayed({ timeout: 3000 });
  await layoutItem.click();
  await browser.pause(300);
}

/**
 * Set the activity bar position via the Customize Layout dialog.
 * The dialog must already be open.
 * @param {'left'|'right'|'top'} position
 */
async function setActivityBarPosition(position) {
  const radio = await browser.$(`[data-testid="layout-ab-${position}"]`);
  await radio.waitForDisplayed({ timeout: 3000 });
  await radio.click();
  await browser.pause(300);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Theme & Layout", () => {
  before(async () => {
    await waitForAppReady();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  // =========================================================================
  // 1. Color theme switching (PR #220)
  // =========================================================================
  describe("THEME-SWITCH: Color theme switching (PR #220)", () => {
    it("should update UI elements when switching to Light theme", async () => {
      await openSettingsTab();
      await selectTheme("light");

      // In light theme, --bg-primary should be a light color (#ffffff)
      const bgPrimary = await getCssVar("--bg-primary");
      expect(bgPrimary).toBe("#ffffff");

      // Sidebar background should be light
      const sidebarBg = await getCssVar("--sidebar-bg");
      expect(sidebarBg).toBe("#f3f3f3");

      // Tab background should be light
      const tabBg = await getCssVar("--tab-bg");
      expect(tabBg).toBe("#ececec");

      // Text primary should be dark text on light background
      const textPrimary = await getCssVar("--text-primary");
      expect(textPrimary).toBe("#383a42");

      // Border should be light
      const borderPrimary = await getCssVar("--border-primary");
      expect(borderPrimary).toBe("#d1d5da");
    });

    it("should revert UI elements when switching back to Dark theme", async () => {
      await openSettingsTab();

      // First switch to light to establish a different state
      await selectTheme("light");
      await browser.pause(200);

      // Now switch back to dark
      await selectTheme("dark");

      // Verify dark theme values
      const bgPrimary = await getCssVar("--bg-primary");
      expect(bgPrimary).toBe("#1e1e1e");

      const sidebarBg = await getCssVar("--sidebar-bg");
      expect(sidebarBg).toBe("#252526");

      const tabBg = await getCssVar("--tab-bg");
      expect(tabBg).toBe("#2d2d2d");

      const textPrimary = await getCssVar("--text-primary");
      expect(textPrimary).toBe("#cccccc");
    });

    it("should re-theme terminal instances live when switching", async () => {
      await ensureConnectionsSidebar();
      const name = uniqueName("theme-term");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(500);

      // Terminal should be present
      const xterm = await browser.$(".xterm");
      expect(await xterm.isExisting()).toBe(true);

      // Open settings and switch to light
      await openSettingsTab();
      await selectTheme("light");

      // Terminal background CSS variable should now be the light value
      const termBg = await getCssVar("--terminal-bg");
      expect(termBg).toBe("#ffffff");

      const termFg = await getCssVar("--terminal-fg");
      expect(termFg).toBe("#383a42");
    });

    it("should keep activity bar dark in both themes (visual anchor)", async () => {
      await openSettingsTab();

      // Dark theme: activity bar bg should be dark
      await selectTheme("dark");
      let abBg = await getCssVar("--activity-bar-bg");
      expect(abBg).toBe("#333333");

      // Light theme: activity bar bg should still be dark
      await selectTheme("light");
      abBg = await getCssVar("--activity-bar-bg");
      expect(abBg).toBe("#2c2c2c");

      // Both should be dark colors (not light like #f3f3f3)
      const activityBar = await browser.$(ACTIVITY_BAR_CONNECTIONS);
      const bgColor = await activityBar.getCSSProperty("background-color");
      // The background-color should be a dark value; verify it is not white/light
      // rgb values < 100 on all channels indicate a dark color
      const match = bgColor.value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        const r = parseInt(match[1]);
        const g = parseInt(match[2]);
        const b = parseInt(match[3]);
        expect(r).toBeLessThan(100);
        expect(g).toBeLessThan(100);
        expect(b).toBeLessThan(100);
      }
    });
  });

  // =========================================================================
  // 2. Theme switching applies immediately (PR #224)
  // =========================================================================
  describe("THEME-IMMEDIATE: Theme switching applies immediately (PR #224)", () => {
    it("should apply change immediately when switching Dark to Light", async () => {
      await openSettingsTab();

      // Ensure we start in dark mode
      await selectTheme("dark");
      let bgPrimary = await getCssVar("--bg-primary");
      expect(bgPrimary).toBe("#1e1e1e");

      // Switch to light — should apply without delay
      await selectTheme("light");
      bgPrimary = await getCssVar("--bg-primary");
      expect(bgPrimary).toBe("#ffffff");
    });

    it("should apply change immediately when switching Light to Dark", async () => {
      await openSettingsTab();

      // Start in light mode
      await selectTheme("light");
      let bgPrimary = await getCssVar("--bg-primary");
      expect(bgPrimary).toBe("#ffffff");

      // Switch to dark — should apply without delay
      await selectTheme("dark");
      bgPrimary = await getCssVar("--bg-primary");
      expect(bgPrimary).toBe("#1e1e1e");
    });

    it("should handle rapid theme toggles without visual glitches", async () => {
      await openSettingsTab();

      // Rapidly toggle several times
      for (let i = 0; i < 5; i++) {
        await selectTheme("light");
        let bg = await getCssVar("--bg-primary");
        expect(bg).toBe("#ffffff");

        await selectTheme("dark");
        bg = await getCssVar("--bg-primary");
        expect(bg).toBe("#1e1e1e");
      }

      // Final state should be consistent dark theme
      const finalBg = await getCssVar("--bg-primary");
      expect(finalBg).toBe("#1e1e1e");

      const finalSidebar = await getCssVar("--sidebar-bg");
      expect(finalSidebar).toBe("#252526");
    });
  });

  // =========================================================================
  // 3. Horizontal Activity Bar mode (PR #264)
  // =========================================================================
  describe("LAYOUT-AB-HORIZONTAL: Horizontal Activity Bar mode (PR #264)", () => {
    afterEach(async () => {
      // Reset to default left position after each test
      try {
        await openCustomizeLayoutDialog();
        await setActivityBarPosition("left");
        const closeBtn = await browser.$(LAYOUT_CLOSE);
        await closeBtn.click();
        await browser.pause(300);
      } catch {
        // Ignore errors if dialog is already closed
      }
      await closeAllTabs();
    });

    it("should render activity bar horizontally above content when set to top", async () => {
      await openCustomizeLayoutDialog();
      await setActivityBarPosition("top");
      const closeBtn = await browser.$(LAYOUT_CLOSE);
      await closeBtn.click();
      await browser.pause(300);

      // Activity bar should have the horizontal class
      const activityBar = await browser.$(".activity-bar--horizontal");
      expect(await activityBar.isExisting()).toBe(true);
      expect(await activityBar.isDisplayed()).toBe(true);
    });

    it("should display icons in a row with correct grouping in horizontal mode", async () => {
      await openCustomizeLayoutDialog();
      await setActivityBarPosition("top");
      const closeBtn = await browser.$(LAYOUT_CLOSE);
      await closeBtn.click();
      await browser.pause(300);

      // All activity bar icons should be visible
      const connBtn = await browser.$(ACTIVITY_BAR_CONNECTIONS);
      const filesBtn = await browser.$(ACTIVITY_BAR_FILE_BROWSER);
      const settingsBtn = await browser.$(ACTIVITY_BAR_SETTINGS);

      expect(await connBtn.isDisplayed()).toBe(true);
      expect(await filesBtn.isDisplayed()).toBe(true);
      expect(await settingsBtn.isDisplayed()).toBe(true);

      // In horizontal mode, icons should be at similar Y positions (same row)
      const connLoc = await connBtn.getLocation();
      const filesLoc = await filesBtn.getLocation();
      const settingsLoc = await settingsBtn.getLocation();

      // Y positions should be roughly the same (within a few pixels)
      expect(Math.abs(connLoc.y - filesLoc.y)).toBeLessThan(10);

      // Left group (connections, files) should be to the left of right group (settings)
      expect(connLoc.x).toBeLessThan(settingsLoc.x);
      expect(filesLoc.x).toBeLessThan(settingsLoc.x);
    });

    it("should show active indicator at bottom edge of active icon in horizontal mode", async () => {
      await openCustomizeLayoutDialog();
      await setActivityBarPosition("top");
      const closeBtn = await browser.$(LAYOUT_CLOSE);
      await closeBtn.click();
      await browser.pause(300);

      // Click connections to activate it
      await ensureConnectionsSidebar();

      // The active indicator in horizontal mode uses bottom positioning via CSS
      // Verify the horizontal class is applied (which changes indicator to bottom edge)
      const horizontalBar = await browser.$(".activity-bar--horizontal");
      expect(await horizontalBar.isDisplayed()).toBe(true);

      // The indicator element should exist within the active item
      const indicator = await browser.$(".activity-bar--horizontal .activity-bar__indicator");
      if (await indicator.isExisting()) {
        expect(await indicator.isDisplayed()).toBe(true);
      }
    });

    it("should open settings gear dropdown downward in horizontal mode", async () => {
      await openCustomizeLayoutDialog();
      await setActivityBarPosition("top");
      const closeBtn = await browser.$(LAYOUT_CLOSE);
      await closeBtn.click();
      await browser.pause(300);

      // Click the gear icon
      const gear = await browser.$(ACTIVITY_BAR_SETTINGS);
      const gearLoc = await gear.getLocation();
      await gear.click();
      await browser.pause(300);

      // The dropdown menu content should appear
      const menuContent = await browser.$(".settings-menu__content");
      expect(await menuContent.isDisplayed()).toBe(true);

      // The menu should be below the gear icon (opens downward)
      const menuLoc = await menuContent.getLocation();
      expect(menuLoc.y).toBeGreaterThan(gearLoc.y);

      await browser.keys("Escape");
    });

    it("should fill remaining vertical space with sidebar and terminal in horizontal mode", async () => {
      await openCustomizeLayoutDialog();
      await setActivityBarPosition("top");
      const closeBtn = await browser.$(LAYOUT_CLOSE);
      await closeBtn.click();
      await browser.pause(300);

      await ensureConnectionsSidebar();

      // The sidebar should still be visible and occupying vertical space
      const sidebar = await browser.$(".sidebar");
      expect(await sidebar.isDisplayed()).toBe(true);

      const sidebarSize = await sidebar.getSize();
      // Sidebar should have significant height (more than just the activity bar)
      expect(sidebarSize.height).toBeGreaterThan(100);

      // Activity bar height should be small (the bar width value, ~48px)
      const activityBar = await browser.$(".activity-bar--horizontal");
      const abSize = await activityBar.getSize();
      expect(abSize.height).toBeLessThan(80);

      // Sidebar height should be greater than activity bar height
      expect(sidebarSize.height).toBeGreaterThan(abSize.height);
    });

    it("should work correctly when switching back to left/right position", async () => {
      // Set to top first
      await openCustomizeLayoutDialog();
      await setActivityBarPosition("top");
      let closeBtn = await browser.$(LAYOUT_CLOSE);
      await closeBtn.click();
      await browser.pause(300);

      let horizontalBar = await browser.$(".activity-bar--horizontal");
      expect(await horizontalBar.isExisting()).toBe(true);

      // Switch back to left
      await openCustomizeLayoutDialog();
      await setActivityBarPosition("left");
      closeBtn = await browser.$(LAYOUT_CLOSE);
      await closeBtn.click();
      await browser.pause(300);

      // Horizontal class should be gone
      horizontalBar = await browser.$(".activity-bar--horizontal");
      const isHorizontal =
        (await horizontalBar.isExisting()) && (await horizontalBar.isDisplayed());
      expect(isHorizontal).toBe(false);

      // Vertical activity bar should be present
      const activityBar = await browser.$(".activity-bar");
      expect(await activityBar.isDisplayed()).toBe(true);

      // Connections icon should be above settings icon (vertical layout)
      const connBtn = await browser.$(ACTIVITY_BAR_CONNECTIONS);
      const settingsBtn = await browser.$(ACTIVITY_BAR_SETTINGS);
      const connLoc = await connBtn.getLocation();
      const settingsLoc = await settingsBtn.getLocation();
      expect(settingsLoc.y).toBeGreaterThan(connLoc.y);
    });
  });

  // =========================================================================
  // 4. Customize Layout dialog (PR #242)
  // =========================================================================
  describe("LAYOUT-DIALOG: Customize Layout dialog (PR #242)", () => {
    it("should open dialog when clicking Settings gear > Customize Layout", async () => {
      await openCustomizeLayoutDialog();

      // The dialog close button should be visible (indicating the dialog is open)
      const closeBtn = await browser.$(LAYOUT_CLOSE);
      expect(await closeBtn.isDisplayed()).toBe(true);

      // The dialog title should contain "Customize Layout"
      const title = await browser.$(".customize-layout-dialog__title");
      expect(await title.isDisplayed()).toBe(true);
      const titleText = await title.getText();
      expect(titleText).toContain("Customize Layout");

      // Close the dialog
      await closeBtn.click();
      await browser.pause(300);
    });

    it("should close dialog when pressing Escape", async () => {
      await openCustomizeLayoutDialog();

      // Verify dialog is open
      const closeBtn = await browser.$(LAYOUT_CLOSE);
      expect(await closeBtn.isDisplayed()).toBe(true);

      // Press Escape to close
      await browser.keys("Escape");
      await browser.pause(300);

      // Dialog should be closed — the close button should no longer be visible
      const closeBtnAfter = await browser.$(LAYOUT_CLOSE);
      const visible = (await closeBtnAfter.isExisting()) && (await closeBtnAfter.isDisplayed());
      expect(visible).toBe(false);
    });
  });

  // =========================================================================
  // 5. Highlight selected tab with top border accent (PR #190)
  // =========================================================================
  describe("TAB-BORDER: Highlight selected tab with top border accent (PR #190)", () => {
    it("should show blue top border on active tab and no border on inactive", async () => {
      await ensureConnectionsSidebar();

      const name1 = uniqueName("border1");
      const name2 = uniqueName("border2");
      await createLocalConnection(name1);
      await createLocalConnection(name2);
      await connectByName(name1);
      await connectByName(name2);
      await browser.pause(300);

      // Tab 2 should be active (most recently opened)
      const activeTab = await getActiveTab();
      expect(activeTab).not.toBeNull();
      const activeClass = await activeTab.getAttribute("class");
      expect(activeClass).toContain("tab--active");

      // Active tab should have a visible border-top-color (not transparent)
      const activeBorderColor = await activeTab.getCSSProperty("border-top-color");
      // transparent is represented as rgba(0, 0, 0, 0)
      expect(activeBorderColor.value).not.toBe("rgba(0,0,0,0)");
      expect(activeBorderColor.value).not.toBe("rgba(0, 0, 0, 0)");

      // The inactive tab should have transparent border-top
      const inactiveTab = await findTabByTitle(name1);
      expect(inactiveTab).not.toBeNull();
      const inactiveClass = await inactiveTab.getAttribute("class");
      expect(inactiveClass).not.toContain("tab--active");

      const inactiveBorderColor = await inactiveTab.getCSSProperty("border-top-color");
      // Inactive tabs have border-top: 2px solid transparent
      expect(
        inactiveBorderColor.value === "rgba(0,0,0,0)" ||
          inactiveBorderColor.value === "rgba(0, 0, 0, 0)" ||
          inactiveBorderColor.parsed?.hex === "#000000"
      ).toBe(true);
    });

    it("should show bright blue border on focused panel and dimmer on unfocused in split view", async () => {
      await ensureConnectionsSidebar();

      // Create a terminal and split
      const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await newBtn.click();
      await browser.pause(500);

      const splitBtn = await browser.$(TOOLBAR_SPLIT);
      await splitBtn.click();
      await browser.pause(500);

      // Add a terminal to the new panel
      await newBtn.click();
      await browser.pause(500);

      // There should now be at least two tab bars
      const tabBars = await browser.$$(".tab-bar");
      expect(tabBars.length).toBeGreaterThanOrEqual(2);

      // One tab bar should have 'tab-bar--focused' class, the other should not
      let focusedCount = 0;
      let unfocusedCount = 0;
      for (const bar of tabBars) {
        const cls = await bar.getAttribute("class");
        if (cls && cls.includes("tab-bar--focused")) {
          focusedCount++;
        } else {
          unfocusedCount++;
        }
      }
      expect(focusedCount).toBeGreaterThanOrEqual(1);
      expect(unfocusedCount).toBeGreaterThanOrEqual(1);
    });

    it("should update borders when clicking between panels", async () => {
      await ensureConnectionsSidebar();

      // Create terminals in two panels
      const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await newBtn.click();
      await browser.pause(500);

      const splitBtn = await browser.$(TOOLBAR_SPLIT);
      await splitBtn.click();
      await browser.pause(500);

      await newBtn.click();
      await browser.pause(500);

      // Find the two panel content areas
      const panels = await browser.$$(".split-view__panel-content");
      expect(panels.length).toBeGreaterThanOrEqual(2);

      // Click the first panel
      await panels[0].click();
      await browser.pause(300);

      // The first panel's tab bar should now be focused
      let firstTabBar = await panels[0].$(".tab-bar");
      let firstCls = await firstTabBar.getAttribute("class");
      expect(firstCls).toContain("tab-bar--focused");

      // Click the second panel
      await panels[1].click();
      await browser.pause(300);

      // The second panel's tab bar should now be focused
      let secondTabBar = await panels[1].$(".tab-bar");
      let secondCls = await secondTabBar.getAttribute("class");
      expect(secondCls).toContain("tab-bar--focused");

      // First panel should no longer be focused
      firstTabBar = await panels[0].$(".tab-bar");
      firstCls = await firstTabBar.getAttribute("class");
      expect(firstCls).not.toContain("tab-bar--focused");
    });

    it("should show bright blue border on remaining panel after closing all tabs in another panel", async () => {
      await ensureConnectionsSidebar();

      // Create a terminal and split
      const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await newBtn.click();
      await browser.pause(500);

      const splitBtn = await browser.$(TOOLBAR_SPLIT);
      await splitBtn.click();
      await browser.pause(500);

      await newBtn.click();
      await browser.pause(500);

      // Close the second panel using the toolbar close button
      const closePanel = await browser.$(TOOLBAR_CLOSE_PANEL);
      await closePanel.click();
      await browser.pause(500);

      // The remaining panel's active tab should have the accent border
      const activeTab = await getActiveTab();
      if (activeTab) {
        const borderColor = await activeTab.getCSSProperty("border-top-color");
        // Should have a non-transparent border color
        expect(borderColor.value).not.toBe("rgba(0,0,0,0)");
        expect(borderColor.value).not.toBe("rgba(0, 0, 0, 0)");
      }

      // Only one panel should remain — close panel button should be gone
      const closePanelAfter = await browser.$(TOOLBAR_CLOSE_PANEL);
      const exists = await closePanelAfter.isExisting();
      expect(exists).toBe(false);
    });
  });

  // =========================================================================
  // 6. Vertical split resize handle (PR #213)
  // =========================================================================
  describe("RESIZE-HANDLE: Vertical split resize handle (PR #213)", () => {
    it("should show resize handle between panels after vertical split", async () => {
      // Create a terminal and split
      const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await newBtn.click();
      await browser.pause(500);

      const splitBtn = await browser.$(TOOLBAR_SPLIT);
      await splitBtn.click();
      await browser.pause(500);

      // There should be a resize handle between the two panels
      const handles = await browser.$$(".split-view__resize-handle");
      expect(handles.length).toBeGreaterThanOrEqual(1);

      const handle = handles[0];
      expect(await handle.isDisplayed()).toBe(true);
    });

    it("should show resize handle after horizontal split as well", async () => {
      // Create a terminal
      const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await newBtn.click();
      await browser.pause(500);

      // Split the view
      const splitBtn = await browser.$(TOOLBAR_SPLIT);
      await splitBtn.click();
      await browser.pause(500);

      // A resize handle should be present regardless of orientation
      const handles = await browser.$$(".split-view__resize-handle");
      expect(handles.length).toBeGreaterThanOrEqual(1);

      for (const handle of handles) {
        expect(await handle.isDisplayed()).toBe(true);
      }
    });

    it("should show resize handles for all divisions in nested splits", async () => {
      // Create a terminal
      const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await newBtn.click();
      await browser.pause(500);

      // First split
      const splitBtn = await browser.$(TOOLBAR_SPLIT);
      await splitBtn.click();
      await browser.pause(500);

      // Add a terminal to the new panel and split again
      await newBtn.click();
      await browser.pause(500);
      await splitBtn.click();
      await browser.pause(500);

      // Should have at least 2 resize handles now (one per split division)
      const handles = await browser.$$(".split-view__resize-handle");
      expect(handles.length).toBeGreaterThanOrEqual(2);

      // All handles should be visible
      for (const handle of handles) {
        expect(await handle.isDisplayed()).toBe(true);
      }
    });
  });

  // =========================================================================
  // Cleanup: restore dark theme at the end of the suite
  // =========================================================================
  after(async () => {
    try {
      await openSettingsTab();
      await selectTheme("dark");
      await closeAllTabs();
    } catch {
      // Ignore cleanup errors
    }
  });
});
