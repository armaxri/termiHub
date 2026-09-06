import { describe, it, expect } from "vitest";
import { isWindows, isMac, getPlatform, fileManagerActionLabel } from "./platform";

describe("isWindows", () => {
  it("returns false on non-Windows user agents", () => {
    // jsdom default user agent does not include "Windows"
    expect(isWindows()).toBe(false);
  });
});

describe("isMac", () => {
  it("returns false on non-macOS user agents", () => {
    // jsdom default user agent does not include "Macintosh"
    expect(isMac()).toBe(false);
  });
});

describe("getPlatform", () => {
  it("returns linux for jsdom default user agent", () => {
    // jsdom's default user agent doesn't contain Windows or Macintosh
    expect(getPlatform()).toBe("linux");
  });
});

describe("fileManagerActionLabel", () => {
  it("uses Finder wording on macOS", () => {
    expect(fileManagerActionLabel("macos")).toBe("Reveal in Finder");
  });

  it("uses File Explorer wording on Windows", () => {
    expect(fileManagerActionLabel("windows")).toBe("Show in File Explorer");
  });

  it("uses generic File Manager wording on Linux", () => {
    expect(fileManagerActionLabel("linux")).toBe("Open in File Manager");
  });

  it("defaults to the detected platform (linux under jsdom)", () => {
    expect(fileManagerActionLabel()).toBe("Open in File Manager");
  });
});
