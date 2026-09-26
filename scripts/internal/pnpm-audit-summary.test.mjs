import { describe, it, expect } from "vitest";
import { summarize } from "./pnpm-audit-summary.mjs";

const payload = (vulnerabilities) => JSON.stringify({ metadata: { vulnerabilities } });

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

  it("warns instead of throwing on an unparseable payload", () => {
    expect(summarize("").annotation).toMatch(/no parseable JSON/);
    expect(summarize("{}").annotation).toMatch(/no parseable JSON/);
  });
});
