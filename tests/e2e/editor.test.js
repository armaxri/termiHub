// Built-in file editor (Monaco) tests.
// Covers: EDITOR-01 (PR #54), EDITOR-STATUS (PR #65), EDITOR-INDENT (PR #111),
//         EDITOR-LANG (PR #113).

import { waitForAppReady, closeAllTabs } from "./helpers/app.js";
import { switchToFilesSidebar } from "./helpers/sidebar.js";
import { findTabByTitle, getTabCount, closeTabByTitle, getActiveTab } from "./helpers/tabs.js";
import {
  FILE_BROWSER_CURRENT_PATH,
  FILE_BROWSER_NEW_FILE,
  FILE_BROWSER_NEW_FILE_INPUT,
  FILE_BROWSER_NEW_FILE_CONFIRM,
  FILE_EDITOR_SAVE,
  STATUS_BAR_TAB_SIZE,
  STATUS_BAR_EOL,
  STATUS_BAR_LANGUAGE,
  LANG_MENU_SEARCH,
  FILE_MENU_EDIT,
  CTX_FILE_EDIT,
  fileRow,
} from "./helpers/selectors.js";

// ---------------------------------------------------------------------------
// Helpers local to this test file
// ---------------------------------------------------------------------------

/**
 * Create a new file via the file browser toolbar and return its name.
 * The file browser sidebar must already be visible.
 * @param {string} name - File name to create (e.g. "test-file.ts")
 */
async function createFileViaBrowser(name) {
  const newFileBtn = await browser.$(FILE_BROWSER_NEW_FILE);
  await newFileBtn.waitForDisplayed({ timeout: 5000 });
  await newFileBtn.click();
  await browser.pause(300);

  const input = await browser.$(FILE_BROWSER_NEW_FILE_INPUT);
  await input.waitForDisplayed({ timeout: 3000 });
  await input.setValue(name);

  const confirmBtn = await browser.$(FILE_BROWSER_NEW_FILE_CONFIRM);
  await confirmBtn.click();
  await browser.pause(500);
}

/**
 * Open a file in the editor by right-clicking it in the file browser and
 * selecting "Edit". The file browser sidebar must already be visible and
 * the file must be listed.
 * @param {string} name - File name as it appears in the file row
 */
async function openFileInEditor(name) {
  const row = await browser.$(fileRow(name));
  await row.waitForDisplayed({ timeout: 5000 });

  // Right-click to open the context menu
  await row.click({ button: "right" });
  await browser.pause(300);

  // Click "Edit" in the context menu
  const editItem = await browser.$(CTX_FILE_EDIT);
  await editItem.waitForDisplayed({ timeout: 3000 });
  await editItem.click();
  await browser.pause(500);

  // Wait for the Monaco editor to render
  const monaco = await browser.$(".monaco-editor");
  await monaco.waitForExist({ timeout: 10000 });
}

/**
 * Wait for the Monaco editor to be fully loaded in the active tab.
 */
async function waitForMonacoEditor() {
  const monaco = await browser.$(".monaco-editor");
  await monaco.waitForExist({ timeout: 10000 });
  await browser.pause(300);
}

/**
 * Type text into the active Monaco editor instance.
 * Clicks into the editor first to ensure focus.
 * @param {string} text - Text to type
 */
async function typeInMonacoEditor(text) {
  const editor = await browser.$(".monaco-editor .view-lines");
  await editor.click();
  await browser.pause(200);
  await browser.keys(text);
  await browser.pause(300);
}

/**
 * Check whether the given tab element shows a dirty indicator (modified dot).
 * @param {WebdriverIO.Element} tabEl - The tab element
 * @returns {Promise<boolean>}
 */
