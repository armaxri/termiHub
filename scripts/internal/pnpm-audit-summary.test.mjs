import { describe, it, expect } from "vitest";
import { fixableBlocking, readIgnoreGhsas, summarize } from "./pnpm-audit-summary.mjs";

const payload = (vulnerabilities, advisories = {}) =>
  JSON.stringify({ metadata: { vulnerabilities }, advisories });

// Shape of a real `pnpm audit --json` advisory (minimist 1.2.5, GHSA-xvch-5gv4-984h).
const advisory = (overrides) => ({
  id: 1179,
  module_name: "minimist",
  severity: "critical",
  patched_versions: ">=1.2.6",
  vulnerable_versions: "<1.2.6",
  github_advisory_id: "GHSA-xvch-5gv4-984h",
  url: "https://github.com/advisories/GHSA-xvch-5gv4-984h",
  ...overrides,
});

describe("summarize", () => {
  it("counts every severity and warns on high/critical", () => {
    const { line, annotation } = summarize(
      payload({ info: 0, low: 2, moderate: 10, high: 22, critical: 0 })
    );
    expect(line).toBe("critical 0, high 22, moderate 10, low 2");
    expect(annotation).toMatch(/^::warning title=Dev-dependency advisories::critical 0, high 22/);
  });

  it("stays quiet when only low/moderate advisories remain", () => {
    expect(summarize(payload({ low: 1, moderate: 3 })).annotation).toBeNull();
  });

  it("warns instead of throwing on an unparseable payload, and never blocks", () => {
    expect(summarize("").annotation).toMatch(/no parseable JSON/);
    expect(summarize("{}").annotation).toMatch(/no parseable JSON/);
    expect(summarize("").fixable).toEqual([]);
  });

  it("reports a fixable critical as blocking", () => {
    const { fixable } = summarize(payload({ critical: 1 }, { 1179: advisory() }));
    expect(fixable).toEqual([
      {
        module: "minimist",
        severity: "critical",
        patched: ">=1.2.6",
        id: "GHSA-xvch-5gv4-984h",
        url: "https://github.com/advisories/GHSA-xvch-5gv4-984h",
      },
    ]);
  });
});

describe("fixableBlocking", () => {
  it("ignores an advisory with no patched version (pnpm's <0.0.0 marker)", () => {
    expect(fixableBlocking({ 1: advisory({ patched_versions: "<0.0.0" }) })).toEqual([]);
    expect(fixableBlocking({ 1: advisory({ patched_versions: "" }) })).toEqual([]);
    expect(fixableBlocking({ 1: advisory({ patched_versions: undefined }) })).toEqual([]);
  });

  it("ignores moderate/low even when a fix exists", () => {
    expect(fixableBlocking({ 1: advisory({ severity: "moderate" }) })).toEqual([]);
    expect(fixableBlocking({ 1: advisory({ severity: "low" }) })).toEqual([]);
  });

  it("blocks on high as well as critical", () => {
    expect(fixableBlocking({ 1: advisory({ severity: "high" }) })).toHaveLength(1);
  });

  it("skips GHSA ids accepted in package.json auditConfig", () => {
    expect(fixableBlocking({ 1: advisory() }, ["GHSA-xvch-5gv4-984h"])).toEqual([]);
  });

  it("tolerates a payload without an advisories map", () => {
    expect(fixableBlocking(undefined)).toEqual([]);
  });
});

describe("readIgnoreGhsas", () => {
  it("reads pnpm.auditConfig.ignoreGhsas and tolerates its absence", () => {
    const pkg = { pnpm: { auditConfig: { ignoreGhsas: ["GHSA-a"] } } };
    expect(readIgnoreGhsas(JSON.stringify(pkg))).toEqual(["GHSA-a"]);
    expect(readIgnoreGhsas(JSON.stringify({ pnpm: {} }))).toEqual([]);
    expect(readIgnoreGhsas("not json")).toEqual([]);
  });
});
