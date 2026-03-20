// terminal-auto-scroll.test.js — Auto-scroll behavior tests.
// Covers: #504 — Auto-scroll should not override user scroll position.

import { waitForAppReady, closeAllTabs } from "./helpers/app.js";
import { TOOLBAR_NEW_TERMINAL } from "./helpers/selectors.js";

describe("Terminal Auto-Scroll (#504)", () => {
  before(async () => {
    await waitForAppReady();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe("MT-SCROLL-01: Auto-scroll preserves user scroll position", () => {
    it("should not auto-scroll when user has scrolled up", async () => {
      // Open a local terminal
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(1500);

      // Generate large output to fill scrollback
      const { sendTerminalInput } = await import("./helpers/infrastructure.js");
      await sendTerminalInput("seq 1 500\n");
      await browser.pause(3000);

      // Scroll up via mouse wheel
      const xtermScreen = await browser.$(".xterm-screen");
      const loc = await xtermScreen.getLocation();
      const size = await xtermScreen.getSize();

      await browser.performActions([
        {
          type: "wheel",
          id: "wheel-up",
          actions: [
            {
              type: "scroll",
              x: Math.round(loc.x + size.width / 2),
              y: Math.round(loc.y + size.height / 2),
              deltaX: 0,
              deltaY: -2000,
            },
          ],
        },
      ]);
      await browser.pause(1000);

      // Read the scroll position after scrolling up
      const posAfterScrollUp = await browser.execute(() => {
        const el = document.querySelector(".terminal-slot > div");
        if (!el || !el._xtermInstance) return null;
        const buf = el._xtermInstance.buffer.active;
        return { viewportY: buf.viewportY, baseY: buf.baseY };
      });

      expect(posAfterScrollUp).not.toBeNull();
      // User should be scrolled up: viewportY < baseY
      expect(posAfterScrollUp.viewportY).toBeLessThan(posAfterScrollUp.baseY);

      const savedViewportY = posAfterScrollUp.viewportY;

      // Generate more output while scrolled up
      await sendTerminalInput("seq 501 600\n");
      await browser.pause(2000);

      // Verify scroll position is preserved (not jumped to bottom)
      const posAfterMoreOutput = await browser.execute(() => {
        const el = document.querySelector(".terminal-slot > div");
        if (!el || !el._xtermInstance) return null;
        const buf = el._xtermInstance.buffer.active;
        return { viewportY: buf.viewportY, baseY: buf.baseY };
      });

      expect(posAfterMoreOutput).not.toBeNull();
      // viewportY should be close to where we left it (not jumped to baseY)
      // Allow some tolerance since baseY may have grown
      expect(posAfterMoreOutput.viewportY).toBeLessThanOrEqual(savedViewportY + 5);
      expect(posAfterMoreOutput.viewportY).toBeLessThan(posAfterMoreOutput.baseY);
    });
  });

  describe("MT-SCROLL-02: Auto-scroll resumes when user scrolls back to bottom", () => {
    it("should auto-scroll again after user scrolls to bottom", async () => {
      // Open a local terminal
      const btn = await browser.$(TOOLBAR_NEW_TERMINAL);
      await btn.click();
      await browser.pause(1500);

      // Generate large output
      const { sendTerminalInput } = await import("./helpers/infrastructure.js");
      await sendTerminalInput("seq 1 500\n");
      await browser.pause(3000);

      // Scroll up
      const xtermScreen = await browser.$(".xterm-screen");
      const loc = await xtermScreen.getLocation();
      const size = await xtermScreen.getSize();

      await browser.performActions([
        {
          type: "wheel",
          id: "wheel-up2",
          actions: [
            {
              type: "scroll",
              x: Math.round(loc.x + size.width / 2),
              y: Math.round(loc.y + size.height / 2),
              deltaX: 0,
              deltaY: -2000,
            },
          ],
        },
      ]);
      await browser.pause(500);

      // Scroll back to bottom with a large positive deltaY
      await browser.performActions([
        {
          type: "wheel",
          id: "wheel-down",
          actions: [
            {
              type: "scroll",
              x: Math.round(loc.x + size.width / 2),
              y: Math.round(loc.y + size.height / 2),
              deltaX: 0,
              deltaY: 50000,
            },
          ],
        },
      ]);
      await browser.pause(1000);

      // Generate more output — auto-scroll should resume
      await sendTerminalInput("seq 601 700\n");
      await browser.pause(2000);

      // Verify viewport is at the bottom
      const posAtBottom = await browser.execute(() => {
        const el = document.querySelector(".terminal-slot > div");
        if (!el || !el._xtermInstance) return null;
        const buf = el._xtermInstance.buffer.active;
        return { viewportY: buf.viewportY, baseY: buf.baseY };
      });

      expect(posAtBottom).not.toBeNull();
      // viewportY should be at or very near baseY (auto-scroll resumed)
      expect(posAtBottom.viewportY).toBeGreaterThanOrEqual(posAtBottom.baseY - 2);
    });
  });
});
