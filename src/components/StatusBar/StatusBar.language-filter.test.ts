/**
 * Tests for the status-bar language picker filter (#4582): it routes through the
 * shared case- and diacritic-insensitive substring matcher.
 */
import { describe, it, expect } from "vitest";
import { filterLanguages } from "./StatusBar";

const languages = [
  { id: "typescript", name: "TypeScript" },
  { id: "francais", name: "Français" },
  { id: "rust", name: "Rust" },
];

describe("filterLanguages", () => {
  it("returns every language for an empty or blank search", () => {
    expect(filterLanguages(languages, "")).toBe(languages);
    expect(filterLanguages(languages, "   ")).toBe(languages);
  });

  it("matches the name or the id case-insensitively", () => {
    expect(filterLanguages(languages, "SCRIPT").map((l) => l.id)).toEqual(["typescript"]);
    expect(filterLanguages(languages, "rus").map((l) => l.id)).toEqual(["rust"]);
  });

  it("matches diacritic-insensitively", () => {
    const withUmlaut = [...languages, { id: "mueller-dsl", name: "Müller DSL" }];
    expect(filterLanguages(withUmlaut, "muller").map((l) => l.id)).toEqual(["mueller-dsl"]);
    expect(filterLanguages(withUmlaut, "FRANÇ").map((l) => l.id)).toEqual(["francais"]);
  });

  it("returns nothing when no language matches", () => {
    expect(filterLanguages(languages, "cobol")).toEqual([]);
  });
});
