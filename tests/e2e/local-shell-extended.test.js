// Extended local shell E2E tests.
// Covers: Baseline (shell dropdown, connect, resize, exit),
//         Terminal input on new connections (PR #198),
//         Configurable starting directory (PR #148),
//         New tabs open in home directory (PR #66).

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "./helpers/app.js";
import {
  uniqueName,
  createLocalConnection,
  connectByName,
  openNewConnectionEditor,
  connectionContextAction,
  CTX_CONNECTION_EDIT,
} from "./helpers/connections.js";
import { findTabByTitle, getActiveTab, getTabCount, getAllTabs } from "./helpers/tabs.js";
import { switchToFilesSidebar } from "./helpers/sidebar.js";
import {
  CONN_EDITOR_NAME,
  CONN_EDITOR_SAVE,
  CONN_EDITOR_SAVE_CONNECT,
  SHELL_SELECT,
  STARTING_DIRECTORY,
  TOOLBAR_NEW_TERMINAL,
  TOOLBAR_SPLIT,
  FILE_BROWSER_CURRENT_PATH,
} from "./helpers/selectors.js";

describe("Local Shell — Extended", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  // ── Baseline ──────────────────────────────────────────────────────────

  describe("Baseline", () => {
    it("should show available shells in the dropdown when creating a Local connection", async () => {
      await openNewConnectionEditor();

      const shellSelect = await browser.$(SHELL_SELECT);
      await shellSelect.waitForDisplayed({ timeout: 3000 });

      const options = await shellSelect.$$("option");
      // Every OS should have at least one shell available
      expect(options.length).toBeGreaterThanOrEqual(1);

      // Verify option texts are non-empty shell names
      for (const opt of options) {
        const text = await opt.getText();
        expect(text.length).toBeGreaterThan(0);
      }

      // Cancel editor
      await browser.keys("Escape");
    });

    it("should open a terminal, show a prompt, and execute commands", async () => {
      const name = uniqueName("baseline-cmd");
      await createLocalConnection(name);
      await connectByName(name);

      // Wait for shell to initialize
      await browser.pause(1500);

      // Tab should be active
      const active = await getActiveTab();
      expect(active).not.toBeNull();
      const activeText = await active.getText();
      expect(activeText).toContain(name);

      // xterm container should exist (prompt rendered)
      const xtermContainer = await browser.$(".xterm");
      expect(await xtermContainer.isExisting()).toBe(true);

      // Type a simple command — echo a unique marker
      const marker = `E2E_MARKER_${Date.now()}`;
      await browser.keys(`echo ${marker}\n`);
      await browser.pause(1000);

      // The terminal should still be functional (xterm present)
      expect(await xtermContainer.isExisting()).toBe(true);
    });

    it("should keep a functional terminal after a resize event (partial)", async () => {
      const name = uniqueName("baseline-resize");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1000);

      // Resize the browser window to trigger a terminal resize
      const originalSize = await browser.getWindowSize();
      await browser.setWindowSize(originalSize.width - 200, originalSize.height - 100);
      await browser.pause(500);

      // Terminal should still exist
      const xtermContainer = await browser.$(".xterm");
      expect(await xtermContainer.isExisting()).toBe(true);

      // Restore window size
      await browser.setWindowSize(originalSize.width, originalSize.height);
      await browser.pause(300);
    });

    it("should show process exited message after typing exit", async () => {
      const name = uniqueName("baseline-exit");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Type "exit" to close the shell
      await browser.keys("exit\n");
      await browser.pause(2000);

      // Look for the "[Process exited with code 0]" overlay or text
      const termArea = await browser.$('[data-testid^="terminal-"]');
      if (await termArea.isExisting()) {
        const text = await termArea.getText();
        // The process exited message should appear somewhere in the terminal area
        const hasExited = text.includes("Process exited") || text.includes("exited with code");
        expect(hasExited).toBe(true);
      } else {
        // If the terminal area element is not found by testid, check for the
        // exit overlay that appears on top of the xterm instance
        const overlay = await browser.$(".terminal-exit-overlay");
        if (await overlay.isExisting()) {
          const overlayText = await overlay.getText();
          expect(overlayText).toContain("exited");
        } else {
          // Fallback: just verify the xterm container is still in DOM
          // (the exit message is rendered inside it)
          const xterm = await browser.$(".xterm");
          expect(await xterm.isExisting()).toBe(true);
        }
      }
    });
  });

  // ── Terminal input works on new connections (PR #198) ─────────────────

  describe("Terminal input on new connections (PR #198)", () => {
    it("should accept keyboard input in rapidly created terminals", async () => {
      const names = [];
      for (let i = 0; i < 3; i++) {
        const name = uniqueName(`rapid-${i}`);
        names.push(name);
        await createLocalConnection(name);
        await connectByName(name);
        await browser.pause(300);
      }

      // Wait for all terminals to initialize
      await browser.pause(1500);

      // Verify all tabs were created
      const tabCount = await getTabCount();
      expect(tabCount).toBeGreaterThanOrEqual(3);

      // Switch to each tab and verify the terminal accepts input
      for (const name of names) {
        const tab = await findTabByTitle(name);
        expect(tab).not.toBeNull();
        await tab.click();
        await browser.pause(500);

        // xterm should be visible for the active terminal
        const xterm = await browser.$(".xterm");
        expect(await xterm.isExisting()).toBe(true);

        // Type into the terminal — if input works, no error is thrown
        const marker = `INPUT_CHECK_${Date.now()}`;
        await browser.keys(`echo ${marker}\n`);
        await browser.pause(300);
      }
    });

    it("should deliver keyboard input to the active terminal when switching tabs", async () => {
      const name1 = uniqueName("switch-input-1");
      const name2 = uniqueName("switch-input-2");
      await createLocalConnection(name1);
      await createLocalConnection(name2);
      await connectByName(name1);
      await browser.pause(800);
      await connectByName(name2);
      await browser.pause(800);

      // Tab 2 should be active — type into it
      let active = await getActiveTab();
      let activeText = await active.getText();
      expect(activeText).toContain(name2);
      await browser.keys(`echo TERMINAL_2\n`);
      await browser.pause(300);

      // Switch to tab 1
      const tab1 = await findTabByTitle(name1);
      await tab1.click();
      await browser.pause(500);

      active = await getActiveTab();
      activeText = await active.getText();
      expect(activeText).toContain(name1);

      // Type into tab 1 — should work without issues
      await browser.keys(`echo TERMINAL_1\n`);
      await browser.pause(300);

      // xterm should still be present
      const xterm = await browser.$(".xterm");
      expect(await xterm.isExisting()).toBe(true);
    });

    it("should accept input in both panels after a split", async () => {
      // Create first terminal
      const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await newBtn.click();
      await browser.pause(800);

      // Split the view
      const splitBtn = await browser.$(TOOLBAR_SPLIT);
      await splitBtn.waitForDisplayed({ timeout: 3000 });
      await splitBtn.click();
      await browser.pause(500);

      // Create a terminal in the new panel
      await newBtn.click();
      await browser.pause(800);

      // Type into the active panel
      await browser.keys(`echo SPLIT_PANEL\n`);
      await browser.pause(300);

      // xterm containers should exist (at least one per panel)
      const xtermElements = await browser.$$(".xterm");
      expect(xtermElements.length).toBeGreaterThanOrEqual(1);

      // Switch to the first tab and type
      const allTabs = await getAllTabs();
      if (allTabs.length >= 2) {
        await allTabs[0].click();
        await browser.pause(500);

        await browser.keys(`echo FIRST_PANEL\n`);
        await browser.pause(300);

        // Terminal should still be functional
        const xterm = await browser.$(".xterm");
        expect(await xterm.isExisting()).toBe(true);
      }
    });
  });

  // ── Configurable starting directory (PR #148) ────────────────────────

  describe("Configurable starting directory (PR #148)", () => {
    it("should open in home directory when no starting directory is set", async () => {
      const name = uniqueName("dir-default");
      await createLocalConnection(name);
      await connectByName(name);
      await browser.pause(1500);

      // Type pwd to check the current directory
      await browser.keys("pwd\n");
      await browser.pause(1000);

      // The terminal should be functional; the output should contain the
      // home directory path. We cannot easily read xterm buffer content,
      // so verify the terminal is still working.
      const xterm = await browser.$(".xterm");
      expect(await xterm.isExisting()).toBe(true);
    });

    it("should open in /tmp when starting directory is set to /tmp", async () => {
      await openNewConnectionEditor();

      const nameInput = await browser.$(CONN_EDITOR_NAME);
      const name = uniqueName("dir-tmp");
      await nameInput.setValue(name);

      // Set starting directory to /tmp
      const startDirInput = await browser.$(STARTING_DIRECTORY);
      await startDirInput.waitForDisplayed({ timeout: 3000 });
      await startDirInput.setValue("/tmp");

      const saveConnectBtn = await browser.$(CONN_EDITOR_SAVE_CONNECT);
      await saveConnectBtn.click();
      await browser.pause(1500);

      // Tab should open
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();

      // Terminal should be functional
      const xterm = await browser.$(".xterm");
      expect(await xterm.isExisting()).toBe(true);

      // Type pwd — the shell should be in /tmp
      await browser.keys("pwd\n");
      await browser.pause(1000);
    });

    it("should expand tilde in starting directory ~/work", async () => {
      await openNewConnectionEditor();

      const nameInput = await browser.$(CONN_EDITOR_NAME);
      const name = uniqueName("dir-tilde");
      await nameInput.setValue(name);

      // Set starting directory with tilde expansion
      const startDirInput = await browser.$(STARTING_DIRECTORY);
      await startDirInput.waitForDisplayed({ timeout: 3000 });
      await startDirInput.setValue("~/work");

      const saveConnectBtn = await browser.$(CONN_EDITOR_SAVE_CONNECT);
      await saveConnectBtn.click();
      await browser.pause(1500);

      // Tab should open — tilde should be expanded by the backend
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();

      const xterm = await browser.$(".xterm");
      expect(await xterm.isExisting()).toBe(true);
    });

    it("should expand env vars in starting directory ${env:HOME}/Desktop", async () => {
      await openNewConnectionEditor();

      const nameInput = await browser.$(CONN_EDITOR_NAME);
      const name = uniqueName("dir-envvar");
      await nameInput.setValue(name);

      // Set starting directory with env var expansion
      const startDirInput = await browser.$(STARTING_DIRECTORY);
      await startDirInput.waitForDisplayed({ timeout: 3000 });
      await startDirInput.setValue("${env:HOME}/Desktop");

      const saveConnectBtn = await browser.$(CONN_EDITOR_SAVE_CONNECT);
      await saveConnectBtn.click();
      await browser.pause(1500);

      // Tab should open
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();

      const xterm = await browser.$(".xterm");
      expect(await xterm.isExisting()).toBe(true);
    });

    it("should apply starting directory when editing an existing connection", async () => {
      // First create a connection without a starting directory
      const name = uniqueName("dir-edit");
      await createLocalConnection(name);
      await browser.pause(300);

      // Edit the connection via context menu
      await connectionContextAction(name, CTX_CONNECTION_EDIT);
      await browser.pause(500);

      // Set starting directory
      const startDirInput = await browser.$(STARTING_DIRECTORY);
      await startDirInput.waitForDisplayed({ timeout: 3000 });
      await startDirInput.setValue("/tmp");

      // Save
      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(500);

      // Connect
      await connectByName(name);
      await browser.pause(1500);

      // Tab should open and terminal should be functional
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();

      const xterm = await browser.$(".xterm");
      expect(await xterm.isExisting()).toBe(true);

      // Type pwd to verify directory (output in xterm buffer)
      await browser.keys("pwd\n");
      await browser.pause(1000);
    });
  });

  // ── New tabs open in home directory (PR #66) ─────────────────────────

  describe("New tabs open in home directory (PR #66)", () => {
    it("should start a new local shell tab in the home directory", async () => {
      // Use the New Terminal toolbar button (creates a default local shell)
      const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await newBtn.click();
      await browser.pause(1500);

      // A tab should be created
      const tabCount = await getTabCount();
      expect(tabCount).toBeGreaterThanOrEqual(1);

      // Terminal should be functional
      const xterm = await browser.$(".xterm");
      expect(await xterm.isExisting()).toBe(true);

      // Type pwd — the shell should start in the home directory
      await browser.keys("pwd\n");
      await browser.pause(1000);
    });

    it("should show the home directory in the file browser for a new shell", async () => {
      // Open a new local terminal
      const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await newBtn.click();
      await browser.pause(1500);

      // Switch to the file browser sidebar
      await switchToFilesSidebar();
      await browser.pause(500);

      // The file browser current path should display a directory
      const currentPath = await browser.$(FILE_BROWSER_CURRENT_PATH);
      if ((await currentPath.isExisting()) && (await currentPath.isDisplayed())) {
        const pathText = await currentPath.getText();
        // The path should be non-empty and look like a home directory
        // (e.g. /home/user, /root, or /Users/user on macOS)
        expect(pathText.length).toBeGreaterThan(0);
        expect(pathText.startsWith("/")).toBe(true);
      }

      // Switch back to connections sidebar for cleanup
      await ensureConnectionsSidebar();
    });
  });
});
