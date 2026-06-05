import { describe, it, expect } from "vitest";
import {
  DEFAULT_LINE_ENDING,
  LINE_ENDING_OPTIONS,
  lineEndingLabel,
  resolveLineEnding,
} from "./lineEndings";

describe("resolveLineEnding", () => {
  it("prefers the per-connection override", () => {
    expect(resolveLineEnding("crlf", "lf")).toBe("crlf");
  });

  it("falls back to the global default when no override is set", () => {
    expect(resolveLineEnding(undefined, "cr")).toBe("cr");
  });

  it("falls back to the built-in default (LF) when nothing is configured", () => {
    expect(resolveLineEnding(undefined, undefined)).toBe("lf");
    expect(DEFAULT_LINE_ENDING).toBe("lf");
  });
});

describe("LINE_ENDING_OPTIONS / lineEndingLabel", () => {
  it("offers exactly the three supported endings", () => {
    expect(LINE_ENDING_OPTIONS.map((o) => o.value)).toEqual(["lf", "cr", "crlf"]);
  });

  it("returns the matching option label for each ending", () => {
    for (const opt of LINE_ENDING_OPTIONS) {
      expect(lineEndingLabel(opt.value)).toBe(opt.label);
    }
  });
});
