import { ThemeDefinition } from "./types";

/**
 * Built-in dark theme — the canonical MODERN design-system palette (UI-001,
 * maintainer-approved). Every core surface/accent/text/border/state token here
 * mirrors the modern dark `:root` values in `src/styles/variables.css`, which is
 * the source of truth (the ui-modernization concept). The theme engine writes
 * these over `:root` via COLOR_TO_CSS_VAR, so what renders now equals the design
 * system. Terminal-specific tokens with no `variables.css` counterpart (the 16
 * ANSI colors) keep the terminal-standard hues but sit coherently on the modern
 * `#0f1117` base (ansiBlack tracks the terminal background — see below).
 */
export const darkTheme: ThemeDefinition = {
  id: "dark",
  name: "Dark",
  colorScheme: "dark",
  colors: {
    // Backgrounds
    bgPrimary: "#0f1117",
    bgSecondary: "#161b24",
    bgTertiary: "#1c2130",
    bgHover: "#1f2434",
    bgActive: "#252b3a",
    bgInput: "#1a1e2c",
    bgDropdown: "#161b24",

    // Activity bar
    activityBarBg: "#0b0d12",
    activityBarActive: "#e4e8f4",
    activityBarInactive: "#525d6e",
    activityBarIndicator: "#3d7de8",

    // Sidebar
    sidebarBg: "#161b24",
    sidebarHeaderBg: "#161b24",

    // Tab bar
    tabBg: "#1c2130",
    tabActiveBg: "#0f1117",
    tabBorder: "#12151d",

    // Text
    textPrimary: "#dde1ec",
    textSecondary: "#7b8597",
    // A11Y-007 / #2070: the raw design-system muted (#656e80) fails WCAG AA
    // (~3.4:1 on the sidebar surface). Lightened within the same modern
    // bluish-gray family to meet AA (5.0:1 on #161b24, 5.5:1 on #0f1117) —
    // locked by contrast.test.ts. variables.css --text-muted matches.
    textMuted: "#838c9c",
    textDisabled: "#3d4557",
    textAccent: "#5aa6ff",
    textLink: "#4190ee",

    // Borders
    borderPrimary: "#2a2f40",
    borderSecondary: "#1a1e2a",

    // Accent / focus
    accentColor: "#3d7de8",
    accentHover: "#5a94f0",
    focusBorder: "#3d7de8",

    // Status
    colorSuccess: "#7dcf88",
    colorWarning: "#d4a843",
    colorError: "#ef6b5a",
    colorInfo: "#6db0ff",

    // State dots
    stateConnected: "#2dd79c",
    stateConnecting: "#f0c040",
    stateDisconnected: "#e05555",

    // Terminal
    terminalBg: "#0f1117",
    terminalFg: "#dde1ec",
    terminalCursor: "#aeafad",
    terminalSelection: "rgba(61, 125, 232, 0.35)",

    // ANSI 16 — terminal-standard hues (no variables.css counterpart). Kept as
    // the established palette so shell output renders correctly; ansiBlack tracks
    // the modern terminal background (#0f1117) so "black" cells match the surface.
    ansiBlack: "#0f1117",
    ansiRed: "#cd3131",
    ansiGreen: "#0dbc79",
    ansiYellow: "#e5e510",
    ansiBlue: "#2472c8",
    ansiMagenta: "#bc3fbc",
    ansiCyan: "#11a8cd",
    ansiWhite: "#e5e5e5",
    ansiBrightBlack: "#666666",
    ansiBrightRed: "#f14c4c",
    ansiBrightGreen: "#23d18b",
    ansiBrightYellow: "#f5f543",
    ansiBrightBlue: "#3b8eea",
    ansiBrightMagenta: "#d670d6",
    ansiBrightCyan: "#29b8db",
    ansiBrightWhite: "#e5e5e5",

    // Scrollbar
    scrollbarThumb: "rgba(121, 121, 121, 0.4)",
    scrollbarThumbHover: "rgba(100, 100, 100, 0.7)",
  },
};
