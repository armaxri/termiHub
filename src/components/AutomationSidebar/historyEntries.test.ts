import { describe, expect, it } from "vitest";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import type { ScheduleRunResult, ScheduleView } from "@/types/schedule";
import { mergeHistory, scheduleGaps, schedulesOfRuns } from "./historyEntries";

const at = (hour: number) => `2026-10-01T${String(hour).padStart(2, "0")}:00:00Z`;
const run = (id: string, hour: number) =>
  ({ id, automationId: "a", automationName: "Backup", endedAt: at(hour) }) as AutomationRun;
const schedule = (id: string, history: ScheduleRunResult[]) =>
  ({
    id,
    name: `Schedule ${id}`,
    action: { kind: "automation", automationId: "a" },
    history,
  }) as unknown as ScheduleView;
const names = new Map([["a", "Backup"]]);
const skipped = (hour: number): ScheduleRunResult => ({
  at: at(hour),
  outcome: "skipped",
  message: "why",
});

describe("the one History (A-043)", () => {
  it("lists a scheduled time without a run, newest first among the runs", () => {
    const schedules = [schedule("s1", [skipped(8), skipped(3)]), schedule("s2", [skipped(5)])];
    const gaps = scheduleGaps(schedules, names);
    expect(gaps.map((g) => [g.scheduleName, g.at])).toEqual([
      ["Schedule s1", at(8)],
      ["Schedule s2", at(5)],
      ["Schedule s1", at(3)],
    ]);
    const list = mergeHistory([run("r1", 9), run("r2", 6), run("r3", 4)], gaps, new Map());
    expect(list.map((e) => (e.kind === "run" ? e.run.id : e.gap.at))).toEqual([
      "r1",
      at(8),
      "r2",
      at(5),
      "r3",
      at(3),
    ]);
  });

  it("never lists a night twice: an attempt with runs is in the list already", () => {
    const ran: ScheduleRunResult = { at: at(2), outcome: "failed", runIds: ["r1"] };
    const completed: ScheduleRunResult = { at: at(1), outcome: "completed" };
    expect(scheduleGaps([schedule("s1", [ran, completed])], names)).toEqual([]);
    const failedToStart: ScheduleRunResult = { at: at(2), outcome: "failed", message: "no" };
    expect(scheduleGaps([schedule("s1", [failedToStart])], names)).toHaveLength(1);
  });

  it("names the schedule of a run, and what the run left out", () => {
    const attempt: ScheduleRunResult = {
      at: at(2),
      outcome: "completed",
      message: "Ran on 1 terminal (db-1: needs a password)",
      runIds: ["r1", "r2"],
    };
    const of = schedulesOfRuns([schedule("s1", [attempt])]);
    expect(of.get("r2")).toEqual({ name: "Schedule s1", leftOut: "db-1: needs a password" });
    const [entry] = mergeHistory([run("r1", 2)], [], of);
    expect(entry).toMatchObject({ kind: "run", schedule: { name: "Schedule s1" } });
  });

  it("names a deleted automation as such", () => {
    expect(scheduleGaps([schedule("s1", [skipped(1)])], new Map())[0].automationName).toBe(
      "Deleted automation"
    );
  });
});
