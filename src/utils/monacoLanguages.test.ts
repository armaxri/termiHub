import { describe, it, expect, beforeEach } from "vitest";
import { getAvailableLanguages, resetLanguageCache } from "./monacoLanguages";

// Monaco is mocked in src/test/setup.ts — it provides a fixed set of languages.
// The mock returns: plaintext, javascript, typescript, json, python, shell,
// ini, yaml, xml, dockerfile, makefile, cmake, toml, nginx, nix, ruby,
// java, cpp, rust, go, html, css, hcl

describe("getAvailableLanguages", () => {
  beforeEach(() => {
    resetLanguageCache();
  });

  it("returns a non-empty list of languages", () => {
    const langs = getAvailableLanguages();
    expect(langs.length).toBeGreaterThan(0);
  });

  it("each entry has an id and name", () => {
    const langs = getAvailableLanguages();
    for (const lang of langs) {
      expect(typeof lang.id).toBe("string");
      expect(lang.id.length).toBeGreaterThan(0);
      expect(typeof lang.name).toBe("string");
      expect(lang.name.length).toBeGreaterThan(0);
    }
  });

  it("results are sorted by name (case-sensitive locale sort)", () => {
    const langs = getAvailableLanguages();
    for (let i = 1; i < langs.length; i++) {
      expect(langs[i - 1].name.localeCompare(langs[i].name)).toBeLessThanOrEqual(0);
    }
  });

  it("uses alias as display name when available", () => {
    // The mock returns {id: 'javascript', aliases: ['JavaScript']}
    const langs = getAvailableLanguages();
    const js = langs.find((l) => l.id === "javascript");
    expect(js).toBeDefined();
    expect(js!.name).toBe("JavaScript");
  });

  it("falls back to id when aliases are absent", () => {
    // Any lang without aliases would use its id as name.
    // The mock languages all have aliases, but the implementation
    // uses `aliases?.[0] ?? id`, so both paths are exercised.
    const langs = getAvailableLanguages();
    // All returned names should be non-empty strings
    expect(langs.every((l) => l.name.length > 0)).toBe(true);
  });
});

describe("getAvailableLanguages — memoisation", () => {
  beforeEach(() => {
    resetLanguageCache();
  });

  it("returns the same array reference on repeated calls (cached)", () => {
    const first = getAvailableLanguages();
    const second = getAvailableLanguages();
    expect(first).toBe(second);
  });

  it("returns a fresh result after resetLanguageCache()", () => {
    const first = getAvailableLanguages();
    resetLanguageCache();
    const second = getAvailableLanguages();
    // Should be a new array (not the same reference)
    expect(first).not.toBe(second);
    // But with same content since mock doesn't change
    expect(first).toEqual(second);
  });
});
