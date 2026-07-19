/**
 * Type definitions for terminal output syntax highlighting.
 *
 * These describe the rule/config data model for the client-side highlighting
 * feature (see `docs/concepts/partial/terminal-syntax-highlighting.md`). The
 * engine (`src/services/syntaxHighlighting.ts`) consumes {@link HighlightRule}s
 * and produces xterm.js decorations; the built-in rule set lives in
 * `src/services/syntaxHighlightingRules.ts`.
 */

/** Visual style applied to matched text. */
export interface HighlightStyle {
  /**
   * Foreground color. xterm.js decoration `foregroundColor` accepts only the
   * `#RRGGBB` format, so this should resolve to a 6-digit hex string. The
   * engine normalizes shorthand (`#RGB`) before applying.
   */
  color: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** A single pattern → style highlighting rule. */
export interface HighlightRule {
  /** Unique identifier (stable across sessions). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Regex pattern source (without flags). */
  pattern: string;
  /** Style applied to matches. */
  style: HighlightStyle;
  /** Whether matching is case sensitive. Defaults to `true`. */
  caseSensitive?: boolean;
  /** Whether the pattern is wrapped in word boundaries. Defaults to `false`. */
  wholeWord?: boolean;
  /** Whether the rule participates in matching. */
  enabled: boolean;
  /**
   * Evaluation priority. Lower wins (P0 = 0, P1 = 1, …). Used to break ties
   * when two equal-length matches overlap.
   */
  priority: number;
  /** `true` for shipped built-in rules, `false` for user-defined rules. */
  builtin: boolean;
}

/** Global syntax-highlighting configuration (stored in app settings). */
export interface SyntaxHighlightingConfig {
  /** Master on/off switch. */
  enabled: boolean;
  /** Built-in rule id → enabled flag (overrides the rule's shipped default). */
  builtinRules: Record<string, boolean>;
  /** User-defined custom rules. */
  customRules: HighlightRule[];
}

/**
 * Per-connection override for the global on/off state.
 * - `global`: follow the global setting.
 * - `always-on`: force highlighting enabled for this connection.
 * - `always-off`: force highlighting disabled for this connection.
 */
export type ConnectionHighlightingOverride = "global" | "always-on" | "always-off";

/** Per-connection syntax-highlighting configuration. */
export interface ConnectionHighlightingConfig {
  /** How the connection relates to the global on/off state. */
  override: ConnectionHighlightingOverride;
  /**
   * Extra rules applied only to this connection, after the global rules. These
   * can add patterns but cannot remove global rules.
   */
  additionalRules: HighlightRule[];
}
