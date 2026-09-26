/**
 * Unit tests for the concurrent fan-out helpers (#3418): the bounded worker
 * pool, the concurrency clamp, and the per-target progress line.
 */
import { describe, it, expect } from "vitest";

import {
  WORKFLOW_FANOUT_CONCURRENCY,
  clampFanoutConcurrency,
  describeFanoutProgress,
  runWithConcurrency,
} from "./workflowFanout";

/** A deferred promise a test resolves by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("runWithConcurrency", () => {
  it("never runs more than `limit` workers at once and returns results by index", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const results = await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return n * 10;
    });
    expect(maxInFlight).toBe(3);
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it("starts the next item as soon as a slot frees, in order", async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const started: number[] = [];
    const run = runWithConcurrency([0, 1, 2], 2, async (i) => {
      started.push(i);
      await gates[i].promise;
      return i;
    });
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    gates[1].resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(started).toEqual([0, 1, 2]);
    gates[0].resolve();
    gates[2].resolve();
    await expect(run).resolves.toEqual([0, 1, 2]);
  });

  it("starts nothing further once shouldStop() is true; unstarted items are undefined", async () => {
    let stop = false;
    const results = await runWithConcurrency(
      [0, 1, 2, 3],
      1,
      async (i) => {
        if (i === 1) stop = true;
        return i;
      },
      () => stop
    );
    expect(results).toEqual([0, 1, undefined, undefined]);
  });

  it("keeps going when one worker rejects", async () => {
    const results = await runWithConcurrency([0, 1, 2], 2, async (i) => {
      if (i === 1) throw new Error("boom");
      return i;
    });
    expect(results).toEqual([0, undefined, 2]);
  });

  it("handles an empty item list", async () => {
    await expect(runWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });
});

describe("clampFanoutConcurrency", () => {
  it("defaults to the cap and clamps into 1..cap", () => {
    expect(clampFanoutConcurrency(undefined)).toBe(WORKFLOW_FANOUT_CONCURRENCY);
    expect(clampFanoutConcurrency(0)).toBe(1);
    expect(clampFanoutConcurrency(-3)).toBe(1);
    expect(clampFanoutConcurrency(2.7)).toBe(2);
    expect(clampFanoutConcurrency(1000)).toBe(WORKFLOW_FANOUT_CONCURRENCY);
    expect(clampFanoutConcurrency(Number.NaN)).toBe(WORKFLOW_FANOUT_CONCURRENCY);
  });
});

describe("describeFanoutProgress", () => {
  it("summarises per-target statuses, omitting zero counts", () => {
    expect(
      describeFanoutProgress([
        "running",
        "queued",
        "completed",
        "completed",
        "failed",
        "cancelled",
        "running",
      ])
    ).toBe("2 running · 1 queued · 2 done · 1 failed · 1 cancelled");
    expect(describeFanoutProgress(["queued", "queued"])).toBe("2 queued");
    expect(describeFanoutProgress([])).toBe("");
  });
});
