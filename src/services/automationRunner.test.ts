/**
 * Tests for the automation run engine (#5818, slice 3): `type-keys` delivery
 * and timing on a fake clock, `run-automation` nesting with cycle and depth
 * errors, error policies on `type-keys`, and independent per-target runs with
 * the parallel cap.
 */
import { describe, expect, it, vi } from "vitest";
import { findAutomationCycle, runAutomation, runAutomationOnTargets } from "./automationRunner";
import {
  MAX_AUTOMATION_DEPTH,
  runWorkflow,
  typeKeysTiming,
  type TypeKeysStep,
  type WorkflowRunnerDeps,
} from "./workflowRunner";
import { DEFAULT_FIXED_DELAY_MS, MAX_STEP_DELAY_MS } from "./macroPlayback";
import { WORKFLOW_FANOUT_CONCURRENCY } from "@/store/slices/workflowFanout";
import type { Automation } from "@/types/generated/Automation";
import type { AutomationStep } from "@/types/generated/AutomationStep";
import type { TypeKeysChunk } from "@/types/generated/TypeKeysChunk";

/** A fake clock: `wait` advances virtual time at once and logs each sleep. */
function fakeClock() {
  const clock = { now: 0, sleeps: [] as number[] };
  const wait = vi.fn(async (ms: number) => {
    clock.sleeps.push(ms);
    clock.now += ms;
  });
  return { clock, wait };
}

/** A send seam that records what it got, stamped with the fake clock's time. */
function recordingSend(clock: { now: number }, accept: (n: number) => boolean = () => true) {
  const sent: { data: string; at: number }[] = [];
  const send = vi.fn(async (data: string) => {
    const ok = accept(sent.length);
    if (ok) sent.push({ data, at: clock.now });
    return ok;
  });
  return { sent, send };
}

const chunk = (data: string, delayMs = 0): TypeKeysChunk => ({ data, delayMs });

const typeKeys = (chunks: TypeKeysChunk[], extra: Partial<TypeKeysStep> = {}): TypeKeysStep => ({
  kind: "type-keys",
  chunks,
  ...extra,
});

const call = (automationId: string, extra: Partial<AutomationStep> = {}): AutomationStep =>
  ({ kind: "run-automation", automationId, ...extra }) as AutomationStep;

const automation = (id: string, steps: AutomationStep[], extra: Partial<Automation> = {}) =>
  ({
    id,
    name: id.toUpperCase(),
    tags: [],
    steps,
    triggers: [],
    createdAt: "",
    updatedAt: "",
    ...extra,
  }) as Automation;

/** Deps over a fake clock with a lookup into `library`. */
function setup(library: Automation[] = [], accept?: (n: number) => boolean) {
  const { clock, wait } = fakeClock();
  const { sent, send } = recordingSend(clock, accept);
  const byId = new Map(library.map((a) => [a.id, a]));
  const deps: WorkflowRunnerDeps = { send, wait, resolveAutomation: (id) => byId.get(id) };
  return { clock, wait, sent, send, deps };
}

