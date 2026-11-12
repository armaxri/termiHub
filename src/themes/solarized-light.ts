import { ThemeDefinition } from "./types";

/** Solarized Light — Ethan Schoonover's Solarized palette, light variant. */
export const solarizedLightTheme: ThemeDefinition = {
  id: "solarized-light",
  name: "Solarized Light",
  colorScheme: "light",
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
    activityBarInactive: "#677d85", // base01, lifted to 3:1 (#5192)
    activityBarIndicator: "#268bd2",

    // Sidebar — #5457: base3, like the editor, so the text levels keep their
    // contrast (on base2 they all had to collapse to near-black base02/base03).
    // The panel border (borderPrimary) separates the sidebar from the editor.
    sidebarBg: "#fdf6e3", // base3
    sidebarHeaderBg: "#fdf6e3", // base3

    // Tab bar
    tabBg: "#eee8d5",
    tabActiveBg: "#fdf6e3",
    tabBorder: "#fdf6e3",

    // Text — #5190: remapped within the canonical Solarized palette so every
    // text role reaches WCAG AA. base00/base1/#acb0a7 measured 3.64 / 2.18 /
    // 1.80:1 on the old base2 sidebar. base01 only reaches 4.39:1 on base2,
    // which the status bar and tab bar (bgSecondary / tabBg) still paint, so
    // the first canonical tone that passes everywhere is base02.
    // Locked by contrast.test.ts, which also checks palette membership.
    textPrimary: "#002b36", // base03: 13.92:1 on sidebar, 9.64:1 on bgActive
    textSecondary: "#073642", // base02: 10.61:1 on bgSecondary / tabBg
    textSecondaryOnSelection: "#073642", // base02: 8.35:1 on bgActive
    textMuted: "#073642", // base02: 12.05:1 on bgPrimary and sidebar
    textMutedOnSelection: "#073642", // base02
    textDisabled: "#c5bfae",
    // #5399: canonical blue measured 3.00:1 on base2 (bgSecondary). Darkened
    // along its hue (mixed towards black in 1% steps) just until it reaches AA
    // on every text surface; locked by contrast.test.ts.
    textAccent: "#1e6ca4",
    textLink: "#1e6ca4",

    // Borders
    borderPrimary: "#cac4b3",
    borderSecondary: "#eee8d5",

    // Accent / focus
    // #5164: blue darkened (same hue) so white button text reaches AA
    // (#268bd2 measured 3.68:1). Now 4.56:1, hover 5.51:1.
    accentColor: "#227bba",
    accentHover: "#176ea5",
    focusBorder: "#2381c3", // #5399: blue nudged to 3:1 on bgTertiary (was 2.68:1)
    textOnAccent: "#ffffff",

    // Status — #5399: canonical green / yellow / red / blue darkened along their
    // hue just until they reach AA (4.5:1) on every text surface.
    colorSuccess: "#606e00", // green
    colorWarning: "#846400", // yellow
    colorError: "#c42d2a", // red
    colorInfo: "#1e6ca4", // blue

    // State dots — #5399: nudged the same way to the 3:1 UI minimum.
    stateConnected: "#7a8d00", // green
    stateConnecting: "#a87f00", // yellow
    stateDisconnected: "#dc322f", // red, canonical (already 3.77:1)

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
    scrollbarThumb: "rgba(147, 161, 161, 0.55)",
    scrollbarThumbHover: "rgba(147, 161, 161, 0.75)",
  },
};
