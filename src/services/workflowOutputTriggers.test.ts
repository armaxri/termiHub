import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Workflow, WorkflowTrigger } from "@/types/workflow";
import {
  OUTPUT_TRIGGER_LIMITS,
  OutputTriggerEngine,
  clampCooldownMs,
  clampMaxFires,
  compileOutputTriggers,
  stripAnsi,
  validateOutputPattern,
  workflowTriggersValid,
  type OutputTriggerDeps,
} from "./workflowOutputTriggers";

const wf = (id: string, triggers: WorkflowTrigger[]): Workflow => ({
  id,
  name: id,
  tags: [],
  steps: [{ kind: "wait", delayMs: 0 }],
  triggers,
  createdAt: "",
  updatedAt: "",
});

const match = (
  pattern: string,
  extra: Partial<Extract<WorkflowTrigger, { kind: "on-output-match" }>> = {}
): WorkflowTrigger => ({
  kind: "on-output-match",
  connectionIds: ["conn-1"],
  pattern,
  ...extra,
});

describe("validateOutputPattern", () => {
  it("accepts a literal and a simple regex", () => {
    expect(validateOutputPattern("Connection refused", false)).toBeNull();
    expect(validateOutputPattern("ERROR \\d+", true)).toBeNull();
    expect(validateOutputPattern("^(foo|bar)$", true)).toBeNull();
  });

  it("rejects an empty or over-long pattern", () => {
    expect(validateOutputPattern("", false)).toBe("empty");
    const long = "x".repeat(OUTPUT_TRIGGER_LIMITS.maxPatternLength + 1);
    expect(validateOutputPattern(long, false)).toBe("too-long");
  });

  it("rejects an invalid regex", () => {
    expect(validateOutputPattern("([a-z", true)).toBe("invalid-regex");
    // The same text is a fine literal.
    expect(validateOutputPattern("([a-z", false)).toBeNull();
  });

  it("rejects catastrophic-backtracking shapes", () => {
    expect(validateOutputPattern("(a+)+$", true)).toBe("unsafe-regex");
    expect(validateOutputPattern("(.*)*x", true)).toBe("unsafe-regex");
    expect(validateOutputPattern("(\\w+){2,}", true)).toBe("unsafe-regex");
    expect(validateOutputPattern("(a)\\1", true)).toBe("unsafe-regex");
  });
});

describe("limits", () => {
  it("clamps cooldown and max fires, defaulting when absent", () => {
    expect(clampCooldownMs(undefined)).toBe(OUTPUT_TRIGGER_LIMITS.defaultCooldownMs);
    expect(clampCooldownMs(0)).toBe(OUTPUT_TRIGGER_LIMITS.minCooldownMs);
    expect(clampCooldownMs(1e12)).toBe(OUTPUT_TRIGGER_LIMITS.maxCooldownMs);
    expect(clampMaxFires(undefined)).toBe(OUTPUT_TRIGGER_LIMITS.defaultMaxFiresPerSession);
    expect(clampMaxFires(0)).toBe(1);
    expect(clampMaxFires(10_000)).toBe(OUTPUT_TRIGGER_LIMITS.maxMaxFiresPerSession);
  });

  it("gates saving on valid patterns and in-range limits", () => {
    expect(workflowTriggersValid([{ kind: "manual" }, match("ok")])).toBe(true);
    expect(workflowTriggersValid([match("(a+)+", { isRegex: true })])).toBe(false);
    expect(workflowTriggersValid([match("ok", { cooldownMs: 10 })])).toBe(false);
    expect(workflowTriggersValid([match("ok", { maxFiresPerSession: 0 })])).toBe(false);
    expect(workflowTriggersValid([match("ok", { maxFiresPerSession: 1.5 })])).toBe(false);
  });
});

describe("compileOutputTriggers", () => {
  it("skips invalid patterns and triggers bound to no connection", () => {
    const compiled = compileOutputTriggers([
      wf("good", [match("ready")]),
      wf("bad-regex", [match("([", { isRegex: true })]),
      wf("unbound", [{ kind: "on-output-match", connectionIds: [], pattern: "x" }]),
      wf("other", [{ kind: "manual" }]),
    ]);
    expect(compiled.map((c) => c.workflowId)).toEqual(["good"]);
  });
});

describe("stripAnsi", () => {
  it("removes colour codes so patterns match visible text", () => {
    expect(stripAnsi("\u001b[31mERROR\u001b[0m: disk")).toBe("ERROR: disk");
  });
});

