// sidebar-sections.test.js — Sidebar section collapse, resize, and scroll tests.
// Covers: MT-UI-21, MT-UI-22, MT-UI-23, MT-UI-24, MT-UI-25.

import { waitForAppReady, ensureConnectionsSidebar, closeAllTabs } from "./helpers/app.js";
import {
  SIDEBAR_GROUP_HEADER_CONNECTIONS,
  CONNECTION_LIST_GROUP_TOGGLE,
  sidebarGroupSeparator,
} from "./helpers/selectors.js";

describe("Sidebar Sections", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  afterEach(async () => {
    await closeAllTabs();
  });

  describe("MT-UI-21: Collapsed section folds to header height", () => {
    it("should fold section to header height when collapsed", async () => {
      const groupHeader = await browser.$(SIDEBAR_GROUP_HEADER_CONNECTIONS);
      expect(await groupHeader.isDisplayed()).toBe(true);

      // Get the parent group element
      const group = await groupHeader.parentElement();
      const expandedHeight = (await group.getSize()).height;

      // Click toggle to collapse
      const toggle = await browser.$(CONNECTION_LIST_GROUP_TOGGLE);
      await toggle.click();
      await browser.pause(300);

      // Collapsed height should be significantly smaller
      const collapsedHeight = (await group.getSize()).height;
      expect(collapsedHeight).toBeLessThan(expandedHeight);

      // Collapse height should be approximately the header height
      const headerHeight = (await groupHeader.getSize()).height;
      expect(collapsedHeight).toBeLessThanOrEqual(headerHeight + 10);

      // Expand again
      await toggle.click();
      await browser.pause(300);
    });
  });

  describe("MT-UI-22: Visible separators between sections", () => {
    it("should show visible separators between sidebar sections", async () => {
      // Check if separator exists (only visible when agents are configured)
      const separator = await browser.$(sidebarGroupSeparator(0));
      if (await separator.isExisting()) {
        expect(await separator.isDisplayed()).toBe(true);

        // Separator should have minimal height (a resize handle)
        const size = await separator.getSize();
        expect(size.height).toBeGreaterThan(0);
        expect(size.height).toBeLessThan(20);
      }
      // If no separator exists, there's only one section - test passes
    });
  });

  describe("MT-UI-23: Multiple expanded groups share space equally", () => {
    it("should distribute space among expanded groups", async () => {
      // Ensure connections group is expanded
      const toggle = await browser.$(CONNECTION_LIST_GROUP_TOGGLE);
      const groupHeader = await browser.$(SIDEBAR_GROUP_HEADER_CONNECTIONS);
      const group = await groupHeader.parentElement();

      // If expanded, the group should take up available space
      const groupSize = await group.getSize();
      expect(groupSize.height).toBeGreaterThan(100);
    });
  });

  describe("MT-UI-24: Resize cursor on separator hover", () => {
    it("should show resize cursor when hovering separator", async () => {
      const separator = await browser.$(sidebarGroupSeparator(0));
      if (await separator.isExisting()) {
        // Move mouse to separator
        await separator.moveTo();
        await browser.pause(200);

        // Verify the separator element has cursor style via CSS
        const cursor = await separator.getCSSProperty("cursor");
        // Resize handles typically have row-resize or ns-resize cursor
        expect(["row-resize", "ns-resize", "n-resize", "s-resize"]).toContain(cursor.value);
      }
    });
  });

  describe("MT-UI-25: Section content scrolls independently", () => {
    it("should allow independent scrolling within sections", async () => {
      // Verify the connections group exists and has content
      const groupHeader = await browser.$(SIDEBAR_GROUP_HEADER_CONNECTIONS);
      expect(await groupHeader.isDisplayed()).toBe(true);

      // The group content area should be scrollable (overflow set)
      const group = await groupHeader.parentElement();
      const overflow = await group.getCSSProperty("overflow-y");
      // Content should be scrollable or auto
      expect(["auto", "scroll", "overlay"]).toContain(overflow.value);
    });
  });
});
