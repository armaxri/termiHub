import { ThemeColors, ThemeDefinition } from "./types";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";
import { solarizedDarkTheme } from "./solarized-dark";
import { solarizedLightTheme } from "./solarized-light";
import {
  customThemeId,
  findCustomTheme,
  isCustomThemeSetting,
  resolveCustomTheme,
} from "./customThemes";
import { findRegisteredPluginTheme, isPluginThemeSetting } from "./pluginThemes";

/**
 * Maps camelCase ThemeColors keys to their corresponding CSS custom
 * property names (kebab-case with `--` prefix).
 */
const COLOR_TO_CSS_VAR: Record<keyof ThemeColors, string> = {
  bgPrimary: "--bg-primary",
  bgSecondary: "--bg-secondary",
  bgTertiary: "--bg-tertiary",
  bgHover: "--bg-hover",
  bgActive: "--bg-active",
  bgInput: "--bg-input",
  bgDropdown: "--bg-dropdown",

  activityBarBg: "--activity-bar-bg",
  activityBarActive: "--activity-bar-active",
  activityBarInactive: "--activity-bar-inactive",
  activityBarIndicator: "--activity-bar-indicator",

  sidebarBg: "--sidebar-bg",
  sidebarHeaderBg: "--sidebar-header-bg",

  tabBg: "--tab-bg",
  tabActiveBg: "--tab-active-bg",
  tabBorder: "--tab-border",

  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  textDisabled: "--text-disabled",
  textAccent: "--text-accent",
  textLink: "--text-link",

  borderPrimary: "--border-primary",
  borderSecondary: "--border-secondary",

  accentColor: "--accent-color",
  accentHover: "--accent-hover",
  focusBorder: "--focus-border",

  colorSuccess: "--color-success",
  colorWarning: "--color-warning",
  colorError: "--color-error",
  colorInfo: "--color-info",

  stateConnected: "--state-connected",
  stateConnecting: "--state-connecting",
  stateDisconnected: "--state-disconnected",

  terminalBg: "--terminal-bg",
  terminalFg: "--terminal-fg",
  terminalCursor: "--terminal-cursor",
  terminalSelection: "--terminal-selection",

  ansiBlack: "--ansi-black",
  ansiRed: "--ansi-red",
  ansiGreen: "--ansi-green",
  ansiYellow: "--ansi-yellow",
  ansiBlue: "--ansi-blue",
  ansiMagenta: "--ansi-magenta",
  ansiCyan: "--ansi-cyan",
  ansiWhite: "--ansi-white",
  ansiBrightBlack: "--ansi-bright-black",
  ansiBrightRed: "--ansi-bright-red",
  ansiBrightGreen: "--ansi-bright-green",
  ansiBrightYellow: "--ansi-bright-yellow",
  ansiBrightBlue: "--ansi-bright-blue",
  ansiBrightMagenta: "--ansi-bright-magenta",
  ansiBrightCyan: "--ansi-bright-cyan",
  ansiBrightWhite: "--ansi-bright-white",

  scrollbarThumb: "--scrollbar-thumb",
  scrollbarThumbHover: "--scrollbar-thumb-hover",
};

/**
 * Elevation shadow tokens, tuned per color scheme (UI-012). The dark scheme's
 * heavy dark-alpha shadows read as muddy smudges on the light theme's pale
 * surfaces, flattening depth. Light schemes therefore get softer, lower-alpha
 * shadows (and drop the dark scheme's inset white top-highlight, which is
 * meaningless on a light surface). The engine writes the set matching the active
 * theme's `colorScheme`, so every dark/light theme — built-in, solarized,
 * custom, or plugin — gets depth that reads correctly. variables.css keeps the
 * dark set as the static `:root` default for pre-engine / SSR / test rendering.
 */
const ELEVATION_SHADOWS: Record<"dark" | "light", Record<string, string>> = {
  dark: {
    "--shadow-sm": "0 1px 4px rgba(0, 0, 0, 0.5), 0 0 1px rgba(0, 0, 0, 0.3)",
    "--shadow-md": "0 4px 12px rgba(0, 0, 0, 0.3)",
    "--shadow-dropdown":
      "0 8px 28px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
    "--shadow-overlay":
      "0 24px 64px rgba(0, 0, 0, 0.75), 0 8px 24px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.055)",
  },
  light: {
    "--shadow-sm": "0 1px 3px rgba(0, 0, 0, 0.12), 0 0 1px rgba(0, 0, 0, 0.08)",
    "--shadow-md": "0 4px 12px rgba(0, 0, 0, 0.12)",
    "--shadow-dropdown": "0 8px 28px rgba(0, 0, 0, 0.16), 0 2px 8px rgba(0, 0, 0, 0.1)",
    "--shadow-overlay": "0 24px 64px rgba(0, 0, 0, 0.22), 0 8px 24px rgba(0, 0, 0, 0.14)",
  },
};

type ThemeChangeCallback = () => void;

let currentTheme: ThemeDefinition = darkTheme;
let mediaQuery: MediaQueryList | null = null;
let mediaListener: EventListener | null = null;
const changeCallbacks = new Set<ThemeChangeCallback>();

/**
 * Resolve a theme setting string (`"dark"`, `"light"`, `"system"`,
 * `"custom:<id>"`, `"plugin:<pluginId>:<themeId>"`, …) to a fully-resolved
 * {@link ThemeDefinition}. Custom themes are run through
 * {@link resolveCustomTheme} so every color falls back to its base; plugin
 * themes are looked up in the runtime registry (see `pluginThemes.ts`). A
 * missing/deleted custom or plugin theme and any unknown setting fall back to
 * dark. `"system"` reads `prefers-color-scheme`, treating a missing `matchMedia`
 * (e.g. under jsdom) as light.
 */
