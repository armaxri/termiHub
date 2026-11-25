import { describe, expect, it } from "vitest";
import { showExactly } from "./showExactly";

describe("showExactly (#6019)", () => {
  it("leaves what shows as it is", () => {
    for (const text of ["", "a b", "C:\\Program Files\\x", "äöü 日本語 🚀", "$(rm -r) && x"]) {
      expect(showExactly(text)).toBe(text);
    }
  });

  it("writes out what would not show or reorders the text", () => {
    expect(showExactly("a\nb\tc\r")).toBe("a\\nb\\tc\\r");
    expect(showExactly("safe\u202ehs.live")).toBe("safe\\u{202e}hs.live");
    expect(showExactly("a\u200bb\u0000")).toBe("a\\u{200b}b\\u{0}");
    expect(showExactly("a\u2028b")).toBe("a\\u{2028}b");
  });

  it("cannot be confused with text that holds the same characters", () => {
    expect(showExactly("a\\n\n")).toBe("a\\\\n\\n");
  });
});
