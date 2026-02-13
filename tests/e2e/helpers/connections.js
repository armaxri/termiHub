// Helpers for creating and managing connections in E2E tests.

import {
  CONNECTION_LIST_NEW_CONNECTION,
  CONN_EDITOR_NAME,
  CONN_EDITOR_TYPE,
  CONN_EDITOR_SAVE,
  CONN_EDITOR_CANCEL,
  CTX_CONNECTION_CONNECT,
  CTX_CONNECTION_EDIT,
  CTX_CONNECTION_DUPLICATE,
  CTX_CONNECTION_DELETE,
} from './selectors.js';

/**
 * Generate a unique connection name to avoid collisions between test runs.
 * @param {string} purpose - Short description (e.g. "local", "ssh")
 */
export function uniqueName(purpose) {
  return `E2E-${purpose}-${Date.now()}`;
}

/**
 * Open the "New Connection" editor from the connection list toolbar.
 */
export async function openNewConnectionEditor() {
  const btn = await browser.$(CONNECTION_LIST_NEW_CONNECTION);
  await btn.waitForDisplayed({ timeout: 5000 });
  await btn.click();
  // Wait for the editor form to render
  const nameInput = await browser.$(CONN_EDITOR_NAME);
  await nameInput.waitForDisplayed({ timeout: 3000 });
}

/**
 * Create a local shell connection with the given name and save it.
 * Assumes the Connections sidebar is already visible.
 * @param {string} name - Connection name
 * @returns {Promise<string>} the name used
 */
export async function createLocalConnection(name) {
  await openNewConnectionEditor();
  // Type defaults to "local" (first option), so no need to change type
  const nameInput = await browser.$(CONN_EDITOR_NAME);
  await nameInput.setValue(name);
  const saveBtn = await browser.$(CONN_EDITOR_SAVE);
  await saveBtn.click();
  await browser.pause(300);
  return name;
}

/**
 * Set the connection type in the editor dropdown.
 * The editor must already be open.
 * @param {'local'|'ssh'|'serial'|'telnet'} type
 */
export async function setConnectionType(type) {
  const select = await browser.$(CONN_EDITOR_TYPE);
  await select.selectByAttribute('value', type);
  await browser.pause(200);
}

/**
 * Find a connection item in the sidebar by its visible name text.
 * Returns the WebdriverIO element, or null if not found.
 * @param {string} name
 */
export async function findConnectionByName(name) {
  const items = await browser.$$('[data-testid^="connection-item-"]');
  for (const item of items) {
    const text = await item.getText();
    if (text.includes(name)) {
      return item;
    }
  }
  return null;
}

/**
 * Double-click a connection by name to open it.
 * @param {string} name
 */
export async function connectByName(name) {
  const item = await findConnectionByName(name);
  if (!item) throw new Error(`Connection "${name}" not found in sidebar`);
  await item.doubleClick();
  await browser.pause(500);
}

/**
 * Right-click a connection by name and select a context menu action.
 * @param {string} name
 * @param {string} menuSelector - One of the CTX_CONNECTION_* selectors
 */
export async function connectionContextAction(name, menuSelector) {
  const item = await findConnectionByName(name);
  if (!item) throw new Error(`Connection "${name}" not found in sidebar`);
  await item.click({ button: 'right' });
  await browser.pause(300);
  const menuItem = await browser.$(menuSelector);
  await menuItem.waitForDisplayed({ timeout: 3000 });
  await menuItem.click();
  await browser.pause(300);
}

/**
 * Cancel the current connection editor without saving.
 */
export async function cancelEditor() {
  const btn = await browser.$(CONN_EDITOR_CANCEL);
  if (await btn.isDisplayed()) {
    await btn.click();
    await browser.pause(200);
  }
}

// Re-export context menu selectors for convenience
export {
  CTX_CONNECTION_CONNECT,
  CTX_CONNECTION_EDIT,
  CTX_CONNECTION_DUPLICATE,
  CTX_CONNECTION_DELETE,
};
