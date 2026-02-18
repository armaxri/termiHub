// Connection CRUD tests.
// Covers: CONN-01, CONN-02, CONN-03, CONN-04, CONN-10, CONN-PING.

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from './helpers/app.js';
import {
  uniqueName,
  createLocalConnection,
  findConnectionByName,
  connectionContextAction,
  openNewConnectionEditor,
  cancelEditor,
  CTX_CONNECTION_EDIT,
  CTX_CONNECTION_DUPLICATE,
  CTX_CONNECTION_DELETE,
} from './helpers/connections.js';
import { findTabByTitle } from './helpers/tabs.js';
import { createSshConnection, createTelnetConnection } from './helpers/infrastructure.js';
import {
  CONN_EDITOR_NAME,
  CONN_EDITOR_SAVE,
  CONNECTION_LIST_NEW_FOLDER,
  INLINE_FOLDER_NAME_INPUT,
  INLINE_FOLDER_CONFIRM,
  CTX_CONNECTION_PING,
} from './helpers/selectors.js';

describe('Connection CRUD', () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  describe('CONN-01: Create connection', () => {
    it('should create a local connection and show it in the list', async () => {
      const name = uniqueName('create');
      await createLocalConnection(name);

      const item = await findConnectionByName(name);
      expect(item).not.toBeNull();
      expect(await item.isDisplayed()).toBe(true);
    });
  });

  describe('CONN-02: Edit connection', () => {
    it('should edit a connection name via context menu', async () => {
      const originalName = uniqueName('edit-orig');
      await createLocalConnection(originalName);

      // Right-click > Edit
      await connectionContextAction(originalName, CTX_CONNECTION_EDIT);

      // Editor should open with the original name
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.waitForDisplayed({ timeout: 3000 });
      const currentValue = await nameInput.getValue();
      expect(currentValue).toBe(originalName);

      // Change the name
      const updatedName = originalName + '-edited';
      await nameInput.clearValue();
      await nameInput.setValue(updatedName);

      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(300);

      // Verify updated name appears
      const updatedItem = await findConnectionByName(updatedName);
      expect(updatedItem).not.toBeNull();

      // Original name should no longer appear
      const originalItem = await findConnectionByName(originalName);
      expect(originalItem).toBeNull();
    });
  });

  describe('CONN-03: Delete connection', () => {
    it('should delete a connection via context menu', async () => {
      const name = uniqueName('delete');
      await createLocalConnection(name);

      // Verify it exists first
      let item = await findConnectionByName(name);
      expect(item).not.toBeNull();

      // Right-click > Delete
      await connectionContextAction(name, CTX_CONNECTION_DELETE);
      await browser.pause(500);

      // Verify it is gone
      item = await findConnectionByName(name);
      expect(item).toBeNull();
    });
  });

  describe('CONN-04: Create folder', () => {
    it('should create a folder via the toolbar button', async () => {
      const folderName = uniqueName('folder');

      const newFolderBtn = await browser.$(CONNECTION_LIST_NEW_FOLDER);
      await newFolderBtn.waitForDisplayed({ timeout: 3000 });
      await newFolderBtn.click();
      await browser.pause(300);

      // Inline folder input should appear
      const input = await browser.$(INLINE_FOLDER_NAME_INPUT);
      await input.waitForDisplayed({ timeout: 3000 });
      await input.setValue(folderName);

      const confirmBtn = await browser.$(INLINE_FOLDER_CONFIRM);
      await confirmBtn.click();
      await browser.pause(300);

      // Verify the folder toggle is visible (folders use folder-toggle-{id})
      // We search by visible text since the ID is a UUID
      const folders = await browser.$$('[data-testid^="folder-toggle-"]');
      let found = false;
      for (const f of folders) {
        const text = await f.getText();
        if (text.includes(folderName)) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    });
  });

  describe('CONN-10: Duplicate connection', () => {
    it('should duplicate a connection via context menu', async () => {
      const name = uniqueName('dup');
      await createLocalConnection(name);

      // Right-click > Duplicate
      await connectionContextAction(name, CTX_CONNECTION_DUPLICATE);
      await browser.pause(500);

      // The duplicate should appear with "Copy of" prefix
      const duplicate = await findConnectionByName(`Copy of ${name}`);
      expect(duplicate).not.toBeNull();
    });
  });

  describe('CONN-PING: Ping host context menu (PR #37)', () => {
    afterEach(async () => {
      await closeAllTabs();
    });

    it('should show "Ping Host" in context menu for SSH connections', async () => {
      const name = uniqueName('ping-ssh');
      await createSshConnection(name, { host: '127.0.0.1', port: '22' });

      const item = await findConnectionByName(name);
      await item.click({ button: 'right' });
      await browser.pause(300);

      const pingItem = await browser.$(CTX_CONNECTION_PING);
      expect(await pingItem.isDisplayed()).toBe(true);

      await browser.keys('Escape');
    });

    it('should show "Ping Host" in context menu for Telnet connections', async () => {
      const name = uniqueName('ping-telnet');
      await createTelnetConnection(name, { host: '127.0.0.1', port: '23' });

      const item = await findConnectionByName(name);
      await item.click({ button: 'right' });
      await browser.pause(300);

      const pingItem = await browser.$(CTX_CONNECTION_PING);
      expect(await pingItem.isDisplayed()).toBe(true);

      await browser.keys('Escape');
    });

    it('should not show "Ping Host" for Local connections', async () => {
      const name = uniqueName('ping-local');
      await createLocalConnection(name);

      const item = await findConnectionByName(name);
      await item.click({ button: 'right' });
      await browser.pause(300);

      const pingItem = await browser.$(CTX_CONNECTION_PING);
      const visible = await pingItem.isExisting() && await pingItem.isDisplayed();
      expect(visible).toBe(false);

      await browser.keys('Escape');
    });

    it('should open a Ping tab when clicking "Ping Host"', async () => {
      const name = uniqueName('ping-tab');
      await createSshConnection(name, { host: '127.0.0.1', port: '22' });

      await connectionContextAction(name, CTX_CONNECTION_PING);
      await browser.pause(1000);

      // A tab titled "Ping ..." should appear
      const tab = await findTabByTitle('Ping');
      expect(tab).not.toBeNull();
    });
  });
});
