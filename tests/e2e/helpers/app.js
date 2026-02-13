// App-level helpers: startup, sidebar navigation, cleanup.

import { ACTIVITY_BAR_CONNECTIONS } from './selectors.js';

/**
 * Wait for the Tauri app to finish rendering.
 * Call once in a top-level `before` hook.
 */
export async function waitForAppReady() {
  // Wait for the activity bar to appear (signals the React tree is mounted)
  const activityBtn = await browser.$(ACTIVITY_BAR_CONNECTIONS);
  await activityBtn.waitForDisplayed({ timeout: 10000 });
}

/**
 * Ensure the Connections sidebar is visible by clicking the activity bar item.
 */
export async function ensureConnectionsSidebar() {
  const btn = await browser.$(ACTIVITY_BAR_CONNECTIONS);
  await btn.waitForDisplayed({ timeout: 5000 });
  await btn.click();
  // Small pause for the sidebar transition
  await browser.pause(300);
}

/**
 * Close every open tab by repeatedly clicking the first visible close button.
 * Useful in `afterEach` to reset state.
 */
export async function closeAllTabs() {
  const MAX_ITERATIONS = 50;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const closeBtns = await browser.$$('[data-testid^="tab-close-"]');
    const visible = [];
    for (const btn of closeBtns) {
      if (await btn.isDisplayed()) {
        visible.push(btn);
      }
    }
    if (visible.length === 0) break;
    await visible[0].click();
    await browser.pause(200);
  }
}
