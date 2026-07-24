import { ThemeColors, ThemeDefinition } from "./types";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import { solarizedDarkTheme } from "./solarized-dark";
import { solarizedLightTheme } from "./solarized-light";
import { COLOR_TOKEN_KEYS } from "./colorTokens";

/** Prefix used in `AppSettings.theme` to reference a custom theme by id. */
export const CUSTOM_THEME_PREFIX = "custom:";

/** Built-in themes usable as a base for custom themes, keyed by their id. */
export const BASE_THEMES: Record<string, ThemeDefinition> = {
  dark: darkTheme,
  light: lightTheme,
  "solarized-dark": solarizedDarkTheme,
  "solarized-light": solarizedLightTheme,
};

/** Base themes offered in the editor's "Based on" selector, in display order. */
export const BASE_THEME_ORDER: ThemeDefinition[] = [
  darkTheme,
  lightTheme,
  solarizedDarkTheme,
  solarizedLightTheme,
];

/** The `theme` setting string that selects a custom theme with the given id. */
export function customThemeSetting(id: string): `custom:${string}` {
  return `${CUSTOM_THEME_PREFIX}${id}`;
}

/** True when a `theme` setting string references a custom theme. */
export function isCustomThemeSetting(setting: string | undefined): setting is string {
  return typeof setting === "string" && setting.startsWith(CUSTOM_THEME_PREFIX);
}

/** Extract the custom theme id from a `custom:<id>` setting, or `null`. */
export function customThemeId(setting: string | undefined): string | null {
  if (!isCustomThemeSetting(setting)) return null;
  const id = setting.slice(CUSTOM_THEME_PREFIX.length);
  return id.length > 0 ? id : null;
}

/** Resolve a base-theme id to its definition, defaulting to the dark theme. */
export function resolveBaseTheme(baseId: string | undefined): ThemeDefinition {
  return (baseId && BASE_THEMES[baseId]) || darkTheme;
}

/**
 * Generate a collision-resistant id for a new custom theme. Uses
 * `crypto.randomUUID` when available (browser + jsdom), falling back to a
 * timestamp+random string in environments without it.
 */
export function generateThemeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Ensure `name` does not collide with any name already in `existing`. A
 * duplicate gets a `" (2)"`, `" (3)"`, … suffix, matching the concept's
 * import/rename behavior.
 */
export function dedupeThemeName(name: string, existing: ThemeDefinition[]): string {
  const taken = new Set(existing.map((t) => t.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} (${n})`)) n += 1;
  return `${name} (${n})`;
}

/**
 * Create a fresh custom theme derived from a base built-in theme. All colors
 * are copied from the base so the result is fully self-contained and
 * serializable; `baseTheme` records the provenance so the editor can offer a
 * per-token reset and so missing colors can fall back on the base.
 */
export function createCustomTheme(baseId: string, name: string): ThemeDefinition {
  const base = resolveBaseTheme(baseId);
  return {
    id: generateThemeId(),
    name,
    colorScheme: base.colorScheme,
    baseTheme: base.id,
    colors: { ...base.colors },
  };
}

/** Look up a custom theme by id in a list, or `undefined` if absent. */
export function findCustomTheme(
  themes: ThemeDefinition[] | undefined,
  id: string
): ThemeDefinition | undefined {
  return themes?.find((t) => t.id === id);
}

/**
 * Produce a render-ready theme from a stored custom theme. Any color missing
 * from the stored definition falls back to the base theme's value, so a partial
 * or lightly-corrupted custom theme (or a partial import in #1880) still renders
 * a complete palette. Extra/unknown color keys are dropped.
 */
export function resolveCustomTheme(custom: ThemeDefinition): ThemeDefinition {
  const base = resolveBaseTheme(custom.baseTheme);
  const stored = (custom.colors ?? {}) as Partial<ThemeColors>;
  const colors = {} as ThemeColors;
  for (const key of COLOR_TOKEN_KEYS) {
    const value = stored[key];
    colors[key] = typeof value === "string" && value.trim() !== "" ? value : base.colors[key];
  }
  return {
    id: custom.id,
    name: custom.name,
    colorScheme: custom.colorScheme === "light" ? "light" : "dark",
    baseTheme: custom.baseTheme,
    colors,
  };
}
