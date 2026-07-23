/**
 * Tests for the workflow run engine (#1852, extended by #1853).
 *
 * Pins the dispatch/execution contract the whole Workflow Automation epic
 * (#1851) builds on: `send-command` and `run-script` steps reach the send seam
 * in order, `run-macro` delegates to the macro-playback seam, `wait` (and
 * per-line delays) route through the timer seam clamped to `MAX_STEP_DELAY_MS`,
 * progress is reported per step, cancellation stops the run between steps and
 * aborts an in-flight `run-script`'s remaining line injections, a failing seam
 * fails the run at the offending step, and the still-unimplemented
 * `run-local-process` kind fails loudly. All seams are mocked so no terminal or
 * session is required.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runWorkflow,
  executeStep,
  type WorkflowRunnerDeps,
  type WorkflowSendSeam,
  type WorkflowRunMacroSeam,
  type WorkflowWaitSeam,
  type WorkflowReadFileSeam,
} from "./workflowRunner";
import { MAX_STEP_DELAY_MS } from "./macroPlayback";
import type { WorkflowStep } from "@/types/workflow";

const sendCommand = (command: string): WorkflowStep => ({ kind: "send-command", command });

/** Build deps with a no-op send by default; override any seam per test. */
const deps = (over: Partial<WorkflowRunnerDeps> = {}): WorkflowRunnerDeps => ({
  send: vi.fn(async () => true),
  ...over,
});

