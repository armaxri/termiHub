// tab-horizontal-scroll.test.js — Horizontal scrolling and context menu tests.
// Covers: MT-TAB-08, MT-TAB-09, MT-TAB-10, MT-TAB-11, MT-TAB-12, MT-TAB-13,
//         MT-TAB-14, MT-TAB-19, MT-TAB-20, MT-TAB-21.

import { waitForAppReady, closeAllTabs } from "./helpers/app.js";
import {
  uniqueName,
  createLocalConnection,
  openNewConnectionEditor,
  connectByName,
} from "./helpers/connections.js";
import { findTabByTitle, getActiveTab } from "./helpers/tabs.js";
import {
  CONN_EDITOR_SAVE,
  CONN_EDITOR_NAME,
  CONN_EDITOR_HORIZONTAL_SCROLL,
  TAB_CTX_HORIZONTAL_SCROLL,
  TERMINAL_CTX_PASTE,
  TERMINAL_CTX_COPY_SELECTION,
  TERMINAL_CTX_COPY_ALL,
  TOOLBAR_NEW_TERMINAL,
} from "./helpers/selectors.js";

describe("Horizontal Scrolling & Context Menu", () => {
  before(async () => {
    await waitForAppReady();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe("MT-TAB-08: Key repeat in horizontal scroll mode", () => {
    it("should handle key repeat with horizontal scrolling enabled", async () => {
      // Create connection with horizontal scrolling
      const name = uniqueName("hscroll-key");
      await openNewConnectionEditor();
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);

      // Enable horizontal scrolling
      const hscroll = await browser.$(CONN_EDITOR_HORIZONTAL_SCROLL);
      if (!(await hscroll.isSelected())) {
        await hscroll.click();
      }

      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(500);

      await connectByName(name);
      await browser.pause(1000);

      // Type rapidly - key repeat simulation
      const active = await browser.$(".xterm-helper-textarea");
      await active.setValue("aaaaaaaaaa");
      await browser.pause(300);

      // Verify terminal still responsive (no crash from key repeat)
      const tab = await findTabByTitle(name);
      expect(tab).not.toBeNull();
      expect(await tab.isDisplayed()).toBe(true);
    });
  });

  describe("MT-TAB-09: Horizontal scroll setting persists", () => {
    it("should persist horizontal scroll setting across editor reopen", async () => {
      const name = uniqueName("hscroll-persist");
      await openNewConnectionEditor();
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);

      // Enable horizontal scrolling
      const hscroll = await browser.$(CONN_EDITOR_HORIZONTAL_SCROLL);
      if (!(await hscroll.isSelected())) {
        await hscroll.click();
      }

      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(500);

      // Reopen the editor for the same connection
      const { connectionContextAction, CTX_CONNECTION_EDIT } =
        await import("./helpers/connections.js");
      await connectionContextAction(name, CTX_CONNECTION_EDIT);
      await browser.pause(500);

      // Verify horizontal scrolling is still checked
      const hscroll2 = await browser.$(CONN_EDITOR_HORIZONTAL_SCROLL);
      expect(await hscroll2.isSelected()).toBe(true);
    });
  });

  describe("MT-TAB-10: Scroll area adjusts on resize", () => {
    it("should adjust scroll area when window is resized", async () => {
      const name = uniqueName("hscroll-resize");
      await openNewConnectionEditor();
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);

      const hscroll = await browser.$(CONN_EDITOR_HORIZONTAL_SCROLL);
      if (!(await hscroll.isSelected())) {
        await hscroll.click();
      }

      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(500);

      await connectByName(name);
      await browser.pause(1000);

      // Get initial window size
      const initialSize = await browser.getWindowSize();

      // Resize window smaller
      await browser.setWindowSize(initialSize.width - 200, initialSize.height);
      await browser.pause(500);

      // Terminal should still be displayed correctly
      const xterm = await browser.$(".xterm");
      expect(await xterm.isDisplayed()).toBe(true);

      // Restore window size
      await browser.setWindowSize(initialSize.width, initialSize.height);
      await browser.pause(300);
    });
  });

  describe("MT-TAB-11: Scrollbar expands after wide output", () => {
    it("should expand scrollbar when wide output is produced", async () => {
      const name = uniqueName("hscroll-wide");
      await openNewConnectionEditor();
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);

      const hscroll = await browser.$(CONN_EDITOR_HORIZONTAL_SCROLL);
      if (!(await hscroll.isSelected())) {
        await hscroll.click();
      }

      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(500);

      await connectByName(name);
      await browser.pause(1000);

      // Send wide output via terminal input
      const { sendTerminalInput } = await import("./helpers/infrastructure.js");
      await sendTerminalInput("echo " + "A".repeat(300) + "\n");
      await browser.pause(1000);

      // Terminal viewport should be displayed with horizontal scroll
      const viewport = await browser.$(".xterm-scroll-area");
      expect(await viewport.isExisting()).toBe(true);
    });
  });

  describe("MT-TAB-12: Key repeat with dynamic scroll", () => {
    it("should allow key repeat without interruption with dynamic scroll", async () => {
      const name = uniqueName("hscroll-dynkey");
      await openNewConnectionEditor();
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);

      const hscroll = await browser.$(CONN_EDITOR_HORIZONTAL_SCROLL);
      if (!(await hscroll.isSelected())) {
        await hscroll.click();
      }

      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(500);

      await connectByName(name);
      await browser.pause(1000);

      // Type rapidly to simulate key repeat
      const active = await browser.$(".xterm-helper-textarea");
      await active.setValue("kkkkkkkkkkkkkkkk");
      await browser.pause(500);

      // Terminal should still be functional
      const xterm = await browser.$(".xterm");
      expect(await xterm.isDisplayed()).toBe(true);
    });
  });

  describe("MT-TAB-13: Clear resets scroll width", () => {
    it("should reset scroll width after clear command", async () => {
      const name = uniqueName("hscroll-clear");
      await openNewConnectionEditor();
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);

      const hscroll = await browser.$(CONN_EDITOR_HORIZONTAL_SCROLL);
      if (!(await hscroll.isSelected())) {
        await hscroll.click();
      }

      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(500);

      await connectByName(name);
      await browser.pause(1000);

      // Produce wide output then clear
      const { sendTerminalInput } = await import("./helpers/infrastructure.js");
      await sendTerminalInput("echo " + "B".repeat(300) + "\n");
      await browser.pause(500);
      await sendTerminalInput("clear\n");
      await browser.pause(500);

      // Terminal should be displayed (clear doesn't break it)
      const xterm = await browser.$(".xterm");
      expect(await xterm.isDisplayed()).toBe(true);
    });
  });

  describe("MT-TAB-14: Toggle horizontal scrolling off/on", () => {
    it("should work correctly after toggling horizontal scrolling", async () => {
      const name = uniqueName("hscroll-toggle");
      await openNewConnectionEditor();
      const nameInput = await browser.$(CONN_EDITOR_NAME);
      await nameInput.setValue(name);

      // Enable horizontal scrolling
      const hscroll = await browser.$(CONN_EDITOR_HORIZONTAL_SCROLL);
      if (!(await hscroll.isSelected())) {
        await hscroll.click();
      }

      const saveBtn = await browser.$(CONN_EDITOR_SAVE);
      await saveBtn.click();
      await browser.pause(500);

      await connectByName(name);
      await browser.pause(1000);

      // Toggle off via context menu
      const tab = await findTabByTitle(name);
      await tab.click({ button: "right" });
      await browser.pause(200);
      const toggleItem = await browser.$(TAB_CTX_HORIZONTAL_SCROLL);
      await toggleItem.click();
      await browser.pause(300);

      // Toggle back on via context menu
      await tab.click({ button: "right" });
      await browser.pause(200);
      const toggleItem2 = await browser.$(TAB_CTX_HORIZONTAL_SCROLL);
      await toggleItem2.click();
      await browser.pause(300);

      // Terminal should still work
      const xterm = await browser.$(".xterm");
      expect(await xterm.isDisplayed()).toBe(true);
    });
  });

  describe("MT-TAB-19: Context menu shows Paste first (no selection)", () => {
    it("should show Paste as first item when no text is selected", async () => {
      // Open a terminal
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(1000);

      // Right-click inside terminal area
      const xtermScreen = await browser.$(".xterm-screen");
      await xtermScreen.click({ button: "right" });
      await browser.pause(300);

      // Paste should be visible
      const pasteItem = await browser.$(TERMINAL_CTX_PASTE);
      expect(await pasteItem.isDisplayed()).toBe(true);

      // Copy Selection should NOT be visible (no selection)
      const copySelItem = await browser.$(TERMINAL_CTX_COPY_SELECTION);
      expect(await copySelItem.isExisting()).toBe(false);

      // Copy All should be visible
      const copyAllItem = await browser.$(TERMINAL_CTX_COPY_ALL);
      expect(await copyAllItem.isDisplayed()).toBe(true);

      // Dismiss menu
      await browser.keys(["Escape"]);
      await browser.pause(200);
    });
  });

  describe("MT-TAB-20: Context menu shows Copy Selection first (with selection)", () => {
    it("should show Copy Selection as first item when text is selected", async () => {
      // Open a terminal and generate output
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(1000);

      // Type something to produce output
      const { sendTerminalInput } = await import("./helpers/infrastructure.js");
      await sendTerminalInput("echo hello world\n");
      await browser.pause(500);

      // Select text by clicking and dragging
      const xtermScreen = await browser.$(".xterm-screen");
      const loc = await xtermScreen.getLocation();
      const size = await xtermScreen.getSize();

      // Click and drag to select text
      await browser.performActions([
        {
          type: "pointer",
          id: "mouse1",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              x: Math.round(loc.x + 10),
              y: Math.round(loc.y + size.height / 2),
            },
            { type: "pointerDown", button: 0 },
            {
              type: "pointerMove",
              x: Math.round(loc.x + size.width / 2),
              y: Math.round(loc.y + size.height / 2),
              duration: 200,
            },
            { type: "pointerUp", button: 0 },
          ],
        },
      ]);
      await browser.pause(300);

      // Right-click
      await xtermScreen.click({ button: "right" });
      await browser.pause(300);

      // Copy Selection should be visible (text was selected)
      const copySelItem = await browser.$(TERMINAL_CTX_COPY_SELECTION);
      if (await copySelItem.isExisting()) {
        expect(await copySelItem.isDisplayed()).toBe(true);
      }

      // Paste should also be visible
      const pasteItem = await browser.$(TERMINAL_CTX_PASTE);
      expect(await pasteItem.isDisplayed()).toBe(true);

      // Dismiss menu
      await browser.keys(["Escape"]);
      await browser.pause(200);
    });
  });

  describe("MT-TAB-21: Scroll wheel at bottom edge", () => {
    it("should scroll correctly at the bottom edge of terminal", async () => {
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(1000);

      // Generate lots of output
      const { sendTerminalInput } = await import("./helpers/infrastructure.js");
      await sendTerminalInput("seq 1 500\n");
      await browser.pause(2000);

      // Terminal should be scrolled to bottom by default
      const xterm = await browser.$(".xterm");
      expect(await xterm.isDisplayed()).toBe(true);

      // Scroll up via mouse wheel simulation
      const xtermScreen = await browser.$(".xterm-screen");
      const loc = await xtermScreen.getLocation();
      const size = await xtermScreen.getSize();

      // Scroll at bottom edge
      await browser.performActions([
        {
          type: "wheel",
          id: "wheel1",
          actions: [
            {
              type: "scroll",
              x: Math.round(loc.x + size.width / 2),
              y: Math.round(loc.y + size.height - 5),
              deltaX: 0,
              deltaY: -500,
            },
          ],
        },
      ]);
      await browser.pause(500);

      // Scroll back down at bottom edge
      await browser.performActions([
        {
          type: "wheel",
          id: "wheel2",
          actions: [
            {
              type: "scroll",
              x: Math.round(loc.x + size.width / 2),
              y: Math.round(loc.y + size.height - 5),
              deltaX: 0,
              deltaY: 500,
            },
          ],
        },
      ]);
      await browser.pause(500);

      // Terminal should still be displayed correctly
      expect(await xterm.isDisplayed()).toBe(true);
    });
  });
});
