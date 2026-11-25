import { describe, expect, it } from "vitest";
import type { Automation } from "@/types/generated/Automation";
import type { ScheduleView } from "@/types/schedule";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import {
  automaticTriggers,
  automationRowTooltip,
  nextScheduledRun,
  summarizeRuns,
  triggerState,
  triggerSummary,
  triggersArmed,
} from "./automationRowInfo";

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "a1",
    name: "Deploy",
    tags: [],
    steps: [],
    triggers: [],
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "r1",
    automationId: "a1",
    automationName: "Deploy",
    startedAt: "2026-11-24T10:00:00Z",
    endedAt: "2026-11-24T10:00:01Z",
    status: "completed",
    stepsCompleted: 1,
    total: 1,
    origin: "manual",
    ...overrides,
  };
}

const names: Record<string, string> = { c1: "prod", c2: "db", c3: "web" };
const nameOf = (id: string) => names[id];
const context = { connectionName: nameOf, resolve: () => undefined };

describe("triggers", () => {
  it("counts only connection-bound automatic triggers, never a hotkey", () => {
    const a = automation({
      triggers: [
        { kind: "hotkey", binding: "Ctrl+Alt+D" },
        { kind: "on-connect", connectionIds: [] },
        { kind: "on-disconnect", connectionIds: ["c1"] },
      ],
    });
    expect(automaticTriggers(a).map((x) => x.kind)).toEqual(["on-disconnect"]);
  });

  it("is armed unless it was switched off", () => {
    expect(triggersArmed(automation())).toBe(true);
    expect(triggersArmed(automation({ triggersEnabled: false }))).toBe(false);
  });

  it("summarizes how it is launched, with the first connections and a count", () => {
    expect(triggerSummary(automation(), nameOf)).toBe("Manual");
    const a = automation({
      triggers: [
        { kind: "on-connect", connectionIds: ["c1", "c2", "c3"] },
        { kind: "hotkey", binding: "Ctrl+Alt+D" },
        { kind: "on-disconnect", connectionIds: ["gone"] },
      ],
    });
    expect(triggerSummary(a, nameOf)).toBe(
      "On connect · prod, db +1; Hotkey Ctrl+Alt+D; On disconnect · a deleted connection"
    );
  });

  describe("what starts it, in the row's words (A-013)", () => {
    const a = automation({
      triggers: [
        { kind: "hotkey", binding: "Ctrl+Alt+D" },
        { kind: "on-output-match", connectionIds: ["c1"], pattern: "x" },
        { kind: "on-connect", connectionIds: ["c2"] },
        { kind: "on-disconnect", connectionIds: ["c1", "c2", "c3"] },
      ],
    });

    it("names every hotkey and trigger while they are on", () => {
      expect(triggerState(a, context)).toEqual({
        on: true,
        effective: true,
        text:
          "Triggers on: hotkey Ctrl+Alt+D, matching output in prod, connecting to db, " +
          "disconnecting from prod, db +1",
      });
    });

    it("says what does not start it while they are off, and that it still runs", () => {
      const off = triggerState({ ...a, triggersEnabled: false }, context)!;
      expect(off.on).toBe(false);
      expect(off.text).toMatch(
        /^Triggers off: hotkey Ctrl\+Alt\+D, matching output in prod, .+ and disconnecting/
      );
      expect(off.text).toMatch(/ do not start it\. You can still run it\.$/);
    });

    describe("what can never start it is not among them (C-001)", () => {
      const waits = { steps: [{ kind: "wait-for-user" as const }] };
      const output = { kind: "on-output-match" as const, connectionIds: ["c1"], pattern: "x" };

      it("says the others, and why that one will not", () => {
        const some = automation({
          ...waits,
          triggers: [{ kind: "hotkey", binding: "F9" }, output],
        });
        expect(triggerState(some, context)).toEqual({
          on: true,
          effective: true,
          text: "Triggers on: hotkey F9. On output match will not start it: step 1 waits for you.",
        });
      });

      it("never says that triggers are on when none can start it", () => {
        expect(triggerState(automation({ ...waits, triggers: [output] }), context)).toEqual({
          on: true,
          effective: false,
          text: "No trigger can start it: step 1 waits for you.",
        });
        const hotkey = automation({ triggers: [{ kind: "hotkey", binding: "F9" }] });
        expect(triggerState(hotkey, { ...context, blocked: true })?.text).toBe(
          "No trigger can start it: it cannot run."
        );
        const gone = automation({ triggers: [{ kind: "on-connect", connectionIds: ["x"] }] });
        expect(triggerState(gone, context)?.text).toBe(
          "No trigger can start it: its connection was deleted."
        );
      });
    });

    it.each([
      ["without a trigger", []],
      ["with a hotkey without keys", [{ kind: "hotkey" as const, binding: "" }]],
      ["without a connection", [{ kind: "on-connect" as const, connectionIds: [] }]],
    ])("says nothing %s", (_what, triggers) => {
      expect(triggerState(automation({ triggers }), context)).toBeNull();
    });
  });

  it("says when a schedule runs it next (A-011)", () => {
    const now = new Date(2026, 9, 1, 18, 0);
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
    const schedule = (over: Partial<ScheduleView>) =>
      ({
        action: { kind: "automation", automationId: "a1" },
        enabled: true,
        nextRunAt: at(2, 2),
        ...over,
      }) as ScheduleView;
    const next = (
      schedules: ScheduleView[],
      paused = false,
      blocked: (s: ScheduleView) => string | null = () => null,
      triggersOff = false
    ) => nextScheduledRun("a1", schedules, paused, blocked, triggersOff, now);
    expect(next([])).toBeNull();
    expect(next([schedule({ enabled: false })])).toBeNull();
    expect(next([schedule({ action: { kind: "automation", automationId: "a2" } })])).toBeNull();
    expect(next([schedule({})])).toBe("Next run tomorrow 02:00");
    expect(next([schedule({}), schedule({ nextRunAt: at(1, 20) })])).toBe(
      "Next run today 20:00 (2 schedules)"
    );
    expect(next([schedule({})], true)).toBe("Schedules paused");
    expect(next([schedule({ nextRunAt: undefined })])).toBe("Schedule on");
    // The triggers' switch is not the schedule's (B-029).
    expect(next([schedule({})], false, () => null, true)).toBe(
      "Schedule still on: next run tomorrow 02:00"
    );
    // One that cannot run promises nothing (B-016), and does not count.
    const gone = schedule({ nextRunAt: at(1, 19), id: "gone" });
    const blocked = (s: ScheduleView) => (s.id === "gone" ? "its connections were deleted" : null);
    expect(next([gone], false, blocked)).toBe(
      "Schedule will not run: its connections were deleted"
    );
    expect(next([gone, schedule({})], false, blocked)).toBe("Next run tomorrow 02:00");
  });
});

