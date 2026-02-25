// Sidebar toggle tests.
// Covers: SIDEBAR-TOGGLE (PR #194).

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "./helpers/app.js";
import {
  TOOLBAR_TOGGLE_SIDEBAR,
  TOOLBAR_NEW_TERMINAL,
  ACTIVITY_BAR_CONNECTIONS,
} from "./helpers/selectors.js";

describe("Sidebar Toggle (PR #194)", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
    // Ensure sidebar is visible again for the next test
    const sidebar = await browser.$(".sidebar");
    if (!(await sidebar.isExisting()) || !(await sidebar.isDisplayed())) {
      const toggleBtn = await browser.$(TOOLBAR_TOGGLE_SIDEBAR);
      if ((await toggleBtn.isExisting()) && (await toggleBtn.isDisplayed())) {
        await toggleBtn.click();
        await browser.pause(300);
      }
    }
  });

  it("should have the sidebar toggle button visible in the toolbar", async () => {
    // Open a terminal so the toolbar appears
    const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
    await newBtn.click();
    await browser.pause(500);

    const toggleBtn = await browser.$(TOOLBAR_TOGGLE_SIDEBAR);
    expect(await toggleBtn.isDisplayed()).toBe(true);
  });

  it("should hide the sidebar when clicking the toggle button", async () => {
    // Open a terminal so the toolbar appears
    const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
    await newBtn.click();
    await browser.pause(500);

    // Sidebar should be visible initially
    const sidebar = await browser.$(".sidebar");
    expect(await sidebar.isDisplayed()).toBe(true);

    // Click toggle to hide
    const toggleBtn = await browser.$(TOOLBAR_TOGGLE_SIDEBAR);
    await toggleBtn.click();
    await browser.pause(300);

    // Sidebar should be hidden
    const sidebarAfter = await browser.$(".sidebar");
    const visible = (await sidebarAfter.isExisting()) && (await sidebarAfter.isDisplayed());
    expect(visible).toBe(false);
  });

  it("should show the sidebar when clicking the toggle button again", async () => {
    // Open a terminal so the toolbar appears
    const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
    await newBtn.click();
    await browser.pause(500);

    const toggleBtn = await browser.$(TOOLBAR_TOGGLE_SIDEBAR);

    // Hide sidebar
    await toggleBtn.click();
    await browser.pause(300);

    // Show sidebar again
    await toggleBtn.click();
    await browser.pause(300);

    const sidebar = await browser.$(".sidebar");
    expect(await sidebar.isDisplayed()).toBe(true);
  });

  it("should show toggle button as highlighted when sidebar is visible", async () => {
    // Open a terminal so the toolbar appears
    const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
    await newBtn.click();
    await browser.pause(500);

    const toggleBtn = await browser.$(TOOLBAR_TOGGLE_SIDEBAR);
    const className = await toggleBtn.getAttribute("class");
    expect(className).toContain("--active");
  });

  it("should not show toggle button as highlighted when sidebar is hidden", async () => {
    // Open a terminal so the toolbar appears
    const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
    await newBtn.click();
    await browser.pause(500);

    const toggleBtn = await browser.$(TOOLBAR_TOGGLE_SIDEBAR);

    // Hide sidebar
    await toggleBtn.click();
    await browser.pause(300);

    const className = await toggleBtn.getAttribute("class");
    expect(className).not.toContain("--active");
  });

  it("should keep the toggle button functional after split view", async () => {
    // Open a terminal
    const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
    await newBtn.click();
    await browser.pause(500);

    // Split the view
    const splitBtn = await browser.$('[data-testid="terminal-view-split"]');
    if ((await splitBtn.isExisting()) && (await splitBtn.isDisplayed())) {
      await splitBtn.click();
      await browser.pause(500);
    }

    // Toggle sidebar should still work
    const toggleBtn = await browser.$(TOOLBAR_TOGGLE_SIDEBAR);
    expect(await toggleBtn.isDisplayed()).toBe(true);

    // Hide sidebar
    await toggleBtn.click();
    await browser.pause(300);

    const sidebar = await browser.$(".sidebar");
    const visible = (await sidebar.isExisting()) && (await sidebar.isDisplayed());
    expect(visible).toBe(false);

    // Show sidebar again
    await toggleBtn.click();
    await browser.pause(300);

    const sidebarShown = await browser.$(".sidebar");
    expect(await sidebarShown.isDisplayed()).toBe(true);
  });
});
