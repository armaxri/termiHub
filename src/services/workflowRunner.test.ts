/**
 * Tests for the workflow run engine (#1852, extended by #1853).
 *
 * Pins the dispatch/execution contract the whole Workflow Automation epic
 * (#1851) builds on: `send-command` and `run-script` steps reach the send seam
 * in order, `run-macro` delegates to the macro-playback seam, `wait` (and
 * per-line delays) route through the timer seam clamped to `MAX_STEP_DELAY_MS`,
 * progress is reported per step, cancellation stops the run between steps and
 * aborts an in-flight `run-script`'s remaining line injections, a failing seam
 * fails the run at the offending step, and the guarded `run-local-process` kind
 * (#1857) is fail-closed: it never spawns without explicit authorization, passes
 * args as a discrete array (no shell split), and surfaces exit/timeout/cancel.
 * All seams are mocked so no terminal or session is required.
 */
import { describe, it, expect, vi } from "vitest";
import {
  runWorkflow,
  executeStep,
  resolveStepParams,
  interpolateParams,
  evaluateCondition,
  matchesOutput,
  MAX_CONDITIONAL_DEPTH,
  MAX_LOOP_DEPTH,
  MAX_LOOP_ITERATIONS,
  WAIT_FOR_OUTPUT_DEFAULT_TIMEOUT_MS,
  type WorkflowRunnerDeps,
  type WorkflowSendSeam,
  type WorkflowRunMacroSeam,
  type WorkflowWaitSeam,
  type WorkflowReadFileSeam,
  type WorkflowRunLocalProcessSeam,
  type WorkflowWaitForOutputSeam,
  type WaitForOutputResult,
  type WorkflowParamValues,
} from "./workflowRunner";
import { MAX_STEP_DELAY_MS } from "./macroPlayback";
import type { WorkflowComparisonOp, WorkflowCondition, WorkflowStep } from "@/types/workflow";

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

  describe("run-local-process (guarded, #1857)", () => {
    const step = (program: string, args: string[] = []): WorkflowStep => ({
      kind: "run-local-process",
      program,
      args,
    });
    const okRun: WorkflowRunLocalProcessSeam = vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      cancelled: false,
    }));

    it("fails without a run seam", async () => {
      const outcome = await executeStep(step("echo"), deps());
      expect(outcome.ok).toBe(false);
    });

    it("GUARDRAIL: never spawns when no authorize seam is wired", async () => {
      const runLocalProcess = vi.fn(okRun);
      const outcome = await executeStep(step("echo"), deps({ runLocalProcess }));

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("not authorized");
      // The security invariant: the process seam is NEVER reached unauthorized.
      expect(runLocalProcess).not.toHaveBeenCalled();
    });

    it("GUARDRAIL: never spawns when authorization is refused", async () => {
      const authorizeLocalProcess = vi.fn(async () => false);
      const runLocalProcess = vi.fn(okRun);
      const outcome = await executeStep(
        step("rm", ["-rf", "/"]),
        deps({ authorizeLocalProcess, runLocalProcess })
      );

      expect(outcome.ok).toBe(false);
      expect(authorizeLocalProcess).toHaveBeenCalledWith("rm", ["-rf", "/"]);
      expect(runLocalProcess).not.toHaveBeenCalled();
    });

    it("GUARDRAIL: passes args as a discrete array, unmodified (no shell split)", async () => {
      const authorizeLocalProcess = vi.fn(async () => true);
      const runLocalProcess = vi.fn(okRun);
      // A single argument containing spaces/metacharacters must stay ONE element.
      const args = ["--message", "hello world; rm -rf /"];
      await executeStep(
        step("notify-send", args),
        deps({ authorizeLocalProcess, runLocalProcess })
      );

      expect(runLocalProcess).toHaveBeenCalledTimes(1);
      const [program, passedArgs] = runLocalProcess.mock.calls[0];
      expect(program).toBe("notify-send");
      expect(passedArgs).toEqual(["--message", "hello world; rm -rf /"]);
      // Same reference-equal contents: the runner does not re-split or reshape.
      expect(passedArgs).toHaveLength(2);
    });

    it("succeeds when an authorized process exits 0", async () => {
      const outcome = await executeStep(
        step("echo", ["hi"]),
        deps({ authorizeLocalProcess: async () => true, runLocalProcess: vi.fn(okRun) })
      );
      expect(outcome).toEqual({ ok: true });
    });

    it("fails and surfaces the exit code on a non-zero exit", async () => {
      const runLocalProcess: WorkflowRunLocalProcessSeam = async () => ({
        exitCode: 3,
        timedOut: false,
        cancelled: false,
      });
      const outcome = await executeStep(
        step("false"),
        deps({ authorizeLocalProcess: async () => true, runLocalProcess })
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("code 3");
    });

    it("fails with a timeout message when the process times out", async () => {
      const runLocalProcess: WorkflowRunLocalProcessSeam = async () => ({
        exitCode: null,
        timedOut: true,
        cancelled: false,
      });
      const outcome = await executeStep(
        step("sleep", ["99"]),
        deps({ authorizeLocalProcess: async () => true, runLocalProcess })
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain("timed out");
    });

    it("ends the run as cancelled when the process was cancelled", async () => {
      const runLocalProcess: WorkflowRunLocalProcessSeam = async () => ({
        exitCode: null,
        timedOut: false,
        cancelled: true,
      });
      const outcome = await executeStep(
        step("sleep", ["99"]),
        deps({ authorizeLocalProcess: async () => true, runLocalProcess })
      );
      expect(outcome).toEqual({ ok: true, cancelled: true });
    });

    it("GUARDRAIL: does not spawn when cancelled before the process starts", async () => {
      const runLocalProcess: WorkflowRunLocalProcessSeam = vi.fn(async () => ({
        exitCode: 0,
        timedOut: false,
        cancelled: false,
      }));
      const outcome = await executeStep(
        step("echo"),
        deps({ authorizeLocalProcess: async () => true, runLocalProcess }),
        { isCancelled: () => true }
      );
      expect(outcome).toEqual({ ok: true, cancelled: true });
      expect(runLocalProcess).not.toHaveBeenCalled();
    });
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

describe("parameter interpolation (PROD-0040)", () => {
  const values: WorkflowParamValues = { host: "example.com", port: 22, verbose: true };

  describe("interpolateParams", () => {
    it("substitutes declared ${name} references", () => {
      expect(interpolateParams("ssh ${host}", values)).toBe("ssh example.com");
    });

    it("stringifies number and boolean values", () => {
      expect(interpolateParams("-p ${port} v=${verbose}", values)).toBe("-p 22 v=true");
    });

    it("treats $${ as an escape for a literal ${ and does not re-scan it", () => {
      // `$${host}` must stay the literal `${host}` (shell var), never substitute.
      expect(interpolateParams("echo $${host}", values)).toBe("echo ${host}");
    });

    it("leaves an unknown ${x} verbatim and reports it", () => {
      const onUnknown = vi.fn();
      expect(interpolateParams("echo ${HOME}/${host}", values, onUnknown)).toBe(
        "echo ${HOME}/example.com"
      );
      expect(onUnknown).toHaveBeenCalledWith("HOME");
      expect(onUnknown).toHaveBeenCalledTimes(1);
    });

    it("substitutes multiple occurrences of the same reference", () => {
      expect(interpolateParams("${host}:${host}", values)).toBe("example.com:example.com");
    });
  });

  describe("resolveStepParams", () => {
    it("returns the same step reference when there are no values (identity pass)", () => {
      const step: WorkflowStep = sendCommand("git status");
      expect(resolveStepParams(step, {})).toBe(step);
    });

    it("substitutes send-command.command", () => {
      const out = resolveStepParams(sendCommand("connect ${host}"), values);
      expect(out).toEqual({ kind: "send-command", command: "connect example.com" });
    });

    it("substitutes run-script.script and preserves other fields", () => {
      const step: WorkflowStep = {
        kind: "run-script",
        script: "ping ${host}",
        perLineDelayMs: 50,
      };
      expect(resolveStepParams(step, values)).toEqual({
        kind: "run-script",
        script: "ping example.com",
        perLineDelayMs: 50,
      });
    });

    it("substitutes run-local-process program and each arg", () => {
      const step: WorkflowStep = {
        kind: "run-local-process",
        program: "${host}-tool",
        args: ["--port", "${port}", "static"],
      };
      expect(resolveStepParams(step, values)).toEqual({
        kind: "run-local-process",
        program: "example.com-tool",
        args: ["--port", "22", "static"],
      });
    });

    it("leaves run-macro and wait untouched", () => {
      const macro: WorkflowStep = { kind: "run-macro", macroId: "m-1" };
      const wait: WorkflowStep = { kind: "wait", delayMs: 500 };
      expect(resolveStepParams(macro, values)).toEqual(macro);
      expect(resolveStepParams(wait, values)).toEqual(wait);
    });

    it("does not mutate the input step", () => {
      const step: WorkflowStep = {
        kind: "run-local-process",
        program: "${host}",
        args: ["${port}"],
      };
      resolveStepParams(step, values);
      expect(step).toEqual({ kind: "run-local-process", program: "${host}", args: ["${port}"] });
    });
  });

  describe("threading through executeStep and runWorkflow", () => {
    it("executeStep interpolates before sending", async () => {
      const send = vi.fn(async () => true);
      await executeStep(sendCommand("ssh ${host}"), deps({ send }), undefined, values);
      expect(send).toHaveBeenCalledWith("ssh example.com\n");
    });

    it("runWorkflow forwards param values to every step", async () => {
      const send = vi.fn(async (_data: string) => true);
      const handle = runWorkflow(
        [sendCommand("a ${host}"), sendCommand("b ${port}")],
        deps({ send }),
        undefined,
        values
      );
      const result = await handle.done;
      expect(result.status).toBe("completed");
      expect(send.mock.calls.map((c) => c[0])).toEqual(["a example.com\n", "b 22\n"]);
    });

    it("leaves ${VAR} verbatim when no values are supplied (byte-identical run)", async () => {
      const send = vi.fn(async () => true);
      await executeStep(sendCommand("echo ${HOME}"), deps({ send }));
      expect(send).toHaveBeenCalledWith("echo ${HOME}\n");
    });
  });
});

// ── Conditional steps (PROD-0044, slice 1) ──────────────────────────────────

const cond = (left: string, op: WorkflowComparisonOp, right: string): WorkflowCondition => ({
  left,
  op,
  right,
});

describe("evaluateCondition", () => {
  it("eq / ne compare as strings", () => {
    expect(evaluateCondition(cond("prod", "eq", "prod"))).toBe(true);
    expect(evaluateCondition(cond("prod", "eq", "dev"))).toBe(false);
    expect(evaluateCondition(cond("prod", "ne", "dev"))).toBe(true);
    expect(evaluateCondition(cond("prod", "ne", "prod"))).toBe(false);
  });

  it("contains is substring containment (left contains right)", () => {
    expect(evaluateCondition(cond("release-2.0", "contains", "2.0"))).toBe(true);
    expect(evaluateCondition(cond("release", "contains", "2.0"))).toBe(false);
  });

  it("gt / lt / gte / lte compare numerically when both operands parse", () => {
    expect(evaluateCondition(cond("10", "gt", "9"))).toBe(true); // not lexicographic ("10" < "9")
    expect(evaluateCondition(cond("9", "lt", "10"))).toBe(true);
    expect(evaluateCondition(cond("5", "gte", "5"))).toBe(true);
    expect(evaluateCondition(cond("5", "lte", "5"))).toBe(true);
    expect(evaluateCondition(cond("4", "gte", "5"))).toBe(false);
    expect(evaluateCondition(cond("6", "lte", "5"))).toBe(false);
  });

  it("gt / lt fall back to lexicographic when an operand is non-numeric", () => {
    expect(evaluateCondition(cond("beta", "gt", "alpha"))).toBe(true);
    expect(evaluateCondition(cond("alpha", "lt", "beta"))).toBe(true);
    expect(evaluateCondition(cond("alpha", "gt", "beta"))).toBe(false);
  });
});

describe("executeStep conditional", () => {
  const conditional = (
    condition: WorkflowCondition,
    thenSteps: WorkflowStep[],
    elseSteps?: WorkflowStep[]
  ): WorkflowStep => ({
    kind: "conditional",
    condition,
    then: thenSteps,
    ...(elseSteps ? { else: elseSteps } : {}),
  });

  it("runs the then branch when the condition holds", async () => {
    const send = vi.fn(async (_data: string) => true);
    const step = conditional(
      cond("a", "eq", "a"),
      [sendCommand("in-then")],
      [sendCommand("in-else")]
    );
    const outcome = await executeStep(step, deps({ send }));
    expect(outcome).toEqual({ ok: true });
    expect(send.mock.calls.map((c) => c[0])).toEqual(["in-then\n"]);
  });

  it("runs the else branch when the condition is false", async () => {
    const send = vi.fn(async (_data: string) => true);
    const step = conditional(
      cond("a", "eq", "b"),
      [sendCommand("in-then")],
      [sendCommand("in-else")]
    );
    const outcome = await executeStep(step, deps({ send }));
    expect(outcome).toEqual({ ok: true });
    expect(send.mock.calls.map((c) => c[0])).toEqual(["in-else\n"]);
  });

  it("is a no-op (never fails) when false and no else branch is present", async () => {
    const send = vi.fn(async () => true);
    const step = conditional(cond("a", "eq", "b"), [sendCommand("in-then")]);
    const outcome = await executeStep(step, deps({ send }));
    expect(outcome).toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves ${param} operands before comparing", async () => {
    const send = vi.fn(async (_data: string) => true);
    const values: WorkflowParamValues = { env: "prod" };
    const step = conditional(cond("${env}", "eq", "prod"), [sendCommand("deploy")]);
    await executeStep(step, deps({ send }), undefined, values);
    expect(send.mock.calls.map((c) => c[0])).toEqual(["deploy\n"]);
  });

  it("resolves ${param} inside the selected branch's sub-steps", async () => {
    const send = vi.fn(async (_data: string) => true);
    const values: WorkflowParamValues = { env: "prod", host: "example.com" };
    const step = conditional(cond("${env}", "eq", "prod"), [sendCommand("ssh ${host}")]);
    await executeStep(step, deps({ send }), undefined, values);
    expect(send.mock.calls.map((c) => c[0])).toEqual(["ssh example.com\n"]);
  });

  it("propagates a sub-step failure as the conditional's failure", async () => {
    const send = vi.fn(async () => false); // session gone
    const step = conditional(cond("a", "eq", "a"), [sendCommand("boom")]);
    const outcome = await executeStep(step, deps({ send }));
    expect(outcome.ok).toBe(false);
  });

  it("nested conditionals recurse into the correct branch", async () => {
    const send = vi.fn(async (_data: string) => true);
    const inner = conditional(cond("1", "lt", "2"), [sendCommand("inner-then")]);
    const outer = conditional(cond("x", "eq", "x"), [inner]);
    await executeStep(outer, deps({ send }));
    expect(send.mock.calls.map((c) => c[0])).toEqual(["inner-then\n"]);
  });

  it("fails when nesting exceeds the maximum depth", async () => {
    const send = vi.fn(async () => true);
    // Build a chain of conditionals nested one-per-branch deeper than the bound.
    let step: WorkflowStep = sendCommand("leaf");
    for (let i = 0; i <= MAX_CONDITIONAL_DEPTH; i++) {
      step = conditional(cond("a", "eq", "a"), [step]);
    }
    const outcome = await executeStep(step, deps({ send }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("depth");
    expect(send).not.toHaveBeenCalled();
  });

  it("stops the branch when cancelled between sub-steps", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls++;
      return true;
    });
    const signal = { isCancelled: () => calls >= 1 };
    const step = conditional(cond("a", "eq", "a"), [sendCommand("one"), sendCommand("two")]);
    const outcome = await executeStep(step, deps({ send }), signal);
    expect(outcome).toEqual({ ok: true, cancelled: true });
    expect(calls).toBe(1);
  });
});

describe("runWorkflow with conditional steps", () => {
  it("counts a conditional as one completed top-level step", async () => {
    const send = vi.fn(async (_data: string) => true);
    const progress: number[] = [];
    const steps: WorkflowStep[] = [
      {
        kind: "conditional",
        condition: cond("a", "eq", "a"),
        then: [sendCommand("x"), sendCommand("y")],
      },
      sendCommand("after"),
    ];
    const handle = runWorkflow(steps, deps({ send }), {
      onProgress: (completed) => progress.push(completed),
    });
    const result = await handle.done;
    expect(result).toEqual({ status: "completed", stepsCompleted: 2 });
    // Two top-level steps → two progress ticks (nested sends do not tick).
    expect(progress).toEqual([1, 2]);
    expect(send.mock.calls.map((c) => c[0])).toEqual(["x\n", "y\n", "after\n"]);
  });

  it("resolveStepParams interpolates only the condition operands, not then/else", () => {
    const values: WorkflowParamValues = { env: "prod", host: "h" };
    const step: WorkflowStep = {
      kind: "conditional",
      condition: cond("${env}", "eq", "prod"),
      then: [sendCommand("ssh ${host}")],
      else: [sendCommand("bye ${host}")],
    };
    const resolved = resolveStepParams(step, values);
    expect(resolved).toEqual({
      kind: "conditional",
      condition: cond("prod", "eq", "prod"),
      then: [sendCommand("ssh ${host}")], // sub-steps left for their own pass
      else: [sendCommand("bye ${host}")],
    });
  });
});

describe("executeStep loop", () => {
  const countLoop = (count: number, body: WorkflowStep[]): WorkflowStep => ({
    kind: "loop",
    loop: { kind: "count", count },
    body,
  });
  const whileLoop = (condition: WorkflowCondition, body: WorkflowStep[]): WorkflowStep => ({
    kind: "loop",
    loop: { kind: "while", condition },
    body,
  });

  it("runs a count loop body exactly N times", async () => {
    const send = vi.fn(async (_data: string) => true);
    const outcome = await executeStep(countLoop(3, [sendCommand("tick")]), deps({ send }));
    expect(outcome).toEqual({ ok: true });
    expect(send.mock.calls.map((c) => c[0])).toEqual(["tick\n", "tick\n", "tick\n"]);
  });

  it("a zero count loop runs the body zero times", async () => {
    const send = vi.fn(async () => true);
    const outcome = await executeStep(countLoop(0, [sendCommand("tick")]), deps({ send }));
    expect(outcome).toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("exposes the reserved ${iteration} value to body steps", async () => {
    const send = vi.fn(async (_data: string) => true);
    const outcome = await executeStep(
      countLoop(3, [sendCommand("echo ${iteration}")]),
      deps({ send })
    );
    expect(outcome).toEqual({ ok: true });
    expect(send.mock.calls.map((c) => c[0])).toEqual(["echo 0\n", "echo 1\n", "echo 2\n"]);
  });

  it("clamps a count loop above the safety cap to the cap", async () => {
    const send = vi.fn(async () => true);
    const outcome = await executeStep(
      countLoop(MAX_LOOP_ITERATIONS + 50, [sendCommand("x")]),
      deps({ send })
    );
    expect(outcome).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(MAX_LOOP_ITERATIONS);
  });

  it("a while loop stops when the condition becomes false", async () => {
    const send = vi.fn(async (_data: string) => true);
    // `${iteration} lt 3` is true for i = 0,1,2 then false at i = 3.
    const outcome = await executeStep(
      whileLoop(cond("${iteration}", "lt", "3"), [sendCommand("run")]),
      deps({ send })
    );
    expect(outcome).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("a never-false while loop fails when it hits the safety cap", async () => {
    const send = vi.fn(async () => true);
    const outcome = await executeStep(
      whileLoop(cond("1", "eq", "1"), [sendCommand("x")]),
      deps({ send })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain(String(MAX_LOOP_ITERATIONS));
    // The body ran exactly the cap number of times before the run failed.
    expect(send).toHaveBeenCalledTimes(MAX_LOOP_ITERATIONS);
  });

  it("a while loop whose condition starts false never runs the body", async () => {
    const send = vi.fn(async () => true);
    const outcome = await executeStep(
      whileLoop(cond("${iteration}", "lt", "0"), [sendCommand("x")]),
      deps({ send })
    );
    expect(outcome).toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("a real ${param} operand is honoured in the while condition", async () => {
    const send = vi.fn(async () => true);
    const values: WorkflowParamValues = { max: "2" };
    const outcome = await executeStep(
      whileLoop(cond("${iteration}", "lt", "${max}"), [sendCommand("x")]),
      deps({ send }),
      undefined,
      values
    );
    expect(outcome).toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("propagates a body-step failure as the loop's failure", async () => {
    const send = vi.fn(async () => false); // session gone
    const outcome = await executeStep(countLoop(3, [sendCommand("boom")]), deps({ send }));
    expect(outcome.ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(1); // stops at the first failing iteration
  });

  it("stops the body when cancelled between sub-steps", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls++;
      return true;
    });
    const signal = { isCancelled: () => calls >= 1 };
    const outcome = await executeStep(
      countLoop(5, [sendCommand("one"), sendCommand("two")]),
      deps({ send }),
      signal
    );
    expect(outcome).toEqual({ ok: true, cancelled: true });
    expect(calls).toBe(1);
  });

  it("fails when loop nesting exceeds the maximum depth", async () => {
    const send = vi.fn(async () => true);
    let step: WorkflowStep = sendCommand("leaf");
    for (let i = 0; i <= MAX_LOOP_DEPTH; i++) {
      step = countLoop(1, [step]);
    }
    const outcome = await executeStep(step, deps({ send }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("depth");
    expect(send).not.toHaveBeenCalled();
  });

  it("counts a loop as one completed top-level step", async () => {
    const send = vi.fn(async (_data: string) => true);
    const progress: number[] = [];
    const steps: WorkflowStep[] = [countLoop(3, [sendCommand("x")]), sendCommand("after")];
    const result = await runWorkflow(steps, deps({ send }), {
      onProgress: (completed) => progress.push(completed),
    }).done;
    expect(result).toEqual({ status: "completed", stepsCompleted: 2 });
    expect(progress).toEqual([1, 2]);
  });
});

describe("matchesOutput", () => {
  it("substring matcher tests literal containment", () => {
    expect(matchesOutput("user@host:~$ ", { pattern: "$ ", isRegex: false })).toBe(true);
    expect(matchesOutput("still booting", { pattern: "login:", isRegex: false })).toBe(false);
  });

  it("regex matcher tests the pattern", () => {
    expect(matchesOutput("exit code 0", { pattern: "code \\d+", isRegex: true })).toBe(true);
    expect(matchesOutput("no digits", { pattern: "code \\d+", isRegex: true })).toBe(false);
  });

  it("treats an invalid regex as a non-match (defensive)", () => {
    expect(matchesOutput("anything", { pattern: "(", isRegex: true })).toBe(false);
  });
});

describe("executeStep wait-for-output", () => {
  const waitStep = (over: Partial<Extract<WorkflowStep, { kind: "wait-for-output" }>> = {}) =>
    ({ kind: "wait-for-output", pattern: "ready", ...over }) as WorkflowStep;

  it("fails loudly when no wait-for-output seam is provided", async () => {
    const outcome = await executeStep(waitStep(), deps());
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("seam");
  });

  it("succeeds when the seam reports a match", async () => {
    const waitForOutput: WorkflowWaitForOutputSeam = vi.fn(
      async (): Promise<WaitForOutputResult> => ({
        matched: true,
        timedOut: false,
        cancelled: false,
      })
    );
    const outcome = await executeStep(waitStep(), deps({ waitForOutput }));
    expect(outcome).toEqual({ ok: true });
  });

  it("fails when the seam reports a timeout", async () => {
    const waitForOutput: WorkflowWaitForOutputSeam = vi.fn(
      async (): Promise<WaitForOutputResult> => ({
        matched: false,
        timedOut: true,
        cancelled: false,
      })
    );
    const outcome = await executeStep(waitStep(), deps({ waitForOutput }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("timed out");
  });

  it("ends the run as cancelled when the seam reports cancellation", async () => {
    const waitForOutput: WorkflowWaitForOutputSeam = vi.fn(
      async (): Promise<WaitForOutputResult> => ({
        matched: false,
        timedOut: false,
        cancelled: true,
      })
    );
    const outcome = await executeStep(waitStep(), deps({ waitForOutput }));
    expect(outcome).toEqual({ ok: true, cancelled: true });
  });

  it("passes the resolved matcher and clamped default timeout to the seam", async () => {
    const waitForOutput = vi.fn(
      async (): Promise<WaitForOutputResult> => ({
        matched: true,
        timedOut: false,
        cancelled: false,
      })
    );
    const values: WorkflowParamValues = { token: "PROMPT" };
    await executeStep(
      waitStep({ pattern: "${token}>" }),
      deps({ waitForOutput }),
      undefined,
      values
    );
    expect(waitForOutput).toHaveBeenCalledWith(
      { pattern: "PROMPT>", isRegex: false },
      WAIT_FOR_OUTPUT_DEFAULT_TIMEOUT_MS,
      expect.anything()
    );
  });

  it("rejects an invalid regex before ever calling the seam", async () => {
    const waitForOutput = vi.fn(
      async (): Promise<WaitForOutputResult> => ({
        matched: true,
        timedOut: false,
        cancelled: false,
      })
    );
    const outcome = await executeStep(
      waitStep({ pattern: "(unterminated", isRegex: true }),
      deps({ waitForOutput })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("invalid regular expression");
    expect(waitForOutput).not.toHaveBeenCalled();
  });
});