describe("row tooltip", () => {
  it("lists trigger, typed lines, last run and tags, never 'macro' or 'workflow'", () => {
    const a = automation({
      tags: ["ops", "release"],
      steps: [
        {
          kind: "type-keys",
          chunks: [{ data: "git pull\r", delayMs: 0 }],
          timing: "recorded",
          recorded: true,
        },
      ],
    });
    const lines = automationRowTooltip(a, nameOf, run({ targetLabels: ["web-1"], targetCount: 1 }));
    expect(lines[0]).toBe("Manual");
    expect(lines[1]).toBe("Types:");
    expect(lines[2]).toContain("git pull");
    expect(lines[3]).toMatch(/^Last run: .* on web-1$/);
    expect(lines[4]).toBe("Tags: ops, release");
    expect(lines.join(" ")).not.toMatch(/macro|workflow/i);
  });

  it("previews the first step and counts the rest", () => {
    const a = automation({
      steps: [
        { kind: "send-command", command: "make build" },
        { kind: "wait", delayMs: 500 },
        { kind: "wait", delayMs: 500 },
      ],
    });
    expect(automationRowTooltip(a, nameOf)[1]).toBe("Run command: make build (+2 more)");
    expect(automationRowTooltip(automation({ steps: a.steps.slice(0, 1) }), nameOf)[1]).toBe(
      "Run command: make build"
    );
  });

  it("counts the terminals of a multi-terminal run and copes with none recorded", () => {
    const many = automationRowTooltip(
      automation(),
      nameOf,
      run({ targetLabels: ["a", "b"], targetCount: 2 })
    );
    expect(many[1]).toMatch(/on 2 terminals$/);
    const none = automationRowTooltip(automation(), nameOf, run());
    expect(none[1]).toMatch(/^Last run: /);
    expect(none[1]).not.toContain("terminal");
  });

  it("says nothing about a nested automation it cannot name", () => {
    const a = automation({ steps: [{ kind: "run-automation", automationId: "a2" }] });
    expect(automationRowTooltip(a, nameOf)).toEqual(["Manual"]);
  });
});

describe("summarizeRuns", () => {
  const at = (minute: number) => `2026-11-24T10:${String(minute).padStart(2, "0")}:00Z`;

  it("picks the newest run whatever the order", () => {
    const runs = [run({ id: "old", endedAt: at(1) }), run({ id: "new", endedAt: at(5) })];
    expect(summarizeRuns(runs).get("a1")?.last.id).toBe("new");
    expect(summarizeRuns([...runs].reverse()).get("a1")?.last.id).toBe("new");
  });

  it.each(["scheduled", "on-connect", "on-disconnect", "on-output-match"] as const)(
    "marks a failed %s run until something completes after it",
    (origin) => {
      const failed = run({ id: "f", origin, status: "failed", endedAt: at(2) });
      expect(summarizeRuns([failed]).get("a1")?.failed).toBe(true);
      const ok = run({ id: "ok", endedAt: at(3) });
      expect(summarizeRuns([ok, failed]).get("a1")?.failed).toBe(false);
      const earlier = run({ id: "before", endedAt: at(1) });
      expect(summarizeRuns([failed, earlier]).get("a1")?.failed).toBe(true);
    }
  );

  it("keeps the mark when a later run by hand also failed or was canceled", () => {
    const failed = run({ id: "f", origin: "scheduled", status: "failed", endedAt: at(2) });
    for (const status of ["failed", "cancelled"] as const) {
      const later = run({ id: "l", status, endedAt: at(4) });
      expect(summarizeRuns([later, failed]).get("a1")?.failed).toBe(true);
    }
  });

  it("marks a failed run the user started too, until one completes (A-037)", () => {
    for (const origin of ["manual", "palette", "hotkey", "run-by-automation"] as const) {
      const failed = run({ origin, status: "failed", endedAt: at(2) });
      expect(summarizeRuns([failed]).get("a1")?.failed).toBe(true);
      const ok = run({ id: "ok", endedAt: at(3) });
      expect(summarizeRuns([ok, failed]).get("a1")?.failed).toBe(false);
    }
  });

  it("keeps automations apart", () => {
    const map = summarizeRuns([run(), run({ id: "r2", automationId: "a2" })]);
    expect([...map.keys()].sort()).toEqual(["a1", "a2"]);
  });
});
