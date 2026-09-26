/**
 * Tests for per-step error handling in the workflow runner (PROD-045): bounded
 * retry with fixed/exponential back-off, continue-on-error, cancellation during
 * a retry wait, nested-step policies, and back-compat (a workflow without the
 * new fields still stops on its first failure with the same result shape).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runWorkflow,
  executeStepWithPolicy,
  effectiveRetryCount,
  retryDelayMs,
  MAX_STEP_RETRIES,
  MAX_RETRY_DELAY_MS,
  type WorkflowRunnerDeps,
  type WorkflowStepRetryEvent,
  type WorkflowStepContinuedEvent,
} from "./workflowRunner";
import type { WorkflowStep } from "@/types/workflow";

/** A send seam that fails the first `failures` calls, then succeeds. */
function flakySend(failures: number) {
  let calls = 0;
  return vi.fn(async () => {
    calls += 1;
    return calls > failures;
  });
}

const cmd = (command: string, extra: Partial<WorkflowStep> = {}): WorkflowStep =>
  ({ kind: "send-command", command, ...extra }) as WorkflowStep;

const deps = (over: Partial<WorkflowRunnerDeps> = {}): WorkflowRunnerDeps => ({
  send: vi.fn(async () => true),
  wait: vi.fn(async () => {}),
  ...over,
});

describe("effectiveRetryCount", () => {
  it("is 0 without a policy or for a non-finite count", () => {
    expect(effectiveRetryCount(undefined)).toBe(0);
    expect(effectiveRetryCount({ count: Number.NaN })).toBe(0);
    expect(effectiveRetryCount({ count: -3 })).toBe(0);
  });

  it("floors and clamps to MAX_STEP_RETRIES", () => {
    expect(effectiveRetryCount({ count: 2.7 })).toBe(2);
    expect(effectiveRetryCount({ count: 10_000 })).toBe(MAX_STEP_RETRIES);
  });
});

describe("retryDelayMs", () => {
  it("retries immediately without a delay", () => {
    expect(retryDelayMs(undefined, 1)).toBe(0);
    expect(retryDelayMs({ count: 3 }, 2)).toBe(0);
    expect(retryDelayMs({ count: 3, delayMs: -5 }, 1)).toBe(0);
  });

  it("keeps a fixed delay constant", () => {
    const retry = { count: 3, delayMs: 500 };
    expect([1, 2, 3].map((n) => retryDelayMs(retry, n))).toEqual([500, 500, 500]);
  });

  it("doubles an exponential delay per retry, capped at MAX_RETRY_DELAY_MS", () => {
    const retry = { count: 10, delayMs: 1000, backoff: "exponential" as const };
    expect([1, 2, 3, 4].map((n) => retryDelayMs(retry, n))).toEqual([1000, 2000, 4000, 8000]);
    expect(retryDelayMs(retry, 10)).toBe(MAX_RETRY_DELAY_MS);
    expect(retryDelayMs({ count: 1, delayMs: 10 * MAX_RETRY_DELAY_MS }, 1)).toBe(
      MAX_RETRY_DELAY_MS
    );
  });
});

