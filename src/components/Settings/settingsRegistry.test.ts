import { describe, it, expect } from "vitest";
import {
  filterSettings,
  getMatchingCategories,
  SETTINGS_REGISTRY,
  CATEGORIES,
} from "./settingsRegistry";
import { EXPERIMENTAL_SETTING_LABEL, EXPERIMENTAL_SETTING_PATH } from "@/utils/experimentalSetting";

describe("settingsRegistry", () => {
  describe("filterSettings", () => {
    it("returns all settings for empty query", () => {
      expect(filterSettings("", { experimental: true })).toEqual(SETTINGS_REGISTRY);
      expect(filterSettings("  ", { experimental: true })).toEqual(SETTINGS_REGISTRY);
    });

    it("omits experimental-only entries unless experimental features are on (#5365)", () => {
      const experimentalIds = SETTINGS_REGISTRY.filter((s) => s.experimental).map((s) => s.id);
      expect(experimentalIds).toContain("rdpTrustedCertificates");
      // Default (gate off): neither an empty query nor any synonym reaches them.
      expect(filterSettings("").some((s) => s.experimental)).toBe(false);
      for (const query of ["rdp", "remote desktop", "certificate", "fingerprint", "mitm"]) {
        expect(filterSettings(query).some((s) => s.id === "rdpTrustedCertificates")).toBe(false);
        expect(
          filterSettings(query, { experimental: false }).some(
            (s) => s.id === "rdpTrustedCertificates"
          )
        ).toBe(false);
        expect(
          filterSettings(query, { experimental: true }).some(
            (s) => s.id === "rdpTrustedCertificates"
          )
        ).toBe(true);
      }
      // "rdp" matches nothing else, so its category is not highlighted while gated.
      expect(getMatchingCategories("rdp").has("security")).toBe(false);
      expect(getMatchingCategories("rdp", { experimental: true }).has("security")).toBe(true);
    });

    it("matches by label", () => {
      const results = filterSettings("Font Size");
      expect(results.some((s) => s.id === "fontSize")).toBe(true);
    });

    it("matches by keyword", () => {
      const results = filterSettings("monospace");
      expect(results.some((s) => s.id === "fontFamily")).toBe(true);
    });

    it("finds the imported workspace confirmations by allowlist and imported (#4445)", () => {
      for (const query of ["allowlist", "imported", "revoke"]) {
        const results = filterSettings(query);
        expect(results.some((s) => s.id === "workspaceImportConfirmations")).toBe(true);
      }
    });

    it("finds the MobaXterm import by mobaxterm, import and migrate (#4850)", () => {
      for (const query of ["mobaxterm", "import", "migrate", "MobaXterm"]) {
        const results = filterSettings(query);
        expect(results.some((s) => s.id === "importMobaxterm")).toBe(true);
        expect(getMatchingCategories(query).has("import")).toBe(true);
      }
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
        "networkToolHistoryEnabled",
      ]) {
        expect(categoryOf(id)).toBe("sessions");
      }
    });

    it("groups confirm/warn prompts under a Safety Prompts category", () => {
      for (const id of [
        "confirmCloseTabOnShortcut",
        "confirmCloseLiveSession",
        "confirmCloseAttachedTab",
        "confirmUndoableDelete",
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

    it("keeps only connection/shell/SSH defaults, the diagnostics controls, and the experimental flag in General", () => {
      const general = SETTINGS_REGISTRY.filter((s) => s.category === "general").map((s) => s.id);
      expect(general).toEqual([
        "defaultUser",
        "defaultSshKeyPath",
        "defaultShell",
        "defaultShellIntegration",
        "defaultX11Forwarding",
        "fileLogLevel",
        "showCrashReportNotice",
        "experimentalFeaturesEnabled",
      ]);
    });
  });

  describe("the experimental-features setting has one name (#5363)", () => {
    it("is labelled with the shared name every pointer to it uses", () => {
      const entry = SETTINGS_REGISTRY.find((s) => s.id === "experimentalFeaturesEnabled");
      expect(entry?.label).toBe(EXPERIMENTAL_SETTING_LABEL);
      expect(EXPERIMENTAL_SETTING_LABEL).toBe("Allow Experimental Features");
      expect(EXPERIMENTAL_SETTING_PATH).toBe("Settings ▸ General ▸ Allow Experimental Features");
    });

    it("is found by searching for the name pointers use", () => {
      expect(
        filterSettings("allow experimental features").some(
          (s) => s.id === "experimentalFeaturesEnabled"
        )
      ).toBe(true);
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
