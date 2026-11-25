import { describe, expect, it } from "vitest";
import type { ScheduleRunResult, ScheduleView } from "@/types/schedule";
import {
  attemptLabel,
  attemptTone,
  lastRunAttention,
  lastRunText,
  scheduleState,
  summarizeAttempt,
} from "./scheduleStatus";

const NOW = new Date(2026, 9, 1, 18, 0);
const at = (h: number, day = 1) => new Date(2026, 9, day, h, 0).toISOString();
const result = (over: Partial<ScheduleRunResult>): ScheduleRunResult => ({
  at: at(2),
  outcome: "completed",
  ...over,
});
const text = (over: Partial<ScheduleRunResult>) => lastRunText(summarizeAttempt(result(over)), NOW);
const view = (over: Partial<ScheduleView> = {}) =>
  ({ enabled: true, confirmedAt: "x", running: false, ...over }) as ScheduleView;

describe("scheduleState", () => {
  const state = (over: Partial<ScheduleView>, paused = false, blocked = false) =>
    scheduleState(view(over), paused, blocked, NOW);

  it("says when it next runs", () => {
    expect(state({ nextRunAt: at(2, 2) })).toBe("Next run tomorrow 02:00");
    expect(state({})).toBe("No next run");
  });

  it("says off, paused and running before anything else", () => {
    expect(state({ enabled: false, nextRunAt: at(2, 2) }, true)).toBe("Off");
    expect(state({ enabled: false, confirmedAt: undefined })).toBe("Off until you switch it on");
    expect(state({ running: true, nextRunAt: at(2, 2) }, true)).toBe("Running now");
    expect(state({ nextRunAt: at(2, 2) }, true)).toBe("Paused");
  });

  it("names no next run for one that cannot run", () => {
    expect(state({ nextRunAt: at(2, 2) }, false, true)).toBe("On");
  });
});

describe("summarizeAttempt and lastRunText: the whole reason, first (A-041)", () => {
  it("completed, and completed with some left out", () => {
    expect(text({ message: "Ran on 2 terminals", startedAt: at(1) })).toBe(
      "Last run completed (today 01:00)"
    );
    expect(text({ message: "Ran on 1 terminal (db-1: needs a password)" })).toBe(
      "Last run left some out: db-1: needs a password (today 02:00)"
    );
  });

  it("failed, also as an older version recorded it", () => {
    const expected = "Last run failed: db-1: it broke (today 02:00)";
    expect(text({ outcome: "failed", message: "db-1: it broke" })).toBe(expected);
    expect(text({ outcome: "failed", message: "Ran on 1 terminal: db-1: it broke" })).toBe(
      expected
    );
    expect(text({ outcome: "failed" })).toBe("Last run failed: no reason recorded (today 02:00)");
  });

  it("missed is told apart from skipped, with the time it was due", () => {
    const reason = "termiHub was closed or the computer was asleep";
    const expected = `Last run missed: ${reason} (due today 02:00)`;
    expect(text({ outcome: "skipped", at: at(9), missedDueAt: at(2), message: reason })).toBe(
      expected
    );
    // As an older version recorded it: the due time inside the message.
    expect(
      text({
        outcome: "skipped",
        at: at(9),
        message: `Missed the run due at 2026-10-01 02:00 (${reason})`,
      })
    ).toBe(expected);
  });

  it("skipped and canceled", () => {
    expect(
      text({ outcome: "skipped", message: "Skipped: the previous run was still in progress" })
    ).toBe("Last run skipped: the previous run was still in progress (today 02:00)");
    expect(text({ outcome: "cancelled", message: "Ran on 1 terminal: canceled" })).toBe(
      "Last run was canceled (today 02:00)"
    );
  });

  it("only a run that did everything is green", () => {
    expect(attemptTone("completed")).toBe("success");
    expect(attemptTone("failed")).toBe("error");
    for (const kind of ["partly", "canceled", "skipped", "missed"] as const) {
      expect(attemptTone(kind)).toBe("warning");
    }
    expect(attemptLabel("missed")).toBe("Missed");
  });
});

describe("lastRunAttention (A-042)", () => {
  const of = (over: Partial<ScheduleRunResult>, enabled = true) =>
    lastRunAttention(view({ enabled, lastResult: result(over) }));

  it("raises a failure, and a night that did not happen", () => {
    expect(of({ outcome: "failed" })).toBe("error");
    expect(of({ outcome: "skipped", missedDueAt: at(2) })).toBe("warning");
    expect(of({ outcome: "skipped" })).toBe("warning");
    expect(of({ message: "Ran on 1 terminal (db-1: needs a password)" })).toBe("warning");
  });

  it("is quiet about what the user did or switched off", () => {
    expect(of({})).toBeNull();
    expect(of({ outcome: "cancelled" })).toBeNull();
    expect(of({ outcome: "failed" }, false)).toBeNull();
    expect(lastRunAttention(view())).toBeNull();
  });
});
