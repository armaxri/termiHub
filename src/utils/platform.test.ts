import { describe, it, expect } from "vitest";
import { isWindows, isMac, getPlatform } from "./platform";

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