describe("runWorkflow — back-compat (no error handling)", () => {
  it("stops at the first failing step with the unchanged result shape", async () => {
    const send = vi.fn(async (data: string) => !data.startsWith("bad"));
    const result = await runWorkflow([cmd("ok"), cmd("bad"), cmd("never")], deps({ send })).done;

    expect(result).toEqual({
      status: "failed",
      stepsCompleted: 1,
      failedStepIndex: 1,
      error: "the target terminal is no longer connected",
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("reports no continuedFailures key on a clean run", async () => {
    const result = await runWorkflow([cmd("a")], deps()).done;
    expect(result).toEqual({ status: "completed", stepsCompleted: 1 });
  });
});

describe("runWorkflow — retry", () => {
  it("retries a failing step until it succeeds", async () => {
    const send = flakySend(2);
    const wait = vi.fn(async () => {});
    const onStepRetry = vi.fn<(e: WorkflowStepRetryEvent) => void>();
    const step = cmd("flaky", { retry: { count: 3, delayMs: 250 } });

    const result = await runWorkflow([step], deps({ send, wait }), { onStepRetry }).done;

    expect(result).toEqual({ status: "completed", stepsCompleted: 1 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[250], [250]]);
    expect(
      onStepRetry.mock.calls.map(([e]) => [e.failedAttempt, e.maxAttempts, e.delayMs])
    ).toEqual([
      [1, 4, 250],
      [2, 4, 250],
    ]);
  });

  it("fails after exhausting the retries, naming the attempt count", async () => {
    const send = vi.fn(async () => false);
    const wait = vi.fn(async () => {});
    const step = cmd("down", { retry: { count: 2, delayMs: 100, backoff: "exponential" } });

    const result = await runWorkflow([step, cmd("next")], deps({ send, wait })).done;

    expect(result.status).toBe("failed");
    expect(result.failedStepIndex).toBe(0);
    expect(result.error).toMatch(/\(after 3 attempts\)$/);
    expect(send).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[100], [200]]);
  });

  it("clamps an oversized retry count to MAX_STEP_RETRIES", async () => {
    const send = vi.fn(async () => false);
    const step = cmd("down", { retry: { count: 999 } });

    await runWorkflow([step], deps({ send })).done;

    expect(send).toHaveBeenCalledTimes(MAX_STEP_RETRIES + 1);
  });

  it("waits with real timers when no wait seam is injected (fake timers)", async () => {
    vi.useFakeTimers();
    try {
      const send = flakySend(1);
      const step = cmd("flaky", { retry: { count: 1, delayMs: 5_000 } });
      const handle = runWorkflow([step], { send });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await handle.done;

      expect(send).toHaveBeenCalledTimes(2);
      expect(result.status).toBe("completed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runWorkflow — cancel during a retry wait", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("interrupts the back-off wait immediately and does not retry", async () => {
    const send = vi.fn(async () => false);
    const step = cmd("down", { retry: { count: 5, delayMs: 60_000 } });
    const handle = runWorkflow([step, cmd("after")], { send });

    // First attempt fails, runner is now sleeping 60s before the retry.
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(1);

    handle.cancel();
    const result = await handle.done;

    expect(result).toEqual({ status: "cancelled", stepsCompleted: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("runWorkflow — continueOnError", () => {
  it("records the failure and continues with the next step", async () => {
    const send = vi.fn(async (data: string) => !data.startsWith("cleanup"));
    const onStepContinued = vi.fn<(e: WorkflowStepContinuedEvent) => void>();
    const onProgress = vi.fn();
    const steps = [cmd("a"), cmd("cleanup", { continueOnError: true }), cmd("b")];

    const result = await runWorkflow(steps, deps({ send }), { onStepContinued, onProgress }).done;

    expect(result).toEqual({
      status: "completed",
      stepsCompleted: 3,
      continuedFailures: [
        { stepIndex: 1, error: "the target terminal is no longer connected", attempts: 1 },
      ],
    });
    expect(send.mock.calls.map(([d]) => d)).toEqual(["a\n", "cleanup\n", "b\n"]);
    expect(onStepContinued).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  it("retries first, then continues when every attempt failed", async () => {
    const send = vi.fn(async (data: string) => data !== "x\n");
    const steps = [cmd("x", { continueOnError: true, retry: { count: 2 } }), cmd("y")];

    const result = await runWorkflow(steps, deps({ send })).done;

    expect(result.status).toBe("completed");
    expect(result.continuedFailures).toEqual([
      { stepIndex: 0, error: "the target terminal is no longer connected", attempts: 3 },
    ]);
  });

  it("keeps tolerated failures on a later hard failure", async () => {
    const send = vi.fn(async () => false);
    const steps = [cmd("soft", { continueOnError: true }), cmd("hard")];

    const result = await runWorkflow(steps, deps({ send })).done;

    expect(result.status).toBe("failed");
    expect(result.failedStepIndex).toBe(1);
    expect(result.continuedFailures).toHaveLength(1);
  });

  it("applies to nested steps inside a conditional, attributed to the top-level step", async () => {
    const send = vi.fn(async (data: string) => data !== "inner\n");
    const conditional: WorkflowStep = {
      kind: "conditional",
      condition: { left: "1", op: "eq", right: "1" },
      then: [cmd("inner", { continueOnError: true }), cmd("after-inner")],
    };

    const result = await runWorkflow([cmd("first"), conditional], deps({ send })).done;

    expect(result.status).toBe("completed");
    expect(result.continuedFailures).toEqual([
      { stepIndex: 1, error: "the target terminal is no longer connected", attempts: 1 },
    ]);
    expect(send.mock.calls.map(([d]) => d)).toEqual(["first\n", "inner\n", "after-inner\n"]);
  });
});

describe("executeStepWithPolicy", () => {
  it("does not retry a cancelled attempt", async () => {
    const runLocalProcess = vi.fn(async () => ({
      exitCode: null,
      timedOut: false,
      cancelled: true,
    }));
    const step: WorkflowStep = {
      kind: "run-local-process",
      program: "p",
      args: [],
      retry: { count: 3 },
    };
    const outcome = await executeStepWithPolicy(
      step,
      deps({ runLocalProcess, authorizeLocalProcess: () => true })
    );

    expect(outcome).toEqual({ ok: true, cancelled: true });
    expect(runLocalProcess).toHaveBeenCalledTimes(1);
  });

  it("behaves exactly like executeStep without a policy", async () => {
    const outcome = await executeStepWithPolicy(cmd("x"), deps({ send: vi.fn(async () => false) }));
    expect(outcome).toEqual({ ok: false, error: "the target terminal is no longer connected" });
  });
});
