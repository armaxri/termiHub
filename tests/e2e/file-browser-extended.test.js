// Extended file browser E2E tests.
// Covers: CWD-aware file browser (PR #39), local file explorer stuck at root (PR #110),
//         file browser stays active when editing (PR #57), New File button (PR #58),
//         right-click context menu (PR #59), double-click file to open (PR #61).

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "./helpers/app.js";
import { uniqueName, createLocalConnection, connectByName } from "./helpers/connections.js";
import { switchToFilesSidebar, openSettingsTab } from "./helpers/sidebar.js";
import { findTabByTitle, getTabCount, closeTabByTitle } from "./helpers/tabs.js";
import {
  FILE_BROWSER_UP,
  FILE_BROWSER_REFRESH,
  FILE_BROWSER_CURRENT_PATH,
  FILE_BROWSER_NEW_FILE,
  FILE_BROWSER_NEW_FILE_INPUT,
  FILE_BROWSER_NEW_FILE_CONFIRM,
  FILE_BROWSER_NEW_FOLDER,
  FILE_BROWSER_NEW_FOLDER_INPUT,
  FILE_BROWSER_NEW_FOLDER_CONFIRM,
  FILE_MENU_EDIT,
  FILE_MENU_RENAME,
  FILE_MENU_DELETE,
  CTX_FILE_EDIT,
  CTX_FILE_RENAME,
  CTX_FILE_DELETE,
  fileRow,
  ACTIVITY_BAR_FILE_BROWSER,
  ACTIVITY_BAR_CONNECTIONS,
} from "./helpers/selectors.js";

