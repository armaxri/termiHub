import { describe, it, expect, beforeEach } from "vitest";
import {
  clearRegisteredPluginThemes,
  findRegisteredPluginTheme,
  getRegisteredPluginThemes,
  isPluginThemeSetting,
  loadPluginThemes,
  parsePluginTheme,
  PluginThemeError,
  pluginThemeId,
  setRegisteredPluginThemes,
  type PluginFileReader,
} from "./pluginThemes";
import { resolveTheme } from "./engine";
import { COLOR_TOKEN_KEYS } from "./colorTokens";
import { darkTheme } from "./dark";
import type { ThemeEntry } from "@/types/plugin";

/** Build a complete, valid `colors` object with every required token present. */
function fullColors(overrides: Record<string, string> = {}): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const key of COLOR_TOKEN_KEYS) colors[key] = "#123456";
  return { ...colors, ...overrides };
}

/** Serialise a plugin theme file with a full palette, allowing field overrides. */
function themeJson(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ colorScheme: "dark", colors: fullColors(), ...fields });
}

const entry = (id: string, name: string, file = `${id}.json`): ThemeEntry => ({ id, name, file });

/** A reader backed by an in-memory `path -> contents` map, tracking reads. */
function fakeReader(files: Record<string, string>): {
  read: PluginFileReader;
  paths: string[];
} {
  const paths: string[] = [];
  const read: PluginFileReader = (_pluginId, path) => {
    paths.push(path);
    const contents = files[path];
    if (contents === undefined) return Promise.reject(new Error(`no such file: ${path}`));
    return Promise.resolve(new TextEncoder().encode(contents));
  };
  return { read, paths };
}

describe("plugin theme id / setting encoding", () => {
  it("builds a namespaced plugin:<pluginId>:<themeId> id", () => {
    expect(pluginThemeId("acme", "midnight")).toBe("plugin:acme:midnight");
  });

  it("recognises plugin theme settings and rejects others", () => {
    expect(isPluginThemeSetting("plugin:acme:midnight")).toBe(true);
    expect(isPluginThemeSetting("custom:abc")).toBe(false);
    expect(isPluginThemeSetting("dark")).toBe(false);
    expect(isPluginThemeSetting(undefined)).toBe(false);
  });
});

describe("parsePluginTheme", () => {
  it("parses a valid file into a namespaced, fully-populated theme", () => {
    const theme = parsePluginTheme("acme", entry("midnight", "Midnight"), themeJson());
    expect(theme.id).toBe("plugin:acme:midnight");
    expect(theme.name).toBe("Midnight");
    expect(theme.colorScheme).toBe("dark");
    for (const key of COLOR_TOKEN_KEYS) {
      expect(typeof theme.colors[key]).toBe("string");
      expect(theme.colors[key]).not.toBe("");
    }
  });

  it("takes colorScheme from the file, defaulting to dark", () => {
    expect(
      parsePluginTheme("p", entry("a", "A"), themeJson({ colorScheme: "light" })).colorScheme
    ).toBe("light");
    expect(
      parsePluginTheme("p", entry("a", "A"), themeJson({ colorScheme: "weird" })).colorScheme
    ).toBe("dark");
  });

  it("rejects a file missing a required color token", () => {
    const colors = fullColors();
    delete colors.terminalBg;
    const json = JSON.stringify({ colors });
    expect(() => parsePluginTheme("p", entry("a", "A"), json)).toThrow(PluginThemeError);
    expect(() => parsePluginTheme("p", entry("a", "A"), json)).toThrow(/terminalBg/);
  });

  it("rejects a blank color value as missing", () => {
    const json = JSON.stringify({ colors: fullColors({ bgPrimary: "   " }) });
    expect(() => parsePluginTheme("p", entry("a", "A"), json)).toThrow(/bgPrimary/);
  });

  it("rejects invalid JSON, a non-object body, and an unknown schema", () => {
    expect(() => parsePluginTheme("p", entry("a", "A"), "{ not json")).toThrow(/valid JSON/);
    expect(() => parsePluginTheme("p", entry("a", "A"), "[]")).toThrow(/JSON object/);
    expect(() =>
      parsePluginTheme("p", entry("a", "A"), themeJson({ $schema: "other-format-v9" }))
    ).toThrow(/unsupported version/);
  });
});

