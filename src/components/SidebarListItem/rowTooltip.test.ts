import { describe, it, expect } from "vitest";
import { rowTooltipDescription, tagsLine } from "./rowTooltip";

describe("rowTooltip (#5757)", () => {
  it("joins the lines as sentences and drops blank ones", () => {
    expect(rowTooltipDescription(["On connect · prod", " ", "Tags: a"])).toBe(
      "On connect · prod. Tags: a"
    );
  });

  it("runs a heading line ending in a colon into the next line", () => {
    expect(rowTooltipDescription(["Types:", "echo one", "echo two"])).toBe(
      "Types: echo one. echo two"
    );
  });

  it("is undefined without lines", () => {
    expect(rowTooltipDescription(undefined)).toBeUndefined();
    expect(rowTooltipDescription(["", "  "])).toBeUndefined();
  });

  it("lists tags, or nothing without any", () => {
    expect(tagsLine(["ops", "prod"])).toBe("Tags: ops, prod");
    expect(tagsLine([])).toBeNull();
  });
});