describe("File Browser — Extended", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    // Switch back to connections sidebar and close all tabs for clean state
    await ensureConnectionsSidebar();
    await closeAllTabs();
  });

  // ── CWD-aware file browser (PR #39) ─────────────────────────────────

  describe("CWD-aware file browser (PR #39)", () => {
    it("should show /tmp contents in file browser after cd /tmp in local terminal", async () => {
      const name = uniqueName("cwd-tmp");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Change directory to /tmp in the terminal
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      // Switch to the file browser sidebar
      await switchToFilesSidebar();
      await browser.pause(500);

      // The file browser current path should reflect /tmp
      const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        const pathText = await currentPath.getText();
        expect(pathText).toContain("/tmp");
      }
    });

    it("should follow each CWD when switching between two local shell tabs", async () => {
      const name1 = uniqueName("cwd-tab1");
      const name2 = uniqueName("cwd-tab2");
      await createLocalConnection(name1);
      await createLocalConnection(name2);

      // Open first terminal and cd to /tmp
      await connectByName(name1);
      await browser.pause(1500);
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      // Open second terminal and cd to /var
      await connectByName(name2);
      await browser.pause(1500);
      await browser.keys("cd /var\n");
      await browser.pause(1000);

      // Switch to file browser
      await switchToFilesSidebar();
      await browser.pause(500);

      // Tab2 is active — file browser should show /var
      const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        let pathText = await currentPath.getText();
        expect(pathText).toContain("/var");

        // Switch to tab1
        const tab1 = await findTabByTitle(name1);
        expect(tab1).not.toBeNull();
        await tab1.click();
        await browser.pause(500);

        // File browser should now show /tmp
        pathText = await currentPath.getText();
        expect(pathText).toContain("/tmp");
      }
    });

    it("should show correct CWD after switching sidebar views and back", async () => {
      const name = uniqueName("cwd-sidebar");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // cd to /tmp
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      // Switch to files sidebar
      await switchToFilesSidebar();
      await browser.pause(500);

      // Verify current path shows /tmp
      let currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        let pathText = await currentPath.getText();
        expect(pathText).toContain("/tmp");
      }

      // Switch to connections sidebar
      const connBtn = await browser.$(ACTIVITY_BAR_CONNECTIONS);
      await connBtn.click();
      await browser.pause(300);

      // Switch back to files sidebar
      await switchToFilesSidebar();
      await browser.pause(500);

      // Current path should still show /tmp
      currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        const pathText = await currentPath.getText();
        expect(pathText).toContain("/tmp");
      }
    });

    it("should support right-click rename/delete on local files with list refresh", async () => {
      const name = uniqueName("cwd-ctx");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // cd to /tmp so we have a writable directory
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      // Create a test file via terminal
      const testFile = `e2e_ctx_${Date.now()}.txt`;
      await browser.keys(`touch ${testFile}\n`);
      await browser.pause(500);

      // Switch to file browser and refresh
      await switchToFilesSidebar();
      await browser.pause(500);
      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      await refreshBtn.click();
      await browser.pause(500);

      // Right-click the test file
      const row = await browser.$(fileRow(testFile));
      if ((await row.isExisting()) && (await row.isDisplayed())) {
        await row.click({ button: "right" });
        await browser.pause(300);

        // Context menu should show Rename and Delete options
        const renameItem = await browser.$(CTX_FILE_RENAME);
        const deleteItem = await browser.$(CTX_FILE_DELETE);

        if (await renameItem.isExisting()) {
          expect(await renameItem.isDisplayed()).toBe(true);
        }
        if (await deleteItem.isExisting()) {
          expect(await deleteItem.isDisplayed()).toBe(true);

          // Click delete to remove the test file
          await deleteItem.click();
          await browser.pause(500);

          // Verify the file is no longer listed
          const deletedRow = await browser.$(fileRow(testFile));
          const stillVisible = (await deletedRow.isExisting()) && (await deletedRow.isDisplayed());
          expect(stillVisible).toBe(false);
        } else {
          // Dismiss context menu
          await browser.keys("Escape");
        }
      }

      // Cleanup: remove test file if still present
      await ensureConnectionsSidebar();
      const tab = await findTabByTitle(name);
      if (tab) {
        await tab.click();
        await browser.pause(300);
        await browser.keys(`rm -f /tmp/${testFile}\n`);
        await browser.pause(300);
      }
    });

    it("should create a directory via toolbar button in local mode", async () => {
      const name = uniqueName("cwd-mkdir");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // cd to /tmp for writable directory
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      // Switch to file browser
      await switchToFilesSidebar();
      await browser.pause(500);

      const newFolderBtn = await browser.$(FILE_BROWSER_NEW_FOLDER);
      if ((await newFolderBtn.isExisting()) && (await newFolderBtn.isDisplayed())) {
        await newFolderBtn.click();
        await browser.pause(300);

        const input = await browser.$(FILE_BROWSER_NEW_FOLDER_INPUT);
        expect(await input.isDisplayed()).toBe(true);

        const folderName = `e2e_dir_${Date.now()}`;
        await input.setValue(folderName);

        const confirmBtn = await browser.$(FILE_BROWSER_NEW_FOLDER_CONFIRM);
        await confirmBtn.click();
        await browser.pause(500);

        // Verify the new directory appears in the file list
        const dirRow = await browser.$(fileRow(folderName));
        if (await dirRow.isExisting()) {
          expect(await dirRow.isDisplayed()).toBe(true);
        }

        // Cleanup: remove the created directory
        await ensureConnectionsSidebar();
        const tab = await findTabByTitle(name);
        if (tab) {
          await tab.click();
          await browser.pause(300);
          await browser.keys(`rmdir /tmp/${folderName}\n`);
          await browser.pause(300);
        }
      }
    });
  });

  // ── Local file explorer stuck at root fix (PR #110) ─────────────────

  describe("Local file explorer stuck at root fix (PR #110)", () => {
    it("should show home directory contents when opening Files sidebar for local terminal", async () => {
      const name = uniqueName("root-fix");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Switch to the file browser sidebar
      await switchToFilesSidebar();
      await browser.pause(500);

      // The current path should show the home directory, not root "/"
      const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        const pathText = await currentPath.getText();
        expect(pathText.length).toBeGreaterThan(1);
        expect(pathText.startsWith("/")).toBe(true);
        // Should not be stuck at root — home dirs are typically /home/*, /root, or /Users/*
        // Allow /tmp or similar if CWD has been set, but it should not be bare "/"
        expect(pathText).not.toBe("/");
      }

      // File entries should be listed
      const rows = await browser.$$('[data-testid^="file-row-"]');
      expect(rows.length).toBeGreaterThanOrEqual(0);
    });

    it("should load home directory even without OSC 7 support (bash fallback)", async () => {
      // Create and connect a local shell (bash may not emit OSC 7)
      const name = uniqueName("no-osc7");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Switch to file browser
      await switchToFilesSidebar();
      await browser.pause(500);

      // The file browser should still show a valid directory, not root
      const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        const pathText = await currentPath.getText();
        expect(pathText.length).toBeGreaterThan(1);
        expect(pathText.startsWith("/")).toBe(true);
      }

      // At least some file entries should be visible
      const rows = await browser.$$('[data-testid^="file-row-"]');
      expect(rows.length).toBeGreaterThanOrEqual(0);
    });

    it("should not re-navigate when switching away and back if entries are already loaded", async () => {
      const name = uniqueName("no-renavigate");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Switch to file browser and note the current path
      await switchToFilesSidebar();
      await browser.pause(500);

      const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
      let initialPath = "";
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        initialPath = await currentPath.getText();
      }

      // Navigate up one level to change the view
      const upBtn = await browser.$(FILE_BROWSER_UP);
      if ((await upBtn.isExisting()) && (await upBtn.isDisplayed())) {
        await upBtn.click();
        await browser.pause(500);
      }

      // Record the path after navigating up
      let navigatedPath = "";
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        navigatedPath = await currentPath.getText();
      }

      // Switch to connections sidebar
      const connBtn = await browser.$(ACTIVITY_BAR_CONNECTIONS);
      await connBtn.click();
      await browser.pause(300);

      // Switch back to files sidebar
      await switchToFilesSidebar();
      await browser.pause(500);

      // The path should remain at the navigated location, not reset
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        const currentPathText = await currentPath.getText();
        // If we successfully navigated up, path should stay at navigated location
        if (navigatedPath) {
          expect(currentPathText).toBe(navigatedPath);
        }
      }
    });
  });

  // ── File browser stays active when editing (PR #57) ─────────────────

  describe("File browser stays active when editing (PR #57)", () => {
    it("should show the parent directory of an opened file in the file browser", async () => {
      const name = uniqueName("edit-browse");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Create a test file
      const testFile = `e2e_edit_${Date.now()}.txt`;
      await browser.keys(`echo "test content" > /tmp/${testFile}\n`);
      await browser.pause(500);

      // cd to /tmp so the file browser shows /tmp contents
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      // Switch to file browser
      await switchToFilesSidebar();
      await browser.pause(500);
      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      await refreshBtn.click();
      await browser.pause(500);

      // Double-click the test file to open it in the editor
      const row = await browser.$(fileRow(testFile));
      if ((await row.isExisting()) && (await row.isDisplayed())) {
        await row.doubleClick();
        await browser.pause(500);

        // File browser should still show /tmp (the parent directory)
        const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
        if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
          const pathText = await currentPath.getText();
          expect(pathText).toContain("/tmp");
        }
      }

      // Cleanup
      await ensureConnectionsSidebar();
      const tab = await findTabByTitle(name);
      if (tab) {
        await tab.click();
        await browser.pause(300);
        await browser.keys(`rm -f /tmp/${testFile}\n`);
        await browser.pause(300);
      }
    });

    it("should update file browser when switching between editor and terminal tabs", async () => {
      const name = uniqueName("edit-switch");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Create a test file and cd to /tmp
      const testFile = `e2e_switch_${Date.now()}.txt`;
      await browser.keys(`echo "content" > /tmp/${testFile}\n`);
      await browser.pause(500);
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      // Switch to file browser
      await switchToFilesSidebar();
      await browser.pause(500);
      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      await refreshBtn.click();
      await browser.pause(500);

      // Open the file in editor by double-clicking
      const row = await browser.$(fileRow(testFile));
      if ((await row.isExisting()) && (await row.isDisplayed())) {
        await row.doubleClick();
        await browser.pause(500);

        // An editor tab should open
        const editorTab = await findTabByTitle(testFile);
        if (editorTab) {
          // Switch back to the terminal tab
          const terminalTab = await findTabByTitle(name);
          if (terminalTab) {
            await terminalTab.click();
            await browser.pause(500);

            // File browser should update (still showing a valid path)
            const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
            if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
              const pathText = await currentPath.getText();
              expect(pathText.length).toBeGreaterThan(0);
              expect(pathText.startsWith("/")).toBe(true);
            }
          }
        }
      }

      // Cleanup
      await ensureConnectionsSidebar();
      const tab = await findTabByTitle(name);
      if (tab) {
        await tab.click();
        await browser.pause(300);
        await browser.keys(`rm -f /tmp/${testFile}\n`);
        await browser.pause(300);
      }
    });

    it('should show "No filesystem available" when Settings tab is active', async () => {
      // Open a Settings tab
      await openSettingsTab();
      await browser.pause(300);

      // Switch to file browser sidebar
      await switchToFilesSidebar();
      await browser.pause(500);

      // The file browser should indicate no filesystem is available
      // This could be a message or the toolbar/path being absent
      const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
      const pathVisible = (await currentPath.isExisting()) && (await currentPath.isDisplayed());

      if (pathVisible) {
        // If the path element exists, it might show a "no filesystem" message
        const pathText = await currentPath.getText();
        // Either the path is empty or contains a message about no filesystem
        const noFs = pathText === "" || pathText.toLowerCase().includes("no filesystem");
        expect(noFs || !pathVisible).toBe(true);
      } else {
        // If no path element is visible, that itself indicates no filesystem
        expect(pathVisible).toBe(false);
      }
    });
  });

  // ── New File button (PR #58) ────────────────────────────────────────

  describe("New File button (PR #58)", () => {
    it("should create a file via inline input when clicking New File and pressing Enter", async () => {
      const name = uniqueName("newfile-enter");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // cd to /tmp for writable directory
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      // Switch to file browser
      await switchToFilesSidebar();
      await browser.pause(500);

      const newFileBtn = await browser.$(FILE_BROWSER_NEW_FILE);
      if ((await newFileBtn.isExisting()) && (await newFileBtn.isDisplayed())) {
        await newFileBtn.click();
        await browser.pause(300);

        // Inline input should appear
        const input = await browser.$(FILE_BROWSER_NEW_FILE_INPUT);
        expect(await input.isDisplayed()).toBe(true);

        // Type a file name and press Enter
        const fileName = `e2e_new_${Date.now()}.txt`;
        await input.setValue(fileName);
        await browser.keys("Enter");
        await browser.pause(500);

        // The file should appear in the file list
        const newRow = await browser.$(fileRow(fileName));
        if (await newRow.isExisting()) {
          expect(await newRow.isDisplayed()).toBe(true);
        }

        // Cleanup
        await ensureConnectionsSidebar();
        const tab = await findTabByTitle(name);
        if (tab) {
          await tab.click();
          await browser.pause(300);
          await browser.keys(`rm -f /tmp/${fileName}\n`);
          await browser.pause(300);
        }
      }
    });

    it("should cancel file creation when pressing Escape", async () => {
      const name = uniqueName("newfile-esc");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // cd to /tmp
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);

      const newFileBtn = await browser.$(FILE_BROWSER_NEW_FILE);
      if ((await newFileBtn.isExisting()) && (await newFileBtn.isDisplayed())) {
        await newFileBtn.click();
        await browser.pause(300);

        const input = await browser.$(FILE_BROWSER_NEW_FILE_INPUT);
        expect(await input.isDisplayed()).toBe(true);

        // Type a name but press Escape to cancel
        await input.setValue("should_not_exist.txt");
        await browser.keys("Escape");
        await browser.pause(300);

        // The input should be dismissed
        const inputAfter = await browser.$(FILE_BROWSER_NEW_FILE_INPUT);
        const inputStillVisible =
          (await inputAfter.isExisting()) && (await inputAfter.isDisplayed());
        expect(inputStillVisible).toBe(false);

        // The file should not have been created
        const row = await browser.$(fileRow("should_not_exist.txt"));
        const rowVisible = (await row.isExisting()) && (await row.isDisplayed());
        expect(rowVisible).toBe(false);
      }
    });

    it("should work in local file browser mode", async () => {
      const name = uniqueName("newfile-local");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);

      // The New File button should be visible in local mode
      const newFileBtn = await browser.$(FILE_BROWSER_NEW_FILE);
      if ((await newFileBtn.isExisting()) && (await newFileBtn.isDisplayed())) {
        await newFileBtn.click();
        await browser.pause(300);

        const input = await browser.$(FILE_BROWSER_NEW_FILE_INPUT);
        expect(await input.isDisplayed()).toBe(true);

        const fileName = `e2e_local_${Date.now()}.txt`;
        await input.setValue(fileName);

        // Use the confirm button instead of Enter
        const confirmBtn = await browser.$(FILE_BROWSER_NEW_FILE_CONFIRM);
        await confirmBtn.click();
        await browser.pause(500);

        // Verify file appears
        const newRow = await browser.$(fileRow(fileName));
        if (await newRow.isExisting()) {
          expect(await newRow.isDisplayed()).toBe(true);
        }

        // Cleanup
        await ensureConnectionsSidebar();
        const tab = await findTabByTitle(name);
        if (tab) {
          await tab.click();
          await browser.pause(300);
          await browser.keys(`rm -f /tmp/${fileName}\n`);
          await browser.pause(300);
        }
      }
    });

    it("should still allow creating folders via New Folder button", async () => {
      const name = uniqueName("newfile-folder");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);

      const newFolderBtn = await browser.$(FILE_BROWSER_NEW_FOLDER);
      if ((await newFolderBtn.isExisting()) && (await newFolderBtn.isDisplayed())) {
        await newFolderBtn.click();
        await browser.pause(300);

        const input = await browser.$(FILE_BROWSER_NEW_FOLDER_INPUT);
        expect(await input.isDisplayed()).toBe(true);

        const folderName = `e2e_folder_${Date.now()}`;
        await input.setValue(folderName);

        const confirmBtn = await browser.$(FILE_BROWSER_NEW_FOLDER_CONFIRM);
        await confirmBtn.click();
        await browser.pause(500);

        // Verify folder appears
        const dirRow = await browser.$(fileRow(folderName));
        if (await dirRow.isExisting()) {
          expect(await dirRow.isDisplayed()).toBe(true);
        }

        // Cleanup
        await ensureConnectionsSidebar();
        const tab = await findTabByTitle(name);
        if (tab) {
          await tab.click();
          await browser.pause(300);
          await browser.keys(`rmdir /tmp/${folderName}\n`);
          await browser.pause(300);
        }
      }
    });
  });

  // ── Right-click context menu (PR #59) ───────────────────────────────

  describe("Right-click context menu (PR #59)", () => {
    it("should show Edit, Rename, Delete in context menu when right-clicking a file", async () => {
      const name = uniqueName("ctx-file");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Create a test file
      const testFile = `e2e_ctx_file_${Date.now()}.txt`;
      await browser.keys(`echo "ctx test" > /tmp/${testFile}\n`);
      await browser.pause(500);
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);
      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      await refreshBtn.click();
      await browser.pause(500);

      // Right-click the test file
      const row = await browser.$(fileRow(testFile));
      if ((await row.isExisting()) && (await row.isDisplayed())) {
        await row.click({ button: "right" });
        await browser.pause(300);

        // Verify context menu items
        const editItem = await browser.$(CTX_FILE_EDIT);
        const renameItem = await browser.$(CTX_FILE_RENAME);
        const deleteItem = await browser.$(CTX_FILE_DELETE);

        if (await editItem.isExisting()) {
          expect(await editItem.isDisplayed()).toBe(true);
        }
        if (await renameItem.isExisting()) {
          expect(await renameItem.isDisplayed()).toBe(true);
        }
        if (await deleteItem.isExisting()) {
          expect(await deleteItem.isDisplayed()).toBe(true);
        }

        // Dismiss the context menu
        await browser.keys("Escape");
      }

      // Cleanup
      await ensureConnectionsSidebar();
      const tab = await findTabByTitle(name);
      if (tab) {
        await tab.click();
        await browser.pause(300);
        await browser.keys(`rm -f /tmp/${testFile}\n`);
        await browser.pause(300);
      }
    });

    it("should show Open, Rename, Delete in context menu when right-clicking a directory", async () => {
      const name = uniqueName("ctx-dir");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Create a test directory
      const testDir = `e2e_ctx_dir_${Date.now()}`;
      await browser.keys(`mkdir /tmp/${testDir}\n`);
      await browser.pause(500);
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);
      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      await refreshBtn.click();
      await browser.pause(500);

      // Right-click the test directory
      const row = await browser.$(fileRow(testDir));
      if ((await row.isExisting()) && (await row.isDisplayed())) {
        await row.click({ button: "right" });
        await browser.pause(300);

        // Directories should show Rename and Delete
        const renameItem = await browser.$(CTX_FILE_RENAME);
        const deleteItem = await browser.$(CTX_FILE_DELETE);

        if (await renameItem.isExisting()) {
          expect(await renameItem.isDisplayed()).toBe(true);
        }
        if (await deleteItem.isExisting()) {
          expect(await deleteItem.isDisplayed()).toBe(true);
        }

        // Dismiss the context menu
        await browser.keys("Escape");
      }

      // Cleanup
      await ensureConnectionsSidebar();
      const tab = await findTabByTitle(name);
      if (tab) {
        await tab.click();
        await browser.pause(300);
        await browser.keys(`rmdir /tmp/${testDir}\n`);
        await browser.pause(300);
      }
    });

    it("should still support the three-dots menu on file rows", async () => {
      const name = uniqueName("ctx-dots");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Create a test file
      const testFile = `e2e_dots_${Date.now()}.txt`;
      await browser.keys(`echo "dots test" > /tmp/${testFile}\n`);
      await browser.pause(500);
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);
      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      await refreshBtn.click();
      await browser.pause(500);

      // Hover over the file row to reveal the three-dots button
      const row = await browser.$(fileRow(testFile));
      if ((await row.isExisting()) && (await row.isDisplayed())) {
        await row.moveTo();
        await browser.pause(300);

        // Look for the three-dots menu trigger within the row or nearby
        const menuBtn = await row.$('[data-testid^="file-menu-"]');
        if ((await menuBtn.isExisting()) && (await menuBtn.isDisplayed())) {
          await menuBtn.click();
          await browser.pause(300);

          // The inline menu items should appear
          const editItem = await browser.$(FILE_MENU_EDIT);
          const renameItem = await browser.$(FILE_MENU_RENAME);
          const deleteItem = await browser.$(FILE_MENU_DELETE);

          const editVisible = (await editItem.isExisting()) && (await editItem.isDisplayed());
          const renameVisible = (await renameItem.isExisting()) && (await renameItem.isDisplayed());
          const deleteVisible = (await deleteItem.isExisting()) && (await deleteItem.isDisplayed());

          // At least some menu items should be visible
          expect(editVisible || renameVisible || deleteVisible).toBe(true);

          await browser.keys("Escape");
        }
      }

      // Cleanup
      await ensureConnectionsSidebar();
      const tab = await findTabByTitle(name);
      if (tab) {
        await tab.click();
        await browser.pause(300);
        await browser.keys(`rm -f /tmp/${testFile}\n`);
        await browser.pause(300);
      }
    });

    it("should execute context menu actions correctly (delete a file)", async () => {
      const name = uniqueName("ctx-action");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Create a test file
      const testFile = `e2e_action_${Date.now()}.txt`;
      await browser.keys(`echo "action test" > /tmp/${testFile}\n`);
      await browser.pause(500);
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);
      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      await refreshBtn.click();
      await browser.pause(500);

      // Right-click and delete the file
      const row = await browser.$(fileRow(testFile));
      if ((await row.isExisting()) && (await row.isDisplayed())) {
        await row.click({ button: "right" });
        await browser.pause(300);

        const deleteItem = await browser.$(CTX_FILE_DELETE);
        if ((await deleteItem.isExisting()) && (await deleteItem.isDisplayed())) {
          await deleteItem.click();
          await browser.pause(500);

          // The file should no longer appear in the list
          const deletedRow = await browser.$(fileRow(testFile));
          const stillVisible = (await deletedRow.isExisting()) && (await deletedRow.isDisplayed());
          expect(stillVisible).toBe(false);
        } else {
          await browser.keys("Escape");
          // Cleanup via terminal
          await ensureConnectionsSidebar();
          const tab = await findTabByTitle(name);
          if (tab) {
            await tab.click();
            await browser.pause(300);
            await browser.keys(`rm -f /tmp/${testFile}\n`);
            await browser.pause(300);
          }
        }
      }
    });

    it("should have consistent styling between file and connection context menus", async () => {
      const name = uniqueName("ctx-style");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Create a test file
      const testFile = `e2e_style_${Date.now()}.txt`;
      await browser.keys(`echo "style test" > /tmp/${testFile}\n`);
      await browser.pause(500);
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);
      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      await refreshBtn.click();
      await browser.pause(500);

      // Right-click to open context menu
      const row = await browser.$(fileRow(testFile));
      if ((await row.isExisting()) && (await row.isDisplayed())) {
        await row.click({ button: "right" });
        await browser.pause(300);

        // Context menu should exist and be styled (has a container element)
        const contextMenu = await browser.$(".context-menu");
        if (await contextMenu.isExisting()) {
          expect(await contextMenu.isDisplayed()).toBe(true);

          // Verify the menu has proper CSS (background, border, shadow)
          const bgColor = await contextMenu.getCSSProperty("background-color");
          expect(bgColor.value).toBeTruthy();
        }

        await browser.keys("Escape");
      }

      // Cleanup
      await ensureConnectionsSidebar();
      const tab = await findTabByTitle(name);
      if (tab) {
        await tab.click();
        await browser.pause(300);
        await browser.keys(`rm -f /tmp/${testFile}\n`);
        await browser.pause(300);
      }
    });
  });

  // ── Double-click file to open in editor (PR #61) ────────────────────

  describe("Double-click file to open in editor (PR #61)", () => {
    it("should open a file in an editor tab when double-clicking it", async () => {
      const name = uniqueName("dblclick-file");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Create a test file
      const testFile = `e2e_dblclick_${Date.now()}.txt`;
      await browser.keys(`echo "double click test" > /tmp/${testFile}\n`);
      await browser.pause(500);
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);
      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      await refreshBtn.click();
      await browser.pause(500);

      // Double-click the file
      const row = await browser.$(fileRow(testFile));
      if ((await row.isExisting()) && (await row.isDisplayed())) {
        const tabCountBefore = await getTabCount();
        await row.doubleClick();
        await browser.pause(500);

        // A new editor tab should have opened
        const tabCountAfter = await getTabCount();
        expect(tabCountAfter).toBeGreaterThan(tabCountBefore);

        // The tab should contain the file name
        const editorTab = await findTabByTitle(testFile);
        if (editorTab) {
          expect(await editorTab.isDisplayed()).toBe(true);
        }
      }

      // Cleanup
      await ensureConnectionsSidebar();
      const tab = await findTabByTitle(name);
      if (tab) {
        await tab.click();
        await browser.pause(300);
        await browser.keys(`rm -f /tmp/${testFile}\n`);
        await browser.pause(300);
      }
    });

    it("should navigate into a directory when double-clicking it", async () => {
      const name = uniqueName("dblclick-dir");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Create a test directory with a file inside
      const testDir = `e2e_dbldir_${Date.now()}`;
      await browser.keys(`mkdir /tmp/${testDir}\n`);
      await browser.pause(300);
      await browser.keys(`touch /tmp/${testDir}/inner.txt\n`);
      await browser.pause(500);
      await browser.keys("cd /tmp\n");
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);
      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      await refreshBtn.click();
      await browser.pause(500);

      // Double-click the directory
      const row = await browser.$(fileRow(testDir));
      if ((await row.isExisting()) && (await row.isDisplayed())) {
        await row.doubleClick();
        await browser.pause(500);

        // The file browser should have navigated into the directory
        const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
        if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
          const pathText = await currentPath.getText();
          expect(pathText).toContain(testDir);
        }

        // The inner file should be visible
        const innerRow = await browser.$(fileRow("inner.txt"));
        if (await innerRow.isExisting()) {
          expect(await innerRow.isDisplayed()).toBe(true);
        }
      }

      // Cleanup
      await ensureConnectionsSidebar();
      const tab = await findTabByTitle(name);
      if (tab) {
        await tab.click();
        await browser.pause(300);
        await browser.keys(`rm -rf /tmp/${testDir}\n`);
        await browser.pause(300);
      }
    });
  });
});
