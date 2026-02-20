/** All color tokens that define a termiHub theme. */
export interface ThemeColors {
  // Backgrounds
  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  bgHover: string;
  bgActive: string;
  bgInput: string;
  bgDropdown: string;

  // Activity bar
  activityBarBg: string;
  activityBarActive: string;
  activityBarInactive: string;
  activityBarIndicator: string;

  // Sidebar
  sidebarBg: string;
  sidebarHeaderBg: string;

  // Tab bar
  tabBg: string;
  tabActiveBg: string;
  tabBorder: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textDisabled: string;
  textAccent: string;
  textLink: string;

  // Borders
  borderPrimary: string;
  borderSecondary: string;

  // Accent / focus
  accentColor: string;
  accentHover: string;
  focusBorder: string;

  // Status colors
  colorSuccess: string;
  colorWarning: string;
  colorError: string;
  colorInfo: string;

  // State indicator dots
  stateConnected: string;
  stateConnecting: string;
  stateDisconnected: string;

  // Terminal
  terminalBg: string;
  terminalFg: string;
  terminalCursor: string;
  terminalSelection: string;

  // Terminal ANSI (16 colors)
  ansiBlack: string;
  ansiRed: string;
  ansiGreen: string;
  ansiYellow: string;
  ansiBlue: string;
  ansiMagenta: string;
  ansiCyan: string;
  ansiWhite: string;
  ansiBrightBlack: string;
  ansiBrightRed: string;
  ansiBrightGreen: string;
  ansiBrightYellow: string;
  ansiBrightBlue: string;
  ansiBrightMagenta: string;
  ansiBrightCyan: string;
  ansiBrightWhite: string;

  // Scrollbar
  scrollbarThumb: string;
  scrollbarThumbHover: string;
}

/** A complete theme definition with metadata and all color values. */
export interface ThemeDefinition {
  id: string;
  name: string;
  colors: ThemeColors;
}
