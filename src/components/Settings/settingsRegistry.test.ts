import { describe, it, expect } from "vitest";
import {
  filterSettings,
  getMatchingCategories,
  SETTINGS_REGISTRY,
  CATEGORIES,
} from "./settingsRegistry";

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

    it("returns security category for credential search", () => {
      const cats = getMatchingCategories("credential");
      expect(cats.has("security")).toBe(true);
      expect(cats.has("general")).toBe(false);
    });
  });

  describe("information architecture (UX-029)", () => {
    const categoryOf = (id: string) => SETTINGS_REGISTRY.find((s) => s.id === id)?.category;

    it("routes every setting to a category that exists in the nav", () => {
      const navIds = new Set(CATEGORIES.map((c) => c.id));
      for (const setting of SETTINGS_REGISTRY) {
        expect(navIds.has(setting.category)).toBe(true);
      }
    });

    it("moves serial port scanning out of General into its own Serial category", () => {
      expect(categoryOf("serialPortScanPrefixes")).toBe("serial");
    });

    it("groups session restore + history under a Sessions category", () => {
      for (const id of [
        "restoreLastSessionOnStartup",
        "sessionHistoryEnabled",
        "sessionHistoryLimit",
        "showRecentSessions",
      ]) {
        expect(categoryOf(id)).toBe("sessions");
      }
    });

    it("groups confirm/warn prompts under a Safety Prompts category", () => {
      for (const id of [
        "confirmCloseTabOnShortcut",
        "confirmCloseLiveSession",
        "confirmCloseAttachedTab",
        "warnLargePortScan",
        "warnLargePingSweep",
      ]) {
        expect(categoryOf(id)).toBe("safety-prompts");
      }
    });

    it("groups X server provisioning under an X Server category", () => {
      for (const id of ["provideXServerAutomatically", "stopXServerWhenIdle"]) {
        expect(categoryOf(id)).toBe("x-server");
      }
    });

    it("keeps only connection/shell defaults and the experimental flag in General", () => {
      const general = SETTINGS_REGISTRY.filter((s) => s.category === "general").map((s) => s.id);
      expect(general).toEqual([
        "defaultUser",
        "defaultSshKeyPath",
        "defaultShell",
        "experimentalFeaturesEnabled",
      ]);
    });
  });

  describe("search follows relocated settings (UX-029)", () => {
    it("still finds serial scanning by keyword and routes it to Serial", () => {
      expect(filterSettings("ttyAMA").some((s) => s.id === "serialPortScanPrefixes")).toBe(true);
      expect(getMatchingCategories("serial port").has("serial")).toBe(true);
    });

    it("still finds session history and routes it to Sessions", () => {
      expect(filterSettings("recent sessions").some((s) => s.id === "sessionHistoryEnabled")).toBe(
        true
      );
      expect(getMatchingCategories("session history").has("sessions")).toBe(true);
    });

    it("still finds X server provisioning and routes it to X Server", () => {
      expect(filterSettings("x11").some((s) => s.id === "provideXServerAutomatically")).toBe(true);
      expect(getMatchingCategories("x server").has("x-server")).toBe(true);
    });

    it("still finds the close confirmations and routes them to Safety Prompts", () => {
      expect(getMatchingCategories("confirm close").has("safety-prompts")).toBe(true);
      expect(getMatchingCategories("ping sweep").has("safety-prompts")).toBe(true);
    });
  });

  describe("close-confirmation labels are precise and differentiated (UX-030)", () => {
    const labelOf = (id: string) => SETTINGS_REGISTRY.find((s) => s.id === id)?.label;

    it("names the keyboard-shortcut trigger", () => {
      expect(labelOf("confirmCloseTabOnShortcut")).toBe(
        "Confirm before closing a tab via keyboard shortcut"
      );
    });

    it("names the live-session trigger", () => {
      expect(labelOf("confirmCloseLiveSession")).toBe(
        "Confirm before closing a tab with a live session"
      );
    });

    it("describes the persistent-session tab as a one-time notice, not a confirm", () => {
      expect(labelOf("confirmCloseAttachedTab")).toBe(
        "Show a one-time notice when closing a persistent-session tab"
      );
    });

    it("gives the three adjacent toggles distinct labels", () => {
      const labels = [
        "confirmCloseTabOnShortcut",
        "confirmCloseLiveSession",
        "confirmCloseAttachedTab",
      ].map(labelOf);
      expect(new Set(labels).size).toBe(3);
    });
  });
});
