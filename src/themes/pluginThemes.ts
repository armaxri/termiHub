/**
 * Loading and registration of plugin-provided color themes (#1996).
 *
 * A theme plugin is the simplest extension type — pure JSON, no native code. On
 * a plugin's activation the app reads each `themes/*.json` file it declares,
 * validates it against the theme engine's colour-token schema, and registers it
 * into a runtime registry the {@link resolveTheme} resolver consults for
 * `plugin:<pluginId>:<themeId>` settings. Registered themes surface in the theme
 * selector alongside the built-ins under a "Plugins" separator.
 *
 * This module is deliberately free of any Tauri/IPC import: file reading is
 * injected (the store passes `readPluginFile`), which keeps the parse/validate/
 * register logic pure and unit-testable, mirroring `themeIO.ts`. Concept:
 * `docs/concepts/future/plugin-system.html` (impl §9; "Second PR — Theme
 * plugins"; Edge Cases → core themes win on a name clash).
 */

import type { ThemeColors, ThemeDefinition } from "./types";
import type { ThemeEntry, PluginFileReader } from "@/types/plugin";
import { COLOR_TOKEN_KEYS } from "./colorTokens";
import { THEME_FILE_SCHEMA } from "./themeIO";
import { BASE_THEME_ORDER } from "./customThemes";

/** Prefix used in `AppSettings.theme` (and as the theme id) for a plugin theme. */
export const PLUGIN_THEME_PREFIX = "plugin:";

/**
 * Display names of the built-in themes. A plugin theme whose name collides with
 * one of these is prefixed on registration — core themes always win the name
 * (concept "Edge Cases").
 */
export const CORE_THEME_NAMES: ReadonlySet<string> = new Set(BASE_THEME_ORDER.map((t) => t.name));

/**
 * Build the namespaced id for a plugin theme: `plugin:<pluginId>:<themeId>`.
 * This same string is stored in `AppSettings.theme` to select the theme, so a
 * plugin theme's id and its settings value are identical.
 */
export function pluginThemeId(pluginId: string, themeId: string): string {
  return `${PLUGIN_THEME_PREFIX}${pluginId}:${themeId}`;
}

/** True when a `theme` setting string references a plugin-provided theme. */
export function isPluginThemeSetting(setting: string | undefined): setting is string {
  return typeof setting === "string" && setting.startsWith(PLUGIN_THEME_PREFIX);
}

/** Error raised when a plugin theme file fails validation. */
export class PluginThemeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginThemeError";
  }
}

/** Type guard: a JSON value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate and parse a single plugin theme file into a {@link ThemeDefinition}.
 *
 * Unlike a user-imported theme (which tolerantly inherits missing colours from a
 * base theme, see {@link parseThemeFile}), a plugin ships a complete theme, so
 * this is **strict**: every colour token in {@link COLOR_TOKEN_KEYS} must be
 * present as a non-empty string. A missing/blank token, a non-object body, bad
 * JSON, or an unknown `$schema` all raise {@link PluginThemeError} and cause the
 * theme to be skipped. Identity (`id`, display `name`) comes from the manifest
 * `entry`; colours and `colorScheme` come from the file.
 */
export function parsePluginTheme(
  pluginId: string,
  entry: ThemeEntry,
  json: string
): ThemeDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new PluginThemeError(`theme "${entry.id}" is not valid JSON`);
  }
  if (!isRecord(raw)) {
    throw new PluginThemeError(`theme "${entry.id}" must be a JSON object`);
  }
  const schema = raw.$schema;
  if (typeof schema === "string" && schema !== THEME_FILE_SCHEMA) {
    throw new PluginThemeError(`theme "${entry.id}" has unsupported version "${schema}"`);
  }

  const stored = isRecord(raw.colors) ? raw.colors : {};
  const colors = {} as ThemeColors;
  const missing: string[] = [];
  for (const key of COLOR_TOKEN_KEYS) {
    const value = stored[key];
    if (typeof value === "string" && value.trim() !== "") {
      colors[key] = value;
    } else {
      missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new PluginThemeError(
      `theme "${entry.id}" is missing color token${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`
    );
  }

  return {
    id: pluginThemeId(pluginId, entry.id),
    name: entry.name,
    colorScheme: raw.colorScheme === "light" ? "light" : "dark",
    colors,
  };
}

/** A single theme that failed to load, for surfacing/logging. */
export interface PluginThemeLoadError {
  pluginId: string;
  themeId: string;
  file: string;
  message: string;
}

/** Result of {@link loadPluginThemes}: the themes that loaded and any failures. */
export interface PluginThemeLoadResult {
  themes: ThemeDefinition[];
  errors: PluginThemeLoadError[];
}

export type { PluginFileReader } from "@/types/plugin";

/** Options for {@link loadPluginThemes}. */
export interface LoadPluginThemesOptions {
  /** Plugin display name, used to prefix a theme that clashes with a core name. */
  pluginName?: string;
  /** Core theme names to guard against (defaults to {@link CORE_THEME_NAMES}). */
  coreThemeNames?: ReadonlySet<string>;
}

/**
 * Load and validate all themes a single plugin declares. Each file is read via
 * the injected {@link PluginFileReader} (the `read_plugin_file` command in the
 * app), decoded as UTF-8, and parsed by {@link parsePluginTheme}. A theme whose
 * name clashes with a built-in has its display name prefixed with the plugin
 * name — core themes always win (concept "Edge Cases"). Individual failures are
 * collected rather than thrown, so one bad theme never blocks the rest.
 */
export async function loadPluginThemes(
  pluginId: string,
  themeFiles: ThemeEntry[],
  readFile: PluginFileReader,
  options: LoadPluginThemesOptions = {}
): Promise<PluginThemeLoadResult> {
  const pluginName = options.pluginName ?? pluginId;
  const coreNames = options.coreThemeNames ?? CORE_THEME_NAMES;
  const themes: ThemeDefinition[] = [];
  const errors: PluginThemeLoadError[] = [];

  for (const entry of themeFiles) {
    try {
      const path = entry.file.startsWith("themes/") ? entry.file : `themes/${entry.file}`;
      const bytes = await readFile(pluginId, path);
      const theme = parsePluginTheme(pluginId, entry, new TextDecoder().decode(bytes));
      if (coreNames.has(theme.name)) {
        theme.name = `${pluginName}: ${theme.name}`;
      }
      themes.push(theme);
    } catch (err) {
      errors.push({
        pluginId,
        themeId: entry.id,
        file: entry.file,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { themes, errors };
}

// ─── Runtime registry ────────────────────────────────────────────────────────
//
// The single source of truth the theme engine consults for `plugin:` settings.
// The app store owns *when* it is refreshed (on plugin load/enable/disable) and
// mirrors the same list into its state for the selector UI; the engine only
// reads it, so a disabled/uninstalled plugin's themes disappear and an active
// selection of a now-gone theme falls back to the default at resolve time.

let registeredThemes: ThemeDefinition[] = [];

/** Replace the set of registered plugin themes (called by the store). */
export function setRegisteredPluginThemes(themes: ThemeDefinition[]): void {
  registeredThemes = themes;
}

/** All currently registered plugin themes. */
export function getRegisteredPluginThemes(): ThemeDefinition[] {
  return registeredThemes;
}

/** Look up a registered plugin theme by its namespaced id, or `undefined`. */
export function findRegisteredPluginTheme(id: string): ThemeDefinition | undefined {
  return registeredThemes.find((t) => t.id === id);
}

/** Drop all registered plugin themes (used on teardown / in tests). */
export function clearRegisteredPluginThemes(): void {
  registeredThemes = [];
}
