import { describe, it, expect } from "vitest";
import {
  MAX_PATTERN_LENGTH,
  buildRuleSource,
  hasNestedQuantifier,
  exceedsAdversarialBudget,
  validateHighlightPattern,
} from "./regexSafety";

describe("buildRuleSource", () => {
  it("passes the raw pattern through with the global flag by default", () => {
    expect(buildRuleSource("foo")).toEqual({ source: "foo", flags: "g" });
  });

  it("wraps whole-word patterns in word boundaries", () => {
    expect(buildRuleSource("cat", { wholeWord: true })).toEqual({
      source: "\\b(?:cat)\\b",
      flags: "g",
    });
  });

  it("adds the case-insensitive flag when caseSensitive is false", () => {
    expect(buildRuleSource("cat", { caseSensitive: false }).flags).toBe("gi");
  });
});

describe("hasNestedQuantifier", () => {
  it("flags the classic (a+)+ / (a*)* star-height-2 shapes", () => {
    expect(hasNestedQuantifier("(a+)+")).toBe(true);
    expect(hasNestedQuantifier("(a*)*")).toBe(true);
    expect(hasNestedQuantifier("(a+)*")).toBe(true);
    expect(hasNestedQuantifier("(\\d+)+")).toBe(true);
    expect(hasNestedQuantifier("([a-z]+)+")).toBe(true);
    expect(hasNestedQuantifier("((ab)+)+")).toBe(true);
    expect(hasNestedQuantifier("(a+){2,}")).toBe(true);
  });

  it("does not flag single-level quantifiers", () => {
    expect(hasNestedQuantifier("\\d+")).toBe(false);
    expect(hasNestedQuantifier("a*")).toBe(false);
    expect(hasNestedQuantifier("(abc)+")).toBe(false);
    expect(hasNestedQuantifier("(a|b)+")).toBe(false);
    expect(hasNestedQuantifier("\\b(?:ERROR|WARN)\\b")).toBe(false);
    expect(hasNestedQuantifier("(?:https?)://\\S+")).toBe(false);
  });

  it("does not flag bounded quantifiers stacked on a group", () => {
    // {n,m} is bounded — no exponential blow-up.
    expect(hasNestedQuantifier("(a{1,3})+")).toBe(false);
  });

  it("ignores quantifier-like characters inside character classes", () => {
    expect(hasNestedQuantifier("[a+*]+")).toBe(false);
  });
});

describe("exceedsAdversarialBudget", () => {
  it("returns true for a catastrophic overlapping-alternation pattern", () => {
    // (a|a)+ is not a nested-quantifier shape but backtracks exponentially.
    expect(exceedsAdversarialBudget("(a|a)+$", "g")).toBe(true);
  });

  it("returns false for a normal linear pattern", () => {
    expect(exceedsAdversarialBudget("\\berror\\b", "g")).toBe(false);
    expect(exceedsAdversarialBudget("(?:https?)://\\S+", "g")).toBe(false);
  });

  it("uses the injected clock to decide (deterministic budget check)", () => {
    let t = 0;
    // Clock jumps 100ms on the first read after start -> over a 30ms budget.
    const fakeNow = (): number => {
      const v = t;
      t += 100;
      return v;
    };
    expect(exceedsAdversarialBudget("abc", "g", 30, fakeNow)).toBe(true);
  });

  it("stays under budget when the injected clock does not advance", () => {
    const frozenNow = (): number => 5;
    expect(exceedsAdversarialBudget("abc", "g", 30, frozenNow)).toBe(false);
  });
});

describe("validateHighlightPattern", () => {
  it("accepts a normal rule pattern", () => {
    expect(validateHighlightPattern("\\b(?:TODO|FIXME)\\b").valid).toBe(true);
    expect(validateHighlightPattern("(?:https?|ftp)://\\S+").valid).toBe(true);
    expect(validateHighlightPattern("cat", { wholeWord: true, caseSensitive: false }).valid).toBe(
      true
    );
  });

  it("rejects an empty pattern", () => {
    const result = validateHighlightPattern("");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/empty/i);
  });

  it("rejects an over-long pattern", () => {
    const result = validateHighlightPattern("a".repeat(MAX_PATTERN_LENGTH + 1));
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/too long/i);
  });

  it("accepts a pattern exactly at the length cap", () => {
    expect(validateHighlightPattern("a".repeat(MAX_PATTERN_LENGTH)).valid).toBe(true);
  });

  it("rejects a syntactically invalid regex", () => {
    const result = validateHighlightPattern("(unclosed");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/invalid regular expression/i);
  });

  it("rejects a nested-quantifier catastrophic-backtracking pattern", () => {
    const result = validateHighlightPattern("(a+)+$");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/backtracking|nested/i);
  });

  it("rejects an overlapping-alternation ReDoS pattern via the empirical backstop", () => {
    const result = validateHighlightPattern("(a|a)+$");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/backtracking|redos|slow/i);
  });
});
