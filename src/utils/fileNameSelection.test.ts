import { describe, it, expect } from "vitest";
import { baseNameSelectionEnd } from "./fileNameSelection";

describe("baseNameSelectionEnd", () => {
  it("selects the base name of a file, preserving the extension", () => {
    // "report.pdf" → select "report" (chars 0..6)
    expect(baseNameSelectionEnd("report.pdf")).toBe(6);
    expect(baseNameSelectionEnd("a.txt")).toBe(1);
  });

  it("selects up to the last dot for multi-part extensions", () => {
    // "archive.tar.gz" → select "archive.tar"
    expect(baseNameSelectionEnd("archive.tar.gz")).toBe("archive.tar".length);
  });

  it("selects the whole name when there is no extension", () => {
    expect(baseNameSelectionEnd("README")).toBe("README".length);
  });

  it("selects the whole name for dotfiles (leading dot only)", () => {
    // ".bashrc" has no real extension — select the entire name.
    expect(baseNameSelectionEnd(".bashrc")).toBe(".bashrc".length);
    expect(baseNameSelectionEnd(".gitignore")).toBe(".gitignore".length);
  });

  it("selects the whole name for a trailing dot", () => {
    expect(baseNameSelectionEnd("weird.")).toBe("weird.".length);
  });

  it("handles an empty name", () => {
    expect(baseNameSelectionEnd("")).toBe(0);
  });
});
