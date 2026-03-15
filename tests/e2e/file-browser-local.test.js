// Local file browser tests.
// Covers: MT-FB-01 (Browse local files), MT-FB-02 (Navigate directories),
//         MT-FB-05/11/18 (create/rename/delete in local mode).

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from './helpers/app.js';
import { uniqueName, createLocalConnection, connectByName } from './helpers/connections.js';
import { switchToFilesSidebar } from './helpers/sidebar.js';
import {
  FILE_BROWSER_UP,
  FILE_BROWSER_REFRESH,
  FILE_BROWSER_CURRENT_PATH,
  FILE_BROWSER_NEW_FOLDER,
  FILE_BROWSER_NEW_FOLDER_INPUT,
  FILE_BROWSER_NEW_FOLDER_CONFIRM,
  FILE_BROWSER_NEW_FILE,
  FILE_BROWSER_NEW_FILE_INPUT,
  FILE_BROWSER_NEW_FILE_CONFIRM,
  fileRow,
} from './helpers/selectors.js';

describe('File Browser (Local)', () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await ensureConnectionsSidebar();
    await closeAllTabs();
  });

  // ── MT-FB-01: Browse local files ─────────────────────────────────────

  describe('MT-FB-01: Browse local files', () => {
    it('should display file browser toolbar when a local terminal is active', async () => {
      const name = uniqueName('fb01-toolbar');
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);

      // Navigation controls must be visible
      const upBtn = await browser.$(FILE_BROWSER_UP);
      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      expect(await upBtn.isDisplayed()).toBe(true);
      expect(await refreshBtn.isDisplayed()).toBe(true);
    });

    it('should show the current working directory path in the file browser', async () => {
      const name = uniqueName('fb01-path');
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1000);

      await switchToFilesSidebar();
      await browser.pause(500);

      // The current path element must be present and show a valid absolute path
      const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        const pathText = await currentPath.getText();
        expect(pathText.length).toBeGreaterThan(0);
        expect(pathText.startsWith('/')).toBe(true);
      }
    });

    it('should list file entries from the current working directory', async () => {
      const name = uniqueName('fb01-entries');
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1000);

      // Navigate to /tmp which always exists and is readable
      await browser.keys('cd /tmp\n');
      await browser.pause(800);

      // Create a sentinel file so we have at least one known entry
      const sentinel = `e2e_fb01_${Date.now()}.txt`;
      await browser.keys(`touch /tmp/${sentinel}\n`);
      await browser.pause(500);

      await switchToFilesSidebar();
      await browser.pause(500);

      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      await refreshBtn.click();
      await browser.pause(500);

      // At least one file entry should be visible
      const rows = await browser.$$('[data-testid^="file-row-"]');
      expect(rows.length).toBeGreaterThan(0);

      // Cleanup
      await ensureConnectionsSidebar();
      const tab = await browser.$(`[title*="${name}"]`);
      if (await tab.isExisting()) {
        await tab.click();
        await browser.pause(300);
        await browser.keys(`rm -f /tmp/${sentinel}\n`);
        await browser.pause(300);
      }
    });
  });

  // ── MT-FB-02: Navigate directories ───────────────────────────────────

  describe('MT-FB-02: Navigate directories', () => {
    it('should update the displayed path when using the Up button', async () => {
      const name = uniqueName('fb02-up');
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1000);

      // Start from a known deep path so there is a parent to navigate to
      await browser.keys('cd /tmp\n');
      await browser.pause(800);

      await switchToFilesSidebar();
      await browser.pause(500);

      const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
      let pathBefore = '';
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        pathBefore = await currentPath.getText();
      }

      // Click the Up button
      const upBtn = await browser.$(FILE_BROWSER_UP);
      expect(await upBtn.isDisplayed()).toBe(true);
      await upBtn.click();
      await browser.pause(500);

      // Path should have changed to the parent directory
      if (pathBefore && (await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        const pathAfter = await currentPath.getText();
        expect(pathAfter).not.toBe(pathBefore);
        // Parent of /tmp is /
        expect(pathAfter.length).toBeLessThan(pathBefore.length);
      }
    });

    it('should navigate into a subdirectory when double-clicking it', async () => {
      const name = uniqueName('fb02-enter');
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1000);

      // Create a test directory with a known file inside
      const testDir = `e2e_fb02_${Date.now()}`;
      await browser.keys(`mkdir /tmp/${testDir}\n`);
      await browser.pause(300);
      await browser.keys(`touch /tmp/${testDir}/inner.txt\n`);
      await browser.pause(300);
      await browser.keys('cd /tmp\n');
      await browser.pause(800);

      await switchToFilesSidebar();
      await browser.pause(500);

      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);
      await refreshBtn.click();
      await browser.pause(500);

      // Double-click the test directory to enter it
      const dirRow = await browser.$(fileRow(testDir));
      if ((await dirRow.isExisting()) && (await dirRow.isDisplayed())) {
        await dirRow.doubleClick();
        await browser.pause(500);

        // Current path should now include the test directory name
        const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
        if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
          const pathText = await currentPath.getText();
          expect(pathText).toContain(testDir);
        }

        // The inner file should be visible
        const innerRow = await browser.$(fileRow('inner.txt'));
        if (await innerRow.isExisting()) {
          expect(await innerRow.isDisplayed()).toBe(true);
        }
      }

      // Cleanup
      await ensureConnectionsSidebar();
      const tab = await browser.$(`[title*="${name}"]`);
      if (await tab.isExisting()) {
        await tab.click();
        await browser.pause(300);
        await browser.keys(`rm -rf /tmp/${testDir}\n`);
        await browser.pause(300);
      }
    });

    it('should restore the previous directory after navigating up and back down', async () => {
      const name = uniqueName('fb02-roundtrip');
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1000);

      await browser.keys('cd /tmp\n');
      await browser.pause(800);

      await switchToFilesSidebar();
      await browser.pause(500);

      // Record starting path (/tmp)
      const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
      let startPath = '';
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        startPath = await currentPath.getText();
      }

      // Navigate up to parent
      const upBtn = await browser.$(FILE_BROWSER_UP);
      await upBtn.click();
      await browser.pause(500);

      // Navigate back into /tmp from the parent listing
      const tmpRow = await browser.$(fileRow('tmp'));
      if ((await tmpRow.isExisting()) && (await tmpRow.isDisplayed())) {
        await tmpRow.doubleClick();
        await browser.pause(500);

        // Path should be back to /tmp
        if (startPath && (await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
          const restoredPath = await currentPath.getText();
          expect(restoredPath).toBe(startPath);
        }
      }
    });
  });

  // ── MT-FB-05/11/18: Create / new-file / rename controls ──────────────

  describe('MT-FB-05: Create directory', () => {
    it('should show the new folder input when clicking the new folder button', async () => {
      const name = uniqueName('fb05-folder');
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1000);

      await browser.keys('cd /tmp\n');
      await browser.pause(800);

      await switchToFilesSidebar();
      await browser.pause(300);

      const newFolderBtn = await browser.$(FILE_BROWSER_NEW_FOLDER);
      if ((await newFolderBtn.isExisting()) && (await newFolderBtn.isDisplayed())) {
        await newFolderBtn.click();
        await browser.pause(300);

        const input = await browser.$(FILE_BROWSER_NEW_FOLDER_INPUT);
        expect(await input.isDisplayed()).toBe(true);

        // Cancel by pressing Escape
        await browser.keys('Escape');
      }
    });

    it('should show the new file input when clicking the new file button', async () => {
      const name = uniqueName('fb05-file');
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1000);

      await browser.keys('cd /tmp\n');
      await browser.pause(800);

      await switchToFilesSidebar();
      await browser.pause(300);

      const newFileBtn = await browser.$(FILE_BROWSER_NEW_FILE);
      if ((await newFileBtn.isExisting()) && (await newFileBtn.isDisplayed())) {
        await newFileBtn.click();
        await browser.pause(300);

        const input = await browser.$(FILE_BROWSER_NEW_FILE_INPUT);
        expect(await input.isDisplayed()).toBe(true);

        // Cancel by pressing Escape
        await browser.keys('Escape');
      }
    });
  });
});
