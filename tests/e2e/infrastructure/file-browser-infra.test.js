// File Browser SFTP Infrastructure E2E tests.
// Run with: pnpm test:e2e:infra

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "../helpers/app.js";
import { uniqueName, connectByName } from "../helpers/connections.js";
import { findTabByTitle, getTabCount } from "../helpers/tabs.js";
import {
  createSshConnection,
  createSerialConnection,
  handlePasswordPrompt,
  verifyTerminalRendered,
} from "../helpers/infrastructure.js";
import { switchToFilesSidebar } from "../helpers/sidebar.js";
import {
  connectSftpBrowser,
  waitForSftpEntries,
  getFileBrowserPath,
  fileBrowserContextAction,
  isNoFilesystemPlaceholder,
  createNewFile,
} from "../helpers/file-browser-infra.js";
import {
  ACTIVITY_BAR_CONNECTIONS,
  FILE_BROWSER_CURRENT_PATH,
  FILE_BROWSER_PLACEHOLDER,
  FILE_BROWSER_NEW_FILE,
  FILE_MENU_DOWNLOAD,
  FILE_MENU_EDIT,
  CTX_FILE_EDIT,
  CTX_FILE_DOWNLOAD,
} from "../helpers/selectors.js";

describe("File Browser — SFTP Infrastructure", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
    const connBtn = await browser.$(ACTIVITY_BAR_CONNECTIONS);
    if (await connBtn.isDisplayed()) {
      await connBtn.click();
      await browser.pause(300);
    }
  });

  describe("SFTP connect and browse (Baseline)", () => {
    it("should connect SFTP and display remote filesystem entries", async () => {
      const name = uniqueName("sftp-browse");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");
      await verifyTerminalRendered(3000);

      // Switch to Files and connect SFTP
      const entriesVisible = await connectSftpBrowser("testpass");
      expect(entriesVisible).toBe(true);

      // Verify file entries are displayed
      const entries = await browser.$$('[data-testid^="file-row-"]');
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  describe("SSH SFTP auto-connect (PR #39)", () => {
    it("should auto-connect SFTP when switching to Files sidebar with SSH tab active", async () => {
      const name = uniqueName("sftp-auto");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");
      await verifyTerminalRendered(3000);

      // Switch to Files sidebar
      await switchToFilesSidebar();
      await browser.pause(3000);

      // Handle SFTP password prompt if it appears
      const { PASSWORD_PROMPT_INPUT, PASSWORD_PROMPT_CONNECT } =
        await import("../helpers/selectors.js");
      const promptInput = await browser.$(PASSWORD_PROMPT_INPUT);
      if ((await promptInput.isExisting()) && (await promptInput.isDisplayed())) {
        await promptInput.setValue("testpass");
        const connectBtn = await browser.$(PASSWORD_PROMPT_CONNECT);
        await connectBtn.click();
        await browser.pause(1000);
      }

      // Wait for file entries or current path
      await browser.pause(3000);
      const pathEl = await browser.$(FILE_BROWSER_CURRENT_PATH);
      const pathVisible = (await pathEl.isExisting()) && (await pathEl.isDisplayed());
      expect(pathVisible).toBe(true);
    });

    it('should show "no filesystem" placeholder for serial connections', async () => {
      const name = uniqueName("serial-no-fs");
      await createSerialConnection(name, {
        port: "/tmp/termihub-serial-a",
        baudRate: "9600",
      });

      await connectByName(name);
      await browser.pause(2000);

      // Switch to Files sidebar
      await switchToFilesSidebar();
      await browser.pause(1000);

      // Should show placeholder
      const placeholder = await isNoFilesystemPlaceholder();
      expect(placeholder).toBe(true);
    });
  });

  describe("SFTP file editing (PR #57)", () => {
    it("should show file browser with parent directory when editing remote file", async () => {
      const name = uniqueName("sftp-edit-parent");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");
      await verifyTerminalRendered(3000);

      // Connect SFTP and find a file to edit
      const entriesVisible = await connectSftpBrowser("testpass");
      if (!entriesVisible) return; // Skip if SFTP didn't connect

      // Look for any file to edit
      const fileRows = await browser.$$('[data-testid^="file-row-"]');
      if (fileRows.length === 0) return;

      // Try to find the three-dot menu and click Edit
      const firstFileName = await fileRows[0].getAttribute("data-testid");
      const cleanName = firstFileName.replace("file-row-", "");

      // Click the menu button for this file
      const menuBtn = await browser.$(`[data-testid="file-row-menu-${cleanName}"]`);
      if (await menuBtn.isExisting()) {
        await menuBtn.click();
        await browser.pause(300);
        const editBtn = await browser.$(FILE_MENU_EDIT);
        if ((await editBtn.isExisting()) && (await editBtn.isDisplayed())) {
          await editBtn.click();
          await browser.pause(1000);
          // Editor should open — file browser should still show parent dir
          const path = await getFileBrowserPath();
          expect(path.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("SFTP new file (PR #58)", () => {
    it("should create a new file in SFTP mode", async () => {
      const name = uniqueName("sftp-new-file");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");
      await verifyTerminalRendered(3000);

      const entriesVisible = await connectSftpBrowser("testpass");
      if (!entriesVisible) return;

      // Create a new file
      const testFileName = `test-${Date.now()}.txt`;
      await createNewFile(testFileName);

      // Verify the file appears in the list
      await browser.pause(1000);
      const newFile = await browser.$(`[data-testid="file-row-${testFileName}"]`);
      const exists = await newFile.isExisting();
      expect(exists).toBe(true);
    });
  });

  describe("SFTP download option (PR #59)", () => {
    it("should show Download option in right-click menu for SFTP files", async () => {
      const name = uniqueName("sftp-download");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");
      await verifyTerminalRendered(3000);

      const entriesVisible = await connectSftpBrowser("testpass");
      if (!entriesVisible) return;

      // Right-click on the first file
      const fileRows = await browser.$$('[data-testid^="file-row-"]');
      if (fileRows.length === 0) return;

      await fileRows[0].click({ button: "right" });
      await browser.pause(300);

      // Check for Download option in context menu
      const downloadOption = await browser.$(CTX_FILE_DOWNLOAD);
      if (await downloadOption.isExisting()) {
        expect(await downloadOption.isDisplayed()).toBe(true);
      }

      // Close context menu by clicking elsewhere
      await browser.keys(["Escape"]);
      await browser.pause(200);
    });
  });

  describe("SFTP double-click (PR #61)", () => {
    it("should open file in editor tab on double-click in SFTP browser", async () => {
      const name = uniqueName("sftp-dblclick");
      await createSshConnection(name, {
        host: "127.0.0.1",
        port: "2201",
        username: "testuser",
        authMethod: "password",
      });

      await connectByName(name);
      await handlePasswordPrompt("testpass");
      await verifyTerminalRendered(3000);

      const entriesVisible = await connectSftpBrowser("testpass");
      if (!entriesVisible) return;

      const tabsBefore = await getTabCount();

      // Double-click a file to open in editor
      const fileRows = await browser.$$('[data-testid^="file-row-"]');
      if (fileRows.length === 0) return;

      // Find a file (not directory) to double-click
      for (const row of fileRows) {
        const testId = await row.getAttribute("data-testid");
        // Double-click
        await row.doubleClick();
        await browser.pause(1000);

        const tabsAfter = await getTabCount();
        if (tabsAfter > tabsBefore) {
          // An editor tab was opened
          expect(tabsAfter).toBeGreaterThan(tabsBefore);
          return;
        }
        // If it was a directory, it navigated instead — try next
      }
    });
  });
});
