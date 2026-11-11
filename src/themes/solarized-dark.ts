import { ThemeDefinition } from "./types";

/** Solarized Dark — Ethan Schoonover's Solarized palette, dark variant. */
export const solarizedDarkTheme: ThemeDefinition = {
  id: "solarized-dark",
  name: "Solarized Dark",
  colorScheme: "dark",
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
    activityBarInactive: "#5d737a", // base01, lifted to 3:1 (#5192)
    activityBarIndicator: "#268bd2",

    // Sidebar
    sidebarBg: "#073642",
    sidebarHeaderBg: "#073642",

    // Tab bar
    tabBg: "#073642",
    tabActiveBg: "#002b36",
    tabBorder: "#002b36",

    // Text — #5190: remapped within the canonical Solarized palette so every
    // text role reaches WCAG AA. base0/base00/base01 measured 3.16-4.11 /
    // 2.92 / 2.42:1 on the sidebar and selected rows. Each role moved up the
    // base ramp to the first canonical tone that passes on its surfaces
    // (locked by contrast.test.ts, which also checks palette membership).
    textPrimary: "#eee8d5", // base2: 8.14:1 on bgActive, 10.61:1 on sidebar
    textSecondary: "#93a1a1", // base1: 4.86:1 on bgSecondary / tabBg
    // base1 drops to 4.28:1 on bgHover; hovered/selected rows use base2.
    textSecondaryOnSelection: "#eee8d5", // base2
    textMuted: "#93a1a1", // base1: 5.61:1 on bgPrimary, 4.86:1 on sidebar
    textMutedOnSelection: "#eee8d5", // base2
    textDisabled: "#3d5862",
    textAccent: "#268bd2",
    textLink: "#268bd2",

    // Borders
    borderPrimary: "#586e75", // base01
    borderSecondary: "#073642",

    // Accent / focus
    // #5164: blue darkened (same hue) so white button text reaches AA
    // (#268bd2 measured 3.68:1). Now 4.56:1, hover 5.51:1.
    accentColor: "#227bba",
    accentHover: "#176ea5",
    focusBorder: "#268bd2",
    textOnAccent: "#ffffff",

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
    scrollbarThumb: "rgba(88, 110, 117, 0.5)",
    scrollbarThumbHover: "rgba(88, 110, 117, 0.7)",
  },
};
