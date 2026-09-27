/**
 * Band boundaries for monitoring severity colours — replaces legacy manual item
 * MT-SSH-23 ("high values show warning/critical colors", #3681).
 */
import { describe, it, expect } from "vitest";
import { severityLevel } from "./monitoringSeverity";

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
