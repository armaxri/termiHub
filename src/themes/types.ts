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
  /**
   * `textSecondary` for labels drawn on a hovered or selected row (`bgHover` /
   * `bgActive`), where plain `textSecondary` can fall below AA (#5249). Built-in
   * themes pin it; custom and plugin themes derive it like
   * `textMutedOnSelection`.
   */
  textSecondaryOnSelection: string;
  textMuted: string;
  /**
   * `textMuted` for hints drawn on a hovered or selected row (`bgHover` /
   * `bgActive`), which sit closer to the muted tone than the plain surfaces do
   * (#5200). Built-in themes pin it; custom and plugin themes derive it from
   * `textMuted` against those two row backgrounds.
   */
  textMutedOnSelection: string;
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
  /**
   * Foreground for text and icons drawn on the accent surface (primary buttons,
   * checked checkboxes, active chips). Built-in themes pin it; custom and
   * plugin themes derive it from `accentColor` by WCAG contrast (UI2-003).
   */
  textOnAccent: string;

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
  /** Controls the CSS `color-scheme` property so WebKit renders system UI (scrollbars, inputs) in the matching mode. */
  colorScheme: "dark" | "light";
  colors: ThemeColors;
  /**
   * For user-defined custom themes only: the id of the built-in theme this
   * theme was derived from (e.g. `"dark"`). Used as the source for per-token
   * "reset to base" in the editor and as a fallback for any missing color.
   * Absent on the built-in themes.
   */
  baseTheme?: string;
  /**
   * Optional opaque surfaces for selected rows (#5562, #5591), drawn on
   * `sidebarBg` (connection tree, file browser, plugin list) and, through
   * `secondary`, on `bgSecondary` (transfer panes). Without it, those rows
   * paint the `--bg-selected` / `--bg-selected-hover` accent tints (see
   * `styles/variables.css`) and carry no indicator bar. A theme built from a
   * fixed palette (Solarized Light and Dark) sets palette colours here, so a
   * selection never reads as a blended, off-palette grey. Built-in themes
   * only: custom and plugin themes always use the tint defaults.
   */
  selection?: ThemeSelection;
}

/** Opaque selected-row surfaces a theme may supply in place of the accent tints. */
export interface ThemeSelection {
  /** Selected row background on the sidebar (`--selected-row-bg`). */
  bg: string;
  /** Hovered selected row background on the sidebar (`--selected-row-hover-bg`). */
  bgHover: string;
  /** The 2px left bar on a selected row, on every surface (`--selected-row-indicator`). */
  indicator: string;
  /**
   * Rows on a `bgSecondary` pane (the transfer view), for a theme whose
   * `bgSecondary` equals or sits too close to `bg`
   * (`--selected-row-secondary-bg` / `--selected-row-secondary-hover-bg`).
   * Omitted, those rows use `bg` / `bgHover`.
   */
  secondary?: { bg: string; bgHover: string };
}
