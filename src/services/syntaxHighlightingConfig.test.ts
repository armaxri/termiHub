import { describe, it, expect } from "vitest";
import {
  DEFAULT_HIGHLIGHTING_ENABLED,
  defaultBuiltinRuleFlags,
  defaultHighlightingConfig,
  resolveActiveRules,
  resolveHighlightingConfig,
} from "./syntaxHighlightingConfig";
import { BUILTIN_RULES } from "./syntaxHighlightingRules";
import type {
  ConnectionHighlightingConfig,
  HighlightRule,
  SyntaxHighlightingConfig,
} from "../types/syntaxHighlighting";

function customRule(overrides: Partial<HighlightRule> = {}): HighlightRule {
  return {
    id: "custom-1",
    name: "Custom 1",
    pattern: "foo",
    style: { color: "#abcdef" },
    enabled: true,
    priority: 5,
    builtin: false,
    ...overrides,
  };
}

describe("defaultBuiltinRuleFlags", () => {
  it("seeds every built-in rule from its shipped enabled flag", () => {
    const flags = defaultBuiltinRuleFlags();
    expect(Object.keys(flags).length).toBe(BUILTIN_RULES.length);
    for (const rule of BUILTIN_RULES) {
      expect(flags[rule.id]).toBe(rule.enabled);
    }
  });

  it("enables P0/P1 rules and disables P2/P3 rules by default", () => {
    const flags = defaultBuiltinRuleFlags();
    for (const rule of BUILTIN_RULES) {
      expect(flags[rule.id]).toBe(rule.priority <= 1);
    }
  });
});

describe("defaultHighlightingConfig", () => {
  it("ships the feature off, with default rule flags and no custom rules", () => {
    const cfg = defaultHighlightingConfig();
    expect(cfg.enabled).toBe(DEFAULT_HIGHLIGHTING_ENABLED);
    expect(cfg.enabled).toBe(false);
    expect(cfg.customRules).toEqual([]);
    expect(cfg.builtinRules).toEqual(defaultBuiltinRuleFlags());
  });
});

describe("resolveHighlightingConfig", () => {
  const globalOn: SyntaxHighlightingConfig = {
    enabled: true,
    builtinRules: { "error-keywords": true },
    customRules: [customRule({ id: "g-custom" })],
  };
  const globalOff: SyntaxHighlightingConfig = { ...globalOn, enabled: false };

  it("falls back to the built-in defaults when the global config is absent", () => {
    const resolved = resolveHighlightingConfig(undefined);
    expect(resolved.enabled).toBe(false);
    expect(resolved.builtinRules).toEqual(defaultBuiltinRuleFlags());
    expect(resolved.customRules).toEqual([]);
  });

  it("follows the global on/off state for the 'global' override", () => {
    expect(
      resolveHighlightingConfig(globalOn, { override: "global", additionalRules: [] }).enabled
    ).toBe(true);
    expect(
      resolveHighlightingConfig(globalOff, { override: "global", additionalRules: [] }).enabled
    ).toBe(false);
  });

  it("defaults to the global state when no per-connection config is given", () => {
    expect(resolveHighlightingConfig(globalOn).enabled).toBe(true);
    expect(resolveHighlightingConfig(globalOff).enabled).toBe(false);
  });

  it("forces highlighting on for 'always-on' even when the global switch is off", () => {
    const perConn: ConnectionHighlightingConfig = { override: "always-on", additionalRules: [] };
    expect(resolveHighlightingConfig(globalOff, perConn).enabled).toBe(true);
  });

  it("forces highlighting off for 'always-off' even when the global switch is on", () => {
    const perConn: ConnectionHighlightingConfig = { override: "always-off", additionalRules: [] };
    expect(resolveHighlightingConfig(globalOn, perConn).enabled).toBe(false);
  });

  it("appends per-connection additional rules after the global custom rules", () => {
    const extra = customRule({ id: "conn-custom" });
    const resolved = resolveHighlightingConfig(globalOn, {
      override: "global",
      additionalRules: [extra],
    });
    expect(resolved.customRules.map((r) => r.id)).toEqual(["g-custom", "conn-custom"]);
  });

  it("carries the global built-in rule flags through unchanged", () => {
    const resolved = resolveHighlightingConfig(globalOn, {
      override: "always-on",
      additionalRules: [],
    });
    expect(resolved.builtinRules).toEqual({ "error-keywords": true });
  });
});

describe("resolveActiveRules", () => {
  it("includes a built-in rule when its flag is true and omits it when false", () => {
    const active = resolveActiveRules({
      builtinRules: { "error-keywords": true, "warning-keywords": false },
      customRules: [],
    });
    const ids = active.map((r) => r.id);
    expect(ids).toContain("error-keywords");
    expect(ids).not.toContain("warning-keywords");
  });

  it("falls back to the shipped default when a built-in rule has no flag", () => {
    const active = resolveActiveRules({ builtinRules: {}, customRules: [] });
    const ids = new Set(active.map((r) => r.id));
    for (const rule of BUILTIN_RULES) {
      expect(ids.has(rule.id)).toBe(rule.enabled);
    }
  });

  it("marks every returned built-in rule as enabled", () => {
    const active = resolveActiveRules({ builtinRules: {}, customRules: [] });
    expect(active.every((r) => r.enabled)).toBe(true);
  });

  it("includes enabled custom rules and skips disabled ones", () => {
    const active = resolveActiveRules({
      builtinRules: {},
      customRules: [
        customRule({ id: "on", enabled: true }),
        customRule({ id: "off", enabled: false }),
      ],
    });
    const ids = active.map((r) => r.id);
    expect(ids).toContain("on");
    expect(ids).not.toContain("off");
  });

  it("returns copies that do not mutate the shared built-in definitions", () => {
    const active = resolveActiveRules({
      builtinRules: { "error-keywords": true },
      customRules: [],
    });
    const copy = active.find((r) => r.id === "error-keywords");
    const original = BUILTIN_RULES.find((r) => r.id === "error-keywords");
    expect(copy).not.toBe(original);
    copy!.style.color = "#000000";
    expect(original!.style.color).not.toBe("#000000");
  });
});
