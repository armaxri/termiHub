// App-level helpers: startup, sidebar navigation, cleanup.

import { ACTIVITY_BAR_CONNECTIONS } from './selectors.js';
import { connectionContextAction, CTX_CONNECTION_DELETE } from './connections.js';

const CTX_AGENT_DELETE = '[data-testid="context-agent-delete"]';

/**
 * Wait for the Tauri app to finish rendering.
 * Call once in a top-level `before` hook.
 */
export async function waitForAppReady() {
  // Wait for the activity bar to appear (signals the React tree is mounted).
  // Allow up to 20 s — a cold-start with a freshly-built bundle can be slow
  // under WebKitGTK/Xvfb; the WebKit disk cache makes subsequent runs faster.
  const activityBtn = await browser.$(ACTIVITY_BAR_CONNECTIONS);
  await activityBtn.waitForDisplayed({ timeout: 20000 });
}

/**
 * Ensure the Connections sidebar is visible.
 * Only clicks the activity bar button if the connections panel is not already
 * showing — clicking when the panel is already active would toggle it closed.
 */
export async function ensureConnectionsSidebar() {
  const btn = await browser.$(ACTIVITY_BAR_CONNECTIONS);
  await btn.waitForDisplayed({ timeout: 5000 });

  // Check if the connection list is already visible (new-connection button present)
  const newConnBtn = await browser.$('[data-testid="connection-list-new-connection"]');
  const alreadyVisible = await newConnBtn.isDisplayed().catch(() => false);
  if (!alreadyVisible) {
    await btn.click();
    // Wait for the sidebar transition to complete
    await browser.pause(300);
  }
}

/**
 * Delete all connections whose names start with "E2E-" (leftover from test runs).
 * Call once in a top-level `before` hook to start each worker with a clean state.
 */
export async function cleanupE2EConnections() {
  const MAX_ROUNDS = 100;
  for (let i = 0; i < MAX_ROUNDS; i++) {
    // Use title attribute to find E2E connections (both regular connections and agent headers).
    // getText() can return truncated text under WebKit, but title always has the full name.
    const connItems = await browser.$$('[data-testid^="connection-item-"][title*="E2E-"]');
    const agentItems = await browser.$$('[data-testid^="agent-header-"][title*="E2E-"]');
    const items = [...connItems, ...agentItems];
    if (items.length === 0) break; // No more E2E connections — done
    let deleted = false;
    for (const item of items) {
      try {
        // Right-click → Delete (works for both connection items and agent headers)
        await item.click({ button: 'right' });
        await browser.pause(300);
        // Try connection delete first, then agent delete
        let deleteBtn = await browser.$(CTX_CONNECTION_DELETE);
        let visible = await deleteBtn.isDisplayed().catch(() => false);
        if (!visible) {
          deleteBtn = await browser.$(CTX_AGENT_DELETE);
          visible = await deleteBtn.isDisplayed().catch(() => false);
        }
        if (visible) {
          await deleteBtn.click();
          await browser.pause(500);
          deleted = true;
          break; // Restart the scan after each successful deletion (DOM changes)
        } else {
          // Context menu didn't show delete — dismiss and try next item
          await browser.keys(['Escape']);
          await browser.pause(200);
        }
      } catch {
        // Stale element — restart the outer loop
        deleted = true; // Treat as progress to avoid premature exit
        break;
      }
    }
    if (!deleted) break; // Tried all items, none could be deleted — stop
  }
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
    // Use JS click to bypass pointer-events CSS (buttons hidden until hover under WebKitGTK).
    await browser.execute((el) => el.click(), visible[0]);
    await browser.pause(200);
  }
}
