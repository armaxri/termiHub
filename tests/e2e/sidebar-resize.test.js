// Sidebar resize tests.
// Covers: resizable sidebar width (#499).

import { waitForAppReady, ensureConnectionsSidebar } from "./helpers/app.js";
import {
  SIDEBAR,
  SIDEBAR_RESIZE_HANDLE,
  TOOLBAR_TOGGLE_SIDEBAR,
  TOOLBAR_NEW_TERMINAL,
} from "./helpers/selectors.js";

describe("Sidebar Resize (#499)", () => {
  before(async () => {
    await waitForAppReady();
    await ensureConnectionsSidebar();
  });

  it("should show the resize handle when sidebar is visible", async () => {
    const handle = await browser.$(SIDEBAR_RESIZE_HANDLE);
    expect(await handle.isExisting()).toBe(true);
    expect(await handle.isDisplayed()).toBe(true);
  });

  it("should have col-resize cursor on the resize handle", async () => {
    const handle = await browser.$(SIDEBAR_RESIZE_HANDLE);
    const cursor = await handle.getCSSProperty("cursor");
    expect(cursor.value).toBe("col-resize");
  });

  it("should widen the sidebar when dragging the handle outward", async () => {
    const sidebar = await browser.$(SIDEBAR);
    const handle = await browser.$(SIDEBAR_RESIZE_HANDLE);

    const initialSize = await sidebar.getSize();
    const handleLocation = await handle.getLocation();

    // Drag handle 100px to the right (wider)
    await browser.performActions([
      {
        type: "pointer",
        id: "finger1",
        parameters: { pointerType: "mouse" },
        actions: [
          {
            type: "pointerMove",
            duration: 0,
            x: Math.round(handleLocation.x),
            y: Math.round(handleLocation.y + 50),
          },
          { type: "pointerDown", button: 0 },
          {
            type: "pointerMove",
            duration: 100,
            x: Math.round(handleLocation.x + 100),
            y: Math.round(handleLocation.y + 50),
          },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);

    await browser.pause(200);
    const newSize = await sidebar.getSize();
    expect(newSize.width).toBeGreaterThan(initialSize.width);
  });

  it("should narrow the sidebar when dragging the handle inward", async () => {
    const sidebar = await browser.$(SIDEBAR);
    const handle = await browser.$(SIDEBAR_RESIZE_HANDLE);

    const initialSize = await sidebar.getSize();
    const handleLocation = await handle.getLocation();

    // Drag handle 80px to the left (narrower)
    await browser.performActions([
      {
        type: "pointer",
        id: "finger1",
        parameters: { pointerType: "mouse" },
        actions: [
          {
            type: "pointerMove",
            duration: 0,
            x: Math.round(handleLocation.x),
            y: Math.round(handleLocation.y + 50),
          },
          { type: "pointerDown", button: 0 },
          {
            type: "pointerMove",
            duration: 100,
            x: Math.round(handleLocation.x - 80),
            y: Math.round(handleLocation.y + 50),
          },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);

    await browser.pause(200);
    const newSize = await sidebar.getSize();
    expect(newSize.width).toBeLessThan(initialSize.width);
  });

  it("should not go below minimum width (170px)", async () => {
    const sidebar = await browser.$(SIDEBAR);
    const handle = await browser.$(SIDEBAR_RESIZE_HANDLE);
    const handleLocation = await handle.getLocation();

    // Drag handle far to the left
    await browser.performActions([
      {
        type: "pointer",
        id: "finger1",
        parameters: { pointerType: "mouse" },
        actions: [
          {
            type: "pointerMove",
            duration: 0,
            x: Math.round(handleLocation.x),
            y: Math.round(handleLocation.y + 50),
          },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 100, x: 0, y: Math.round(handleLocation.y + 50) },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);

    await browser.pause(200);
    const size = await sidebar.getSize();
    expect(size.width).toBeGreaterThanOrEqual(170);
  });

  it("should not exceed maximum width (600px)", async () => {
    const sidebar = await browser.$(SIDEBAR);
    const handle = await browser.$(SIDEBAR_RESIZE_HANDLE);
    const handleLocation = await handle.getLocation();

    // Drag handle far to the right
    await browser.performActions([
      {
        type: "pointer",
        id: "finger1",
        parameters: { pointerType: "mouse" },
        actions: [
          {
            type: "pointerMove",
            duration: 0,
            x: Math.round(handleLocation.x),
            y: Math.round(handleLocation.y + 50),
          },
          { type: "pointerDown", button: 0 },
          { type: "pointerMove", duration: 100, x: 900, y: Math.round(handleLocation.y + 50) },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);

    await browser.pause(200);
    const size = await sidebar.getSize();
    expect(size.width).toBeLessThanOrEqual(600);
  });

  it("should preserve sidebar width after collapse and expand", async () => {
    const sidebar = await browser.$(SIDEBAR);
    const handle = await browser.$(SIDEBAR_RESIZE_HANDLE);
    const handleLocation = await handle.getLocation();

    // Drag to a custom width (+60px from current)
    await browser.performActions([
      {
        type: "pointer",
        id: "finger1",
        parameters: { pointerType: "mouse" },
        actions: [
          {
            type: "pointerMove",
            duration: 0,
            x: Math.round(handleLocation.x),
            y: Math.round(handleLocation.y + 50),
          },
          { type: "pointerDown", button: 0 },
          {
            type: "pointerMove",
            duration: 100,
            x: Math.round(handleLocation.x + 60),
            y: Math.round(handleLocation.y + 50),
          },
          { type: "pointerUp", button: 0 },
        ],
      },
    ]);
    await browser.pause(200);

    const sizeAfterResize = await sidebar.getSize();

    // Open a terminal so toolbar toggle is available
    const newBtn = await browser.$(TOOLBAR_NEW_TERMINAL);
    await newBtn.click();
    await browser.pause(500);

    // Collapse sidebar
    const toggleBtn = await browser.$(TOOLBAR_TOGGLE_SIDEBAR);
    await toggleBtn.click();
    await browser.pause(300);

    // Expand sidebar
    await toggleBtn.click();
    await browser.pause(300);

    const sidebarExpanded = await browser.$(SIDEBAR);
    const sizeAfterExpand = await sidebarExpanded.getSize();

    // Width should be preserved (allow 2px tolerance for rounding)
    expect(Math.abs(sizeAfterExpand.width - sizeAfterResize.width)).toBeLessThanOrEqual(2);
  });
});
