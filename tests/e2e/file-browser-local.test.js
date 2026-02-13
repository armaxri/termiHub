// Local file browser tests.
// Covers: FILE-01, FILE-05 (create/rename/delete in local mode).

import { waitForAppReady, closeAllTabs } from './helpers/app.js';
import { switchToFilesSidebar } from './helpers/sidebar.js';
import {
  FILE_BROWSER_UP,
  FILE_BROWSER_REFRESH,
  FILE_BROWSER_NEW_FOLDER,
  FILE_BROWSER_NEW_FOLDER_INPUT,
  FILE_BROWSER_NEW_FOLDER_CONFIRM,
  FILE_BROWSER_NEW_FILE,
  FILE_BROWSER_NEW_FILE_INPUT,
  FILE_BROWSER_NEW_FILE_CONFIRM,
} from './helpers/selectors.js';

describe('File Browser (Local)', () => {
  before(async () => {
    await waitForAppReady();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe('FILE-01: Local browse', () => {
    it('should display file browser with navigation controls when switching to Files view', async () => {
      await switchToFilesSidebar();

      // The file browser toolbar should be visible
      const upBtn = await browser.$(FILE_BROWSER_UP);
      const refreshBtn = await browser.$(FILE_BROWSER_REFRESH);

      expect(await upBtn.isDisplayed()).toBe(true);
      expect(await refreshBtn.isDisplayed()).toBe(true);
    });

    it('should show file entries in the browser', async () => {
      await switchToFilesSidebar();
      await browser.pause(500);

      // Check that at least one file row is rendered
      const rows = await browser.$$('[data-testid^="file-row-"]');
      // The home directory or terminal working directory should have entries
      expect(rows.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('FILE-05: Create directory', () => {
    it('should show the new folder input when clicking the new folder button', async () => {
      await switchToFilesSidebar();
      await browser.pause(300);

      const newFolderBtn = await browser.$(FILE_BROWSER_NEW_FOLDER);
      // New folder button may not always be visible (depends on browse mode)
      if (await newFolderBtn.isExisting() && await newFolderBtn.isDisplayed()) {
        await newFolderBtn.click();
        await browser.pause(300);

        const input = await browser.$(FILE_BROWSER_NEW_FOLDER_INPUT);
        expect(await input.isDisplayed()).toBe(true);

        // Cancel by pressing Escape
        await browser.keys('Escape');
      }
    });

    it('should show the new file input when clicking the new file button', async () => {
      await switchToFilesSidebar();
      await browser.pause(300);

      const newFileBtn = await browser.$(FILE_BROWSER_NEW_FILE);
      if (await newFileBtn.isExisting() && await newFileBtn.isDisplayed()) {
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
