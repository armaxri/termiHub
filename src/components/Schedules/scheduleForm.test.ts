import { describe, expect, it } from "vitest";

import type { ScheduleInput } from "@/types/schedule";

import {
  blankScheduleForm,
  describeRule,
  describeTargetNames,
  formatNextRun,
  formToScheduleInput,
  scheduleFormSchema,
  scheduleToForm,
  type ScheduleFormValues,
} from "./scheduleForm";

const valid = (over: Partial<ScheduleFormValues> = {}): ScheduleFormValues => ({
  ...blankScheduleForm({ kind: "workflow", workflowId: "wf" }),
  name: "Health",
  connectionIds: ["c1"],
  ...over,
});

const issues = (v: ScheduleFormValues): string[] => {
  const r = scheduleFormSchema.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => String(i.path[0]));
};

describe("scheduleFormSchema", () => {
  it("accepts a complete interval schedule", () => {
    expect(issues(valid())).toEqual([]);
  });

  it("requires a name, an action and at least one target", () => {
    expect(issues(valid({ name: "  " }))).toContain("name");
    expect(issues(valid({ workflowId: "" }))).toContain("workflowId");
    expect(issues(valid({ actionKind: "macro", macroId: "" }))).toContain("macroId");
    expect(issues(valid({ connectionIds: [] }))).toContain("connectionIds");
    expect(issues(valid({ targetsKind: "broadcast-group", groupId: "" }))).toContain("groupId");
  });

  it("bounds the interval to 1 minute … 1 week, whole minutes", () => {
    expect(issues(valid({ everyMinutes: 0 }))).toContain("everyMinutes");
    expect(issues(valid({ everyMinutes: "" }))).toContain("everyMinutes");
    expect(issues(valid({ everyMinutes: 1.5 }))).toContain("everyMinutes");
    expect(issues(valid({ everyMinutes: 1 }))).toEqual([]);
    expect(issues(valid({ everyMinutes: 10080 }))).toEqual([]);
    expect(issues(valid({ everyMinutes: 10081 }))).toContain("everyMinutes");
  });

  it("requires a valid 24h time for daily/weekly and a day for weekly", () => {
    expect(issues(valid({ ruleKind: "daily", time: "24:00" }))).toContain("time");
    expect(issues(valid({ ruleKind: "daily", time: "9:00" }))).toContain("time");
    expect(issues(valid({ ruleKind: "daily", time: "23:59" }))).toEqual([]);
    expect(issues(valid({ ruleKind: "weekly", days: [] }))).toContain("days");
    // The interval's time field is irrelevant.
    expect(issues(valid({ ruleKind: "interval", time: "" }))).toEqual([]);
  });
});

describe("form ↔ input conversion", () => {
  it("round-trips every rule kind and target kind", () => {
    const inputs: ScheduleInput[] = [
      {
        id: "s1",
        name: "A",
        action: { kind: "workflow", workflowId: "wf" },
        targets: { kind: "connections", connectionIds: ["c1", "c2"] },
        rule: { kind: "interval", everyMinutes: 5 },
        missedRuns: "skip",
      },
      {
        id: "s2",
        name: "B",
        action: { kind: "macro", macroId: "m" },
        targets: { kind: "broadcast-group", groupId: "g" },
        rule: { kind: "weekly", days: ["mon", "fri"], time: "18:30" },
        missedRuns: "run-once",
      },
      {
        id: "s3",
        name: "C",
        action: { kind: "workflow", workflowId: "wf" },
        targets: { kind: "connections", connectionIds: ["c1"] },
        rule: { kind: "daily", time: "07:05" },
        missedRuns: "skip",
      },
    ];
    for (const input of inputs) {
      expect(formToScheduleInput(input.id, scheduleToForm(input))).toEqual(input);
    }
  });

  it("stores weekdays in week order and trims the name", () => {
    const out = formToScheduleInput(
      "s",
      valid({ name: "  X  ", ruleKind: "weekly", days: ["sun", "mon", "wed"], time: "08:00" })
    );
    expect(out.name).toBe("X");
    expect(out.rule).toEqual({ kind: "weekly", days: ["mon", "wed", "sun"], time: "08:00" });
  });

  it("pre-selects the action a new schedule was opened for", () => {
    expect(blankScheduleForm({ kind: "macro", macroId: "m1" })).toMatchObject({
      actionKind: "macro",
      macroId: "m1",
      workflowId: "",
    });
  });
});

describe("describeRule", () => {
  it("summarises every rule kind", () => {
    expect(describeRule({ kind: "interval", everyMinutes: 1 })).toBe("Every minute");
    expect(describeRule({ kind: "interval", everyMinutes: 15 })).toBe("Every 15 minutes");
    expect(describeRule({ kind: "daily", time: "09:00" })).toBe("Daily at 09:00");
    expect(describeRule({ kind: "weekly", days: ["fri", "mon"], time: "18:30" })).toBe(
      "Mon, Fri at 18:30"
    );
    expect(
      describeRule({ kind: "weekly", days: ["mon", "tue", "wed", "thu", "fri"], time: "08:00" })
    ).toBe("Weekdays at 08:00");
    expect(
      describeRule({
        kind: "weekly",
        days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        time: "08:00",
      })
    ).toBe("Every day at 08:00");
  });
});

describe("describeTargetNames", () => {
  const names = new Map([
    ["c1", "web-1"],
    ["c2", "web-2"],
  ]);
  const lookup = (id: string) => names.get(id);

  it("lists connection names, flagging unknown ids", () => {
    expect(
      describeTargetNames({ kind: "connections", connectionIds: ["c1", "zz"] }, lookup, [])
    ).toEqual({ label: "web-1, Unknown (zz)", hosts: ["web-1", "Unknown (zz)"] });
  });

  it("resolves a broadcast group's members, or flags a missing group", () => {
    const groups = [{ id: "g", name: "Web", connectionIds: ["c1", "c2"] }];
    expect(describeTargetNames({ kind: "broadcast-group", groupId: "g" }, lookup, groups)).toEqual({
      label: 'Group "Web"',
      hosts: ["web-1", "web-2"],
    });
    expect(
      describeTargetNames({ kind: "broadcast-group", groupId: "x" }, lookup, groups).hosts
    ).toEqual([]);
  });
});

describe("formatNextRun", () => {
  const now = new Date(2026, 5, 1, 10, 0);
  it("says today / tomorrow, else the date", () => {
    expect(formatNextRun(new Date(2026, 5, 1, 18, 5).toISOString(), now)).toBe("today 18:05");
    expect(formatNextRun(new Date(2026, 5, 2, 7, 0).toISOString(), now)).toBe("tomorrow 07:00");
    expect(formatNextRun(new Date(2026, 5, 5, 9, 30).toISOString(), now)).toMatch(/09:30$/);
    expect(formatNextRun("garbage", now)).toBe("");
  });
});
