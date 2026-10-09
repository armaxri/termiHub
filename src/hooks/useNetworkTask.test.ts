import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  useNetworkTask,
  type NetworkTaskContext,
  type UseNetworkTaskOptions,
} from "./useNetworkTask";

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

function Harness({
  opts,
  onResult,
}: {
  opts: UseNetworkTaskOptions;
  onResult: (r: ReturnType<typeof useNetworkTask>) => void;
}) {
  onResult(useNetworkTask(opts));
  return null;
}

describe("useNetworkTask", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useNetworkTask>;

  /** Render the hook; returns the captured subscribe context + the unlisten mock. */
  function mount(overrides: Partial<UseNetworkTaskOptions> = {}) {
    const unlisten = vi.fn();
    let ctx: NetworkTaskContext | null = null;
    const opts: UseNetworkTaskOptions = {
      start: vi.fn(() => Promise.resolve("task-1")),
      cancel: vi.fn(() => Promise.resolve()),
      subscribe: vi.fn(async (c: NetworkTaskContext) => {
        ctx = c;
        c.register(unlisten);
      }),
      logScope: "test",
      ...overrides,
    };
    act(() => {
      root.render(createElement(Harness, { opts, onResult: (r) => (latest = r) }));
    });
    return { opts, unlisten, getCtx: () => ctx! };
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("starts idle", () => {
    mount();
    expect(latest.status).toBe("idle");
    expect(latest.error).toBeNull();
  });

  it("subscribes before starting and goes running", async () => {
    const { opts } = mount();
    await act(async () => {
      await latest.run();
    });
    expect(opts.subscribe).toHaveBeenCalledTimes(1);
    expect(opts.start).toHaveBeenCalledTimes(1);
    // subscribe must be registered before start so no early event is missed.
    expect(vi.mocked(opts.subscribe).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(opts.start).mock.invocationCallOrder[0]
    );
    expect(latest.status).toBe("running");
  });

  it("calls onReset on each run", async () => {
    const onReset = vi.fn();
    mount({ onReset });
    await act(async () => {
      await latest.run();
    });
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("accepts events before the task id resolves, then filters by id", async () => {
    // A deferred start keeps taskIdRef null mid-run; resolve it inside the same
    // act() so no promise dangles across the act boundary.
    let resolveStart: (id: string) => void = () => {};
    const start = vi.fn(() => new Promise<string>((r) => (resolveStart = r)));
    const { getCtx } = mount({ start });
    await act(async () => {
      const runPromise = latest.run();
      await Promise.resolve(); // let subscribe() run so ctx is captured
      // Before the id is known, any id is accepted.
      expect(getCtx().matchesTask("anything")).toBe(true);
      resolveStart("task-1");
      await runPromise;
    });
    // Once known, only the matching id is accepted.
    expect(getCtx().matchesTask("task-1")).toBe(true);
    expect(getCtx().matchesTask("other")).toBe(false);
  });

  it("finish('completed') sets status and tears down listeners", async () => {
    const { getCtx, unlisten } = mount();
    await act(async () => {
      await latest.run();
    });
    act(() => getCtx().finish("completed"));
    expect(latest.status).toBe("completed");
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("finish('error', msg) sets error and tears down", async () => {
    const { getCtx, unlisten } = mount();
    await act(async () => {
      await latest.run();
    });
    act(() => getCtx().finish("error", "boom"));
    expect(latest.status).toBe("error");
    expect(latest.error).toBe("boom");
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("stop cancels the task, reports canceled, and tears down", async () => {
    const { opts, unlisten } = mount();
    await act(async () => {
      await latest.run();
    });
    await act(async () => {
      await latest.stop();
    });
    expect(opts.cancel).toHaveBeenCalledWith("task-1");
    expect(latest.status).toBe("canceled");
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("stop is a no-op when nothing is running", async () => {
    const { opts } = mount();
    await act(async () => {
      await latest.stop();
    });
    expect(opts.cancel).not.toHaveBeenCalled();
  });

  it("surfaces a start failure as an error and tears down", async () => {
    const start = vi.fn(() => Promise.reject(new Error("nope")));
    const { unlisten } = mount({ start });
    await act(async () => {
      await latest.run();
    });
    expect(latest.status).toBe("error");
    expect(latest.error).toContain("nope");
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight task on unmount", async () => {
    const { opts } = mount();
    await act(async () => {
      await latest.run();
    });
    act(() => root.unmount());
    expect(opts.cancel).toHaveBeenCalledWith("task-1");
  });
  // FES2-006 (#4375): a run whose start() resolves after the hook unmounted must
  // cancel the task it started, since nothing else is left to cancel it.
  it("cancels a task whose start resolves after unmount", async () => {
    let resolveStart: (id: string) => void = () => {};
    const start = vi.fn(() => new Promise<string>((r) => (resolveStart = r)));
    const { opts } = mount({ start });
    let runPromise: Promise<void> = Promise.resolve();
    await act(async () => {
      runPromise = latest.run();
      await Promise.resolve();
    });
    act(() => root.unmount());
    expect(opts.cancel).not.toHaveBeenCalled();
    resolveStart("late-task");
    await runPromise;
    expect(opts.cancel).toHaveBeenCalledWith("late-task");
  });

  it("tears down a listener registered after unmount", async () => {
    const lateUnlisten = vi.fn();
    let resolveSubscribe: () => void = () => {};
    const subscribe = vi.fn(
      (c: NetworkTaskContext) =>
        new Promise<void>((r) => {
          resolveSubscribe = () => {
            c.register(lateUnlisten);
            r();
          };
        })
    );
    const { opts } = mount({ subscribe });
    let runPromise: Promise<void> = Promise.resolve();
    await act(async () => {
      runPromise = latest.run();
      await Promise.resolve();
    });
    act(() => root.unmount());
    resolveSubscribe();
    await runPromise;
    expect(lateUnlisten).toHaveBeenCalledTimes(1);
    // The run was abandoned before start, so no backend task was launched.
    expect(opts.start).not.toHaveBeenCalled();
  });

  it("cancels a superseded run's task when a newer run started first", async () => {
    const resolvers: Array<(id: string) => void> = [];
    const start = vi.fn(() => new Promise<string>((r) => resolvers.push(r)));
    const { opts } = mount({ start });
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      first = latest.run();
      await Promise.resolve();
      await Promise.resolve();
      second = latest.run();
      await Promise.resolve();
      await Promise.resolve();
      resolvers[0]("old-task");
      await first;
      resolvers[1]("new-task");
      await second;
    });
    expect(opts.cancel).toHaveBeenCalledWith("old-task");
    expect(opts.cancel).not.toHaveBeenCalledWith("new-task");
    // The newer run owns the task id: stop cancels it, not the superseded one.
    vi.mocked(opts.cancel).mockClear();
    await act(async () => {
      await latest.stop();
    });
    expect(opts.cancel).toHaveBeenCalledWith("new-task");
  });

  it("does not re-arm the task id when the run finished before start resolved", async () => {
    let resolveStart: (id: string) => void = () => {};
    const start = vi.fn(() => new Promise<string>((r) => (resolveStart = r)));
    const { opts, getCtx } = mount({ start });
    await act(async () => {
      const runPromise = latest.run();
      await Promise.resolve();
      getCtx().finish("completed");
      resolveStart("done-task");
      await runPromise;
    });
    expect(latest.status).toBe("completed");
    await act(async () => {
      await latest.stop();
    });
    // stop() is a no-op: the finished task's id was never stored.
    expect(opts.cancel).not.toHaveBeenCalled();
  });
});