describe("OutputTriggerEngine", () => {
  let now: number;
  let fire: ReturnType<typeof vi.fn<OutputTriggerDeps["fire"]>>;
  let resolveSession: ReturnType<typeof vi.fn<OutputTriggerDeps["resolveSession"]>>;
  let decode: ReturnType<typeof vi.fn<NonNullable<OutputTriggerDeps["decode"]>>>;

  /** An engine whose "encoded" chunks are plain text (identity decoder). */
  function makeEngine(workflows: Workflow[]): OutputTriggerEngine {
    const engine = new OutputTriggerEngine({ resolveSession, fire, now: () => now, decode });
    engine.setWorkflows(workflows);
    return engine;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    fire = vi.fn<OutputTriggerDeps["fire"]>(() => true);
    resolveSession = vi.fn<OutputTriggerDeps["resolveSession"]>((sid) =>
      sid === "sess-1" ? { tabId: "tab-1", connectionId: "conn-1" } : null
    );
    decode = vi.fn<NonNullable<OutputTriggerDeps["decode"]>>((chunk) => chunk);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires on a match after the batch window, not synchronously", () => {
    const engine = makeEngine([wf("wf-a", [match("ready")])]);
    engine.enqueue("sess-1", "server ready\n");
    // The tap does no decoding or matching itself.
    expect(decode).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(OUTPUT_TRIGGER_LIMITS.batchMs);
    expect(fire).toHaveBeenCalledWith("wf-a", "tab-1", "sess-1");
  });

  it("does not fire when the output does not match", () => {
    const engine = makeEngine([wf("wf-a", [match("ready")])]);
    engine.enqueue("sess-1", "still booting\n");
    engine.flush();
    expect(fire).not.toHaveBeenCalled();
  });

  it("does not fire for a session of an unbound connection", () => {
    const engine = makeEngine([wf("wf-a", [match("ready")])]);
    engine.enqueue("sess-other", "ready\n");
    engine.flush();
    expect(fire).not.toHaveBeenCalled();
  });

  it("matches the ANSI-stripped text and a regex", () => {
    const engine = makeEngine([wf("wf-a", [match("^ERROR: \\d+", { isRegex: true })])]);
    engine.enqueue("sess-1", "\u001b[1;31mERROR\u001b[0m: 42");
    engine.flush();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("matches across two batches", () => {
    const engine = makeEngine([wf("wf-a", [match("connection lost")])]);
    engine.enqueue("sess-1", "... connec");
    engine.flush();
    engine.enqueue("sess-1", "tion lost");
    engine.flush();
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("respects the cooldown and never re-fires on already-matched text", () => {
    const engine = makeEngine([wf("wf-a", [match("ERR", { cooldownMs: 5_000 })])]);
    engine.enqueue("sess-1", "ERR");
    engine.flush();
    now += 1_000;
    engine.enqueue("sess-1", "ERR again");
    engine.flush();
    expect(fire).toHaveBeenCalledTimes(1);
    // Cooldown over, but only unrelated output arrives: the old match is consumed.
    now += 10_000;
    engine.enqueue("sess-1", "fine");
    engine.flush();
    expect(fire).toHaveBeenCalledTimes(1);
    engine.enqueue("sess-1", "ERR");
    engine.flush();
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("stops at the max fires per session, per session", () => {
    const engine = makeEngine([wf("wf-a", [match("ERR", { maxFiresPerSession: 2 })])]);
    for (let i = 0; i < 5; i++) {
      engine.enqueue("sess-1", "ERR");
      engine.flush();
      now += OUTPUT_TRIGGER_LIMITS.defaultCooldownMs;
    }
    expect(fire).toHaveBeenCalledTimes(2);
    // A new session (after the old one is forgotten) starts from zero.
    engine.forgetSession("sess-1");
    engine.enqueue("sess-1", "ERR");
    engine.flush();
    expect(fire).toHaveBeenCalledTimes(3);
  });

  it("does not count a refused launch towards the limit, but applies the cooldown", () => {
    fire.mockReturnValueOnce(false);
    const engine = makeEngine([wf("wf-a", [match("ERR", { maxFiresPerSession: 1 })])]);
    engine.enqueue("sess-1", "ERR");
    engine.flush();
    engine.enqueue("sess-1", "ERR");
    engine.flush();
    expect(fire).toHaveBeenCalledTimes(1);
    now += OUTPUT_TRIGGER_LIMITS.defaultCooldownMs;
    engine.enqueue("sess-1", "ERR");
    engine.flush();
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it("bounds pending output, keeping the newest", () => {
    const engine = makeEngine([wf("wf-a", [match("TAIL")])]);
    const big = "x".repeat(OUTPUT_TRIGGER_LIMITS.maxPendingChars);
    engine.enqueue("sess-1", big);
    engine.enqueue("sess-1", big);
    engine.enqueue("sess-1", "TAIL");
    engine.flush();
    // The oldest oversized chunks were dropped before decoding.
    expect(decode.mock.calls.length).toBeLessThanOrEqual(2);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it("is inactive and ignores output without valid triggers", () => {
    const engine = makeEngine([wf("wf-a", [{ kind: "manual" }])]);
    expect(engine.active).toBe(false);
    engine.enqueue("sess-1", "anything");
    vi.advanceTimersByTime(OUTPUT_TRIGGER_LIMITS.batchMs * 2);
    expect(decode).not.toHaveBeenCalled();
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it("decodes base64 chunks by default", () => {
    const engine = new OutputTriggerEngine({ resolveSession, fire, now: () => now });
    engine.setWorkflows([wf("wf-a", [match("héllo")])]);
    const bytes = new TextEncoder().encode("say héllo");
    engine.enqueue("sess-1", btoa(String.fromCharCode(...bytes)));
    engine.flush();
    expect(fire).toHaveBeenCalledTimes(1);
  });
});
