import { describe, it, expect } from "vitest";
import { parseTags } from "./parseTags";

describe("parseTags", () => {
  it("splits a comma-separated string into trimmed tags", () => {
    expect(parseTags("a, b ,  c")).toEqual(["a", "b", "c"]);
  });

  it("drops empty entries", () => {
    expect(parseTags("a,,b, ,c")).toEqual(["a", "b", "c"]);
  });

  it("de-duplicates while preserving first-seen order", () => {
    expect(parseTags("b, a, b, a, c")).toEqual(["b", "a", "c"]);
  });

  it("returns an empty list for an empty or whitespace-only string", () => {
    expect(parseTags("")).toEqual([]);
    expect(parseTags("   ")).toEqual([]);
    expect(parseTags(" , , ")).toEqual([]);
  });

  it("does not trim within a tag, only its ends", () => {
    expect(parseTags(" hello world , foo ")).toEqual(["hello world", "foo"]);
  });
});
