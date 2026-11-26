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

    it("still finds settings by their old Title Case labels (#5391)", () => {
      const oldLabels: [string, string][] = [
        ["Font Family", "fontFamily"],
        ["Restore Last Session on Startup", "restoreLastSessionOnStartup"],
        ["Warn Before a Large Port Scan", "warnLargePortScan"],
        ["Provide X Server Automatically", "provideXServerAutomatically"],
        ["Check for Plugin Updates Automatically", "pluginUpdateCheckEnabled"],
        ["Command Marks (Shell Hook) by Default", "defaultShellIntegration"],
        // The labels before #5633 grouped both toggles under Terminal ▸ Command marks.
        ["Command marks by default", "defaultShellIntegration"],
        ["Command status marks", "terminalCommandDecorations"],
      ];
      for (const [query, id] of oldLabels) {
        expect(filterSettings(query).some((s) => s.id === id)).toBe(true);
      }
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

    it("files the host-monitoring settings under Monitoring (#5775)", () => {
      for (const id of ["powerMonitoring", "monitorLocalShells", "statusBarMetrics"]) {
        expect(categoryOf(id)).toBe("monitoring");
        // The pre-#5775 home was External files ▸ Advanced; its words still find them.
        for (const query of ["monitoring", "advanced", "external"]) {
          expect(filterSettings(query).some((s) => s.id === id)).toBe(true);
        }
      }
    });

    it("files the File browser default with the connection defaults (#5786, #5860)", () => {
      expect(categoryOf("fileBrowser")).toBe("connection-defaults");
      // The old homes' words (External files ▸ Advanced, General) and the new ones all find it.
      for (const query of [
        "file browser",
        "sftp",
        "advanced",
        "external",
        "general",
        "new connection",
        "connection defaults",
      ]) {
        expect(
          filterSettings(query).some((s) => s.id === "fileBrowser"),
          query
        ).toBe(true);
      }
      // External files now holds only the external connection file list.
      expect(
        SETTINGS_REGISTRY.filter((s) => s.category === "external-files").map((s) => s.id)
      ).toEqual(["externalConnectionFiles"]);
    });

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
        "closeLiveSessionConfirm",
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

    it("files both command-mark toggles under Terminal, side by side (#5633)", () => {
      expect(categoryOf("terminalCommandDecorations")).toBe("terminal");
      expect(categoryOf("defaultShellIntegration")).toBe("terminal");
      const ids = SETTINGS_REGISTRY.map((s) => s.id);
      expect(ids.indexOf("defaultShellIntegration")).toBe(
        ids.indexOf("terminalCommandDecorations") + 1
      );
    });

    it("keeps the default shell, the diagnostics controls, and the experimental flag in General", () => {
      const general = SETTINGS_REGISTRY.filter((s) => s.category === "general").map((s) => s.id);
      expect(general).toEqual([
        "defaultShell",
        "fileLogLevel",
        "showCrashReportNotice",
        "experimentalFeaturesEnabled",
      ]);
    });
  });

  describe("settings grouped by object (#5860)", () => {
    const categoryOf = (id: string) => SETTINGS_REGISTRY.find((s) => s.id === id)?.category;
    /** Each moved setting, where it was, and where it is. */
    const MOVED: [id: string, was: string, now: string][] = [
      ["defaultUser", "general", "connection-defaults"],
      ["defaultSshKeyPath", "general", "connection-defaults"],
      ["defaultX11Forwarding", "general", "connection-defaults"],
      ["fileBrowser", "general", "connection-defaults"],
    ];

    it.each(MOVED)("files %s under %s's successor %s", (id, _was, now) => {
      expect(categoryOf(id)).toBe(now);
    });

    it.each(MOVED)("finds %s by its old category word %s and its new one", (id, was, now) => {
      for (const query of [was, now, "connections"]) {
        expect(
          filterSettings(query).some((s) => s.id === id),
          query
        ).toBe(true);
      }
    });

    it("finds what was in the folded Advanced group by that word, and by its own", () => {
      for (const [id, own] of [
        ["schedules", "schedules"],
        ["pluginSettings", "plugins"],
        ["importSshConfig", "import"],
        ["portableMode", "portable"],
        ["provideXServerAutomatically", "x server"],
      ]) {
        for (const query of ["advanced", own]) {
          expect(
            filterSettings(query).some((s) => s.id === id),
            `${id}: ${query}`
          ).toBe(true);
        }
      }
    });

    it("finds the one password backup by its old name and actions", () => {
      for (const query of ["credential vault backup", "export vault", "import vault"]) {
        const ids = filterSettings(query).map((s) => s.id);
        expect(ids, query).toContain("credentialVaultBackup");
        expect(ids, query).toContain("backupRestore");
      }
    });
  });

  describe("the experimental-features setting has one name (#5363)", () => {
    it("is labelled with the shared name every pointer to it uses", () => {
      const entry = SETTINGS_REGISTRY.find((s) => s.id === "experimentalFeaturesEnabled");
      expect(entry?.label).toBe(EXPERIMENTAL_SETTING_LABEL);
      expect(EXPERIMENTAL_SETTING_LABEL).toBe("Allow experimental features");
      expect(EXPERIMENTAL_SETTING_PATH).toBe("Settings ▸ General ▸ Allow experimental features");
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

    it("offers one live-session close choice instead of two overlapping toggles (#5844)", () => {
      expect(labelOf("closeLiveSessionConfirm")).toBe("Ask before closing a live session");
      expect(labelOf("confirmCloseTabOnShortcut")).toBeUndefined();
      expect(labelOf("confirmCloseLiveSession")).toBeUndefined();
    });

    it("describes the persistent-session tab as a one-time notice, not a confirm", () => {
      expect(labelOf("confirmCloseAttachedTab")).toBe(
        "Show a one-time notice when closing a persistent-session tab"
      );
    });

    it("gives the two adjacent close settings distinct labels", () => {
      const labels = ["closeLiveSessionConfirm", "confirmCloseAttachedTab"].map(labelOf);
      expect(new Set(labels).size).toBe(2);
    });
  });

  describe("file manager integration category (#5616)", () => {
    it("is named for the menu entry it adds, not OSC 133 shell integration (#5845)", () => {
      expect(CATEGORIES.find((c) => c.id === "shell-integration")?.label).toBe("Open in termiHub");
    });

    it("is found by its name and its earlier names", () => {
      for (const query of [
        "open in termihub",
        "file manager integration",
        "shell integration",
        "finder",
        "explorer",
      ]) {
        expect(getMatchingCategories(query).has("shell-integration")).toBe(true);
      }
    });
  });
});
