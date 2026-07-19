/**
 * Pure helpers for managing the user-defined ("custom") highlight rules stored
 * in {@link SyntaxHighlightingConfig.customRules}.
 *
 * These keep the add / edit / delete / reorder logic out of the React editor so
 * it can be unit-tested independently, and so every mutation returns a fresh
 * array (never mutates the persisted config in place, which would defeat the
 * store's change detection and auto-save).
 */

import type { HighlightRule, HighlightStyle } from "../types/syntaxHighlighting";

/**
 * Default evaluation priority for a new custom rule. Built-ins span P0–P3; a
 * custom rule sits at P1 so it competes on equal footing for overlapping,
 * equal-length matches without automatically overriding the P0 keyword rules.
 */
export const DEFAULT_CUSTOM_RULE_PRIORITY = 1;

/** Default style for a freshly-created custom rule. */
export function defaultCustomRuleStyle(): HighlightStyle {
  return { color: "#4fc1ff" };
}

/** Generates a stable, collision-resistant id for a new custom rule. */
export function generateRuleId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return `custom-${cryptoObj.randomUUID()}`;
  }
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Builds a new, enabled custom rule with sensible defaults. The caller supplies
 * the fields the user edits; everything else is filled in.
 */
export function createCustomRule(
  overrides: Partial<Omit<HighlightRule, "id" | "builtin">> = {}
): HighlightRule {
  return {
    id: generateRuleId(),
    name: "",
    pattern: "",
    style: defaultCustomRuleStyle(),
    caseSensitive: true,
    wholeWord: false,
    enabled: true,
    priority: DEFAULT_CUSTOM_RULE_PRIORITY,
    builtin: false,
    ...overrides,
  };
}

/** Appends a rule, returning a new array. */
export function addCustomRule(rules: readonly HighlightRule[], rule: HighlightRule): HighlightRule[] {
  return [...rules, rule];
}

/**
 * Replaces the rule whose id matches `rule.id`, returning a new array. If no
 * rule matches (e.g. it was deleted concurrently), the list is returned
 * unchanged.
 */
export function updateCustomRule(
  rules: readonly HighlightRule[],
  rule: HighlightRule
): HighlightRule[] {
  return rules.map((r) => (r.id === rule.id ? rule : r));
}

/** Removes the rule with the given id, returning a new array. */
export function removeCustomRule(rules: readonly HighlightRule[], id: string): HighlightRule[] {
  return rules.filter((r) => r.id !== id);
}

/**
 * Moves the rule at `from` to `to`, returning a new array. Out-of-range indices
 * leave the list unchanged. Order matters: it is the final tie-breaker when two
 * equal-length, equal-priority matches overlap.
 */
export function moveCustomRule(
  rules: readonly HighlightRule[],
  from: number,
  to: number
): HighlightRule[] {
  if (from < 0 || from >= rules.length || to < 0 || to >= rules.length || from === to) {
    return [...rules];
  }
  const next = [...rules];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
