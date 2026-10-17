/**
 * MobaXterm's global colours, font and cursor (#4880).
 *
 * The backend parses `[Colors]`, `[Font]` and `[Cursor]` into a
 * {@link MobaxtermGlobalAppearance}; it applies nothing. These pure helpers
 * turn it into what the import dialog offers behind two separate opt-ins:
 * a new custom theme built from the colours, and the global font family,
 * size and cursor style (shown as before → after before anything changes).
 */

import type {
  AppSettings,
  MobaxtermGlobalAppearance,
  MobaxtermThemeColors,
} from "@/types/connection";
import type { ThemeColors, ThemeDefinition } from "@/themes/types";
import { relativeLuminance } from "@/themes/contrast";
import { createCustomTheme, customThemeSetting, dedupeThemeName } from "@/themes/customThemes";

/** Name of the theme created from MobaXterm's colours (deduplicated). */
export const MOBAXTERM_THEME_NAME = "MobaXterm";

/** termiHub's terminal defaults, shown as "before" when a setting is unset. */
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_CURSOR_STYLE = "block";
const DEFAULT_CURSOR_BLINK = true;

/** The ANSI theme tokens, in the backend's `ansi` order. */
const ANSI_TOKENS: (keyof ThemeColors)[] = [
  "ansiBlack",
  "ansiRed",
  "ansiGreen",
  "ansiYellow",
  "ansiBlue",
  "ansiMagenta",
  "ansiCyan",
  "ansiWhite",
  "ansiBrightBlack",
  "ansiBrightRed",
  "ansiBrightGreen",
  "ansiBrightYellow",
  "ansiBrightBlue",
  "ansiBrightMagenta",
  "ansiBrightCyan",
  "ansiBrightWhite",
];

/** One appearance setting the font/cursor opt-in would change. */
export interface AppearanceChange {
  key: "fontFamily" | "fontSize" | "cursorStyle" | "cursorBlink";
  label: string;
  before: string;
  after: string;
}

/** Which parts of the global appearance the user opted in to. */
export interface GlobalAppearanceOptIn {
  theme: boolean;
  appearance: boolean;
}

/**
 * A light base for a light MobaXterm background, dark otherwise, so the rest
 * of termiHub's UI around the terminal matches it.
 */
function baseThemeFor(colors: MobaxtermThemeColors): "dark" | "light" {
  const luminance = colors.background ? relativeLuminance(colors.background) : null;
  return luminance !== null && luminance > 0.5 ? "light" : "dark";
}

/**
 * Build a new custom theme from MobaXterm's terminal colours. It gets a fresh
 * id and a name no existing theme uses, so it can never overwrite one; any
 * colour MobaXterm did not provide keeps the base theme's value.
 */
export function buildMobaxtermTheme(
  colors: MobaxtermThemeColors,
  existing: ThemeDefinition[]
): ThemeDefinition {
  const name = dedupeThemeName(MOBAXTERM_THEME_NAME, existing);
  const theme = createCustomTheme(baseThemeFor(colors), name);
  const set = (token: keyof ThemeColors, value: string | null | undefined) => {
    if (value) theme.colors[token] = value;
  };
  set("terminalBg", colors.background);
  set("terminalFg", colors.foreground);
  set("terminalCursor", colors.cursor);
  ANSI_TOKENS.forEach((token, i) => set(token, colors.ansi[i]));
  return theme;
}

/** `"Example Mono", monospace` → `Example Mono` for display. */
function fontLabel(family: string | undefined): string {
  if (!family) return "termiHub default";
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(family);
  return match ? match[1].replace(/\\(.)/g, "$1") : family;
}

const cursorLabel = (style: string) => style.charAt(0).toUpperCase() + style.slice(1);
const blinkLabel = (blink: boolean) => (blink ? "On" : "Off");

/**
 * The global font/cursor settings the opt-in would change, as before → after
 * rows. Values that already match termiHub's current settings are left out.
 */
export function appearanceChanges(
  global: MobaxtermGlobalAppearance,
  settings: AppSettings
): AppearanceChange[] {
  const rows: AppearanceChange[] = [];
  if (global.fontFamily !== undefined && global.fontFamily !== settings.fontFamily) {
    rows.push({
      key: "fontFamily",
      label: "Font",
      before: fontLabel(settings.fontFamily),
      after: fontLabel(global.fontFamily),
    });
  }
  const fontSize = settings.fontSize ?? DEFAULT_FONT_SIZE;
  if (global.fontSize !== undefined && global.fontSize !== fontSize) {
    rows.push({
      key: "fontSize",
      label: "Font size",
      before: `${fontSize} px`,
      after: `${global.fontSize} px`,
    });
  }
  const cursorStyle = settings.cursorStyle ?? DEFAULT_CURSOR_STYLE;
  if (global.cursorStyle !== undefined && global.cursorStyle !== cursorStyle) {
    rows.push({
      key: "cursorStyle",
      label: "Cursor style",
      before: cursorLabel(cursorStyle),
      after: cursorLabel(global.cursorStyle),
    });
  }
  const cursorBlink = settings.cursorBlink ?? DEFAULT_CURSOR_BLINK;
  if (global.cursorBlink !== undefined && global.cursorBlink !== cursorBlink) {
    rows.push({
      key: "cursorBlink",
      label: "Cursor blink",
      before: blinkLabel(cursorBlink),
      after: blinkLabel(global.cursorBlink),
    });
  }
  return rows;
}

/**
 * The settings after applying exactly what the user opted in to: a new theme
 * appended to `customThemes` and selected, and/or the font/cursor values
 * listed by {@link appearanceChanges}. Returns `null` when nothing changes.
 */
export function applyMobaxtermGlobalAppearance(
  settings: AppSettings,
  global: MobaxtermGlobalAppearance,
  optIn: GlobalAppearanceOptIn
): { settings: AppSettings; theme: ThemeDefinition | null } | null {
  let next: AppSettings = settings;
  let theme: ThemeDefinition | null = null;
  if (optIn.theme && global.colors) {
    const existing = settings.customThemes ?? [];
    theme = buildMobaxtermTheme(global.colors, existing);
    next = {
      ...next,
      customThemes: [...existing, theme],
      theme: customThemeSetting(theme.id),
    };
  }
  const changes = optIn.appearance ? appearanceChanges(global, settings) : [];
  for (const change of changes) {
    next = { ...next, [change.key]: global[change.key] };
  }
  return next === settings ? null : { settings: next, theme };
}
