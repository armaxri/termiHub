import { describe, it, expect } from "vitest";
import {
  MAX_PATTERN_LENGTH,
  buildRuleSource,
  hasNestedQuantifier,
  hasSuperLinearBacktracking,
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

describe("hasSuperLinearBacktracking", () => {
  it("flags overlapping-alternation ReDoS the structural check misses", () => {
    // (a|a)+ is not a nested-quantifier shape but backtracks super-linearly.
    // Detection is static (automaton-based), so it never depends on machine speed.
    expect(hasSuperLinearBacktracking("(a|a)+$", "g")).toBe(true);
    expect(hasSuperLinearBacktracking("(a|ab)+$", "g")).toBe(true);
    expect(hasSuperLinearBacktracking("(x+x+)+y", "g")).toBe(true);
  });

  it("returns false for a normal linear pattern", () => {
    expect(hasSuperLinearBacktracking("\\berror\\b", "g")).toBe(false);
    expect(hasSuperLinearBacktracking("(?:https?)://\\S+", "g")).toBe(false);
    expect(hasSuperLinearBacktracking("(a|b)+", "g")).toBe(false);
    expect(hasSuperLinearBacktracking("\\b(?:TODO|FIXME)\\b", "g")).toBe(false);
  });

  it("is deterministic across repeated calls (no timing dependence)", () => {
    // The same verdict every time, regardless of how fast the machine runs it.
    for (let i = 0; i < 5; i++) {
      expect(hasSuperLinearBacktracking("(a|a)+$", "g")).toBe(true);
      expect(hasSuperLinearBacktracking("\\berror\\b", "g")).toBe(false);
    }
  });

  it("defers (returns false) for an uncompilable source", () => {
    expect(hasSuperLinearBacktracking("(unclosed", "g")).toBe(false);
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

  it("rejects an overlapping-alternation ReDoS pattern via static analysis", () => {
    // Deterministic: caught by scslre's automaton analysis, not a wall-clock
    // threshold, so the verdict does not depend on runner speed (#2262).
    const result = validateHighlightPattern("(a|a)+$");
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/backtracking|redos/i);
  });

  it("gives the same verdict on repeated runs (no timing flake)", () => {
    for (let i = 0; i < 5; i++) {
      expect(validateHighlightPattern("(a|a)+$").valid).toBe(false);
      expect(validateHighlightPattern("\\b(?:TODO|FIXME)\\b").valid).toBe(true);
    }
  });
});
