import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { SETTINGS_REGISTRY, filterSettings, type SettingsCategory } from "./settingsRegistry";

/**
 * Registry-coverage guard (#2828).
 *
 * Settings search is driven entirely by `SETTINGS_REGISTRY`: a panel only
 * shows a field during search when that field's id is in the matched set it
 * receives as `visibleFields`. A field that a panel gates with `show("x")`
 * (or `visibleFields.has("x")`) but that has no registry entry is therefore
 * rendered in the normal category view yet can never be found by search —
 * exactly how the SSH default toggles and Line Height went missing.
 *
 * Rather than a hand-maintained list of setting ids, this test derives the
 * rendered setting keys from the panels' own gating calls, so a new field
 * added with the standard `show()` pattern is covered automatically.
 */

const SETTINGS_DIR = dirname(fileURLToPath(import.meta.url));

/** Matches `show("id")` and `visibleFields.has("id")` / `visibleFields?.has("id")`. */
const GATE_PATTERNS = [
  /\bshow\(\s*"([A-Za-z0-9_]+)"\s*\)/g,
  /\bvisibleFields\??\.has\(\s*"([A-Za-z0-9_]+)"\s*\)/g,
];

/**
 * The category under which `SettingsPanel` renders each gated panel in search
 * mode. A setting's registry category must match, otherwise search highlights
 * the wrong category and the panel that owns the field is never mounted.
 */
const PANEL_CATEGORY: Record<string, SettingsCategory> = {
  "GeneralSettings.tsx": "general",
  "SerialPortSettings.tsx": "serial",
  "AppearanceSettings.tsx": "appearance",
  "TerminalSettings.tsx": "terminal",
  // Rendered inside TerminalSettings.
  "SyntaxHighlightingSettings.tsx": "terminal",
  "AccessibilitySettings.tsx": "accessibility",
  "KeyboardSettings.tsx": "keyboard",
  "SessionSettings.tsx": "sessions",
  "SafetyPromptSettings.tsx": "safety-prompts",
  "XServerSettings.tsx": "x-server",
  "SecuritySettings.tsx": "security",
  "RdpTrustSettings.tsx": "security",
  "SshTrustSettings.tsx": "security",
  // Rendered inside EditorSettingsSection.
  "FileTypeSettings.tsx": "editor",
  "LanguagePackagesSettings.tsx": "editor",
  "CustomGrammarsSettings.tsx": "editor",
};

/**
 * Panels that use the gating pattern but are deliberately NOT part of the
 * Settings search surface. Each entry must say why; the test also verifies
 * the claim still holds (the panel is not mounted by `SettingsPanel`).
 */
const NOT_IN_SETTINGS_SEARCH: Record<string, string> = {
  "UpdateSettings.tsx":
    "Rendered only by the Updates overlay view (OverlayViewPanel), never by SettingsPanel, " +
    "so it never receives visibleFields and has no Settings category to be searched under.",
};

/**
 * Categories whose panels are mounted whole during search (no per-field
 * gating). Their registry entries make the category searchable rather than
 * gating individual fields, so they need not match a `show()` call.
 */
const WHOLE_PANEL_CATEGORIES = new Set<SettingsCategory>([
  "shell-integration",
  "plugins",
  "backup",
  "portable",
]);

function panelSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const name of readdirSync(SETTINGS_DIR)) {
    if (!name.endsWith(".tsx") || name.includes(".test.")) continue;
    sources.set(name, readFileSync(join(SETTINGS_DIR, name), "utf8"));
  }
  return sources;
}

function gatedKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const pattern of GATE_PATTERNS) {
    for (const match of source.matchAll(pattern)) keys.add(match[1]);
  }
  return keys;
}

const SOURCES = panelSources();
const GATED_BY_PANEL = new Map(
  [...SOURCES].map(([file, src]) => [file, gatedKeys(src)] as const).filter(([, k]) => k.size > 0)
);
const REGISTRY_BY_ID = new Map(SETTINGS_REGISTRY.map((s) => [s.id, s]));

describe("settings registry coverage (#2828)", () => {
  it("discovers gated settings in the panels (sanity check on the extractor)", () => {
    const total = [...GATED_BY_PANEL.values()].reduce((n, keys) => n + keys.size, 0);
    expect(total).toBeGreaterThan(30);
    expect(GATED_BY_PANEL.get("GeneralSettings.tsx")).toContain("defaultUser");
  });

  it("maps every gated panel to a search category or an explicit, justified exclusion", () => {
    const unmapped = [...GATED_BY_PANEL.keys()].filter(
      (file) => !(file in PANEL_CATEGORY) && !(file in NOT_IN_SETTINGS_SEARCH)
    );
    expect(unmapped).toEqual([]);
  });

  it("keeps the exclusion list honest: excluded panels are not mounted by SettingsPanel", () => {
    const settingsPanel = SOURCES.get("SettingsPanel.tsx") ?? "";
    for (const file of Object.keys(NOT_IN_SETTINGS_SEARCH)) {
      const component = file.replace(/\.tsx$/, "");
      expect(settingsPanel, `${component} is now rendered by SettingsPanel`).not.toMatch(
        new RegExp(`<${component}\\b`)
      );
    }
  });

  it("has a registry entry for every setting a searchable panel gates on", () => {
    const missing: string[] = [];
    for (const [file, keys] of GATED_BY_PANEL) {
      if (file in NOT_IN_SETTINGS_SEARCH) continue;
      for (const key of keys) {
        if (!REGISTRY_BY_ID.has(key)) missing.push(`${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("files each gated setting under the category of the panel that renders it", () => {
    const miscategorized: string[] = [];
    for (const [file, keys] of GATED_BY_PANEL) {
      const category = PANEL_CATEGORY[file];
      if (!category) continue;
      for (const key of keys) {
        const entry = REGISTRY_BY_ID.get(key);
        if (entry && entry.category !== category) {
          miscategorized.push(`${key}: registry=${entry.category}, rendered in ${category}`);
        }
      }
    }
    expect(miscategorized).toEqual([]);
  });

  it("has no registry entry that no panel renders", () => {
    const allGated = new Set([...GATED_BY_PANEL.values()].flatMap((keys) => [...keys]));
    const orphaned = SETTINGS_REGISTRY.filter(
      (s) => !allGated.has(s.id) && !WHOLE_PANEL_CATEGORIES.has(s.category)
    ).map((s) => s.id);
    expect(orphaned).toEqual([]);
  });

  describe("previously unsearchable settings are now found by search", () => {
    const finds = (query: string, id: string) => filterSettings(query).some((s) => s.id === id);

    it("finds the SSH shell-integration default", () => {
      expect(finds("shell integration", "defaultShellIntegration")).toBe(true);
      expect(finds("osc 7", "defaultShellIntegration")).toBe(true);
    });

    it("finds the SSH X11-forwarding default", () => {
      expect(finds("x11 forwarding", "defaultX11Forwarding")).toBe(true);
    });

    it("finds line height", () => {
      expect(finds("line height", "lineHeight")).toBe(true);
      expect(finds("box-drawing", "lineHeight")).toBe(true);
    });
  });
});
