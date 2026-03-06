import { describe, it, expect } from "vitest";
import { isWindows } from "./platform";

describe("isWindows", () => {
  it("returns false on non-Windows user agents", () => {
    // jsdom default user agent does not include "Windows"
    expect(isWindows()).toBe(false);
  });
});
