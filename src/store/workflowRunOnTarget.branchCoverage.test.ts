/**
 * Direct tests for the per-target workflow run (`runWorkflowOnTarget`, #2979):
 * the `wait-for-output` seam (PROD-044) — matching, ANSI stripping, the bounded
 * match buffer, timeout, cancel and a failed subscription — plus sessionless
 * (on-disconnect) runs, the outcome toasts, the shared fan-out authorization and
 * the history-record guards. The bridge dispatches, terminal-output events, the
 * input injector and the backend history are mocked; the real step runner runs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  toast: {
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
  },
  outputListeners: [] as Array<(sessionId: string, data: Uint8Array) => void>,
  onTerminalOutput: vi.fn(),
  injector: vi.fn((_tabId: string, _data: string) => true),
  getTerminalInputInjector: vi.fn(),
  recordWorkflowRun: vi.fn(),
  recordMacroRun: vi.fn(),
  ensureWorkflowSubscribed: vi.fn(),
  settings: {
    workflowLocalProcessEnabled: true,
    workflowLocalProcessAllowlist: undefined as string[] | undefined,
  },
  frontendLog: vi.fn(),
}));

vi.mock("@/components/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/ui")>()),
  toast: mocks.toast,
}));

vi.mock("@/services/events", () => ({
  onTerminalOutput: (cb: (sessionId: string, data: Uint8Array) => void) =>
    mocks.onTerminalOutput(cb),
}));

vi.mock("@/services/macroPlayback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/macroPlayback")>()),
  getTerminalInputInjector: () => mocks.getTerminalInputInjector(),
}));

vi.mock("@/services/workflowApi", () => ({
  recordWorkflowRun: (run: unknown) => mocks.recordWorkflowRun(run),
}));

vi.mock("@/services/macroApi", () => ({
  recordMacroRun: (run: unknown) => mocks.recordMacroRun(run),
}));

vi.mock("@/utils/frontendLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/frontendLog")>()),
  frontendLog: (...args: unknown[]) => mocks.frontendLog(...args),
}));

vi.mock("./settingsBridge", () => ({
  currentSettingsView: () => mocks.settings,
}));

vi.mock("./workflowRunBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workflowRunBridge")>()),
  ensureWorkflowSubscribed: () => mocks.ensureWorkflowSubscribed(),
  dispatchWorkflowRunStarted: vi.fn(() => Promise.resolve()),
  dispatchWorkflowStepAdvanced: vi.fn(() => Promise.resolve()),
  dispatchWorkflowOutputOpened: vi.fn(() => Promise.resolve()),
  dispatchWorkflowRunSettled: vi.fn(() => Promise.resolve()),
}));

import { useAppStore, type AppState } from "./appStore";
import type { Macro } from "@/types/macro";
import type { Workflow, WorkflowStep } from "@/types/workflow";
import {
  activeWorkflowRunCount,
  cancelWorkflowRunById,
  runWorkflowOnTarget,
  toastRunOutcome,
  type WorkflowFanoutHooks,
} from "./slices/workflowRunOnTarget";

const encoder = new TextEncoder();

/** Push a terminal-output chunk to every attached listener. */
function emitOutput(sessionId: string, text: string): void {
  for (const listener of [...mocks.outputListeners]) listener(sessionId, encoder.encode(text));
}

/** Resolves once the wait-for-output listener has attached. */
async function listenerAttached(): Promise<void> {
  await vi.waitFor(() => expect(mocks.outputListeners.length).toBeGreaterThan(0));
}

function workflow(steps: WorkflowStep[], name = "wf"): Workflow {
  return { id: `wf-${name}`, name, steps } as Workflow;
}

let state: Partial<AppState>;
const set = vi.fn((partial: Partial<AppState>) => {
  state = { ...state, ...partial };
});
const get = () => state as AppState;