export function resolveTheme(
  setting: string | undefined,
  customThemes: ThemeDefinition[] = []
): ThemeDefinition {
  if (setting === "light") return lightTheme;
  if (setting === "solarized-dark") return solarizedDarkTheme;
  if (setting === "solarized-light") return solarizedLightTheme;
  if (setting === "system") {
    const prefersDark =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? darkTheme : lightTheme;
  }
  if (isPluginThemeSetting(setting)) {
    // Plugin themes carry a complete, pre-validated palette, so no base
    // fallback is needed. A theme whose plugin is disabled/uninstalled is no
    // longer registered and falls back to dark (concept edge case).
    return findRegisteredPluginTheme(setting) ?? darkTheme;
  }
  if (isCustomThemeSetting(setting)) {
    const id = customThemeId(setting);
    const custom = id ? findCustomTheme(customThemes, id) : undefined;
    // A deleted or missing custom theme falls back to dark (concept edge case).
    return custom ? resolveCustomTheme(custom) : darkTheme;
  }
  return darkTheme;
}

/** Write all theme colors as CSS custom properties on the document root. */
function setCssVariables(theme: ThemeDefinition): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(COLOR_TO_CSS_VAR)) {
    root.style.setProperty(cssVar, theme.colors[key as keyof ThemeColors]);
  }
  // Elevation shadows are tuned per color scheme (UI-012): light themes get
  // softer, lower-alpha shadows so depth reads on pale surfaces. Written every
  // apply so switching light->dark (or vice versa) restores the correct set.
  for (const [token, value] of Object.entries(ELEVATION_SHADOWS[theme.colorScheme])) {
    root.style.setProperty(token, value);
  }
  // Tell WebKit which color scheme is active so system UI elements (scrollbars,
  // form controls) render in the matching dark/light style.
  root.style.colorScheme = theme.colorScheme;
}

/** Remove the current matchMedia listener if one exists. */
function removeMediaListener(): void {
  if (mediaQuery && mediaListener) {
    mediaQuery.removeEventListener("change", mediaListener);
  }
  mediaQuery = null;
  mediaListener = null;
}

/**
 * Apply a theme based on the setting value (`"dark"`, `"light"`, or
 * `"system"`). When `"system"` is chosen, a `matchMedia` listener is
 * registered that automatically re-applies the theme when the OS
 * preference changes.
 */
export function applyTheme(
  setting: string | undefined,
  customThemes: ThemeDefinition[] = []
): void {
  removeMediaListener();
  currentTheme = resolveTheme(setting, customThemes);
  setCssVariables(currentTheme);

  if (setting === "system" && typeof window !== "undefined") {
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaListener = ((e: MediaQueryListEvent) => {
      currentTheme = e.matches ? darkTheme : lightTheme;
      setCssVariables(currentTheme);
      for (const cb of changeCallbacks) cb();
    }) as EventListener;
    mediaQuery.addEventListener("change", mediaListener);
  }
}

/**
 * Apply a full theme definition directly, bypassing the settings-string
 * resolver. Used by the theme editor to render live, unsaved edits to the whole
 * app (CSS variables + open terminals) without persisting anything. The passed
 * theme is resolved through {@link resolveCustomTheme} so any missing color
 * falls back to its base. Any `"system"` media listener is torn down first;
 * restore the persisted theme afterwards with {@link applyTheme}.
 */
export function previewTheme(theme: ThemeDefinition): void {
  removeMediaListener();
  currentTheme = resolveCustomTheme(theme);
  setCssVariables(currentTheme);
  for (const cb of changeCallbacks) cb();
}

/**
 * Returns an xterm.js-compatible `ITheme` object derived from the
 * current theme's terminal and ANSI colors.
 */
export function getXtermTheme(): Record<string, string> {
  const c = currentTheme.colors;
  return {
    background: c.terminalBg,
    foreground: c.terminalFg,
    cursor: c.terminalCursor,
    selectionBackground: c.terminalSelection,
    black: c.ansiBlack,
    red: c.ansiRed,
    green: c.ansiGreen,
    yellow: c.ansiYellow,
    blue: c.ansiBlue,
    magenta: c.ansiMagenta,
    cyan: c.ansiCyan,
    white: c.ansiWhite,
    brightBlack: c.ansiBrightBlack,
    brightRed: c.ansiBrightRed,
    brightGreen: c.ansiBrightGreen,
    brightYellow: c.ansiBrightYellow,
    brightBlue: c.ansiBrightBlue,
    brightMagenta: c.ansiBrightMagenta,
    brightCyan: c.ansiBrightCyan,
    brightWhite: c.ansiBrightWhite,
    // xterm.js 6 draws its own scrollbar via the built-in scrollable element;
    // mirror the rest of the UI by reusing the global scrollbar tokens.
    scrollbarSliderBackground: c.scrollbarThumb,
    scrollbarSliderHoverBackground: c.scrollbarThumbHover,
    scrollbarSliderActiveBackground: c.scrollbarThumbHover,
  };
}

/** Returns the currently active ThemeDefinition. */
export function getCurrentTheme(): ThemeDefinition {
  return currentTheme;
}

/**
 * Register a callback that fires when the OS theme changes while in
 * "system" mode. Returns an unsubscribe function.
 */
export function onThemeChange(callback: ThemeChangeCallback): () => void {
  changeCallbacks.add(callback);
  return () => {
    changeCallbacks.delete(callback);
  };
}

/** Clean up the matchMedia listener and all registered callbacks. */
export function dispose(): void {
  removeMediaListener();
  changeCallbacks.clear();
}
