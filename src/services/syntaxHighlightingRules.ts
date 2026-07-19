/**
 * Built-in syntax-highlighting rule set and theme-aware color resolution.
 *
 * The rules here are pure data. The engine (`syntaxHighlighting.ts`) compiles
 * the enabled ones into matchers. Priorities follow the concept doc:
 *   - P0/P1 (error/warning/success keywords, URLs, file paths, IPs, numbers)
 *     ship enabled by default.
 *   - P2/P3 (quoted strings, emails, MAC, dates, UUIDs, hex) ship disabled.
 *
 * Built-in colors are resolved against the active theme via
 * {@link getThemedRuleColor}; the `style.color` baked into {@link BUILTIN_RULES}
 * is only a fallback for when no theme is available.
 */

import { getCurrentTheme } from "../themes";
import type { ThemeColors } from "../themes";
import type { HighlightRule } from "../types/syntaxHighlighting";

/**
 * Built-in rules in evaluation order. Colors are the dark-theme defaults; use
 * {@link getThemedRuleColor} / {@link getThemedBuiltinRules} to resolve against
 * the active theme.
 */
export const BUILTIN_RULES: readonly HighlightRule[] = [
  {
    id: "error-keywords",
    name: "Error keywords",
    pattern: "\\b(?:ERROR|ERR|FAIL(?:ED|URE)?|FATAL|CRITICAL|DENIED|REFUSED|ABORT(?:ED)?|PANIC)\\b",
    style: { color: "#f48771" },
    caseSensitive: false,
    priority: 0,
    builtin: true,
    enabled: true,
  },
  {
    id: "warning-keywords",
    name: "Warning keywords",
    pattern: "\\b(?:WARN(?:ING)?|DEPRECATED|CAUTION|NOTICE)\\b",
    style: { color: "#cca700" },
    caseSensitive: false,
    priority: 0,
    builtin: true,
    enabled: true,
  },
  {
    id: "success-keywords",
    name: "Success keywords",
    pattern: "\\b(?:OK|PASS(?:ED)?|SUCCESS(?:FUL)?|DONE|CONNECTED|COMPLETE(?:D)?|READY)\\b",
    style: { color: "#89d185" },
    caseSensitive: false,
    priority: 0,
    builtin: true,
    enabled: true,
  },
  {
    id: "urls",
    name: "URLs",
    pattern: "(?:https?|ftp)://[^\\s\"'<>]+",
    style: { color: "#3794ff", underline: true },
    priority: 0,
    builtin: true,
    enabled: true,
  },
  {
    id: "file-paths",
    name: "File paths",
    pattern: "(?:~|\\.{1,2})?/[\\w.@%+=~-]+(?:/[\\w.@%+=~-]+)*/?",
    style: { color: "#11a8cd" },
    priority: 1,
    builtin: true,
    enabled: true,
  },
  {
    id: "ip-addresses",
    name: "IP addresses",
    pattern:
      "\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d{1,5})?\\b|(?:(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}|::(?:[0-9a-fA-F]{1,4}:?)*[0-9a-fA-F]{1,4}|[0-9a-fA-F]{1,4}::(?:[0-9a-fA-F]{1,4}:?)*)(?:%[\\w.-]+)?",
    style: { color: "#bc3fbc" },
    priority: 1,
    builtin: true,
    enabled: true,
  },
  {
    id: "numbers",
    name: "Numbers",
    pattern: "\\b(?:0x[0-9a-fA-F]+|\\d[\\d,]*(?:\\.\\d+)?)\\b",
    style: { color: "#29b8db" },
    priority: 1,
    builtin: true,
    enabled: true,
  },
  // --- P2 (disabled by default) ---
  {
    id: "quoted-strings",
    name: "Quoted strings",
    pattern: "\"[^\"\\n]{0,200}\"|'[^'\\n]{0,200}'",
    style: { color: "#e5e510" },
    priority: 2,
    builtin: true,
    enabled: false,
  },
  {
    id: "email-addresses",
    name: "Email addresses",
    pattern: "[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+",
    style: { color: "#3794ff", underline: true },
    priority: 2,
    builtin: true,
    enabled: false,
  },
  {
    id: "mac-addresses",
    name: "MAC addresses",
    pattern: "\\b(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\\b",
    style: { color: "#bc3fbc" },
    priority: 2,
    builtin: true,
    enabled: false,
  },
  // --- P3 (disabled by default) ---
  {
    id: "dates-times",
    name: "Dates/times",
    pattern:
      "\\b\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?\\b|\\b\\d{2}:\\d{2}(?::\\d{2})?\\b",
    style: { color: "#23d18b" },
    priority: 3,
    builtin: true,
    enabled: false,
  },
  {
    id: "uuids",
    name: "UUIDs",
    pattern: "\\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\b",
    style: { color: "#7d7d7d" },
    priority: 3,
    builtin: true,
    enabled: false,
  },
  {
    id: "hex-values",
    name: "Hex values",
    pattern: "\\b0x[0-9a-fA-F]+\\b|#[0-9a-fA-F]{6}\\b|#[0-9a-fA-F]{3}\\b",
    style: { color: "#29b8db" },
    priority: 3,
    builtin: true,
    enabled: false,
  },
];

/**
 * Maps each built-in rule id to a semantic theme color key. Custom (non-builtin)
 * rules are not in this map — they carry explicit hex colors instead.
 */
const RULE_COLOR_KEY: Record<string, keyof ThemeColors> = {
  "error-keywords": "colorError",
  "warning-keywords": "colorWarning",
  "success-keywords": "colorSuccess",
  urls: "textLink",
  "file-paths": "ansiCyan",
  "ip-addresses": "ansiMagenta",
  numbers: "ansiBrightCyan",
  "quoted-strings": "ansiYellow",
  "email-addresses": "textLink",
  "mac-addresses": "ansiMagenta",
  "dates-times": "ansiBrightGreen",
  uuids: "textMuted",
  "hex-values": "ansiBrightCyan",
};

/**
 * Resolves the themed color for a built-in rule against the active theme.
 * Returns a `#RRGGBB` string. Falls back to the theme's primary text color for
 * unknown rule ids.
 */
export function getThemedRuleColor(ruleId: string): string {
  const colors = getCurrentTheme().colors;
  const key = RULE_COLOR_KEY[ruleId];
  return key ? colors[key] : colors.textPrimary;
}

/**
 * Returns the built-in rules with their `style.color` resolved against the
 * active theme. Enabled flags are left at their shipped defaults; callers layer
 * user preferences on top.
 */
export function getThemedBuiltinRules(): HighlightRule[] {
  return BUILTIN_RULES.map((rule) => ({
    ...rule,
    style: { ...rule.style, color: getThemedRuleColor(rule.id) },
  }));
}

/** Returns a fresh, deeply-cloned copy of the built-in rules (mutable). */
export function cloneBuiltinRules(): HighlightRule[] {
  return BUILTIN_RULES.map((rule) => ({ ...rule, style: { ...rule.style } }));
}
