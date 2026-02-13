// Helpers for sidebar navigation in E2E tests.

import {
  ACTIVITY_BAR_FILE_BROWSER,
  ACTIVITY_BAR_SETTINGS,
  SETTINGS_MENU_OPEN,
} from './selectors.js';

/**
 * Switch to the File Browser sidebar by clicking the activity bar icon.
 */
export async function switchToFilesSidebar() {
  const btn = await browser.$(ACTIVITY_BAR_FILE_BROWSER);
  await btn.waitForDisplayed({ timeout: 5000 });
  await btn.click();
  await browser.pause(300);
}

/**
 * Open the Settings tab via the gear icon dropdown menu.
 */
export async function openSettingsTab() {
  const gear = await browser.$(ACTIVITY_BAR_SETTINGS);
  await gear.waitForDisplayed({ timeout: 5000 });
  await gear.click();
  await browser.pause(300);
  const openItem = await browser.$(SETTINGS_MENU_OPEN);
  await openItem.waitForDisplayed({ timeout: 3000 });
  await openItem.click();
  await browser.pause(300);
}
