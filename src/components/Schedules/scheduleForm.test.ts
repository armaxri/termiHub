import { describe, expect, it } from "vitest";

import type { ScheduleInput } from "@/types/schedule";

import {
  blankScheduleForm,
  describeRule,
  describeTargetNames,
  formToScheduleInput,
  scheduleFormSchema,
  scheduleToForm,
  type ScheduleFormValues,
} from "./scheduleForm";

const valid = (over: Partial<ScheduleFormValues> = {}): ScheduleFormValues => ({
  ...blankScheduleForm({ kind: "automation", automationId: "wf" }),
  name: "Health",
  connectionIds: ["c1"],
  ifClosed: "skip",
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
    expect(issues(valid({ automationId: "" }))).toContain("automationId");
    expect(issues(valid({ connectionIds: [] }))).toContain("connectionIds");
    expect(issues(valid({ targetsKind: "broadcast-group", groupId: "" }))).toContain("groupId");
  });

  it("bounds the interval to 1 minute … 1 week, whole minutes", () => {
    expect(issues(valid({ ruleKind: "interval", everyMinutes: 0 }))).toContain("everyMinutes");
    expect(issues(valid({ ruleKind: "interval", everyMinutes: "" }))).toContain("everyMinutes");
    expect(issues(valid({ ruleKind: "interval", everyMinutes: 1.5 }))).toContain("everyMinutes");
    expect(issues(valid({ ruleKind: "interval", everyMinutes: 1 }))).toEqual([]);
    expect(issues(valid({ ruleKind: "interval", everyMinutes: 10080 }))).toEqual([]);
    expect(issues(valid({ ruleKind: "interval", everyMinutes: 10081 }))).toContain("everyMinutes");
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
        action: { kind: "automation", automationId: "wf" },
        targets: { kind: "connections", connectionIds: ["c1", "c2"] },
        rule: { kind: "interval", everyMinutes: 5 },
        missedRuns: "skip",
      },
      {
        id: "s2",
        name: "B",
        action: { kind: "automation", automationId: "m" },
        targets: { kind: "broadcast-group", groupId: "g" },
        rule: { kind: "weekly", days: ["mon", "fri"], time: "18:30" },
        missedRuns: "run-once",
      },
      {
        id: "s3",
        name: "C",
        action: { kind: "automation", automationId: "wf" },
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
    expect(blankScheduleForm({ kind: "automation", automationId: "m1" })).toMatchObject({
      automationId: "m1",
    });
    expect(blankScheduleForm().automationId).toBe("");
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

  it("lists connection names, a deleted one named as such (#6024)", () => {
    expect(
      describeTargetNames(
        { kind: "connections", connectionIds: ["c1", "Work/Old Box"] },
        lookup,
        []
      )
    ).toEqual({
      label: "web-1, Deleted connection “Old Box”",
      hosts: ["web-1", "Deleted connection “Old Box”"],
      gone: null,
    });
  });

  it("says when every connection was deleted (A-045)", () => {
    const { label, gone } = describeTargetNames(
      { kind: "connections", connectionIds: ["zz"] },
      lookup,
      []
    );
    expect(label).toBe("Deleted connection “zz”");
    expect(gone).toBe("its connections were deleted");
  });

  it("resolves a broadcast group's members, or says what is left of it", () => {
    const groups = [
      { id: "g", name: "Web", connectionIds: ["c1", "c2"] },
      { id: "old", name: "Old", connectionIds: ["x/y"] },
    ];
    const of = (groupId: string) =>
      describeTargetNames({ kind: "broadcast-group", groupId }, lookup, groups);
    expect(of("g")).toEqual({ label: "Group “Web”", hosts: ["web-1", "web-2"], gone: null });
    expect(of("old")).toEqual({
      label: "Group “Old”",
      hosts: ["Deleted connection “y”"],
      gone: "its broadcast group has no connection left",
    });
    expect(of("x")).toEqual({
      label: "Deleted broadcast group",
      hosts: [],
      gone: "its broadcast group was deleted",
    });
  });
});

describe("what to do with a closed connection (#3527, #6024)", () => {
  const base: ScheduleInput = {
    id: "s1",
    name: "Health",
    action: { kind: "automation", automationId: "wf" },
    targets: { kind: "connections", connectionIds: ["c1"] },
    rule: { kind: "interval", everyMinutes: 15 },
    missedRuns: "skip",
  };

  it("is not chosen for a new schedule, which cannot be saved without", () => {
    expect(blankScheduleForm().ifClosed).toBe("");
    expect(issues(valid({ ifClosed: "" }))).toEqual(["ifClosed"]);
    expect(issues(valid({ ifClosed: "skip" }))).toEqual([]);
    expect(issues(valid({ ifClosed: "connect" }))).toEqual([]);
  });

  it("an existing schedule keeps its value: absent and off mean skip", () => {
    for (const stored of [base, { ...base, connectIfNeeded: false }]) {
      const form = scheduleToForm(stored);
      expect(form.ifClosed).toBe("skip");
      expect(formToScheduleInput("s1", form)).not.toHaveProperty("connectIfNeeded");
    }
    const form = scheduleToForm({ ...base, connectIfNeeded: true });
    expect(form.ifClosed).toBe("connect");
    expect(formToScheduleInput("s1", form).connectIfNeeded).toBe(true);
  });
});

describe("description (#5757)", () => {
  it("starts empty and round-trips a set description", () => {
    expect(blankScheduleForm().description).toBe("");
    const input: ScheduleInput = {
      id: "s1",
      name: "A",
      description: "Checks the web hosts",
      action: { kind: "automation", automationId: "wf" },
      targets: { kind: "connections", connectionIds: ["c1"] },
      rule: { kind: "interval", everyMinutes: 5 },
      missedRuns: "skip",
    };
    expect(formToScheduleInput("s1", scheduleToForm(input))).toEqual(input);
  });

  it("sends one trimmed line, and none when blank", () => {
    expect(formToScheduleInput("s", valid({ description: "  a\n b " })).description).toBe("a b");
    expect(formToScheduleInput("s", valid({ description: "  " })).description).toBeUndefined();
  });

  it("refuses a description over 80 characters", () => {
    expect(issues(valid({ description: "x".repeat(80) }))).toEqual([]);
    expect(issues(valid({ description: "x".repeat(81) }))).toContain("description");
  });
});
