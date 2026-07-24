import { ThemeColors } from "./types";

/** A single editable color token: its `ThemeColors` key and a human label. */
export interface ColorToken {
  key: keyof ThemeColors;
  label: string;
}

/** A labelled group of related color tokens, used to lay out the theme editor. */
export interface ColorTokenGroup {
  label: string;
  tokens: ColorToken[];
}

/**
 * All editable theme color tokens, grouped by UI section. The theme editor
 * renders one section per group and one swatch/hex row per token. Kept in a
 * single place so the editor, validation, and any future import/export tooling
 * (#1880) share one source of truth for what a theme contains.
 */
export const COLOR_TOKEN_GROUPS: ColorTokenGroup[] = [
  {
    label: "Backgrounds",
    tokens: [
      { key: "bgPrimary", label: "Primary" },
      { key: "bgSecondary", label: "Secondary" },
      { key: "bgTertiary", label: "Tertiary" },
      { key: "bgHover", label: "Hover" },
      { key: "bgActive", label: "Active" },
      { key: "bgInput", label: "Input" },
      { key: "bgDropdown", label: "Dropdown" },
    ],
  },
  {
    label: "Activity Bar",
    tokens: [
      { key: "activityBarBg", label: "Background" },
      { key: "activityBarActive", label: "Active" },
      { key: "activityBarInactive", label: "Inactive" },
      { key: "activityBarIndicator", label: "Indicator" },
    ],
  },
  {
    label: "Sidebar & Tabs",
    tokens: [
      { key: "sidebarBg", label: "Sidebar Background" },
      { key: "sidebarHeaderBg", label: "Sidebar Header" },
      { key: "tabBg", label: "Tab Background" },
      { key: "tabActiveBg", label: "Active Tab" },
      { key: "tabBorder", label: "Tab Border" },
    ],
  },
  {
    label: "Text",
    tokens: [
      { key: "textPrimary", label: "Primary" },
      { key: "textSecondary", label: "Secondary" },
      { key: "textMuted", label: "Muted" },
      { key: "textDisabled", label: "Disabled" },
      { key: "textAccent", label: "Accent" },
      { key: "textLink", label: "Link" },
    ],
  },
  {
    label: "Borders & Accent",
    tokens: [
      { key: "borderPrimary", label: "Border Primary" },
      { key: "borderSecondary", label: "Border Secondary" },
      { key: "accentColor", label: "Accent" },
      { key: "accentHover", label: "Accent Hover" },
      { key: "focusBorder", label: "Focus Border" },
    ],
  },
  {
    label: "Status",
    tokens: [
      { key: "colorSuccess", label: "Success" },
      { key: "colorWarning", label: "Warning" },
      { key: "colorError", label: "Error" },
      { key: "colorInfo", label: "Info" },
      { key: "stateConnected", label: "Connected" },
      { key: "stateConnecting", label: "Connecting" },
      { key: "stateDisconnected", label: "Disconnected" },
    ],
  },
  {
    label: "Terminal",
    tokens: [
      { key: "terminalBg", label: "Background" },
      { key: "terminalFg", label: "Foreground" },
      { key: "terminalCursor", label: "Cursor" },
      { key: "terminalSelection", label: "Selection" },
    ],
  },
  {
    label: "Terminal ANSI",
    tokens: [
      { key: "ansiBlack", label: "Black" },
      { key: "ansiRed", label: "Red" },
      { key: "ansiGreen", label: "Green" },
      { key: "ansiYellow", label: "Yellow" },
      { key: "ansiBlue", label: "Blue" },
      { key: "ansiMagenta", label: "Magenta" },
      { key: "ansiCyan", label: "Cyan" },
      { key: "ansiWhite", label: "White" },
      { key: "ansiBrightBlack", label: "Bright Black" },
      { key: "ansiBrightRed", label: "Bright Red" },
      { key: "ansiBrightGreen", label: "Bright Green" },
      { key: "ansiBrightYellow", label: "Bright Yellow" },
      { key: "ansiBrightBlue", label: "Bright Blue" },
      { key: "ansiBrightMagenta", label: "Bright Magenta" },
      { key: "ansiBrightCyan", label: "Bright Cyan" },
      { key: "ansiBrightWhite", label: "Bright White" },
    ],
  },
  {
    label: "Scrollbar",
    tokens: [
      { key: "scrollbarThumb", label: "Thumb" },
      { key: "scrollbarThumbHover", label: "Thumb Hover" },
    ],
  },
];

/** Flat list of every editable color token key, in editor display order. */
export const COLOR_TOKEN_KEYS: (keyof ThemeColors)[] = COLOR_TOKEN_GROUPS.flatMap((g) =>
  g.tokens.map((t) => t.key)
);
