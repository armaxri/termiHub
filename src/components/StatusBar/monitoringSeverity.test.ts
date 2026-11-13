/**
 * Band boundaries for monitoring severity colours — replaces legacy manual item
 * MT-SSH-23 ("high values show warning/critical colors", #3681).
 */
import { describe, it, expect } from "vitest";
import { severityLevel, statusStatSeverity } from "./monitoringSeverity";

describe("severityLevel (MT-SSH-23)", () => {
  it.each([
    [0, "normal"],
    [69.9, "normal"],
    [70, "warning"],
    [89.9, "warning"],
    [90, "critical"],
    [100, "critical"],
  ] as const)("maps %s%% to %s", (value, expected) => {
    expect(severityLevel(value)).toBe(expected);
  });
});

describe("statusStatSeverity (#5563)", () => {
  it.each([
    [0, "normal"],
    [78, "normal"],
    [89.9, "normal"],
    [90, "warning"],
    [94.9, "warning"],
    [95, "critical"],
    [100, "critical"],
  ] as const)("maps %s%% to %s", (value, expected) => {
    expect(statusStatSeverity(value)).toBe(expected);
  });
});

describe("status-bar stat colours (#5563)", () => {
  it("paints normal stats in the inherited muted status-bar colour", async () => {
    const { readFileSync } = await import("fs");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "StatusBar.css"),
      "utf8"
    );
    const rule = css.slice(css.indexOf(".monitoring-status__stat--normal {"));
    expect(rule.slice(0, rule.indexOf("}"))).toMatch(/color:\s*inherit;/);
  });
});
