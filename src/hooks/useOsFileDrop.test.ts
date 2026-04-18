import { describe, it, expect } from "vitest";

/**
 * Pure position-hit-test logic extracted from useOsFileDrop.
 * Physical pixels are converted to logical CSS pixels by dividing by devicePixelRatio.
 */
function isPhysicalPosOver(
  pos: { x: number; y: number },
  rect: { left: number; top: number; right: number; bottom: number },
  devicePixelRatio: number
): boolean {
  const logX = pos.x / devicePixelRatio;
  const logY = pos.y / devicePixelRatio;
  return logX >= rect.left && logX <= rect.right && logY >= rect.top && logY <= rect.bottom;
}

describe("useOsFileDrop — hit-test logic", () => {
  const rect = { left: 100, top: 100, right: 300, bottom: 300 };

  it("returns true when position is inside element at dpr=1", () => {
    expect(isPhysicalPosOver({ x: 200, y: 200 }, rect, 1)).toBe(true);
  });

  it("returns false when position is outside element at dpr=1", () => {
    expect(isPhysicalPosOver({ x: 50, y: 50 }, rect, 1)).toBe(false);
  });

  it("converts physical to logical at dpr=2 (inside)", () => {
    // Physical (400,400) / 2 → logical (200,200), which is inside [100,300]
    expect(isPhysicalPosOver({ x: 400, y: 400 }, rect, 2)).toBe(true);
  });

  it("converts physical to logical at dpr=2 (outside)", () => {
    // Physical (100,100) / 2 → logical (50,50), which is outside
    expect(isPhysicalPosOver({ x: 100, y: 100 }, rect, 2)).toBe(false);
  });

  it("returns true at element edges", () => {
    expect(isPhysicalPosOver({ x: 100, y: 100 }, rect, 1)).toBe(true);
    expect(isPhysicalPosOver({ x: 300, y: 300 }, rect, 1)).toBe(true);
  });

  it("returns false just outside element edges", () => {
    expect(isPhysicalPosOver({ x: 99, y: 200 }, rect, 1)).toBe(false);
    expect(isPhysicalPosOver({ x: 301, y: 200 }, rect, 1)).toBe(false);
  });
});

/**
 * Shell-safe quoting logic — mirrors quotePath() in TerminalView.tsx.
 */
function quotePath(path: string): string {
  if (/^[A-Za-z]:/.test(path) || path.includes("\\")) {
    return `"${path.replace(/"/g, '\\"')}"`;
  }
  return `'${path.replace(/'/g, "'\\''")}'`;
}

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
