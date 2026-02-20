import { describe, it, expect } from "vitest";
import { filterSettings, getMatchingCategories, SETTINGS_REGISTRY, CATEGORIES } from "./settingsRegistry";

describe("settingsRegistry", () => {
  describe("filterSettings", () => {
    it("returns all settings for empty query", () => {
      expect(filterSettings("")).toEqual(SETTINGS_REGISTRY);
      expect(filterSettings("  ")).toEqual(SETTINGS_REGISTRY);
    });

    it("matches by label", () => {
      const results = filterSettings("Font Size");
      expect(results.some((s) => s.id === "fontSize")).toBe(true);
    });

    it("matches by keyword", () => {
      const results = filterSettings("monospace");
      expect(results.some((s) => s.id === "fontFamily")).toBe(true);
    });

    it("matches by description", () => {
      const results = filterSettings("scrollback buffer");
      expect(results.some((s) => s.id === "scrollbackBuffer")).toBe(true);
    });

    it("is case insensitive", () => {
      const results = filterSettings("CURSOR");
      expect(results.length).toBeGreaterThanOrEqual(2);
      expect(results.some((s) => s.id === "cursorStyle")).toBe(true);
      expect(results.some((s) => s.id === "cursorBlink")).toBe(true);
    });

    it("returns empty for non-matching query", () => {
      expect(filterSettings("xyznonexistent")).toHaveLength(0);
    });
  });

  describe("getMatchingCategories", () => {
    it("returns all categories for empty query", () => {
      const cats = getMatchingCategories("");
      for (const cat of CATEGORIES) {
        if (cat.id !== "external-files") {
          expect(cats.has(cat.id)).toBe(true);
        }
      }
    });

    it("returns only the matching category", () => {
      const cats = getMatchingCategories("theme");
      expect(cats.has("appearance")).toBe(true);
      expect(cats.has("terminal")).toBe(false);
    });
  });
});
