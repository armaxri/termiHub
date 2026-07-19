import { describe, it, expect } from "vitest";
import {
  BUILTIN_RULES,
  cloneBuiltinRules,
  getThemedBuiltinRules,
  getThemedRuleColor,
} from "./syntaxHighlightingRules";
import type { HighlightRule } from "../types/syntaxHighlighting";

/** Build a case-aware regex for a built-in rule exactly as the engine would. */
function ruleRegex(rule: HighlightRule): RegExp {
  const flags = rule.caseSensitive === false ? "gi" : "g";
  return new RegExp(rule.pattern, flags);
}

function ruleById(id: string): HighlightRule {
  const rule = BUILTIN_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`no built-in rule ${id}`);
  return rule;
}

/** Whether the rule matches the entire string (a clean positive example). */
function matchesWhole(rule: HighlightRule, text: string): boolean {
  const re = ruleRegex(rule);
  const m = re.exec(text);
  return m !== null && m[0] === text;
}

/** Whether the rule matches anywhere in the string. */
function matchesAnywhere(rule: HighlightRule, text: string): boolean {
  return ruleRegex(rule).test(text);
}

describe("BUILTIN_RULES structure", () => {
  it("has unique ids", () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("enables P0/P1 by default and disables P2/P3", () => {
    for (const rule of BUILTIN_RULES) {
      if (rule.priority <= 1) expect(rule.enabled).toBe(true);
      else expect(rule.enabled).toBe(false);
    }
  });

  it("marks every built-in rule as builtin with a valid regex and hex color", () => {
    for (const rule of BUILTIN_RULES) {
      expect(rule.builtin).toBe(true);
      expect(() => new RegExp(rule.pattern)).not.toThrow();
      expect(rule.style.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe("built-in regex positives and negatives", () => {
  const cases: Record<string, { positives: string[]; negatives: string[] }> = {
    "error-keywords": {
      positives: ["ERROR", "error", "Failed", "FATAL", "CRITICAL", "DENIED", "refused"],
      negatives: ["errorless", "terror", "okay"],
    },
    "warning-keywords": {
      positives: ["WARN", "warning", "DEPRECATED", "Caution"],
      negatives: ["forewarn", "warned-you-not"],
    },
    "success-keywords": {
      positives: ["OK", "PASS", "passed", "SUCCESS", "done", "CONNECTED"],
      negatives: ["okra", "passenger", "undone-ish"],
    },
    urls: {
      positives: ["https://example.com", "http://a.b/c?d=e", "ftp://host/file"],
      negatives: ["example.com", "just text"],
    },
    "file-paths": {
      positives: ["/usr/local/bin/foo", "./config.json", "../a/b", "~/docs/notes.txt"],
      negatives: ["nothing", "a.b.c"],
    },
    "ip-addresses": {
      positives: ["192.168.1.1", "10.0.0.1:8080", "::1", "fe80::1%eth0"],
      negatives: ["hello world", "just.a.host.name"],
    },
    numbers: {
      positives: ["42", "3.14", "0xFF", "1,234,567"],
      negatives: ["word", "abc"],
    },
    "quoted-strings": {
      positives: ['"hello world"', "'config value'"],
      negatives: ["unquoted", "no quotes here"],
    },
    "email-addresses": {
      positives: ["user@example.com", "a.b+c@sub.domain.io"],
      negatives: ["not-an-email", "@nope"],
    },
    "mac-addresses": {
      positives: ["00:1A:2B:3C:4D:5E", "aa-bb-cc-dd-ee-ff"],
      negatives: ["00:1A:2B", "hello"],
    },
    "dates-times": {
      positives: ["2026-03-21", "2026-03-21T14:30:05", "14:30:05", "09:15"],
      negatives: ["not a date", "2026/03/21"],
    },
    uuids: {
      positives: ["550e8400-e29b-41d4-a716-446655440000"],
      negatives: ["550e8400", "not-a-uuid"],
    },
    "hex-values": {
      positives: ["0xDEADBEEF", "#FF5733", "#abc"],
      negatives: ["hello", "0xZZ"],
    },
  };

  for (const [id, { positives, negatives }] of Object.entries(cases)) {
    describe(id, () => {
      const rule = ruleById(id);
      for (const positive of positives) {
        it(`matches ${JSON.stringify(positive)}`, () => {
          expect(matchesAnywhere(rule, positive)).toBe(true);
        });
      }
      for (const negative of negatives) {
        it(`rejects ${JSON.stringify(negative)}`, () => {
          expect(matchesWhole(rule, negative)).toBe(false);
        });
      }
    });
  }
});

describe("theme-aware color resolution", () => {
  it("resolves known rule ids to #RRGGBB", () => {
    expect(getThemedRuleColor("error-keywords")).toMatch(/^#[0-9a-fA-F]{6}$/i);
    expect(getThemedRuleColor("urls")).toMatch(/^#[0-9a-fA-F]{6}$/i);
  });

  it("falls back to a valid color for unknown rule ids", () => {
    expect(getThemedRuleColor("does-not-exist")).toMatch(/^#[0-9a-fA-F]{6}$/i);
  });

  it("getThemedBuiltinRules returns one themed rule per built-in", () => {
    const themed = getThemedBuiltinRules();
    expect(themed).toHaveLength(BUILTIN_RULES.length);
    for (const rule of themed) {
      expect(rule.style.color).toMatch(/^#[0-9a-fA-F]{6}$/i);
    }
  });

  it("cloneBuiltinRules yields an independent mutable copy", () => {
    const clone = cloneBuiltinRules();
    clone[0].enabled = !clone[0].enabled;
    clone[0].style.color = "#000000";
    expect(BUILTIN_RULES[0].enabled).not.toBe(clone[0].enabled);
    expect(BUILTIN_RULES[0].style.color).not.toBe("#000000");
  });
});
