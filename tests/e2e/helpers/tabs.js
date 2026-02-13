// Helpers for tab management in E2E tests.

import { ALL_TABS, TAB_ACTIVE_CLASS } from './selectors.js';

/**
 * Get all visible tab elements in the tab bar.
 * Filters out close buttons and context menu items by using the ALL_TABS selector.
 */
export async function getAllTabs() {
  const tabs = await browser.$$(ALL_TABS);
  const visible = [];
  for (const t of tabs) {
    if (await t.isDisplayed()) {
      visible.push(t);
    }
  }
  return visible;
}

/**
 * Get the number of visible tabs.
 */
export async function getTabCount() {
  const tabs = await getAllTabs();
  return tabs.length;
}

/**
 * Find a tab by its visible title text.
 * @param {string} title
 * @returns {Promise<WebdriverIO.Element|null>}
 */
export async function findTabByTitle(title) {
  const tabs = await getAllTabs();
  for (const t of tabs) {
    const text = await t.getText();
    if (text.includes(title)) {
      return t;
    }
  }
  return null;
}

/**
 * Close a tab by its title.  Finds the tab, extracts the UUID from its
 * `data-testid`, then clicks the corresponding close button.
 * @param {string} title
 */
export async function closeTabByTitle(title) {
  const tab = await findTabByTitle(title);
  if (!tab) throw new Error(`Tab "${title}" not found`);
  const testId = await tab.getAttribute('data-testid');
  // testId is "tab-<uuid>", close button is "tab-close-<uuid>"
  const uuid = testId.replace('tab-', '');
  const closeBtn = await browser.$(`[data-testid="tab-close-${uuid}"]`);
  await closeBtn.click();
  await browser.pause(200);
}

/**
 * Get the currently active tab element (has class tab--active).
 * @returns {Promise<WebdriverIO.Element|null>}
 */
export async function getActiveTab() {
  const tabs = await getAllTabs();
  for (const t of tabs) {
    const cls = await t.getAttribute('class');
    if (cls && cls.includes(TAB_ACTIVE_CLASS)) {
      return t;
    }
  }
  return null;
}
