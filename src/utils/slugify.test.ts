import { describe, it, expect } from "vitest";
import { slugify } from "./slugify";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("My Cool Macro", "macro")).toBe("my-cool-macro");
  });

  it("collapses runs of non-alphanumerics into a single hyphen", () => {
    expect(slugify("a  --  b__c!!d", "x")).toBe("a-b-c-d");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugify("  !!hello!!  ", "x")).toBe("hello");
  });

  it("returns the fallback when the name has no alphanumerics", () => {
    expect(slugify("!!!", "workflow")).toBe("workflow");
    expect(slugify("", "macro")).toBe("macro");
  });

  it("uses the caller-supplied fallback verbatim", () => {
    expect(slugify("---", "custom-default")).toBe("custom-default");
  });

  it("keeps digits", () => {
    expect(slugify("Backup 2026", "x")).toBe("backup-2026");
  });
});
