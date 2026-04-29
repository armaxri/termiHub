import { ThemeDefinition } from "./types";

/** Solarized Dark — Ethan Schoonover's Solarized palette, dark variant. */
export const solarizedDarkTheme: ThemeDefinition = {
  id: "solarized-dark",
  name: "Solarized Dark",
  colors: {
    // Backgrounds — derived from the Solarized base0x monotone ramp
    bgPrimary: "#002b36", // base03
    bgSecondary: "#073642", // base02
    bgTertiary: "#0d3f4d",
    bgHover: "#0d3f4d",
    bgActive: "#174858",
    bgInput: "#073642",
    bgDropdown: "#073642",

    // Activity bar
    activityBarBg: "#002b36",
    activityBarActive: "#eee8d5", // base2
    activityBarInactive: "#586e75", // base01
    activityBarIndicator: "#268bd2",

    // Sidebar
    sidebarBg: "#073642",
    sidebarHeaderBg: "#073642",

    // Tab bar
    tabBg: "#073642",
    tabActiveBg: "#002b36",
    tabBorder: "#002b36",

    // Text
    textPrimary: "#839496", // base0
    textSecondary: "#657b83", // base00
    textDisabled: "#3d5862",
    textAccent: "#268bd2",
    textLink: "#268bd2",

    // Borders
    borderPrimary: "#586e75", // base01
    borderSecondary: "#073642",

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
    terminalBg: "#002b36",
    terminalFg: "#839496",
    terminalCursor: "#839496",
    terminalSelection: "rgba(38, 139, 210, 0.3)",

    // ANSI 16 — canonical Solarized mapping
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
    scrollbarThumb: "rgba(88, 110, 117, 0.4)",
    scrollbarThumbHover: "rgba(88, 110, 117, 0.7)",
  },
};
