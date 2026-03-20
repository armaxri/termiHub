// Helpers for creating and managing connections in E2E tests.

import {
  CONNECTION_LIST_NEW_CONNECTION,
  CONN_EDITOR_NAME,
  CONN_EDITOR_TYPE,
  CONN_EDITOR_SAVE,
  CONN_EDITOR_CANCEL,
  STARTING_DIRECTORY,
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
  // Use JavaScript to set the input value instead of keyboard events.
  // After a terminal session, WebKitGTK keyboard state can become corrupted
  // (e.g. Shift stuck), causing setValue() to produce wrong-case characters.
  // Directly setting the React-controlled input via the native value setter
  // and dispatching an 'input' event reliably triggers React's onChange.
  await browser.execute(
    (el, val) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      nativeSetter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    nameInput,
    name,
  );
  // Wait briefly for React state to settle before clicking save
  await browser.pause(200);
  const saveBtn = await browser.$(CONN_EDITOR_SAVE);
  await saveBtn.click();
  // Wait for the editor to close and sidebar to re-render
  await browser.pause(800);
  return name;
}

/**
 * Create a local shell connection with a specific starting directory.
 * Assumes the Connections sidebar is already visible.
 * @param {string} name - Connection name
 * @param {string} startingDir - Absolute path for the starting directory
 */
export async function createLocalConnectionInDir(name, startingDir) {
  await openNewConnectionEditor();
  const nameInput = await browser.$(CONN_EDITOR_NAME);
  await browser.execute(
    (el, val) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      nativeSetter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
    nameInput,
    name,
  );
  await browser.pause(200);
  // Set the starting directory field if it exists
  const dirInput = await browser.$(STARTING_DIRECTORY);
  if (await dirInput.isExisting()) {
    await browser.execute(
      (el, val) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        ).set;
        nativeSetter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      },
      dirInput,
      startingDir,
    );
    await browser.pause(200);
  }
  const saveBtn = await browser.$(CONN_EDITOR_SAVE);
  await saveBtn.click();
  await browser.pause(800);
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
  // Wait for the form to re-render with type-specific fields under WebKitGTK
  await browser.pause(500);
}

/**
 * Find a connection item in the sidebar by its visible name.
 * Uses the `title` attribute (`"Double-click to connect: <name>"`) which is
 * always the full untruncated name, making it reliable under WebKit where
 * getText() can return CSS-truncated text.
 * Retries for up to `timeout` ms to allow the sidebar list to refresh after a save.
 * Returns the WebdriverIO element, or null if not found within the timeout.
 * @param {string} name
 * @param {number} timeout - Max wait in ms (default 5000)
 */
export async function findConnectionByName(name, timeout = 5000) {
  // Regular connections: title="Double-click to connect: <name>"
  // Remote agent headers: title="Remote agent: <name>"
  // Both use title*= selector for reliable matching even when display text is truncated.
  const selector = [
    `[data-testid^="connection-item-"][title*="${name}"]`,
    `[data-testid^="agent-header-"][title*="${name}"]`,
  ].join(', ');
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const item = await browser.$(selector);
    if (await item.isExisting()) return item;
    await browser.pause(300);
  }
  return null;
}

/**
 * Double-click a connection by name to open it.
 * Scrolls the element into view using JavaScript first, since the connection
 * list can be long and WdIO's built-in scroll may not reach nested containers.
 * @param {string} name
 */
export async function connectByName(name) {
  const item = await findConnectionByName(name);
  if (!item) throw new Error(`Connection "${name}" not found in sidebar`);
  await browser.execute((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }), item);
  await browser.pause(300);
  // Use JS double-click dispatch to bypass WebDriver's "element not interactable"
  // check which can fail under WebKitGTK when pointer-events CSS is conditional.
  await browser.execute(
    (el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 })),
    item
  );
  await browser.pause(500);
}

/**
 * Right-click a connection by name and select a context menu action.
 * Scrolls the element into view using JavaScript first, since the connection
 * list can be long and WdIO's built-in scroll may not reach nested containers.
 * @param {string} name
 * @param {string} menuSelector - One of the CTX_CONNECTION_* selectors
 */
export async function connectionContextAction(name, menuSelector) {
  const item = await findConnectionByName(name);
  if (!item) throw new Error(`Connection "${name}" not found in sidebar`);
  await browser.execute((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }), item);
  await browser.pause(300);
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
