import { ThemeDefinition } from "./types";

/** Solarized Light — Ethan Schoonover's Solarized palette, light variant. */
export const solarizedLightTheme: ThemeDefinition = {
  id: "solarized-light",
  name: "Solarized Light",
  colors: {
    // Backgrounds — derived from the Solarized base0x monotone ramp
    bgPrimary: "#fdf6e3", // base3
    bgSecondary: "#eee8d5", // base2
    bgTertiary: "#e2dcc9",
    bgHover: "#e2dcc9",
    bgActive: "#d5cfbd",
    bgInput: "#fdf6e3",
    bgDropdown: "#fdf6e3",

    // Activity bar (kept dark for visual anchor, same as light theme pattern)
    activityBarBg: "#073642",
    activityBarActive: "#eee8d5",
    activityBarInactive: "#586e75",
    activityBarIndicator: "#268bd2",

    // Sidebar
    sidebarBg: "#eee8d5",
    sidebarHeaderBg: "#eee8d5",

    // Tab bar
    tabBg: "#eee8d5",
    tabActiveBg: "#fdf6e3",
    tabBorder: "#fdf6e3",

    // Text
    textPrimary: "#657b83", // base00
    textSecondary: "#93a1a1", // base1
    textDisabled: "#c5bfae",
    textAccent: "#268bd2",
    textLink: "#268bd2",

    // Borders
    borderPrimary: "#cac4b3",
    borderSecondary: "#eee8d5",

    // Accent / focus
    accentColor: "#268bd2",
    accentHover: "#1a7bb8",
    focusBorder: "#268bd2",

    // Status
    colorSuccess: "#859900",
    colorWarning: "#b58900",
    colorError: "#dc322f",
    colorInfo: "#268bd2",

    // State dots
    stateConnected: "#859900",
    stateConnecting: "#b58900",
    stateDisconnected: "#dc322f",

    // Terminal
    terminalBg: "#fdf6e3",
    terminalFg: "#657b83",
    terminalCursor: "#657b83",
    terminalSelection: "rgba(38, 139, 210, 0.25)",

    // ANSI 16 — canonical Solarized mapping (same palette as dark variant)
    ansiBlack: "#073642", // base02
    ansiRed: "#dc322f",
    ansiGreen: "#859900",
    ansiYellow: "#b58900",
    ansiBlue: "#268bd2",
    ansiMagenta: "#d33682",
    ansiCyan: "#2aa198",
    ansiWhite: "#eee8d5", // base2
    ansiBrightBlack: "#002b36", // base03
    ansiBrightRed: "#cb4b16", // orange
    ansiBrightGreen: "#586e75", // base01
    ansiBrightYellow: "#657b83", // base00
    ansiBrightBlue: "#839496", // base0
    ansiBrightMagenta: "#6c71c4", // violet
    ansiBrightCyan: "#93a1a1", // base1
    ansiBrightWhite: "#fdf6e3", // base3

    // Scrollbar
    scrollbarThumb: "rgba(147, 161, 161, 0.4)",
    scrollbarThumbHover: "rgba(147, 161, 161, 0.7)",
  },
};
