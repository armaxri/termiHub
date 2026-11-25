import { describe, expect, it } from "vitest";
import type { ScheduleInput } from "@/types/schedule";
import {
  needsNewConfirmation,
  scheduleSummary,
  type ScheduleSummaryInput,
} from "./scheduleSummary";

const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
tomorrow.setHours(2, 0, 0, 0);

const summary = (over: Partial<ScheduleSummaryInput> = {}) =>
  scheduleSummary({
    next: tomorrow.toISOString(),
    rule: { kind: "daily", time: "02:00" },
    targets: { label: "Build Box", hosts: ["Build Box"], gone: null },
    cannotRun: false,
    missing: [],
    ifClosed: "connect",
    isOn: true,
    switchesOff: false,
    paused: false,
    ...over,
  });

describe("scheduleSummary: what will happen, before saving (A-046)", () => {
  it("names the next run and where", () => {
    expect(summary()).toEqual(["On. Next run: tomorrow 02:00 on Build Box."]);
  });

  it("promises no run of one that is off, only what happens when it is switched on (B-030)", () => {
    expect(summary({ isOn: false })).toEqual([
      "When switched on: next run tomorrow 02:00 on Build Box.",
    ]);
    expect(summary({ isOn: false, next: null })).toEqual([
      "Off until you switch it on in the list.",
    ]);
  });

  it("says everything that is missing, and nothing about a run (B-032)", () => {
    expect(summary({ isOn: false, missing: ["give it a name", "choose a connection"] })).toEqual([
      "To save: give it a name and choose a connection.",
    ]);
    expect(summary({ missing: ["give it a name"], cannotRun: true })).toEqual([
      "Will not run on a schedule.",
      "To save: give it a name.",
    ]);
  });

  it("an interval counts from the moment it is switched on", () => {
    const rule = { kind: "interval" as const, everyMinutes: 15 };
    expect(summary({ rule, isOn: false })[0]).toBe(
      "Next run: 15 minutes after you switch it on, on Build Box."
    );
    expect(summary({ rule: { ...rule, everyMinutes: 1 }, isOn: false })[0]).toContain(
      "1 minute after"
    );
    expect(summary({ rule })[0]).toBe("On. Next run: tomorrow 02:00 on Build Box.");
  });

  it("says what keeps it from running", () => {
    expect(summary({ targets: { label: "x", hosts: ["x"], gone: "it is gone" } })[0]).toBe(
      "Will not run: it is gone. Choose a connection, or remove the schedule."
    );
    expect(summary({ cannotRun: true })).toEqual(["Will not run on a schedule."]);
    expect(summary({ paused: true })).toContain("All schedules are paused.");
  });

  it("says that a closed connection is skipped", () => {
    expect(summary({ ifClosed: "skip" })).toContain("Skipped where the connection is closed.");
    expect(summary({ ifClosed: "" })).toEqual(summary());
  });

  it("says that saving switches it off", () => {
    expect(summary({ switchesOff: true })[1]).toMatch(/^Saving switches it off/);
  });

  it("promises no time while none is known", () => {
    expect(summary({ next: null })).toEqual([]);
  });
});

describe("needsNewConfirmation mirrors the backend", () => {
  const stored: ScheduleInput = {
    id: "s1",
    name: "Nightly",
    action: { kind: "automation", automationId: "a" },
    targets: { kind: "connections", connectionIds: ["c1"] },
    rule: { kind: "daily", time: "02:00" },
    missedRuns: "skip",
  };
  const changed = (over: Partial<ScheduleInput>) =>
    needsNewConfirmation(stored, { ...stored, ...over });

  it("for another automation, other targets, or newly connecting", () => {
    expect(changed({ action: { kind: "automation", automationId: "b" } })).toBe(true);
    expect(changed({ targets: { kind: "connections", connectionIds: ["c1", "c2"] } })).toBe(true);
    expect(changed({ targets: { kind: "broadcast-group", groupId: "g" } })).toBe(true);
    expect(changed({ connectIfNeeded: true })).toBe(true);
  });

  it("not for a name, a time, or no longer connecting", () => {
    expect(changed({ name: "x", rule: { kind: "daily", time: "03:00" } })).toBe(false);
    expect(changed({ targets: { kind: "connections", connectionIds: ["c1", "c1", " "] } })).toBe(
      false
    );
    const connects = { ...stored, connectIfNeeded: true };
    expect(needsNewConfirmation(connects, stored)).toBe(false);
  });
});