function run(
  wf: Workflow,
  extra: Partial<Parameters<typeof runWorkflowOnTarget>[0]> = {}
): ReturnType<typeof runWorkflowOnTarget> {
  return runWorkflowOnTarget({
    set,
    get,
    workflow: wf,
    targetTabId: "tab-1",
    targetSessionId: "sess-1",
    paramValues: {},
    triggeredBy: "manual",
    ...extra,
  });
}

beforeEach(() => {
  for (const fn of Object.values(mocks.toast)) fn.mockReset();
  mocks.outputListeners.length = 0;
  mocks.onTerminalOutput.mockReset().mockImplementation((cb) => {
    mocks.outputListeners.push(cb);
    return Promise.resolve(() => {
      const i = mocks.outputListeners.indexOf(cb);
      if (i >= 0) mocks.outputListeners.splice(i, 1);
    });
  });
  mocks.injector.mockReset().mockReturnValue(true);
  mocks.getTerminalInputInjector.mockReset().mockReturnValue(mocks.injector);
  mocks.recordWorkflowRun.mockReset().mockResolvedValue([]);
  mocks.recordMacroRun.mockReset().mockResolvedValue([]);
  mocks.ensureWorkflowSubscribed.mockReset().mockResolvedValue(undefined);
  mocks.settings.workflowLocalProcessEnabled = true;
  mocks.settings.workflowLocalProcessAllowlist = undefined;
  mocks.frontendLog.mockReset();
  set.mockClear();
  // The real initial state (an empty layout), so tab lookups resolve nothing.
  state = { ...useAppStore.getInitialState(), macros: [], workflowRuns: [], macroRuns: [] };
});