describe("type-keys delivery", () => {
  it("sends every chunk byte for byte, with no newline and no parameter substitution", async () => {
    const data = ["l", "s", " -la", "\r", "\x03", "\x1b[A", "${HOME}", "$${x}", "ü→😀", "\n"];
    const { sent, deps } = setup();
    const result = await runWorkflow([typeKeys(data.map((d) => chunk(d)))], deps, undefined, {
      HOME: "/root",
      x: "1",
    }).done;
    expect(result.status).toBe("completed");
    expect(sent.map((s) => s.data)).toEqual(data);
  });

  it("an empty step types nothing and succeeds", async () => {
    const { send, deps } = setup();
    const result = await runWorkflow([typeKeys([])], deps).done;
    expect(result).toEqual({ status: "completed", stepsCompleted: 1 });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("type-keys timing", () => {
  const chunks = [chunk("a", 900), chunk("b", 120), chunk("c", 0), chunk("d", 60_000)];

  it("recorded (the default) replays each recorded delay, first chunk at once, clamped", async () => {
    const { sent, deps } = setup();
    await runWorkflow([typeKeys(chunks)], deps).done;
    expect(sent.map((s) => s.at)).toEqual([0, 120, 120, 120 + MAX_STEP_DELAY_MS]);
  });

  it("recorded set explicitly behaves like the default", async () => {
    const { sent, deps } = setup();
    await runWorkflow([typeKeys(chunks, { timing: "recorded" })], deps).done;
    expect(sent.map((s) => s.at)).toEqual([0, 120, 120, 120 + MAX_STEP_DELAY_MS]);
  });

  it("fixed waits fixedDelayMs between chunks", async () => {
    const { sent, deps } = setup();
    await runWorkflow([typeKeys(chunks, { timing: "fixed", fixedDelayMs: 25 })], deps).done;
    expect(sent.map((s) => s.at)).toEqual([0, 25, 50, 75]);
  });

  it("fixed without fixedDelayMs uses the default delay", async () => {
    const { sent, deps } = setup();
    await runWorkflow([typeKeys(chunks, { timing: "fixed" })], deps).done;
    const d = DEFAULT_FIXED_DELAY_MS;
    expect(sent.map((s) => s.at)).toEqual([0, d, 2 * d, 3 * d]);
  });

  it("instant never sleeps", async () => {
    const { sent, wait, deps } = setup();
    await runWorkflow([typeKeys(chunks, { timing: "instant" })], deps).done;
    expect(sent.map((s) => s.at)).toEqual([0, 0, 0, 0]);
    expect(wait).not.toHaveBeenCalled();
  });

  it("maps each saved timing to the macro-playback mode", () => {
    expect(typeKeysTiming(typeKeys([]))).toEqual({ timingMode: "real-time" });
    expect(typeKeysTiming(typeKeys([], { timing: "instant" }))).toEqual({
      timingMode: "instant",
    });
    expect(typeKeysTiming(typeKeys([], { timing: "fixed", fixedDelayMs: 7 }))).toEqual({
      timingMode: "fixed",
      fixedDelayMs: 7,
    });
  });

  it("a cancel during a chunk delay stops before the next chunk", async () => {
    let release: () => void = () => {};
    const deps: WorkflowRunnerDeps = {
      send: vi.fn(async () => true),
      // The first sleep never ends on its own; only the cancel ends it.
      wait: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      ),
    };
    const handle = runWorkflow([typeKeys([chunk("a"), chunk("b", 500), chunk("c", 500)])], deps);
    await vi.waitFor(() => expect(deps.wait).toHaveBeenCalledTimes(1));
    handle.cancel();
    const result = await handle.done;
    release();
    expect(result).toEqual({ status: "cancelled", stepsCompleted: 0 });
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledWith("a");
  });
});

describe("type-keys error policies", () => {
  it("a target that stops accepting input fails the step with how far it got", async () => {
    const { sent, deps } = setup([], (n) => n < 2);
    const result = await runWorkflow(
      [typeKeys([chunk("a"), chunk("b"), chunk("c")]), { kind: "send-command", command: "x" }],
      deps
    ).done;
    expect(sent.map((s) => s.data)).toEqual(["a", "b"]);
    expect(result.status).toBe("failed");
    expect(result.failedStepIndex).toBe(0);
    expect(result.error).toContain("typed 2 of 3 chunks");
  });

  it("continueOnError tolerates the failure and the run carries on", async () => {
    let calls = 0;
    const deps: WorkflowRunnerDeps = {
      send: vi.fn(async () => ++calls !== 1),
      wait: vi.fn(async () => {}),
    };
    const result = await runWorkflow(
      [typeKeys([chunk("a")], { continueOnError: true }), typeKeys([chunk("b")])],
      deps
    ).done;
    expect(result.status).toBe("completed");
    expect(result.continuedFailures).toHaveLength(1);
    expect(result.continuedFailures?.[0].stepIndex).toBe(0);
  });

  it("retry re-types the whole step until it is delivered", async () => {
    let calls = 0;
    const sent: string[] = [];
    const deps: WorkflowRunnerDeps = {
      // The second chunk fails on the first attempt only.
      send: vi.fn(async (d: string) => {
        calls += 1;
        if (calls === 2) return false;
        sent.push(d);
        return true;
      }),
      wait: vi.fn(async () => {}),
    };
    const result = await runWorkflow(
      [typeKeys([chunk("a"), chunk("b")], { retry: { count: 2, delayMs: 10 } })],
      deps
    ).done;
    expect(result.status).toBe("completed");
    expect(sent).toEqual(["a", "a", "b"]);
  });
});

describe("run-automation", () => {
  it("runs the callee's steps inline on the same target", async () => {
    const inner = automation("inner", [typeKeys([chunk("in")])]);
    const outer = automation("outer", [
      typeKeys([chunk("a")]),
      call("inner"),
      typeKeys([chunk("b")]),
    ]);
    const { sent, deps } = setup([inner, outer]);
    const result = await runAutomation(outer, deps).done;
    expect(result.status).toBe("completed");
    expect(sent.map((s) => s.data)).toEqual(["a", "in", "b"]);
  });

  it("passes declared parameters through, else the callee's defaults", async () => {
    const inner = automation("inner", [{ kind: "send-command", command: "${host} ${port}" }], {
      parameters: [
        { name: "host", type: "string" },
        { name: "port", type: "number", default: 22 },
      ],
    });
    const outer = automation("outer", [call("inner")]);
    const { sent, deps } = setup([inner, outer]);
    await runAutomation(outer, deps, undefined, { host: "box", other: "x" }).done;
    expect(sent.map((s) => s.data)).toEqual(["box 22\n"]);
  });

  it("fails clearly when the callee does not exist", async () => {
    const outer = automation("outer", [call("ghost")]);
    const { deps } = setup([outer]);
    const result = await runAutomation(outer, deps).done;
    expect(result.status).toBe("failed");
    expect(result.error).toBe("automation “ghost” was not found");
  });

  it("fails without an automation lookup", async () => {
    const result = await runWorkflow([call("x")], { send: vi.fn(async () => true) }).done;
    expect(result.error).toContain("requires an automation lookup");
  });

  it("rejects a self-call before typing anything", async () => {
    const self = automation("self", [typeKeys([chunk("a")]), call("self")]);
    const { send, deps } = setup([self]);
    const result = await runAutomation(self, deps).done;
    expect(result).toMatchObject({ status: "failed", stepsCompleted: 0, failedStepIndex: 1 });
    expect(result.error).toBe("automation calls itself: “SELF” → “SELF”");
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an indirect cycle, even one hidden in a conditional branch", async () => {
    const a = automation("a", [
      typeKeys([chunk("x")]),
      {
        kind: "conditional",
        condition: { left: "1", op: "eq", right: "2" },
        then: [],
        else: [call("b")],
      },
    ]);
    const b = automation("b", [
      { kind: "loop", loop: { kind: "count", count: 1 }, body: [call("c")] },
    ]);
    const c = automation("c", [call("a")]);
    const { send, deps } = setup([a, b, c]);
    const result = await runAutomation(a, deps).done;
    expect(result.failedStepIndex).toBe(1);
    expect(result.error).toBe("automation calls itself: “A” → “B” → “C” → “A”");
    expect(send).not.toHaveBeenCalled();
  });

  it("the runner's own chain guard catches a cycle introduced mid-run", async () => {
    // `b` only calls back into `a` once the run is going (edited meanwhile).
    const a = automation("a", [call("b")]);
    let bSteps: AutomationStep[] = [];
    const lookup = (id: string) =>
      id === "a" ? a : id === "b" ? automation("b", bSteps) : undefined;
    const deps: WorkflowRunnerDeps = { send: vi.fn(async () => true), resolveAutomation: lookup };
    const handle = runAutomation(a, deps);
    bSteps = [call("a")];
    const result = await handle.done;
    expect(result.status).toBe("failed");
    expect(result.error).toContain("automation calls itself: “A” → “B” → “A”");
  });

  it("caps call depth with a clear error", async () => {
    // a0 → a1 → … → aN, no cycle, one level deeper than allowed.
    const n = MAX_AUTOMATION_DEPTH + 1;
    const library = Array.from({ length: n + 1 }, (_, i) =>
      automation(`a${i}`, i < n ? [call(`a${i + 1}`)] : [typeKeys([chunk("deep")])])
    );
    const { send, deps } = setup(library);
    const result = await runAutomation(library[0], deps).done;
    expect(result.status).toBe("failed");
    expect(result.error).toContain(
      `automations call each other more than ${MAX_AUTOMATION_DEPTH} levels deep`
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("allows exactly the maximum call depth", async () => {
    const n = MAX_AUTOMATION_DEPTH;
    const library = Array.from({ length: n + 1 }, (_, i) =>
      automation(`a${i}`, i < n ? [call(`a${i + 1}`)] : [typeKeys([chunk("deep")])])
    );
    const { sent, deps } = setup(library);
    const result = await runAutomation(library[0], deps).done;
    expect(result.status).toBe("completed");
    expect(sent.map((s) => s.data)).toEqual(["deep"]);
  });

  it("a callee's failure names the automation and its step", async () => {
    const inner = automation("inner", [typeKeys([chunk("a")]), typeKeys([chunk("b")])]);
    const outer = automation("outer", [call("inner")]);
    const { deps } = setup([inner, outer], (n) => n < 1);
    const result = await runAutomation(outer, deps).done;
    expect(result.error).toMatch(/^in automation “INNER”, step 2: /);
  });
});

describe("findAutomationCycle", () => {
  it("returns null for a diamond without a cycle", () => {
    const d = automation("d", []);
    const b = automation("b", [call("d")]);
    const c = automation("c", [call("d")]);
    const a = automation("a", [call("b"), call("c")]);
    const lib = new Map([a, b, c, d].map((x) => [x.id, x]));
    expect(findAutomationCycle(a, (id) => lib.get(id))).toBeNull();
  });

  it("finds a cycle below the root that does not include the root", () => {
    const b = automation("b", [call("c")]);
    const c = automation("c", [call("b")]);
    const a = automation("a", [typeKeys([]), call("b")]);
    const lib = new Map([a, b, c].map((x) => [x.id, x]));
    expect(findAutomationCycle(a, (id) => lib.get(id))).toEqual({
      path: ["b", "c", "b"],
      stepIndex: 1,
    });
  });
});

describe("runAutomationOnTargets", () => {
  /** Deps per target whose `send` blocks until released, to observe concurrency. */
  function gatedTargets(count: number) {
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: (() => void)[] = [];
    const sentBy: string[][] = Array.from({ length: count }, () => []);
    const depsFor = (_t: number, index: number): WorkflowRunnerDeps => ({
      send: (data) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<boolean>((resolve) => {
          releases.push(() => {
            inFlight -= 1;
            sentBy[index].push(data);
            resolve(true);
          });
        });
      },
    });
    const releaseAll = () => releases.splice(0).forEach((r) => r());
    return { depsFor, releaseAll, sentBy, stats: () => ({ inFlight, maxInFlight }) };
  }

  const auto = automation("a", [typeKeys([chunk("x")], { timing: "instant" })]);

  it(`runs at most ${WORKFLOW_FANOUT_CONCURRENCY} targets at once and queues the rest`, async () => {
    const n = WORKFLOW_FANOUT_CONCURRENCY + 3;
    const g = gatedTargets(n);
    const run = runAutomationOnTargets(
      auto,
      Array.from({ length: n }, (_, i) => i),
      g.depsFor
    );
    await vi.waitFor(() => expect(g.stats().inFlight).toBe(WORKFLOW_FANOUT_CONCURRENCY));
    const drain = setInterval(g.releaseAll, 1);
    const results = await run.done;
    clearInterval(drain);
    expect(g.stats().maxInFlight).toBe(WORKFLOW_FANOUT_CONCURRENCY);
    expect(results.map((r) => r?.status)).toEqual(Array(n).fill("completed"));
    expect(g.sentBy.every((s) => s.join() === "x")).toBe(true);
  });

  it("runs one after another when parallel is off", async () => {
    const g = gatedTargets(3);
    const run = runAutomationOnTargets(auto, [0, 1, 2], g.depsFor, { parallel: false });
    const drain = setInterval(g.releaseAll, 1);
    await run.done;
    clearInterval(drain);
    expect(g.stats().maxInFlight).toBe(1);
  });

  it("a failing target ends only its own run", async () => {
    const depsFor = (t: number): WorkflowRunnerDeps => ({ send: vi.fn(async () => t !== 1) });
    const results = await runAutomationOnTargets(auto, [0, 1, 2], depsFor).done;
    expect(results.map((r) => r?.status)).toEqual(["completed", "failed", "completed"]);
  });

  it("reports each target's end as soon as that target ends", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const depsFor = (t: number): WorkflowRunnerDeps => ({
      send: async () => {
        if (t === 0) await gate;
        return t === 0;
      },
    });
    const ended: Array<[number, string]> = [];
    const run = runAutomationOnTargets(auto, [0, 1], depsFor, {
      onTargetEnd: (i, result) => ended.push([i, result.status]),
    });
    // Target 1 fails at once while target 0 is still typing.
    await vi.waitFor(() => expect(ended).toEqual([[1, "failed"]]));
    release();
    await run.done;
    expect(ended).toEqual([
      [1, "failed"],
      [0, "completed"],
    ]);
  });

  it("cancelAll stops running targets and starts no queued one", async () => {
    const n = WORKFLOW_FANOUT_CONCURRENCY + 2;
    const g = gatedTargets(n);
    const started: number[] = [];
    const twoChunks = automation("a", [typeKeys([chunk("x"), chunk("y")], { timing: "instant" })]);
    const run = runAutomationOnTargets(
      twoChunks,
      Array.from({ length: n }, (_, i) => i),
      g.depsFor,
      { onTargetStart: (i) => started.push(i) }
    );
    await vi.waitFor(() => expect(g.stats().inFlight).toBe(WORKFLOW_FANOUT_CONCURRENCY));
    run.cancelAll();
    g.releaseAll();
    const results = await run.done;
    expect(started).toHaveLength(WORKFLOW_FANOUT_CONCURRENCY);
    expect(results.slice(0, WORKFLOW_FANOUT_CONCURRENCY).map((r) => r?.status)).toEqual(
      Array(WORKFLOW_FANOUT_CONCURRENCY).fill("cancelled")
    );
    expect(results.slice(WORKFLOW_FANOUT_CONCURRENCY)).toEqual([undefined, undefined]);
    expect(g.sentBy.flat()).not.toContain("y");
  });

  it("cancel stops one target and leaves the others running", async () => {
    const g = gatedTargets(2);
    const twoChunks = automation("a", [typeKeys([chunk("x"), chunk("y")], { timing: "instant" })]);
    const run = runAutomationOnTargets(twoChunks, [0, 1], g.depsFor);
    await vi.waitFor(() => expect(g.stats().inFlight).toBe(2));
    run.cancel(0);
    const drain = setInterval(g.releaseAll, 1);
    const results = await run.done;
    clearInterval(drain);
    expect(results.map((r) => r?.status)).toEqual(["cancelled", "completed"]);
    expect(g.sentBy[1]).toEqual(["x", "y"]);
  });
});
