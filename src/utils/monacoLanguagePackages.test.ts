import { describe, it, expect } from "vitest";
import { ALL_LANGUAGE_PACKAGES, BUILTIN_PACKAGE_IDS } from "./monacoLanguagePackages";

describe("monacoLanguagePackages", () => {
  describe("BUILTIN_PACKAGE_IDS", () => {
    it("contains the expected built-in language IDs", () => {
      expect(BUILTIN_PACKAGE_IDS.has("cmake")).toBe(true);
      expect(BUILTIN_PACKAGE_IDS.has("toml")).toBe(true);
      expect(BUILTIN_PACKAGE_IDS.has("nginx")).toBe(true);
      expect(BUILTIN_PACKAGE_IDS.has("nix")).toBe(true);
      expect(BUILTIN_PACKAGE_IDS.has("lua")).toBe(true);
    });

    it("does not contain arbitrary language IDs", () => {
      expect(BUILTIN_PACKAGE_IDS.has("python")).toBe(false);
      expect(BUILTIN_PACKAGE_IDS.has("javascript")).toBe(false);
      expect(BUILTIN_PACKAGE_IDS.has("astro")).toBe(false);
    });
  });

  describe("ALL_LANGUAGE_PACKAGES", () => {
    it("contains entries for all Shiki bundled languages (mocked set)", () => {
      // In the test environment shiki is mocked with a subset of languages.
      expect(ALL_LANGUAGE_PACKAGES.length).toBeGreaterThan(0);
    });

    it("each entry has id and name", () => {
      for (const pkg of ALL_LANGUAGE_PACKAGES) {
        expect(typeof pkg.id).toBe("string");
        expect(pkg.id.length).toBeGreaterThan(0);
        expect(typeof pkg.name).toBe("string");
        expect(pkg.name.length).toBeGreaterThan(0);
      }
    });

    it("is sorted by display name", () => {
      const names = ALL_LANGUAGE_PACKAGES.map((p) => p.name);
      const sorted = [...names].sort((a, b) => a.localeCompare(b));
      expect(names).toEqual(sorted);
    });

    it("includes built-in package IDs", () => {
      const ids = new Set(ALL_LANGUAGE_PACKAGES.map((p) => p.id));
      for (const id of BUILTIN_PACKAGE_IDS) {
        expect(ids.has(id)).toBe(true);
      }
    });
  });
});
