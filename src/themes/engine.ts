import { ThemeColors, ThemeDefinition } from "./types";
import { darkTheme } from "./dark";
import { lightTheme } from "./light";

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

type ThemeChangeCallback = () => void;

let currentTheme: ThemeDefinition = darkTheme;
let mediaQuery: MediaQueryList | null = null;
let mediaListener: EventListener | null = null;
const changeCallbacks = new Set<ThemeChangeCallback>();

/** Resolve the theme setting string to an actual ThemeDefinition. */
function resolveTheme(setting: string | undefined): ThemeDefinition {
  if (setting === "light") return lightTheme;
  if (setting === "system") {
    const prefersDark =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    return prefersDark ? darkTheme : lightTheme;
  }
  return darkTheme;
}

/** Write all theme colors as CSS custom properties on the document root. */
function setCssVariables(colors: ThemeColors): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [key, cssVar] of Object.entries(COLOR_TO_CSS_VAR)) {
    root.style.setProperty(cssVar, colors[key as keyof ThemeColors]);
  }
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
export function applyTheme(setting: string | undefined): void {
  removeMediaListener();
  currentTheme = resolveTheme(setting);
  setCssVariables(currentTheme.colors);

  if (setting === "system" && typeof window !== "undefined") {
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaListener = ((e: MediaQueryListEvent) => {
      currentTheme = e.matches ? darkTheme : lightTheme;
      setCssVariables(currentTheme.colors);
      for (const cb of changeCallbacks) cb();
    }) as EventListener;
    mediaQuery.addEventListener("change", mediaListener);
  }
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
