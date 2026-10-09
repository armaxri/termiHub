import { describe, it, expect } from "vitest";
import { getBasename, joinPath, normalizeDirPath, parentDir } from "./paths";

describe("getBasename", () => {
  it.each([
    // POSIX
    ["/a", "a"],
    ["/home/u/file.txt", "file.txt"],
    ["relative/name.txt", "name.txt"],
    ["name.txt", "name.txt"],
    // Windows backslash and forward slash
    ["C:\\a\\b.txt", "b.txt"],
    ["C:/b.txt", "b.txt"],
    ["C:\\Users\\me\\terminal.txt", "terminal.txt"],
    ["C:\\mixed/sep\\c.log", "c.log"],
    // UNC
    ["\\\\server\\share\\dir\\f.txt", "f.txt"],
    ["//server/share/f.txt", "f.txt"],
    // Trailing separators
    ["/a/b/", "b"],
    ["/a/b//", "b"],
    ["C:\\a\\dir\\", "dir"],
    // Roots and empty have no name segment: returned unchanged
    ["/", "/"],
    ["C:\\", "C:\\"],
    ["C:/", "C:/"],
    ["\\\\server\\share", "\\\\server\\share"],
    ["", ""],
  ])("getBasename(%j) → %j", (path, expected) => {
    expect(getBasename(path)).toBe(expected);
  });
});

describe("normalizeDirPath", () => {
  it.each([
    ["/", "/"],
    ["//", "/"],
    ["/a/b/", "/a/b"],
    ["/a/b//", "/a/b"],
    ["C:\\Users\\", "C:/Users"],
    ["C:\\", "C:/"],
    ["C:", "C:/"],
    ["C:/", "C:/"],
    ["\\\\server\\share\\", "//server/share"],
    ["", ""],
  ])("normalizeDirPath(%j) → %j", (path, expected) => {
    expect(normalizeDirPath(path)).toBe(expected);
  });
});

describe("parentDir", () => {
  it.each([
    // POSIX
    ["/a", "/"],
    ["/home/u/a.txt", "/home/u"],
    ["/a/b/c", "/a/b"],
    ["/", "/"],
    // Windows backslash and forward slash: a top-level entry's parent is the
    // drive root, never a bare `C:` (the drive's current directory)
    ["C:\\a\\b.txt", "C:/a"],
    ["C:\\Users\\a.txt", "C:/Users"],
    ["C:/b.txt", "C:/"],
    ["C:\\b.txt", "C:/"],
    ["C:\\", "C:/"],
    ["C:/", "C:/"],
    // UNC: the share root is a fixed point
    ["\\\\server\\share\\dir\\f.txt", "//server/share/dir"],
    ["\\\\server\\share\\f.txt", "//server/share"],
    ["//server/share", "//server/share"],
    // Trailing separators are ignored
    ["/a/b/", "/a"],
    ["C:\\a\\dir\\", "C:/a"],
    // A bare name has no directory component
    ["name.txt", "/"],
  ])("parentDir(%j) → %j", (path, expected) => {
    expect(parentDir(path)).toBe(expected);
  });
});

describe("joinPath", () => {
  it.each([
    ["/", "a", "/a"],
    ["", "a", "/a"],
    ["/home/u", "a", "/home/u/a"],
    ["/home/u/", "a", "/home/u/a"],
    ["C:/", "a", "C:/a"],
    ["C:\\", "a", "C:/a"],
    ["C:", "a", "C:/a"],
    ["C:\\Users\\me", "a.txt", "C:/Users/me/a.txt"],
    ["\\\\server\\share", "a", "//server/share/a"],
    ["\\\\server\\share\\", "a", "//server/share/a"],
  ])("joinPath(%j, %j) → %j", (dir, name, expected) => {
    expect(joinPath(dir, name)).toBe(expected);
  });

  it("round-trips with parentDir and getBasename", () => {
    for (const p of ["/a/b/c.txt", "C:/Users/me/x.log", "//server/share/d/e"]) {
      expect(joinPath(parentDir(p), getBasename(p))).toBe(p);
    }
  });
});
