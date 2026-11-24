/**
 * The `onNestedRunFinished` hook (#5818, slice 9): an automation a
 * `run-automation` step ran reports its own run, so the history can record it
 * as "Run by another automation".
 */
import { describe, expect, it, vi } from "vitest";
import { runAutomation, runAutomationOnTargets } from "./automationRunner";
import type { WorkflowNestedRunEvent, WorkflowRunnerDeps } from "./workflowRunner";
import { collectNestedRun, nestedRunRecord } from "@/store/slices/automationViews";
import type { AutomationRun } from "@/types/generated/AutomationRun";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";

const keys = (data: string): AutomationStep => ({
  kind: "type-keys",
  chunks: [{ data, delayMs: 0 }],
  timing: "instant",
});

const call = (automationId: string): AutomationStep => ({ kind: "run-automation", automationId });

const automation = (id: string, steps: AutomationStep[]): Automation => ({
  id,
  name: id.toUpperCase(),
  tags: [],
  steps,
  triggers: [],
  createdAt: "",
  updatedAt: "",
});

async function run(library: Automation[], accept: (n: number) => boolean = () => true) {
  const byId = new Map(library.map((a) => [a.id, a]));
  let sent = 0;
  const deps: WorkflowRunnerDeps = {
    send: vi.fn(async () => accept(sent++)),
    wait: vi.fn(async () => undefined),
    resolveAutomation: (id) => byId.get(id),
  };
  const events: WorkflowNestedRunEvent[] = [];
  const result = await runAutomation(library[library.length - 1], deps, {
    onNestedRunFinished: (event) => events.push(event),
  }).done;
  return { result, events };
}

describe("nested automation runs (#5818, slice 9)", () => {
  it("reports each callee that finished, innermost first", async () => {
    const inner = automation("inner", [keys("a"), keys("b")]);
    const middle = automation("middle", [call("inner")]);
    const outer = automation("outer", [keys("x"), call("middle")]);
    const { result, events } = await run([inner, middle, outer]);
    expect(result.status).toBe("completed");
    expect(events.map((e) => [e.automation.id, e.status, e.stepsCompleted])).toEqual([
      ["inner", "completed", 2],
      ["middle", "completed", 1],
    ]);
    expect(events[0].endedAt.getTime()).toBeGreaterThanOrEqual(events[0].startedAt.getTime());
  });

  it("reports a failed callee with the step that failed", async () => {
    const inner = automation("inner", [keys("a"), keys("b")]);
    const outer = automation("outer", [call("inner")]);
    const { result, events } = await run([inner, outer], (n) => n < 1);
    expect(result.status).toBe("failed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "failed", stepsCompleted: 1, failedStepIndex: 1 });
    expect(events[0].error).toBeTruthy();
  });

  it("reports nothing for a callee that never started", async () => {
    const outer = automation("outer", [call("ghost")]);
    const { events } = await run([outer]);
    expect(events).toEqual([]);
  });

  it("records the callee as run by another automation on the caller's terminal", () => {
    const callee = automation("inner", [keys("a"), keys("b")]);
    const record = nestedRunRecord(
      {
        automation: callee,
        startedAt: new Date("2026-09-20T00:00:00Z"),
        endedAt: new Date("2026-09-20T00:00:02Z"),
        status: "failed",
        stepsCompleted: 1,
        failedStepIndex: 1,
        error: "gone",
      },
      "tab-1",
      "prod-web",
      "run-9"
    );
    expect(record).toEqual({
      id: "run-9",
      automationId: "inner",
      automationName: "INNER",
      startedAt: "2026-09-20T00:00:00.000Z",
      endedAt: "2026-09-20T00:00:02.000Z",
      status: "failed",
      stepsCompleted: 1,
      total: 2,
      failedStepIndex: 1,
      error: "gone",
      tabId: "tab-1",
      targetLabel: "prod-web",
      origin: "run-by-automation",
    });
    // No targetCount: it is not a macro fan-out playback.
    expect(record.targetCount).toBeUndefined();
  });

  it("keeps one record for an automation a loop calls many times", async () => {
    const inner = automation("inner", [keys("a")]);
    const outer = automation("outer", [
      { kind: "loop", loop: { kind: "count", count: 300 }, body: [call("inner")] },
    ]);
    const { events } = await run([inner, outer], (n) => n < 299);
    expect(events).toHaveLength(300);
    const nested = new Map<string, AutomationRun>();
    events.forEach((e, i) => collectNestedRun(nested, nestedRunRecord(e, "t", "x", `r${i}`)));
    expect([...nested.values()]).toHaveLength(1);
    expect(nested.get("inner")).toMatchObject({
      id: "r0",
      startedAt: events[0].startedAt.toISOString(),
      endedAt: events[299].endedAt.toISOString(),
      status: "failed",
    });
  });

  it("reports nested runs per target when one automation runs on several", async () => {
    const inner = automation("inner", [keys("a")]);
    const outer = automation("outer", [
      { kind: "loop", loop: { kind: "count", count: 3 }, body: [call("inner")] },
    ]);
    const perTarget = [0, 1].map(() => new Map<string, AutomationRun>());
    const results = await runAutomationOnTargets(
      outer,
      ["t1", "t2"],
      () => ({
        send: vi.fn(async () => true),
        wait: vi.fn(async () => undefined),
        resolveAutomation: (id) => (id === "inner" ? inner : undefined),
      }),
      {
        hooksFor: (index) => ({
          onNestedRunFinished: (event) =>
            collectNestedRun(perTarget[index], nestedRunRecord(event, `t${index + 1}`, undefined)),
        }),
      }
    ).done;
    expect(results.map((r) => r?.status)).toEqual(["completed", "completed"]);
    expect(perTarget.map((m) => [...m.values()].map((r) => [r.automationId, r.tabId]))).toEqual([
      [["inner", "t1"]],
      [["inner", "t2"]],
    ]);
  });
});
