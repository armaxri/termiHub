// Connection CRUD tests.
// Covers: CONN-01, CONN-02, CONN-03, CONN-04, CONN-10, CONN-PING.

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "./helpers/app.js";
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
} from "./helpers/connections.js";
import { findTabByTitle, getTabCount, getActiveTab } from "./helpers/tabs.js";
import { createSshConnection, createTelnetConnection } from "./helpers/infrastructure.js";
import {
  CONN_EDITOR_NAME,
  CONN_EDITOR_NAME_ERROR,
  CONN_EDITOR_SAVE,
  CONN_EDITOR_SAVE_CONNECT,
  CONN_EDITOR_CANCEL,
  CONNECTION_LIST_NEW_FOLDER,
  INLINE_FOLDER_NAME_INPUT,
  INLINE_FOLDER_CONFIRM,
  CTX_CONNECTION_PING,
} from "./helpers/selectors.js";

describe("Connection CRUD", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  describe("CONN-01: Create connection", () => {
    it("should create a local connection and show it in the list", async () => {
      const name = uniqueName("create");
      await createLocalConnection(name);

      const item = await findConnectionByName(name);
      expect(item).not.toBeNull();
      expect(await item.isDisplayed()).toBe(true);
    });
  });

  describe("CONN-02: Edit connection", () => {
    it("should edit a connection name via context menu", async () => {
      const originalName = uniqueName("edit-orig");
      await createLocalConnection(originalName);

      // Right-click > Edit
      await connectionContextAction(originalName, CTX_CONNECTION_EDIT);

      // Editor should open with the original name
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.waitForDisplayed({ timeout: 3000 });
      const currentValue = await nameInput.getValue();
      expect(currentValue).toBe(originalName);

      // Change the name
      const updatedName = originalName + "-edited";
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

  describe("CONN-03: Delete connection", () => {
    it("should delete a connection via context menu", async () => {
      const name = uniqueName("delete");
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

  describe("CONN-04: Create folder", () => {
    it("should create a folder via the toolbar button", async () => {
      const folderName = uniqueName("folder");

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

  describe("CONN-10: Duplicate connection", () => {
    it("should duplicate a connection via context menu", async () => {
      const name = uniqueName("dup");
      await createLocalConnection(name);

      // Right-click > Duplicate
      await connectionContextAction(name, CTX_CONNECTION_DUPLICATE);
      await browser.pause(500);

      // The duplicate should appear with "Copy of" prefix
      const duplicate = await findConnectionByName(`Copy of ${name}`);
      expect(duplicate).not.toBeNull();
    });
  });

  describe("CONN-EDITOR-TAB: Connection editor as tab (PR #109)", () => {
    afterEach(async () => {
      await closeAllTabs();
    });

    it("should open editor as a tab when clicking New Connection", async () => {
      await openNewConnectionEditor();

      // An editor tab should appear (the form is inside a tab)
      const tabCount = await getTabCount();
      expect(tabCount).toBeGreaterThanOrEqual(1);

      // The editor form should be visible
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      expect(await nameInput.isDisplayed()).toBe(true);

      await cancelEditor();
    });

    it('should open editor tab with "Edit: <name>" title when editing', async () => {
      const name = uniqueName("edit-tab");
      await createLocalConnection(name);

      await connectionContextAction(name, CTX_CONNECTION_EDIT);
      await browser.pause(300);

      // Editor tab should contain "Edit" in its title
      const editTab = await findTabByTitle("Edit");
      expect(editTab).not.toBeNull();

      await cancelEditor();
    });

    it("should close editor tab when saving", async () => {
      const name = uniqueName("save-close");
      await openNewConnectionEditor();
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);

      const tabsBefore = await getTabCount();
      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(300);

      const tabsAfter = await getTabCount();
      expect(tabsAfter).toBeLessThan(tabsBefore);
    });

    it("should close editor tab when cancelling without saving", async () => {
      await openNewConnectionEditor();

      const tabsBefore = await getTabCount();
      const cancelBtn = await browser.$(CONN_EDITOR_CANCEL);
      await cancelBtn.click();
      await browser.pause(300);

      const tabsAfter = await getTabCount();
      expect(tabsAfter).toBeLessThan(tabsBefore);
    });

    it("should activate existing editor tab when re-editing same connection", async () => {
      const name = uniqueName("re-edit");
      await createLocalConnection(name);

      // Open editor for the connection
      await connectionContextAction(name, CTX_CONNECTION_EDIT);
      await browser.pause(300);
      const tabsAfterFirst = await getTabCount();

      await browser.keys("Escape");
      await browser.pause(200);

      // Edit the same connection again
      await connectionContextAction(name, CTX_CONNECTION_EDIT);
      await browser.pause(300);
      const tabsAfterSecond = await getTabCount();

      // Should not have created a second editor tab
      expect(tabsAfterSecond).toBe(tabsAfterFirst);

      await cancelEditor();
    });

    it("should open multiple editor tabs for different connections (PR #109)", async () => {
      const name1 = uniqueName("multi-ed1");
      const name2 = uniqueName("multi-ed2");
      await createLocalConnection(name1);
      await createLocalConnection(name2);

      // Edit first connection
      await connectionContextAction(name1, CTX_CONNECTION_EDIT);
      await browser.pause(300);
      const tabsAfterFirst = await getTabCount();

      // Edit second connection — should open a SECOND editor tab
      await connectionContextAction(name2, CTX_CONNECTION_EDIT);
      await browser.pause(300);
      const tabsAfterSecond = await getTabCount();

      expect(tabsAfterSecond).toBe(tabsAfterFirst + 1);

      // Both editor tabs should be open
      const editTab1 = await findTabByTitle(name1);
      const editTab2 = await findTabByTitle(name2);
      expect(editTab1).not.toBeNull();
      expect(editTab2).not.toBeNull();
    });
  });

  describe("CONN-SAVE-CONNECT: Save & Connect button (PR #112)", () => {
    afterEach(async () => {
      await closeAllTabs();
    });

    it("should save connection AND open terminal tab when clicking Save & Connect", async () => {
      await openNewConnectionEditor();
      const name = uniqueName("save-conn");
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);

      // Click Save & Connect
      const saveConnectBtn = await browser.$(CONN_EDITOR_SAVE_CONNECT);
      await saveConnectBtn.click();
      await browser.pause(1000);

      // Connection should be saved in sidebar
      const item = await findConnectionByName(name);
      expect(item).not.toBeNull();

      // A terminal tab should have opened
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();
    });

    it("should still have working Save and Cancel buttons", async () => {
      // Test Save
      await openNewConnectionEditor();
      const name = uniqueName("save-only");
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);
      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(300);

      const item = await findConnectionByName(name);
      expect(item).not.toBeNull();

      // Test Cancel
      await openNewConnectionEditor();
      const cancelBtn = await browser.$(CONN_EDITOR_CANCEL);
      await cancelBtn.click();
      await browser.pause(300);

      // Editor should be closed
      const editorName = await browser.$(CONN_EDITOR_NAME);
      const visible = (await editorName.isExisting()) && (await editorName.isDisplayed());
      expect(visible).toBe(false);
    });
  });

  describe("CONN-DUP-NAME: Duplicate connection name validation (#380)", () => {
    afterEach(async () => {
      await closeAllTabs();
    });

    it("should show error when creating a connection with a duplicate name", async () => {
      const name = uniqueName("dup-check");
      await createLocalConnection(name);

      // Open a new connection editor and type the same name
      await openNewConnectionEditor();
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);
      await browser.pause(200);

      // Error message should appear
      const errorHint = await browser.$(CONN_EDITOR_NAME_ERROR);
      await errorHint.waitForDisplayed({ timeout: 3000 });
      const errorText = await errorHint.getText();
      expect(errorText).toContain("already exists");
    });

    it("should prevent saving when name is a duplicate", async () => {
      const name = uniqueName("dup-block");
      await createLocalConnection(name);

      // Open a new connection editor with the same name
      await openNewConnectionEditor();
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);

      // Click Save
      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(300);

      // The editor should still be open (save was blocked)
      expect(await nameInput.isDisplayed()).toBe(true);

      // Error message should still be visible
      const errorHint = await browser.$(CONN_EDITOR_NAME_ERROR);
      expect(await errorHint.isDisplayed()).toBe(true);
    });

    it("should clear error when name is changed to a unique value", async () => {
      const name = uniqueName("dup-clear");
      await createLocalConnection(name);

      // Open a new connection editor with the same name
      await openNewConnectionEditor();
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);

      // Verify error is shown
      const errorHint = await browser.$(CONN_EDITOR_NAME_ERROR);
      await errorHint.waitForDisplayed({ timeout: 3000 });

      // Change to a unique name
      const uniqueNewName = uniqueName("dup-fixed");
      await nameInput.clearValue();
      await nameInput.setValue(uniqueNewName);
      await browser.pause(200);

      // Error should disappear
      const errorVisible = (await errorHint.isExisting()) && (await errorHint.isDisplayed());
      expect(errorVisible).toBe(false);

      // Save should now work
      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(300);

      // Editor should close (save succeeded)
      const nameInputAfterSave = await browser.$(CONN_EDITOR_NAME);
      const stillVisible =
        (await nameInputAfterSave.isExisting()) && (await nameInputAfterSave.isDisplayed());
      expect(stillVisible).toBe(false);

      // Connection should appear in sidebar
      const item = await findConnectionByName(uniqueNewName);
      expect(item).not.toBeNull();
    });

    it("should allow saving when editing a connection without changing its name", async () => {
      const name = uniqueName("self-edit");
      await createLocalConnection(name);

      // Edit the same connection (its own name should not be a duplicate)
      await connectionContextAction(name, CTX_CONNECTION_EDIT);
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.waitForDisplayed({ timeout: 3000 });

      // No error should be shown (editing own name)
      const errorHint = await browser.$(CONN_EDITOR_NAME_ERROR);
      const errorVisible = (await errorHint.isExisting()) && (await errorHint.isDisplayed());
      expect(errorVisible).toBe(false);

      // Save should work
      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(300);

      // Editor should close
      const nameInputAfterSave = await browser.$(CONN_EDITOR_NAME);
      const stillVisible =
        (await nameInputAfterSave.isExisting()) && (await nameInputAfterSave.isDisplayed());
      expect(stillVisible).toBe(false);
    });
  });

  describe("CONN-PING: Ping host context menu (PR #37)", () => {
    afterEach(async () => {
      await closeAllTabs();
    });

    it('should show "Ping Host" in context menu for SSH connections', async () => {
      const name = uniqueName("ping-ssh");
      await createSshConnection(name, { host: "127.0.0.1", port: "22" });

      const item = await findConnectionByName(name);
      await item.click({ button: "right" });
      await browser.pause(300);

      const pingItem = await browser.$(CTX_CONNECTION_PING);
      expect(await pingItem.isDisplayed()).toBe(true);

      await browser.keys("Escape");
    });

    it('should show "Ping Host" in context menu for Telnet connections', async () => {
      const name = uniqueName("ping-telnet");
      await createTelnetConnection(name, { host: "127.0.0.1", port: "23" });

      const item = await findConnectionByName(name);
      await item.click({ button: "right" });
      await browser.pause(300);

      const pingItem = await browser.$(CTX_CONNECTION_PING);
      expect(await pingItem.isDisplayed()).toBe(true);

      await browser.keys("Escape");
    });

    it('should not show "Ping Host" for Local connections', async () => {
      const name = uniqueName("ping-local");
      await createLocalConnection(name);

      const item = await findConnectionByName(name);
      await item.click({ button: "right" });
      await browser.pause(300);

      const pingItem = await browser.$(CTX_CONNECTION_PING);
      const visible = (await pingItem.isExisting()) && (await pingItem.isDisplayed());
      expect(visible).toBe(false);

      await browser.keys("Escape");
    });

    it('should open a Ping tab when clicking "Ping Host"', async () => {
      const name = uniqueName("ping-tab");
      await createSshConnection(name, { host: "127.0.0.1", port: "22" });

      await connectionContextAction(name, CTX_CONNECTION_PING);
      await browser.pause(1000);

      // A tab titled "Ping ..." should appear
      const tab = await findTabByTitle("Ping");
      expect(tab).not.toBeNull();
    });
  });
});
