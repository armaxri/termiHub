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
    // #5853: hints and empty-state body copy read weak at 5.24:1 on the
    // #f3f3f3 sidebar. #5e6670 darkened along its hue to 5.8:1 there (6.19:1;
    // 5.81:1 on tabBg); muted stays the lighter level for timestamps and counts.
    textSecondary: "#545b64",
    // #5249: secondary labels on hovered/selected rows. #5853's darker
    // textSecondary already reaches AA there (5.61:1 on bgHover, 4.73:1 on
    // bgActive), so deriveTextSecondaryOnSelection keeps it. Locked by
    // contrast.test.ts.
    textSecondaryOnSelection: "#545b64",
    textMuted: "#686d74",
    // #5200: muted hints on hovered/selected rows. #686d74 measures 4.25:1 on
    // bgHover and 3.59:1 on bgActive; deriveTextMutedOnSelection nudges it 14%
    // towards black (5.34:1 / 4.50:1). Locked by contrast.test.ts.
    textMutedOnSelection: "#595e64",
    textDisabled: "#a0a0a0",
    textAccent: "#0366d6",
    // #5853: links reach 5:1 on the #f3f3f3 sidebar (was 4.88:1).
    textLink: "#0364d2",

    // Borders
    borderPrimary: "#d1d5da",
    borderSecondary: "#e1e4e8",
    borderInput: "#7d838c", // #6154: 3:1 on the input and around it

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
    stateConnecting: "#8a6d00", // #6154: 3:1 on every surface a dot sits on
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
    // Indicators (#6154): text on the status bar at 4.5:1, marks at 3:1.
    colorNotice: "#a14a08",
    broadcastAccent: "#b23c0b",
    macroAccent: "#7c3aed",

    // 3:1 against every surface it sits on (#6167; graded in tokenContrast.test.ts).
    scrollbarThumb: "rgba(80, 80, 80, 0.65)",
    scrollbarThumbHover: "rgba(60, 60, 60, 0.8)",
  },
};
