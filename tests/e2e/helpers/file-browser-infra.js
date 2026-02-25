// SFTP file browser helpers for infrastructure E2E tests.

import {
  FILE_BROWSER_CURRENT_PATH,
  FILE_BROWSER_PLACEHOLDER,
  FILE_BROWSER_SFTP_CONNECTING,
  FILE_BROWSER_NEW_FILE,
  FILE_BROWSER_NEW_FILE_INPUT,
  FILE_BROWSER_NEW_FILE_CONFIRM,
  PASSWORD_PROMPT_INPUT,
  PASSWORD_PROMPT_CONNECT,
} from "./selectors.js";
import { switchToFilesSidebar } from "./sidebar.js";

/**
 * Switch to the Files sidebar and handle SFTP password prompt if needed.
 * Assumes an SSH tab is already open and active.
 * @param {string} password - Password for SFTP auth (default 'testpass')
 * @param {number} timeout - Max wait for SFTP to connect (default 15000)
 */
export async function connectSftpBrowser(password = "testpass", timeout = 15000) {
  await switchToFilesSidebar();
  await browser.pause(1000);

  // Check if a password prompt appears (for SFTP auto-connect)
  const promptInput = await browser.$(PASSWORD_PROMPT_INPUT);
  const promptVisible = (await promptInput.isExisting()) && (await promptInput.isDisplayed());

  if (promptVisible) {
    await promptInput.setValue(password);
    const connectBtn = await browser.$(PASSWORD_PROMPT_CONNECT);
    await connectBtn.click();
    await browser.pause(500);
  }

  // Wait for SFTP to connect and show file entries
  return waitForSftpEntries(timeout);
}

/**
 * Wait for SFTP file browser to show file entries.
 * @param {number} timeout - Max wait time (default 15000)
 * @returns {Promise<boolean>} true if file entries appeared
 */
export async function waitForSftpEntries(timeout = 15000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const entries = await browser.$$('[data-testid^="file-row-"]');
    if (entries.length > 0) return true;
    await browser.pause(500);
  }
  return false;
}

/**
 * Get the current path displayed in the file browser.
 * @returns {Promise<string>}
 */
export async function getFileBrowserPath() {
  const pathEl = await browser.$(FILE_BROWSER_CURRENT_PATH);
  if (await pathEl.isExisting()) {
    return pathEl.getText();
  }
  return "";
}

/**
 * Right-click a file in the file browser by name and select a context action.
 * @param {string} fileName - File name to right-click
 * @param {string} menuSelector - Context menu item selector
 */
export async function fileBrowserContextAction(fileName, menuSelector) {
  const fileEl = await browser.$(`[data-testid="file-row-${fileName}"]`);
  await fileEl.waitForDisplayed({ timeout: 5000 });
  await fileEl.click({ button: "right" });
  await browser.pause(300);
  const menuItem = await browser.$(menuSelector);
  await menuItem.waitForDisplayed({ timeout: 3000 });
  await menuItem.click();
  await browser.pause(300);
}

/**
 * Check if the "no filesystem" placeholder is showing.
 * @returns {Promise<boolean>}
 */
export async function isNoFilesystemPlaceholder() {
  const placeholder = await browser.$(FILE_BROWSER_PLACEHOLDER);
  return placeholder.isExisting() && placeholder.isDisplayed();
}

/**
 * Create a new file in the file browser.
 * @param {string} fileName - Name for the new file
 */
export async function createNewFile(fileName) {
  const newBtn = await browser.$(FILE_BROWSER_NEW_FILE);
  await newBtn.click();
  await browser.pause(200);

  const input = await browser.$(FILE_BROWSER_NEW_FILE_INPUT);
  await input.waitForDisplayed({ timeout: 3000 });
  await input.setValue(fileName);

  const confirmBtn = await browser.$(FILE_BROWSER_NEW_FILE_CONFIRM);
  await confirmBtn.click();
  await browser.pause(500);
}
