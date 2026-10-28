import { describe, it, expect } from "vitest";
import { quotePath } from "@/utils/quotePath";
import type { Platform } from "@/utils/platform";
import { dropPositionToCss } from "./useOsFileDrop";

/** Hit-tests a Tauri drop position against a CSS rect, the way useOsFileDrop does. */
function isDropOver(
  pos: { x: number; y: number },
  rect: { left: number; top: number; right: number; bottom: number },
  platform: Platform,
  devicePixelRatio: number
): boolean {
  const { x, y } = dropPositionToCss(pos, platform, devicePixelRatio);
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

describe("dropPositionToCss — native drop position to CSS pixels (#4997)", () => {
  it("divides Windows device pixels by devicePixelRatio", () => {
    expect(dropPositionToCss({ x: 400, y: 300 }, "windows", 2)).toEqual({ x: 200, y: 150 });
    expect(dropPositionToCss({ x: 300, y: 300 }, "windows", 1.5)).toEqual({ x: 200, y: 200 });
  });

  it("keeps Linux (GTK logical) coordinates at any scale", () => {
    expect(dropPositionToCss({ x: 400, y: 300 }, "linux", 2)).toEqual({ x: 400, y: 300 });
  });

  it("keeps macOS (AppKit points) coordinates at any scale", () => {
    expect(dropPositionToCss({ x: 400, y: 300 }, "macos", 2)).toEqual({ x: 400, y: 300 });
  });

  it("ignores a nonsensical Windows devicePixelRatio", () => {
    expect(dropPositionToCss({ x: 40, y: 30 }, "windows", 0)).toEqual({ x: 40, y: 30 });
  });
});

describe("useOsFileDrop — hit-test logic", () => {
  const rect = { left: 100, top: 100, right: 300, bottom: 300 };
  // Two panes side by side at scale 2: a Linux/macOS drop at (450, 200) is over
  // the right pane; halving it (the old bug) moved it into the left one.
  const left = { left: 0, top: 0, right: 299, bottom: 600 };
  const right = { left: 300, top: 0, right: 600, bottom: 600 };

  it("returns true when position is inside element at dpr=1", () => {
    expect(isDropOver({ x: 200, y: 200 }, rect, "linux", 1)).toBe(true);
  });

  it("returns false when position is outside element at dpr=1", () => {
    expect(isDropOver({ x: 50, y: 50 }, rect, "linux", 1)).toBe(false);
  });

  it("converts Windows physical to logical at dpr=2", () => {
    expect(isDropOver({ x: 400, y: 400 }, rect, "windows", 2)).toBe(true);
    expect(isDropOver({ x: 100, y: 100 }, rect, "windows", 2)).toBe(false);
  });

  it("lands a scaled Linux/macOS drop in the pane under the cursor", () => {
    for (const platform of ["linux", "macos"] as const) {
      expect(isDropOver({ x: 450, y: 200 }, right, platform, 2)).toBe(true);
      expect(isDropOver({ x: 450, y: 200 }, left, platform, 2)).toBe(false);
    }
  });

  it("returns true at element edges", () => {
    expect(isDropOver({ x: 100, y: 100 }, rect, "linux", 1)).toBe(true);
    expect(isDropOver({ x: 300, y: 300 }, rect, "linux", 1)).toBe(true);
  });

  it("returns false just outside element edges", () => {
    expect(isDropOver({ x: 99, y: 200 }, rect, "linux", 1)).toBe(false);
    expect(isDropOver({ x: 301, y: 200 }, rect, "linux", 1)).toBe(false);
  });
});

describe("quotePath — terminal path insertion", () => {
  it("wraps a simple unix path in single quotes", () => {
    expect(quotePath("/home/user/file.txt")).toBe("'/home/user/file.txt'");
  });

  it("wraps a path with spaces in single quotes", () => {
    expect(quotePath("/home/user/my file.txt")).toBe("'/home/user/my file.txt'");
  });

  it("escapes single quotes inside unix paths", () => {
    expect(quotePath("/home/user/it's here.txt")).toBe("'/home/user/it'\\''s here.txt'");
  });

  it("wraps a Windows path in double quotes", () => {
    expect(quotePath("C:\\Users\\Alice\\document.docx")).toBe('"C:\\Users\\Alice\\document.docx"');
  });

  it("escapes double quotes inside Windows paths", () => {
    expect(quotePath('C:\\Users\\Alice\\"weird".txt')).toBe('"C:\\Users\\Alice\\\\"weird\\".txt"');
  });

  it("treats drive-letter paths as Windows even without backslash", () => {
    expect(quotePath("C:/Users/Alice/file.txt")).toBe('"C:/Users/Alice/file.txt"');
  });
});
