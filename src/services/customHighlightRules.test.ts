import { describe, it, expect } from "vitest";
import {
  DEFAULT_CUSTOM_RULE_PRIORITY,
  addCustomRule,
  createCustomRule,
  generateRuleId,
  moveCustomRule,
  removeCustomRule,
  updateCustomRule,
} from "./customHighlightRules";
import type { HighlightRule } from "../types/syntaxHighlighting";

function ruleWith(id: string, overrides: Partial<HighlightRule> = {}): HighlightRule {
  return createCustomRule({ name: id, pattern: id, ...overrides, id } as Partial<HighlightRule>);
}

describe("generateRuleId", () => {
  it("produces unique, custom-prefixed ids", () => {
    const a = generateRuleId();
    const b = generateRuleId();
    expect(a).toMatch(/^custom-/);
    expect(a).not.toBe(b);
  });
});

describe("createCustomRule", () => {
  it("fills in enabled, non-builtin defaults", () => {
    const rule = createCustomRule({ name: "TODO", pattern: "TODO" });
    expect(rule.builtin).toBe(false);
    expect(rule.enabled).toBe(true);
    expect(rule.caseSensitive).toBe(true);
    expect(rule.wholeWord).toBe(false);
    expect(rule.priority).toBe(DEFAULT_CUSTOM_RULE_PRIORITY);
    expect(rule.id).toMatch(/^custom-/);
    expect(rule.style.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it("applies overrides", () => {
    const rule = createCustomRule({
      name: "n",
      pattern: "p",
      style: { color: "#ff0000", bold: true },
      caseSensitive: false,
    });
    expect(rule.name).toBe("n");
    expect(rule.style).toEqual({ color: "#ff0000", bold: true });
    expect(rule.caseSensitive).toBe(false);
  });
});

describe("custom-rule list mutations", () => {
  it("adds a rule without mutating the input", () => {
    const original: HighlightRule[] = [];
    const next = addCustomRule(original, ruleWith("a"));
    expect(next).toHaveLength(1);
    expect(original).toHaveLength(0);
  });

  it("updates the matching rule by id", () => {
    const rules = [ruleWith("a"), ruleWith("b")];
    const edited = { ...rules[1], name: "renamed" };
    const next = updateCustomRule(rules, edited);
    expect(next[1].name).toBe("renamed");
    expect(next[0]).toBe(rules[0]);
  });

  it("leaves the list unchanged when updating a missing id", () => {
    const rules = [ruleWith("a")];
    const next = updateCustomRule(rules, ruleWith("zzz"));
    expect(next).toEqual(rules);
  });

  it("removes a rule by id", () => {
    const rules = [ruleWith("a"), ruleWith("b")];
    const next = removeCustomRule(rules, "a");
    expect(next.map((r) => r.id)).toEqual(["b"]);
  });

  it("reorders a rule and leaves the source array intact", () => {
    const rules = [ruleWith("a"), ruleWith("b"), ruleWith("c")];
    const next = moveCustomRule(rules, 0, 2);
    expect(next.map((r) => r.id)).toEqual(["b", "c", "a"]);
    expect(rules.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("ignores out-of-range or no-op moves", () => {
    const rules = [ruleWith("a"), ruleWith("b")];
    expect(moveCustomRule(rules, 0, 0).map((r) => r.id)).toEqual(["a", "b"]);
    expect(moveCustomRule(rules, -1, 1).map((r) => r.id)).toEqual(["a", "b"]);
    expect(moveCustomRule(rules, 0, 5).map((r) => r.id)).toEqual(["a", "b"]);
  });
});
