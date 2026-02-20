import { ThemeDefinition } from "./types";

/** Built-in light theme — VS Code Light+ inspired with dark activity bar. */
export const lightTheme: ThemeDefinition = {
  id: "light",
  name: "Light",
  colors: {
    // Backgrounds
    bgPrimary: "#ffffff",
    bgSecondary: "#f3f3f3",
    bgTertiary: "#e8e8e8",
    bgHover: "#e8e8e8",
    bgActive: "#d6d6d6",
    bgInput: "#ffffff",
    bgDropdown: "#ffffff",

    // Activity bar (stays dark for visual anchor)
    activityBarBg: "#2c2c2c",
    activityBarActive: "#ffffff",
    activityBarInactive: "#858585",
    activityBarIndicator: "#ffffff",

    // Sidebar
    sidebarBg: "#f3f3f3",
    sidebarHeaderBg: "#f3f3f3",

    // Tab bar
    tabBg: "#ececec",
    tabActiveBg: "#ffffff",
    tabBorder: "#f3f3f3",

    // Text
    textPrimary: "#383a42",
    textSecondary: "#6a737d",
    textDisabled: "#a0a0a0",
    textAccent: "#0366d6",
    textLink: "#0366d6",

    // Borders
    borderPrimary: "#d1d5da",
    borderSecondary: "#e1e4e8",

    // Accent / focus
    accentColor: "#0366d6",
    accentHover: "#0350a0",
    focusBorder: "#0366d6",

    // Status
    colorSuccess: "#22863a",
    colorWarning: "#b08800",
    colorError: "#cb2431",
    colorInfo: "#0366d6",

    // State dots
    stateConnected: "#22863a",
    stateConnecting: "#b08800",
    stateDisconnected: "#cb2431",

    // Terminal
    terminalBg: "#ffffff",
    terminalFg: "#383a42",
    terminalCursor: "#526eff",
    terminalSelection: "rgba(3, 102, 214, 0.2)",

    // ANSI 16
    ansiBlack: "#383a42",
    ansiRed: "#e45649",
    ansiGreen: "#50a14f",
    ansiYellow: "#c18401",
    ansiBlue: "#4078f2",
    ansiMagenta: "#a626a4",
    ansiCyan: "#0184bc",
    ansiWhite: "#fafafa",
    ansiBrightBlack: "#4f525e",
    ansiBrightRed: "#e06c75",
    ansiBrightGreen: "#98c379",
    ansiBrightYellow: "#e5c07b",
    ansiBrightBlue: "#61afef",
    ansiBrightMagenta: "#c678dd",
    ansiBrightCyan: "#56b6c2",
    ansiBrightWhite: "#ffffff",

    // Scrollbar
    scrollbarThumb: "rgba(100, 100, 100, 0.3)",
    scrollbarThumbHover: "rgba(100, 100, 100, 0.5)",
  },
};
