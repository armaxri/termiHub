import { ThemeDefinition } from "./types";

/** Built-in dark theme — extracted from the current variables.css and Terminal.tsx values. */
export const darkTheme: ThemeDefinition = {
  id: "dark",
  name: "Dark",
  colors: {
    // Backgrounds
    bgPrimary: "#1e1e1e",
    bgSecondary: "#252526",
    bgTertiary: "#2d2d2d",
    bgHover: "#2a2d2e",
    bgActive: "#37373d",
    bgInput: "#3c3c3c",
    bgDropdown: "#252526",

    // Activity bar
    activityBarBg: "#333333",
    activityBarActive: "#ffffff",
    activityBarInactive: "#858585",
    activityBarIndicator: "#ffffff",

    // Sidebar
    sidebarBg: "#252526",
    sidebarHeaderBg: "#252526",

    // Tab bar
    tabBg: "#2d2d2d",
    tabActiveBg: "#1e1e1e",
    tabBorder: "#252526",

    // Text
    textPrimary: "#cccccc",
    textSecondary: "#969696",
    textDisabled: "#5a5a5a",
    textAccent: "#4fc1ff",
    textLink: "#3794ff",

    // Borders
    borderPrimary: "#474747",
    borderSecondary: "#2b2b2b",

    // Accent / focus
    accentColor: "#007acc",
    accentHover: "#1c97ea",
    focusBorder: "#007fd4",

    // Status
    colorSuccess: "#89d185",
    colorWarning: "#cca700",
    colorError: "#f48771",
    colorInfo: "#75beff",

    // State dots
    stateConnected: "#0dbc79",
    stateConnecting: "#e5e510",
    stateDisconnected: "#cd3131",

    // Terminal
    terminalBg: "#1e1e1e",
    terminalFg: "#cccccc",
    terminalCursor: "#aeafad",
    terminalSelection: "rgba(38, 79, 120, 0.5)",

    // ANSI 16
    ansiBlack: "#1e1e1e",
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
