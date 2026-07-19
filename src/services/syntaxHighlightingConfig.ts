/**
 * Settings model + resolution helpers for terminal output syntax highlighting.
 *
 * This layer sits between the persisted configuration
 * ({@link SyntaxHighlightingConfig} in app settings, plus an optional
 * per-connection {@link ConnectionHighlightingConfig}) and the engine
 * (`src/services/syntaxHighlighting.ts`), which consumes a flat list of
 * {@link HighlightRule}s.
 *
 * - {@link defaultHighlightingConfig} produces the shipped defaults (P0/P1
 *   built-in rules on, P2/P3 off, no custom rules — see the built-in rule set
 *   in `syntaxHighlightingRules.ts`). Absent config resolves to these defaults,
 *   which keeps older settings files forward-compatible.
 * - {@link resolveHighlightingConfig} folds the global config and an optional
 *   per-connection override into a single {@link ResolvedHighlightingConfig}.
 * - {@link resolveActiveRules} turns a resolved (or global) config into the
 *   concrete list of enabled rules the engine should compile.
 */

import { BUILTIN_RULES } from "./syntaxHighlightingRules";
import type {
  ConnectionHighlightingConfig,
  HighlightRule,
  SyntaxHighlightingConfig,
} from "../types/syntaxHighlighting";

/**
 * Product default for the master on/off switch.
 *
 * Shipped **off**: the feature is opt-in until the user enables it in settings.
 * Built-in rules still carry their shipped per-rule enabled flags so that
 * turning the master switch on immediately activates the P0/P1 set.
 */
export const DEFAULT_HIGHLIGHTING_ENABLED = false;

/**
 * Built-in rule id → enabled flag, seeded from each rule's shipped default
 * (`HighlightRule.enabled`). P0/P1 rules are on, P2/P3 rules are off.
 */
export function defaultBuiltinRuleFlags(): Record<string, boolean> {
  const flags: Record<string, boolean> = {};
  for (const rule of BUILTIN_RULES) {
    flags[rule.id] = rule.enabled;
  }
  return flags;
}

/** The shipped global configuration used when no config has been persisted. */
export function defaultHighlightingConfig(): SyntaxHighlightingConfig {
  return {
    enabled: DEFAULT_HIGHLIGHTING_ENABLED,
    builtinRules: defaultBuiltinRuleFlags(),
    customRules: [],
  };
}

/**
 * A global config merged with a per-connection override, ready for the engine.
 *
 * `enabled` reflects the effective on/off state for the connection after
 * applying the override; the caller should skip highlighting entirely when it
 * is `false`. `builtinRules` and `customRules` describe *which* rules apply
 * when highlighting runs — pass this object to {@link resolveActiveRules}.
 */
export interface ResolvedHighlightingConfig {
  /** Effective on/off state after the per-connection override is applied. */
  enabled: boolean;
  /** Built-in rule id → enabled flag (from the global config). */
  builtinRules: Record<string, boolean>;
  /** Global custom rules followed by per-connection additional rules. */
  customRules: HighlightRule[];
}

/**
 * Folds the global config and an optional per-connection config into a single
 * {@link ResolvedHighlightingConfig}.
 *
 * The per-connection `override` decides the effective on/off state:
 * - `"always-on"` forces highlighting on regardless of the global switch;
 * - `"always-off"` forces it off;
 * - `"global"` (the default when no per-connection config exists) follows the
 *   global `enabled` flag.
 *
 * Per-connection `additionalRules` are appended after the global custom rules —
 * they can add patterns but never remove global rules.
 *
 * A missing global config falls back to {@link defaultHighlightingConfig}.
 */
export function resolveHighlightingConfig(
  global: SyntaxHighlightingConfig | undefined,
  perConnection?: ConnectionHighlightingConfig
): ResolvedHighlightingConfig {
  const g = global ?? defaultHighlightingConfig();
  const override = perConnection?.override ?? "global";

  let enabled: boolean;
  switch (override) {
    case "always-on":
      enabled = true;
      break;
    case "always-off":
      enabled = false;
      break;
    default:
      enabled = g.enabled;
      break;
  }

  return {
    enabled,
    builtinRules: g.builtinRules,
    customRules: [...g.customRules, ...(perConnection?.additionalRules ?? [])],
  };
}

/**
 * Produces the concrete list of rules the engine should compile, independent of
 * the master on/off state (callers gate on `enabled` themselves).
 *
 * A built-in rule is included when its flag in `builtinRules` is `true`, or —
 * when the flag is absent — when the rule ships enabled by default. Custom
 * rules are included when their own `enabled` flag is set. Every returned rule
 * is a shallow copy with its own `style`, so callers may recolor (e.g. theme
 * resolution) without mutating the shared built-in definitions.
 */
export function resolveActiveRules(config: {
  builtinRules: Record<string, boolean>;
  customRules: HighlightRule[];
}): HighlightRule[] {
  const active: HighlightRule[] = [];

  for (const rule of BUILTIN_RULES) {
    const enabled = config.builtinRules[rule.id] ?? rule.enabled;
    if (enabled) {
      active.push({ ...rule, enabled: true, style: { ...rule.style } });
    }
  }

  for (const rule of config.customRules) {
    if (rule.enabled) {
      active.push({ ...rule, style: { ...rule.style } });
    }
  }

  return active;
}
