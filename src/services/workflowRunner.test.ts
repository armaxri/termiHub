/**
 * Tests for the workflow run engine (#1852).
 *
 * Pins the dispatch/execution contract the whole Workflow Automation epic
 * (#1851) builds on: `send-command` steps reach the send seam in order, progress
 * is reported per step, cancellation stops the run between steps (a step already
 * in flight finishes but the next never starts), a failing seam fails the run at
 * the offending step, and the not-yet-implemented placeholder kinds fail loudly.
 * The send seam is mocked so no terminal or session is required.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runWorkflow,
  executeStep,
  type WorkflowRunnerDeps,
  type WorkflowSendSeam,
} from "./workflowRunner";
import type { WorkflowStep } from "@/types/workflow";

const sendCommand = (command: string): WorkflowStep => ({ kind: "send-command", command });

const deps = (send: WorkflowSendSeam): WorkflowRunnerDeps => ({ send });

describe("executeStep", () => {
  it("sends a send-command with a trailing newline through the seam", async () => {
    const send = vi.fn(async () => true);
    const outcome = await executeStep(sendCommand("git status"), deps(send));

    expect(outcome).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith("git status\n");
  });

  it("fails a send-command when the seam reports the session vanished", async () => {
    const send = vi.fn(async () => false);
    const outcome = await executeStep(sendCommand("ls"), deps(send));

    expect(outcome.ok).toBe(false);
  });

  it.each(["run-script", "run-macro", "wait", "run-local-process"] as const)(
    "fails loudly for the not-yet-implemented %s step",
    async (kind) => {
      // Build a minimal step of the given placeholder kind.
      const byKind: Record<string, WorkflowStep> = {
        "run-script": { kind: "run-script", script: "echo hi" },
        "run-macro": { kind: "run-macro", macroId: "m-1" },
        wait: { kind: "wait", delayMs: 100 },
        "run-local-process": { kind: "run-local-process", program: "echo", args: [] },
      };
      const outcome = await executeStep(byKind[kind], deps(vi.fn(async () => true)));

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain(kind);
    }
  );
});

describe("runWorkflow", () => {
  it("executes every send-command step in order", async () => {
    const send = vi.fn(async () => true);
    const handle = runWorkflow(
      [sendCommand("a"), sendCommand("b"), sendCommand("c")],
      deps(send)
    );
    const result = await handle.done;

    expect(result).toEqual({ status: "completed", stepsCompleted: 3 });
    expect(send.mock.calls.map((c) => c[0])).toEqual(["a\n", "b\n", "c\n"]);
  });

  it("reports progress after each completed step", async () => {
    const send = vi.fn(async () => true);
    const onProgress = vi.fn();
    const steps = [sendCommand("a"), sendCommand("b")];
    const handle = runWorkflow(steps, deps(send), { onProgress });
    await handle.done;

    expect(onProgress.mock.calls).toEqual([
      [1, 2, steps[0]],
      [2, 2, steps[1]],
    ]);
  });

  it("completes vacuously for an empty workflow", async () => {
    const send = vi.fn(async () => true);
    const result = await runWorkflow([], deps(send)).done;

    expect(result).toEqual({ status: "completed", stepsCompleted: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("stops between steps when cancelled — the in-flight step finishes, the next never starts", async () => {
    // Signals when the first send has genuinely started, and gates its return so
    // we can cancel while it is truly in flight.
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const send = vi.fn(async (_data: string) => {
      call += 1;
      if (call === 1) {
        markFirstStarted();
        await firstGate;
      }
      return true;
    });

    const handle = runWorkflow([sendCommand("a"), sendCommand("b")], deps(send));

    // Wait until the first step is genuinely in flight, then cancel and let it finish.
    await firstStarted;
    handle.cancel();
    releaseFirst();
    const result = await handle.done;

    // The in-flight first step completed; the second was never attempted.
    expect(result).toEqual({ status: "cancelled", stepsCompleted: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("a\n");
  });

  it("does not run anything when cancelled before it starts", async () => {
    const send = vi.fn(async () => true);
    const handle = runWorkflow([sendCommand("a")], deps(send));
    handle.cancel();
    const result = await handle.done;

    expect(result).toEqual({ status: "cancelled", stepsCompleted: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it("fails at the offending step when the seam reports failure", async () => {
    const send = vi
      .fn<(data: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const handle = runWorkflow(
      [sendCommand("a"), sendCommand("b"), sendCommand("c")],
      deps(send)
    );
    const result = await handle.done;

    expect(result.status).toBe("failed");
    expect(result.stepsCompleted).toBe(1);
    expect(result.failedStepIndex).toBe(1);
    // The third step is never attempted after the second fails.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fails at a not-yet-implemented step kind", async () => {
    const send = vi.fn(async () => true);
    const handle = runWorkflow(
      [sendCommand("a"), { kind: "wait", delayMs: 10 }],
      deps(send)
    );
    const result = await handle.done;

    expect(result.status).toBe("failed");
    expect(result.failedStepIndex).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
