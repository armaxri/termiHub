import { describe, it, expect } from "vitest";
import { ITEM_DESCRIPTION_MAX_LENGTH, normalizeItemDescription } from "./itemDescription";

describe("normalizeItemDescription (#5757)", () => {
  it("keeps one line: breaks become spaces and runs collapse", () => {
    expect(normalizeItemDescription("  Main\n web   box \r\n")).toBe("Main web box");
  });

  it("treats empty and blank input as no description", () => {
    expect(normalizeItemDescription("")).toBeUndefined();
    expect(normalizeItemDescription("   ")).toBeUndefined();
    expect(normalizeItemDescription(undefined)).toBeUndefined();
    expect(normalizeItemDescription(null)).toBeUndefined();
  });

  it("caps descriptions at a short single line", () => {
    expect(ITEM_DESCRIPTION_MAX_LENGTH).toBe(80);
  });
});