describe("executeStep", () => {
  it("sends a send-command with a trailing newline through the seam", async () => {
    const send = vi.fn(async () => true);
    const outcome = await executeStep(sendCommand("git status"), deps({ send }));

    expect(outcome).toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith("git status\n");
  });

  it("fails a send-command when the seam reports the session vanished", async () => {
    const send = vi.fn(async () => false);
    const outcome = await executeStep(sendCommand("ls"), deps({ send }));

    expect(outcome.ok).toBe(false);
  });

  describe("run-script", () => {
    it("streams each line into the send seam with a trailing newline", async () => {
      const send = vi.fn(async (_data: string) => true);
      const step: WorkflowStep = { kind: "run-script", script: "echo a\necho b\necho c" };
      const outcome = await executeStep(step, deps({ send }));

      expect(outcome).toEqual({ ok: true });
      expect(send.mock.calls.map((c) => c[0])).toEqual(["echo a\n", "echo b\n", "echo c\n"]);
    });

    it("drops a single trailing newline but keeps interior blank lines", async () => {
      const send = vi.fn(async (_data: string) => true);
      const step: WorkflowStep = { kind: "run-script", script: "a\n\nb\n" };
      await executeStep(step, deps({ send }));

      expect(send.mock.calls.map((c) => c[0])).toEqual(["a\n", "\n", "b\n"]);
    });

    it("waits the clamped per-line delay between lines (not before the first)", async () => {
      const send = vi.fn(async () => true);
      const wait = vi.fn(async () => {});
      const step: WorkflowStep = {
        kind: "run-script",
        script: "a\nb\nc",
        perLineDelayMs: MAX_STEP_DELAY_MS + 10_000,
      };
      await executeStep(step, deps({ send, wait }));

      // One delay between each of the three lines (two gaps), each clamped.
      expect(wait.mock.calls).toEqual([[MAX_STEP_DELAY_MS], [MAX_STEP_DELAY_MS]]);
    });

    it("fails when the send seam reports the session vanished mid-stream", async () => {
      const send = vi
        .fn<(data: string) => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const step: WorkflowStep = { kind: "run-script", script: "a\nb\nc" };
      const outcome = await executeStep(step, deps({ send }));

      expect(outcome.ok).toBe(false);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it("reads the body from sourcePath when a read seam is provided", async () => {
      const send = vi.fn(async (_data: string) => true);
      const readScriptFile: WorkflowReadFileSeam = vi.fn(async () => "fromdisk1\nfromdisk2");
      const step: WorkflowStep = {
        kind: "run-script",
        script: "stale",
        sourcePath: "/tmp/s.sh",
      };
      await executeStep(step, deps({ send, readScriptFile }));

      expect(readScriptFile).toHaveBeenCalledWith("/tmp/s.sh");
      expect(send.mock.calls.map((c) => c[0])).toEqual(["fromdisk1\n", "fromdisk2\n"]);
    });

    it("falls back to the embedded script when the sourcePath read fails", async () => {
      const send = vi.fn(async (_data: string) => true);
      const readScriptFile: WorkflowReadFileSeam = vi.fn(async () => {
        throw new Error("no such file");
      });
      const step: WorkflowStep = {
        kind: "run-script",
        script: "embedded",
        sourcePath: "/tmp/missing.sh",
      };
      await executeStep(step, deps({ send, readScriptFile }));

      expect(send.mock.calls.map((c) => c[0])).toEqual(["embedded\n"]);
    });

    it("aborts remaining lines when the signal reports cancellation", async () => {
      const send = vi.fn(async () => true);
      let cancelled = false;
      const step: WorkflowStep = { kind: "run-script", script: "a\nb\nc" };
      // Cancel right after the first line is sent.
      send.mockImplementation(async () => {
        cancelled = true;
        return true;
      });
      const outcome = await executeStep(step, deps({ send }), { isCancelled: () => cancelled });

      expect(outcome).toEqual({ ok: true, cancelled: true });
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe("run-macro", () => {
    it("delegates to the run-macro seam and succeeds when it replays", async () => {
      const runMacro: WorkflowRunMacroSeam = vi.fn(async () => true);
      const outcome = await executeStep({ kind: "run-macro", macroId: "m-1" }, deps({ runMacro }));

      expect(outcome).toEqual({ ok: true });
      expect(runMacro).toHaveBeenCalledWith("m-1");
    });

    it("fails when the macro cannot be replayed", async () => {
      const runMacro: WorkflowRunMacroSeam = vi.fn(async () => false);
      const outcome = await executeStep({ kind: "run-macro", macroId: "gone" }, deps({ runMacro }));

      expect(outcome.ok).toBe(false);
    });

    it("fails loudly when no run-macro seam is wired", async () => {
      const outcome = await executeStep({ kind: "run-macro", macroId: "m-1" }, deps());

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("run-macro");
    });
  });

  describe("wait", () => {
    it("sleeps the clamped delay through the timer seam", async () => {
      const wait: WorkflowWaitSeam = vi.fn(async () => {});
      const outcome = await executeStep({ kind: "wait", delayMs: 250 }, deps({ wait }));

      expect(outcome).toEqual({ ok: true });
      expect(wait).toHaveBeenCalledWith(250);
    });

    it("clamps an over-long wait to MAX_STEP_DELAY_MS", async () => {
      const wait: WorkflowWaitSeam = vi.fn(async () => {});
      await executeStep({ kind: "wait", delayMs: MAX_STEP_DELAY_MS + 999_999 }, deps({ wait }));

      expect(wait).toHaveBeenCalledWith(MAX_STEP_DELAY_MS);
    });
  });

  it("fails loudly for the still-unimplemented run-local-process step", async () => {
    const outcome = await executeStep(
      { kind: "run-local-process", program: "echo", args: [] },
      deps()
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("run-local-process");
  });
});

describe("runWorkflow", () => {
  it("executes every send-command step in order", async () => {
    const send = vi.fn(async (_data: string) => true);
    const handle = runWorkflow(
      [sendCommand("a"), sendCommand("b"), sendCommand("c")],
      deps({ send })
    );
    const result = await handle.done;

    expect(result).toEqual({ status: "completed", stepsCompleted: 3 });
    expect(send.mock.calls.map((c) => c[0])).toEqual(["a\n", "b\n", "c\n"]);
  });

  it("runs a mixed-kind workflow in order across all seams", async () => {
    const order: string[] = [];
    const send: WorkflowSendSeam = vi.fn(async (data: string) => {
      order.push(`send:${JSON.stringify(data)}`);
      return true;
    });
    const runMacro: WorkflowRunMacroSeam = vi.fn(async (id: string) => {
      order.push(`macro:${id}`);
      return true;
    });
    const wait: WorkflowWaitSeam = vi.fn(async (ms: number) => {
      order.push(`wait:${ms}`);
    });
    const steps: WorkflowStep[] = [
      sendCommand("first"),
      { kind: "run-script", script: "s1\ns2" },
      { kind: "wait", delayMs: 500 },
      { kind: "run-macro", macroId: "tail-log" },
    ];
    const result = await runWorkflow(steps, deps({ send, runMacro, wait })).done;

    expect(result).toEqual({ status: "completed", stepsCompleted: 4 });
    expect(order).toEqual([
      'send:"first\\n"',
      'send:"s1\\n"',
      'send:"s2\\n"',
      "wait:500",
      "macro:tail-log",
    ]);
  });

  it("reports progress after each completed step", async () => {
    const send = vi.fn(async () => true);
    const onProgress = vi.fn();
    const steps = [sendCommand("a"), sendCommand("b")];
    const handle = runWorkflow(steps, deps({ send }), { onProgress });
    await handle.done;

    expect(onProgress.mock.calls).toEqual([
      [1, 2, steps[0]],
      [2, 2, steps[1]],
    ]);
  });

  it("completes vacuously for an empty workflow", async () => {
    const send = vi.fn(async () => true);
    const result = await runWorkflow([], deps({ send })).done;

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

    const handle = runWorkflow([sendCommand("a"), sendCommand("b")], deps({ send }));

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

  it("aborts an in-flight run-script's remaining lines when cancelled", async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const send = vi.fn(async (_data: string) => {
      call += 1;
      if (call === 1) {
        markStarted();
        await gate;
      }
      return true;
    });
    const steps: WorkflowStep[] = [{ kind: "run-script", script: "a\nb\nc" }, sendCommand("z")];
    const handle = runWorkflow(steps, deps({ send }));

    await started;
    handle.cancel();
    releaseFirst();
    const result = await handle.done;

    // The run-script aborted after its first line and is not counted completed;
    // the following send-command never ran.
    expect(result).toEqual({ status: "cancelled", stepsCompleted: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("a\n");
  });

  it("does not run anything when cancelled before it starts", async () => {
    const send = vi.fn(async () => true);
    const handle = runWorkflow([sendCommand("a")], deps({ send }));
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
      deps({ send })
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
      [sendCommand("a"), { kind: "run-local-process", program: "x", args: [] }],
      deps({ send })
    );
    const result = await handle.done;

    expect(result.status).toBe("failed");
    expect(result.failedStepIndex).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