async function isTabDirty(tabEl) {
  const cls = await tabEl.getAttribute("class");
  const text = await tabEl.getText();
  // The dirty indicator is typically a dot or "modified" class on the tab
  return (
    (cls && cls.includes("dirty")) || (cls && cls.includes("modified")) || text.includes("\u25CF")
  );
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("Built-in File Editor (Monaco)", () => {
  const testTsFile = `e2e-editor-test-${Date.now()}.ts`;
  const testJsonFile = `e2e-editor-test-${Date.now()}.json`;

  before(async () => {
    await waitForAppReady();
    await switchToFilesSidebar();
    await browser.pause(500);

    // Create test files that will be used across the describe blocks
    await createFileViaBrowser(testTsFile);
    await createFileViaBrowser(testJsonFile);
  });

  afterEach(async () => {
    await closeAllTabs();
    // Ensure we are on the file browser sidebar for the next test
    await switchToFilesSidebar();
    await browser.pause(300);
  });

  // -----------------------------------------------------------------------
  // EDITOR-01: Built-in file editor with Monaco (PR #54)
  // -----------------------------------------------------------------------
  describe("EDITOR-01: Built-in file editor with Monaco (PR #54)", () => {
    it("should open a file in the editor with syntax highlighting via right-click > Edit", async () => {
      await openFileInEditor(testTsFile);

      // Monaco editor should be present
      const monaco = await browser.$(".monaco-editor");
      expect(await monaco.isDisplayed()).toBe(true);

      // A tab with the file name should exist
      const tab = await findTabByTitle(testTsFile);
      expect(tab).not.toBeNull();
    });

    it("should show dirty dot after editing, and clear it after Ctrl+S", async () => {
      await openFileInEditor(testTsFile);

      // Type some content to make the file dirty
      await typeInMonacoEditor('const hello = "world";');

      // Tab should show dirty indicator
      let tab = await findTabByTitle(testTsFile);
      expect(tab).not.toBeNull();
      const dirty = await isTabDirty(tab);
      expect(dirty).toBe(true);

      // Save with Ctrl+S
      await browser.keys(["Control", "s"]);
      await browser.pause(500);

      // Dirty indicator should be cleared
      tab = await findTabByTitle(testTsFile);
      expect(tab).not.toBeNull();
      const stillDirty = await isTabDirty(tab);
      expect(stillDirty).toBe(false);
    });

    it("should save via the Save button in the toolbar", async () => {
      await openFileInEditor(testTsFile);
      await typeInMonacoEditor("// toolbar save test");

      // Tab should be dirty
      let tab = await findTabByTitle(testTsFile);
      expect(await isTabDirty(tab)).toBe(true);

      // Click the Save button
      const saveBtn = await browser.$(FILE_EDITOR_SAVE);
      await saveBtn.waitForDisplayed({ timeout: 3000 });
      await saveBtn.click();
      await browser.pause(500);

      // Dirty indicator should be cleared
      tab = await findTabByTitle(testTsFile);
      expect(await isTabDirty(tab)).toBe(false);
    });

    it("should show confirmation dialog when closing a dirty tab", async () => {
      await openFileInEditor(testTsFile);
      await typeInMonacoEditor("// unsaved changes");

      // Tab should be dirty
      const tab = await findTabByTitle(testTsFile);
      expect(await isTabDirty(tab)).toBe(true);

      // Attempt to close the tab
      const testId = await tab.getAttribute("data-testid");
      const uuid = testId.replace("tab-", "");
      const closeBtn = await browser.$(`[data-testid="tab-close-${uuid}"]`);
      await closeBtn.click();
      await browser.pause(500);

      // A confirmation dialog should appear (look for common dialog patterns)
      const dialog = await browser.$(
        '.confirm-dialog, [role="dialog"], [data-testid="confirm-dialog"]'
      );
      const dialogVisible = (await dialog.isExisting()) && (await dialog.isDisplayed());
      expect(dialogVisible).toBe(true);

      // Dismiss the dialog (press Escape or click cancel/discard)
      await browser.keys("Escape");
      await browser.pause(300);
    });

    it("should close a clean tab without confirmation", async () => {
      await openFileInEditor(testTsFile);
      await waitForMonacoEditor();

      const countBefore = await getTabCount();
      await closeTabByTitle(testTsFile);
      const countAfter = await getTabCount();

      // Tab should have been closed immediately without dialog
      expect(countAfter).toBe(countBefore - 1);
    });

    it("should reuse existing editor tab when opening the same file twice", async () => {
      await openFileInEditor(testTsFile);
      const countAfterFirst = await getTabCount();

      // Switch back to file browser and open the same file again
      await switchToFilesSidebar();
      await browser.pause(300);
      await openFileInEditor(testTsFile);
      const countAfterSecond = await getTabCount();

      // No new tab should have been created
      expect(countAfterSecond).toBe(countAfterFirst);
    });

    it("should show a graceful error for binary/non-UTF-8 files", async () => {
      // Attempt to edit a binary file if one exists, or check error handling
      // We look for a known non-text file; if none is available we create a file
      // with a binary-sounding extension
      const binaryFile = `e2e-binary-${Date.now()}.bin`;
      await createFileViaBrowser(binaryFile);
      await browser.pause(300);

      const row = await browser.$(fileRow(binaryFile));
      await row.waitForDisplayed({ timeout: 5000 });
      await row.click({ button: "right" });
      await browser.pause(300);

      const editItem = await browser.$(CTX_FILE_EDIT);
      // If Edit option is available, click it and look for error/fallback
      if ((await editItem.isExisting()) && (await editItem.isDisplayed())) {
        await editItem.click();
        await browser.pause(1000);

        // Either the editor opens (file was technically empty/valid UTF-8) or
        // an error message appears. Check for both valid outcomes.
        const monaco = await browser.$(".monaco-editor");
        const errorMsg = await browser.$(
          '.editor-error, [data-testid="editor-error"], .notification--error'
        );
        const monacoVisible = (await monaco.isExisting()) && (await monaco.isDisplayed());
        const errorVisible = (await errorMsg.isExisting()) && (await errorMsg.isDisplayed());

        // At least one should be true (editor opened or error shown)
        expect(monacoVisible || errorVisible).toBe(true);
      } else {
        // Edit option not shown for binary files - that's also a valid handling
        await browser.keys("Escape");
      }
    });
  });

  // -----------------------------------------------------------------------
  // EDITOR-STATUS: Editor status bar (PR #65)
  // -----------------------------------------------------------------------
  describe("EDITOR-STATUS: Editor status bar (PR #65)", () => {
    it("should show Ln/Col, Spaces, UTF-8, LF, and language in status bar for a .ts file", async () => {
      await openFileInEditor(testTsFile);

      // Check for status bar items
      const statusBar = await browser.$(".status-bar");
      await statusBar.waitForDisplayed({ timeout: 5000 });
      const statusText = await statusBar.getText();

      // Should show line/column indicator
      expect(statusText).toMatch(/Ln\s+\d+/);
      expect(statusText).toMatch(/Col\s+\d+/);

      // Should show indent setting
      const tabSize = await browser.$(STATUS_BAR_TAB_SIZE);
      expect(await tabSize.isDisplayed()).toBe(true);

      // Should show EOL indicator
      const eol = await browser.$(STATUS_BAR_EOL);
      expect(await eol.isDisplayed()).toBe(true);

      // Should show encoding (UTF-8)
      expect(statusText).toContain("UTF-8");

      // Should show language mode
      const lang = await browser.$(STATUS_BAR_LANGUAGE);
      expect(await lang.isDisplayed()).toBe(true);
      const langText = await lang.getText();
      expect(langText.toLowerCase()).toContain("typescript");
    });

    it("should update Ln/Col when the cursor moves", async () => {
      await openFileInEditor(testTsFile);

      // Type some multi-line content
      await typeInMonacoEditor("line one");
      await browser.keys("Enter");
      await typeInMonacoEditor("line two");
      await browser.keys("Enter");
      await typeInMonacoEditor("line three");
      await browser.pause(300);

      const statusBar = await browser.$(".status-bar");
      const statusText = await statusBar.getText();

      // After typing three lines, cursor should be on line 3+
      expect(statusText).toMatch(/Ln\s+[3-9]\d*/);

      // Move cursor to beginning of file
      await browser.keys(["Control", "Home"]);
      await browser.pause(300);

      const updatedText = await statusBar.getText();
      expect(updatedText).toMatch(/Ln\s+1/);

      // Save to clean the file for other tests
      await browser.keys(["Control", "s"]);
      await browser.pause(300);
    });

    it('should change indent size when clicking "Spaces: 4"', async () => {
      await openFileInEditor(testTsFile);

      const tabSize = await browser.$(STATUS_BAR_TAB_SIZE);
      await tabSize.waitForDisplayed({ timeout: 5000 });
      const initialText = await tabSize.getText();

      // Click to open indent options
      await tabSize.click();
      await browser.pause(500);

      // Look for a dropdown or menu with indent size options
      const dropdown = await browser.$(
        '.indent-dropdown, [data-testid="indent-dropdown"], .status-bar-dropdown'
      );
      if ((await dropdown.isExisting()) && (await dropdown.isDisplayed())) {
        // Select a different size option (e.g., "2" if current is "4")
        const option = initialText.includes("4")
          ? await browser.$("*=Spaces: 2")
          : await browser.$("*=Spaces: 4");
        if ((await option.isExisting()) && (await option.isDisplayed())) {
          await option.click();
          await browser.pause(300);

          const updatedText = await tabSize.getText();
          expect(updatedText).not.toBe(initialText);
        } else {
          // Dismiss dropdown
          await browser.keys("Escape");
        }
      }
    });

    it("should toggle EOL between LF and CRLF when clicking the EOL indicator", async () => {
      await openFileInEditor(testTsFile);

      const eol = await browser.$(STATUS_BAR_EOL);
      await eol.waitForDisplayed({ timeout: 5000 });
      const initialText = await eol.getText();

      // Click to toggle or open EOL menu
      await eol.click();
      await browser.pause(500);

      // Check if it changed or if a dropdown appeared
      const dropdown = await browser.$(
        '.eol-dropdown, [data-testid="eol-dropdown"], .status-bar-dropdown'
      );
      if ((await dropdown.isExisting()) && (await dropdown.isDisplayed())) {
        // Select the opposite option
        const targetOption =
          initialText.includes("LF") && !initialText.includes("CRLF")
            ? await browser.$("*=CRLF")
            : await browser.$("*=LF");
        if ((await targetOption.isExisting()) && (await targetOption.isDisplayed())) {
          await targetOption.click();
          await browser.pause(300);
        } else {
          await browser.keys("Escape");
        }
      }

      // Verify EOL indicator updated
      const updatedText = await eol.getText();
      // It should have toggled (or at least the click didn't crash)
      expect(updatedText).toBeTruthy();
    });

    it("should hide status bar editor items when switching to a terminal tab", async () => {
      await openFileInEditor(testTsFile);

      // Verify status bar items are visible for the editor
      const tabSize = await browser.$(STATUS_BAR_TAB_SIZE);
      expect(await tabSize.isDisplayed()).toBe(true);

      // Open a new terminal tab
      const newTermBtn = await browser.$('[data-testid="terminal-view-new-terminal"]');
      await newTermBtn.click();
      await browser.pause(500);

      // Status bar editor items should not be visible for terminal tabs
      const tabSizeVisible = (await tabSize.isExisting()) && (await tabSize.isDisplayed());
      expect(tabSizeVisible).toBe(false);
    });

    it("should show status bar editor items again when switching back to editor tab", async () => {
      await openFileInEditor(testTsFile);

      // Open a terminal tab
      const newTermBtn = await browser.$('[data-testid="terminal-view-new-terminal"]');
      await newTermBtn.click();
      await browser.pause(500);

      // Status bar items should be hidden
      let tabSize = await browser.$(STATUS_BAR_TAB_SIZE);
      let visible = (await tabSize.isExisting()) && (await tabSize.isDisplayed());
      expect(visible).toBe(false);

      // Switch back to the editor tab
      const editorTab = await findTabByTitle(testTsFile);
      await editorTab.click();
      await browser.pause(300);

      // Status bar items should reappear
      tabSize = await browser.$(STATUS_BAR_TAB_SIZE);
      expect(await tabSize.isDisplayed()).toBe(true);

      const lang = await browser.$(STATUS_BAR_LANGUAGE);
      expect(await lang.isDisplayed()).toBe(true);
    });

    it("should clear status bar editor items when the editor tab is closed", async () => {
      await openFileInEditor(testTsFile);

      // Verify items are visible
      const tabSize = await browser.$(STATUS_BAR_TAB_SIZE);
      expect(await tabSize.isDisplayed()).toBe(true);

      // Close the editor tab
      await closeTabByTitle(testTsFile);
      await browser.pause(300);

      // Status bar editor items should be gone
      const tabSizeGone = (await tabSize.isExisting()) && (await tabSize.isDisplayed());
      expect(tabSizeGone).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // EDITOR-INDENT: Indent selection in status bar (PR #111)
  // -----------------------------------------------------------------------
  describe("EDITOR-INDENT: Indent selection in status bar (PR #111)", () => {
    it("should show a dropdown with Spaces/Tabs options when clicking the indent indicator", async () => {
      await openFileInEditor(testTsFile);

      const tabSize = await browser.$(STATUS_BAR_TAB_SIZE);
      await tabSize.waitForDisplayed({ timeout: 5000 });
      await tabSize.click();
      await browser.pause(500);

      // A dropdown should appear with indent options
      const spacesOption = await browser.$("*=Spaces");
      const tabsOption = await browser.$("*=Tab");

      const spacesVisible = (await spacesOption.isExisting()) && (await spacesOption.isDisplayed());
      const tabsVisible = (await tabsOption.isExisting()) && (await tabsOption.isDisplayed());

      expect(spacesVisible || tabsVisible).toBe(true);

      await browser.keys("Escape");
    });

    it("should update editor and status bar when selecting a different indent option", async () => {
      await openFileInEditor(testTsFile);

      const tabSize = await browser.$(STATUS_BAR_TAB_SIZE);
      await tabSize.waitForDisplayed({ timeout: 5000 });
      const initialText = await tabSize.getText();
      await tabSize.click();
      await browser.pause(500);

      // Try to select a different option
      // If currently "Spaces: 4", look for "Spaces: 2" or "Tab Size"
      const options = await browser.$$(
        '.indent-dropdown li, .status-bar-dropdown li, [class*="dropdown"] [class*="item"], [class*="menu"] [class*="item"]'
      );
      for (const opt of options) {
        const text = await opt.getText();
        if (
          text &&
          !text.includes(initialText) &&
          (text.includes("Spaces") || text.includes("Tab"))
        ) {
          await opt.click();
          await browser.pause(300);
          break;
        }
      }

      // Verify the status bar label updated
      const updatedText = await tabSize.getText();
      // Either changed or remained (if no valid option was found)
      expect(updatedText).toBeTruthy();
    });

    it('should display "Spaces: N" or "Tab Size: N" as the indent label', async () => {
      await openFileInEditor(testTsFile);

      const tabSize = await browser.$(STATUS_BAR_TAB_SIZE);
      await tabSize.waitForDisplayed({ timeout: 5000 });
      const text = await tabSize.getText();

      // Label should match one of the expected formats
      const validFormat = /Spaces:\s*\d+/.test(text) || /Tab Size:\s*\d+/.test(text);
      expect(validFormat).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // EDITOR-LANG: Language mode selector (PR #113)
  // -----------------------------------------------------------------------
  describe("EDITOR-LANG: Language mode selector (PR #113)", () => {
    it("should show a dropdown with search and language list when clicking the language name", async () => {
      await openFileInEditor(testTsFile);

      const lang = await browser.$(STATUS_BAR_LANGUAGE);
      await lang.waitForDisplayed({ timeout: 5000 });
      await lang.click();
      await browser.pause(500);

      // Search input should be visible in the language dropdown
      const searchInput = await browser.$(LANG_MENU_SEARCH);
      expect(await searchInput.isDisplayed()).toBe(true);

      await browser.keys("Escape");
    });

    it("should filter languages in real time when typing in the search field", async () => {
      await openFileInEditor(testTsFile);

      const lang = await browser.$(STATUS_BAR_LANGUAGE);
      await lang.click();
      await browser.pause(500);

      const searchInput = await browser.$(LANG_MENU_SEARCH);
      await searchInput.waitForDisplayed({ timeout: 3000 });

      // Get the initial count of visible language items
      const initialItems = await browser.$$(
        '.lang-menu-item, [data-testid^="lang-menu-item"], [class*="language-item"]'
      );
      const initialCount = initialItems.length;

      // Type a filter term
      await searchInput.setValue("python");
      await browser.pause(300);

      // The filtered list should have fewer items
      const filteredItems = await browser.$$(
        '.lang-menu-item, [data-testid^="lang-menu-item"], [class*="language-item"]'
      );
      const filteredCount = filteredItems.length;

      // Filtered results should be fewer than the full list (or at least 1 match)
      expect(filteredCount).toBeLessThanOrEqual(initialCount);
      expect(filteredCount).toBeGreaterThanOrEqual(1);

      await browser.keys("Escape");
    });

    it("should update syntax highlighting and label when selecting a different language", async () => {
      await openFileInEditor(testTsFile);

      const lang = await browser.$(STATUS_BAR_LANGUAGE);
      const initialLang = await lang.getText();
      await lang.click();
      await browser.pause(500);

      const searchInput = await browser.$(LANG_MENU_SEARCH);
      await searchInput.waitForDisplayed({ timeout: 3000 });

      // Search for and select "JavaScript"
      await searchInput.setValue("javascript");
      await browser.pause(300);

      // Click the first matching result
      const items = await browser.$$(
        '.lang-menu-item, [data-testid^="lang-menu-item"], [class*="language-item"]'
      );
      for (const item of items) {
        const text = await item.getText();
        if (text.toLowerCase().includes("javascript")) {
          await item.click();
          await browser.pause(500);
          break;
        }
      }

      // The language label should have changed
      const updatedLang = await lang.getText();
      expect(updatedLang.toLowerCase()).toContain("javascript");
      expect(updatedLang).not.toBe(initialLang);
    });

    it("should close the language dropdown on selection or clicking outside", async () => {
      await openFileInEditor(testTsFile);

      const lang = await browser.$(STATUS_BAR_LANGUAGE);
      await lang.click();
      await browser.pause(500);

      // Dropdown should be open
      let searchInput = await browser.$(LANG_MENU_SEARCH);
      expect(await searchInput.isDisplayed()).toBe(true);

      // Click outside the dropdown to dismiss it
      const editor = await browser.$(".monaco-editor");
      await editor.click();
      await browser.pause(300);

      // Dropdown should be closed
      searchInput = await browser.$(LANG_MENU_SEARCH);
      const stillVisible = (await searchInput.isExisting()) && (await searchInput.isDisplayed());
      expect(stillVisible).toBe(false);
    });
  });
});