describe("loadPluginThemes", () => {
  it("reads each declared file under themes/ and registers valid themes", async () => {
    const { read, paths } = fakeReader({
      "themes/midnight.json": themeJson(),
      "themes/aurora.json": themeJson(),
    });
    const { themes, errors } = await loadPluginThemes(
      "acme",
      [entry("midnight", "Midnight"), entry("aurora", "Aurora")],
      read
    );
    expect(errors).toHaveLength(0);
    expect(themes.map((t) => t.id)).toEqual(["plugin:acme:midnight", "plugin:acme:aurora"]);
    expect(paths).toEqual(["themes/midnight.json", "themes/aurora.json"]);
  });

  it("does not double-prefix a file path already rooted at themes/", async () => {
    const { read, paths } = fakeReader({ "themes/midnight.json": themeJson() });
    await loadPluginThemes("acme", [entry("midnight", "Midnight", "themes/midnight.json")], read);
    expect(paths).toEqual(["themes/midnight.json"]);
  });

  it("collects a validation failure without dropping the other themes", async () => {
    const { read } = fakeReader({
      "themes/good.json": themeJson(),
      "themes/bad.json": JSON.stringify({ colors: { bgPrimary: "#000" } }),
    });
    const { themes, errors } = await loadPluginThemes(
      "acme",
      [entry("good", "Good"), entry("bad", "Bad")],
      read
    );
    expect(themes.map((t) => t.id)).toEqual(["plugin:acme:good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0].themeId).toBe("bad");
  });

  it("prefixes the plugin name when a theme name clashes with a core theme", async () => {
    const { read } = fakeReader({ "themes/dark.json": themeJson() });
    const { themes } = await loadPluginThemes("acme", [entry("dark", "Dark")], read, {
      pluginName: "Acme Themes",
    });
    // Core "Dark" wins the plain name; the plugin theme is prefixed.
    expect(themes[0].name).toBe("Acme Themes: Dark");
    expect(themes[0].id).toBe("plugin:acme:dark");
  });

  it("leaves a non-clashing name untouched", async () => {
    const { read } = fakeReader({ "themes/x.json": themeJson() });
    const { themes } = await loadPluginThemes("acme", [entry("x", "Totally Unique")], read, {
      pluginName: "Acme Themes",
    });
    expect(themes[0].name).toBe("Totally Unique");
  });
});

describe("plugin theme registry + resolveTheme", () => {
  beforeEach(() => {
    clearRegisteredPluginThemes();
  });

  it("resolves a registered plugin theme by its setting id", () => {
    const theme = parsePluginTheme("acme", entry("midnight", "Midnight"), themeJson());
    setRegisteredPluginThemes([theme]);
    expect(findRegisteredPluginTheme("plugin:acme:midnight")).toBe(theme);
    expect(getRegisteredPluginThemes()).toEqual([theme]);
    expect(resolveTheme("plugin:acme:midnight")).toBe(theme);
  });

  it("falls back to the default theme once the plugin theme is removed (disable/uninstall)", () => {
    const theme = parsePluginTheme("acme", entry("midnight", "Midnight"), themeJson());
    setRegisteredPluginThemes([theme]);
    expect(resolveTheme("plugin:acme:midnight")).toBe(theme);

    // Simulate the plugin being disabled/uninstalled: registry is refreshed empty.
    setRegisteredPluginThemes([]);
    expect(findRegisteredPluginTheme("plugin:acme:midnight")).toBeUndefined();
    expect(resolveTheme("plugin:acme:midnight")).toBe(darkTheme);
  });
});
