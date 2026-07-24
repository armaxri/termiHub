/**
 * Import/export of custom themes as portable JSON files (#1880).
 *
 * These are pure, dependency-free helpers: serialising a custom theme into the
 * versioned on-disk shape, and validating/parsing such a file back into a
 * {@link ThemeDefinition}. File IO (the save/open dialogs) lives in the UI
 * layer; keeping the serialise/validate logic here makes it unit-testable in
 * isolation and mirrors `services/macroIo.ts`.
 */

import type { ThemeColors, ThemeDefinition } from "./types";
import { COLOR_TOKEN_KEYS } from "./colorTokens";
import { generateThemeId, resolveBaseTheme } from "./customThemes";

/**
 * `$schema` marker written to (and required-if-present on) exported theme
 * files. It enables future format versioning: a file carrying a different,
 * unknown schema is rejected rather than imported as a corrupt theme. Files
 * with no `$schema` are accepted leniently.
 */
export const THEME_FILE_SCHEMA = "termihub-theme-v1";

/**
 * The stable, explicit on-disk shape for an exported theme — deliberately NOT
 * the raw {@link ThemeDefinition} (no `id`, which is regenerated on import) so
 * the file format can evolve independently of the runtime type. Per the
 * concept, only overridden colors need to be present; missing ones inherit from
 * `baseTheme`.
 */
export interface ThemeFile {
  $schema: string;
  name: string;
  baseTheme?: string;
  colorScheme?: "dark" | "light";
  colors: Partial<ThemeColors>;
}

/** Result of parsing an imported theme file. */
export interface ThemeImportResult {
  /** The validated theme, with a fresh id and a full color palette. */
  theme: ThemeDefinition;
  /**
   * True when the file carried one or more color values that were present but
   * invalid (wrong type / empty) and had to fall back to the base theme's
   * default. Absent keys inherit silently (the intended partial-file format);
   * only genuinely corrupt values raise this so the UI can warn.
   */
  hadInvalidColors: boolean;
}

/** Type guard: a JSON value is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Serialise a custom theme into a pretty-printed export-file string ready to
 * write to a `.json` file. The full stored palette is written so the file is
 * self-contained even if the base theme later changes.
 */
export function serializeTheme(theme: ThemeDefinition): string {
  const file: ThemeFile = {
    $schema: THEME_FILE_SCHEMA,
    name: theme.name,
    baseTheme: theme.baseTheme ?? "dark",
    colorScheme: theme.colorScheme,
    colors: { ...theme.colors },
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * A filesystem-safe default file name for a theme export, e.g.
 * `"My Custom Theme"` -> `"my-custom-theme.json"`. Falls back to `theme.json`
 * for a name that slugs to nothing.
 */
export function themeFileName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "theme"}.json`;
}

/**
 * Validate and parse an imported theme-file string into a {@link ThemeDefinition}.
 *
 * Hard errors (thrown, surfaced as an error toast): not valid JSON, not an
 * object, an unknown `$schema`, or a missing/blank `name`. Everything else is
 * tolerant per the concept — an unknown `baseTheme` defaults to Dark, unknown
 * color keys are dropped, and missing/invalid color values fall back to the
 * base theme's defaults (with {@link ThemeImportResult.hadInvalidColors} flagged
 * only for values that were present but corrupt).
 */
export function parseThemeFile(json: string): ThemeImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("File is not valid JSON.");
  }
  if (!isRecord(raw)) {
    throw new Error("Theme file must be a JSON object.");
  }

  const schema = raw.$schema;
  if (typeof schema === "string" && schema !== THEME_FILE_SCHEMA) {
    throw new Error(`Unsupported theme file version "${schema}".`);
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new Error("Theme file is missing a name.");
  }

  const baseId = typeof raw.baseTheme === "string" ? raw.baseTheme : undefined;
  const base = resolveBaseTheme(baseId);
  const stored = isRecord(raw.colors) ? (raw.colors as Partial<ThemeColors>) : {};

  const colors = {} as ThemeColors;
  let hadInvalidColors = false;
  for (const key of COLOR_TOKEN_KEYS) {
    const value = stored[key];
    if (typeof value === "string" && value.trim() !== "") {
      colors[key] = value;
    } else {
      if (key in stored) hadInvalidColors = true; // present but unusable
      colors[key] = base.colors[key];
    }
  }

  const colorScheme =
    raw.colorScheme === "light" || raw.colorScheme === "dark" ? raw.colorScheme : base.colorScheme;

  return {
    theme: {
      id: generateThemeId(),
      name: raw.name.trim(),
      colorScheme,
      baseTheme: base.id,
      colors,
    },
    hadInvalidColors,
  };
}