describe("runWorkflowOnTarget — wait-for-output (PROD-044)", () => {
  it("matches the target session's ANSI-stripped output across chunks", async () => {
    const done = run(workflow([{ kind: "wait-for-output", pattern: "ready>", timeoutMs: 5_000 }]));
    await listenerAttached();

    emitOutput("other-session", "ready>"); // a different session never matches
    emitOutput("sess-1", "\u001b[32mrea");
    emitOutput("sess-1", "dy\u001b[0m>");

    const result = await done;
    expect(result.status).toBe("completed");
    // The listener is detached once the wait settles.
    expect(mocks.outputListeners).toHaveLength(0);
    expect(mocks.toast.success).toHaveBeenCalledWith('Ran workflow "wf"', expect.anything());
  });

  it("strips OSC 133 marks split across chunks before a $-anchored match (#4355)", async () => {
    const done = run(
      workflow([{ kind: "wait-for-output", pattern: "\\$ $", isRegex: true, timeoutMs: 50 }])
    );
    await listenerAttached();
    emitOutput("sess-1", "\u001b]0;arne@box: ~\u0007arne@box:~$ \u001b]13");
    emitOutput("sess-1", "3;B\u0007");
    expect((await done).status).toBe("completed");
  });

  it("matches a regular-expression pattern", async () => {
    const done = run(
      workflow([{ kind: "wait-for-output", pattern: "build \\d+ ok", isRegex: true }])
    );
    await listenerAttached();
    emitOutput("sess-1", "build 42 ok\r\n");
    expect((await done).status).toBe("completed");
  });

  it("bounds the match buffer, dropping the oldest output", async () => {
    // `^START` is only true while the very first chunk is still at the head of
    // the buffer; a chunk longer than the 64 KiB cap trims it before matching.
    const done = run(
      workflow([{ kind: "wait-for-output", pattern: "^START", isRegex: true, timeoutMs: 50 }])
    );
    await listenerAttached();
    emitOutput("sess-1", "START" + "x".repeat(70_000));

    const result = await done;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/timed out after 50 ms/);
  });

  it("fails the step when the output never matches within the timeout", async () => {
    const result = await run(
      workflow([{ kind: "wait-for-output", pattern: "never", timeoutMs: 20 }], "slow")
    );
    expect(result.status).toBe("failed");
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Workflow "slow" failed at step 1',
      expect.objectContaining({ description: expect.stringMatching(/timed out/) })
    );
  });

  it("ends the wait as cancelled when the run is cancelled", async () => {
    let runId = "";
    const fanout: WorkflowFanoutHooks = { onStart: (id) => (runId = id) };
    const done = run(workflow([{ kind: "wait-for-output", pattern: "never" }]), { fanout });
    await listenerAttached();

    expect(cancelWorkflowRunById(runId)).toBe(true);

    const result = await done;
    expect(result.status).toBe("cancelled");
    expect(activeWorkflowRunCount()).toBe(0);
    // A fan-out target raises no toast of its own.
    expect(mocks.toast.info).not.toHaveBeenCalled();
  });

  it("ends the wait on the cancel event itself, without a polling timer (#4381)", async () => {
    vi.useFakeTimers();
    try {
      let runId = "";
      const fanout: WorkflowFanoutHooks = { onStart: (id) => (runId = id) };
      let settled = false;
      const done = run(workflow([{ kind: "wait-for-output", pattern: "never" }]), { fanout });
      void done.then(() => (settled = true));
      await listenerAttached();
      // Only the step's own timeout is pending — no cancel-poll interval.
      expect(vi.getTimerCount()).toBe(1);

      expect(cancelWorkflowRunById(runId)).toBe(true);
      // No clock advance: the cancel signal alone settles the wait.
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect((await done).status).toBe("cancelled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a failed output subscription as a timeout", async () => {
    mocks.onTerminalOutput.mockRejectedValueOnce(new Error("no event bus"));

    const result = await run(workflow([{ kind: "wait-for-output", pattern: "x" }]));

    expect(result.status).toBe("failed");
    expect(mocks.frontendLog).toHaveBeenCalledWith(
      "workflow",
      expect.stringContaining("wait-for-output could not subscribe: no event bus")
    );
  });

  it("detaches a listener that attaches only after the wait settled", async () => {
    let attach: (un: () => void) => void = () => {};
    mocks.onTerminalOutput.mockImplementationOnce(
      () => new Promise<() => void>((resolve) => (attach = resolve))
    );
    const unlisten = vi.fn();

    const result = await run(workflow([{ kind: "wait-for-output", pattern: "x", timeoutMs: 0 }]));
    expect(result.status).toBe("failed");

    attach(unlisten);
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});

describe("runWorkflowOnTarget — sessionless runs (#3791)", () => {
  it("fails a send step instead of touching the dead tab", async () => {
    const result = await run(workflow([{ kind: "send-command", command: "echo hi" }]), {
      sessionless: true,
    });
    expect(result.status).toBe("failed");
    expect(mocks.injector).not.toHaveBeenCalled();
  });

  it("fails a run-macro step instead of touching the dead tab", async () => {
    state.macros = [
      { id: "m1", name: "M", steps: [{ data: "x", delayMs: 0 }] } as unknown as Macro,
    ];
    const result = await run(workflow([{ kind: "run-macro", macroId: "m1" }]), {
      sessionless: true,
    });
    expect(result.status).toBe("failed");
    expect(mocks.injector).not.toHaveBeenCalled();
  });

  it("fails a wait-for-output step loudly — there is no output to wait for", async () => {
    const result = await run(workflow([{ kind: "wait-for-output", pattern: "x" }]), {
      sessionless: true,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/requires a terminal-output seam/);
    expect(mocks.onTerminalOutput).not.toHaveBeenCalled();
  });

  it("still runs a plain wait step", async () => {
    const result = await run(workflow([{ kind: "wait", delayMs: 0 }]), { sessionless: true });
    expect(result.status).toBe("completed");
  });
});

describe("runWorkflowOnTarget — run-macro labels and history", () => {
  it("labels an unknown tab 'Terminal' and tolerates a non-array history reply", async () => {
    state.macros = [
      { id: "m1", name: "M", steps: [{ data: "x", delayMs: 0 }] } as unknown as Macro,
    ];
    mocks.recordMacroRun.mockResolvedValueOnce(null);

    const result = await run(workflow([{ kind: "run-macro", macroId: "m1" }]));

    expect(result.status).toBe("completed");
    expect(mocks.recordMacroRun).toHaveBeenCalledWith(
      expect.objectContaining({ targetLabels: ["Terminal"], origin: "workflow-step" })
    );
    await vi.waitFor(() => expect(state.macroRuns).toEqual([]));
  });

  it("stores an empty history when the workflow record reply is not an array", async () => {
    state.workflowRuns = [{ id: "stale" }] as AppState["workflowRuns"];
    mocks.recordWorkflowRun.mockResolvedValueOnce(undefined);

    await run(workflow([{ kind: "wait", delayMs: 0 }]));

    await vi.waitFor(() => expect(state.workflowRuns).toEqual([]));
  });

  it("never lets a synchronously-throwing history write fail the run", async () => {
    mocks.recordWorkflowRun.mockImplementationOnce(() => {
      throw new Error("no tauri");
    });

    const result = await run(workflow([{ kind: "wait", delayMs: 0 }]));

    expect(result.status).toBe("completed");
    expect(mocks.frontendLog).toHaveBeenCalledWith(
      "workflow",
      "Failed to record workflow run: no tauri"
    );
  });

  it("still runs when warming the region subscription throws synchronously", async () => {
    mocks.ensureWorkflowSubscribed.mockImplementationOnce(() => {
      throw new Error("no socket");
    });
    const result = await run(workflow([{ kind: "wait", delayMs: 0 }]));
    expect(result.status).toBe("completed");
  });
});

describe("runWorkflowOnTarget — local-process authorization", () => {
  const lp: WorkflowStep = { kind: "run-local-process", program: "make", args: ["test"] };

  it("reuses a fan-out's shared decision instead of prompting again", async () => {
    const authDecisions = new Map([[JSON.stringify(["make", "test"]), Promise.resolve(false)]]);

    const result = await run(workflow([lp]), { fanout: { authDecisions } });

    expect(result.status).toBe("failed");
    expect(set).not.toHaveBeenCalledWith(
      expect.objectContaining({ localProcessPrompt: expect.anything() })
    );
  });

  it("refuses an un-allowlisted program in an unattended run without prompting", async () => {
    mocks.settings.workflowLocalProcessAllowlist = ["other"];

    const result = await run(workflow([lp]), { unattended: true });

    expect(result.status).toBe("failed");
    expect(mocks.frontendLog).toHaveBeenCalledWith(
      "workflow",
      "scheduled run refused un-allowlisted local program: make"
    );
  });
});

describe("runWorkflowOnTarget — fan-out retry reporting", () => {
  it("reports a retry to the fan-out hook instead of raising its own toast", async () => {
    mocks.injector.mockReturnValueOnce(false).mockReturnValue(true);
    const onProgress = vi.fn();

    const result = await run(
      workflow([{ kind: "send-command", command: "ls", retry: { count: 1, delayMs: 0 } }]),
      { fanout: { onProgress } }
    );

    expect(result.status).toBe("completed");
    expect(onProgress).toHaveBeenCalledWith(0, "Retrying step 1 (attempt 2 of 2)");
    expect(mocks.toast.loading).not.toHaveBeenCalled();
  });
});

describe("toastRunOutcome", () => {
  it("pluralises several tolerated step failures", () => {
    toastRunOutcome(
      "wf",
      {
        status: "completed",
        stepsCompleted: 3,
        continuedFailures: [
          { stepIndex: 0, error: "boom", attempts: 1 },
          { stepIndex: 2, error: "bang", attempts: 1 },
        ],
      },
      3,
      "t"
    );
    expect(mocks.toast.info).toHaveBeenCalledWith(
      'Ran workflow "wf" with 2 tolerated step failures',
      { id: "t", description: "Step 1: boom" }
    );
  });

  it("falls back to the completed-step count when no failed index is known", () => {
    toastRunOutcome("wf", { status: "failed", stepsCompleted: 1, error: "nope" }, 3, "t");
    expect(mocks.toast.error).toHaveBeenCalledWith('Workflow "wf" failed at step 2', {
      id: "t",
      description: "nope",
    });
  });
});
