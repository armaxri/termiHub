import { ThemeDefinition } from "./types";

/** Built-in light theme — VS Code Light+ inspired with dark activity bar. */
export const lightTheme: ThemeDefinition = {
  id: "light",
  name: "Light",
  colorScheme: "light",
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
    textSecondary: "#5e6670",
    // #5249: secondary labels on hovered/selected rows. #5e6670 measures
    // 4.00:1 on bgActive; deriveTextSecondaryOnSelection nudges it towards
    // black (5.37:1 on bgHover, 4.53:1 on bgActive). Locked by contrast.test.ts.
    textSecondaryOnSelection: "#565e67",
    textMuted: "#686d74",
    // #5200: muted hints on hovered/selected rows. #686d74 measures 4.25:1 on
    // bgHover and 3.59:1 on bgActive; deriveTextMutedOnSelection nudges it 14%
    // towards black (5.34:1 / 4.50:1). Locked by contrast.test.ts.
    textMutedOnSelection: "#595e64",
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
    textOnAccent: "#ffffff",

    // Status
    colorSuccess: "#22863a",
    colorWarning: "#856900",
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

    // ANSI 16 — every entry reaches 3:1 on terminalBg (#5191, locked by
    // contrast.test.ts). The failing ones were darkened in OKLCH lightness
    // only, keeping hue and chroma, to the smallest value that passes.
    ansiBlack: "#383a42",
    ansiRed: "#e45649",
    ansiGreen: "#50a14f",
    ansiYellow: "#c18401",
    ansiBlue: "#4078f2",
    ansiMagenta: "#a626a4",
    ansiCyan: "#0184bc",
    ansiWhite: "#949494", // was #fafafa (1.04:1)
    ansiBrightBlack: "#4f525e",
    ansiBrightRed: "#e06c75",
    ansiBrightGreen: "#77a058", // was #98c379 (2.02:1)
    ansiBrightYellow: "#b38f4b", // was #e5c07b (1.73:1)
    ansiBrightBlue: "#4c9ad9", // was #61afef (2.36:1)
    ansiBrightMagenta: "#c476db", // was #c678dd (2.94:1)
    ansiBrightCyan: "#40a2ae", // was #56b6c2 (2.37:1)
    ansiBrightWhite: "#949494", // was #ffffff (1.00:1)

    // Scrollbar
    scrollbarThumb: "rgba(100, 100, 100, 0.45)",
    scrollbarThumbHover: "rgba(100, 100, 100, 0.65)",
  },
};
