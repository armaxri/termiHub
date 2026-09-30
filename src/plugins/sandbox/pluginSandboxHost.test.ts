/**
 * Tests for the plugin sandbox host (#2136): worker lifecycle (create-on-first /
 * dispose-on-last), the ordered asynchronous transform pipeline (per-session
 * FIFO drain under out-of-order results, byte-exact pass-through), backpressure
 * and the head-of-line watchdog, and the widget descriptor relay into the store.
 *
 * The real Worker is replaced by a fake so the test can drive both directions of
 * the protocol deterministically.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { HostToWorkerMessage, WorkerToHostMessage } from "./protocol";
import {
  loadPluginInSandbox,
  unloadPluginFromSandbox,
  sandboxLoadedCount,
  sandboxHasParsers,
  sandboxSessionPending,
  enqueueSandboxTransform,
  discardSandboxSession,
  __setSandboxWorkerFactory,
  __resetSandboxHost,
} from "./pluginSandboxHost";
import { getStatusBarWidgets, clearStatusBarWidgets } from "./statusBarWidgetStore";
import { frontendLog } from "@/utils/frontendLog";

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), onFrontendLog: vi.fn() }));

const mockedFrontendLog = vi.mocked(frontendLog);

/** A fake Worker capturing host→worker posts and dispatching worker→host messages. */
class FakeWorker {
  posted: HostToWorkerMessage[] = [];
  terminated = false;
  private handler: ((e: MessageEvent<WorkerToHostMessage>) => void) | null = null;
  private errorHandler: ((e: ErrorEvent) => void) | null = null;
  private messageErrorHandler: ((e: MessageEvent) => void) | null = null;

  addEventListener(type: "message", handler: (e: MessageEvent<WorkerToHostMessage>) => void): void;
  addEventListener(type: "error", handler: (e: ErrorEvent) => void): void;
  addEventListener(type: "messageerror", handler: (e: MessageEvent) => void): void;
  addEventListener(type: string, handler: (e: never) => void): void {
    if (type === "message")
      this.handler = handler as (e: MessageEvent<WorkerToHostMessage>) => void;
    else if (type === "error") this.errorHandler = handler as (e: ErrorEvent) => void;
    else if (type === "messageerror")
      this.messageErrorHandler = handler as (e: MessageEvent) => void;
  }
  postMessage(message: HostToWorkerMessage) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** Simulate a message from the worker. */
  emit(message: WorkerToHostMessage) {
    this.handler?.({ data: message } as MessageEvent<WorkerToHostMessage>);
  }
  /** Simulate an uncaught error in the worker. */
  emitError(message = "boom", filename = "") {
    this.errorHandler?.({ message, filename } as ErrorEvent);
  }
  /** Simulate an undeserializable message from the worker. */
  emitMessageError() {
    this.messageErrorHandler?.({} as MessageEvent);
  }
  postsOfType<T extends HostToWorkerMessage["t"]>(t: T) {
    return this.posted.filter((m) => m.t === t) as Extract<HostToWorkerMessage, { t: T }>[];
  }
}

let fake: FakeWorker;

beforeEach(() => {
  __resetSandboxHost();
  clearStatusBarWidgets();
  fake = new FakeWorker();
  __setSandboxWorkerFactory(() => fake as unknown as Worker);
});

afterEach(() => {
  __resetSandboxHost();
  __setSandboxWorkerFactory(null);
});

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("worker lifecycle", () => {
  it("creates the worker on first load and posts the entry URLs", () => {
    loadPluginInSandbox("p", ["plugin://localhost/load/p/frontend/index.js"]);
    expect(sandboxLoadedCount()).toBe(1);
    expect(fake.postsOfType("load")).toEqual([
      { t: "load", pluginId: "p", entryUrls: ["plugin://localhost/load/p/frontend/index.js"] },
    ]);
  });

  it("terminates the worker once the last plugin unloads", () => {
    loadPluginInSandbox("p", ["/*a*/"]);
    loadPluginInSandbox("q", ["/*b*/"]);
    unloadPluginFromSandbox("p");
    expect(fake.terminated).toBe(false);
    unloadPluginFromSandbox("q");
    expect(sandboxLoadedCount()).toBe(0);
    expect(fake.terminated).toBe(true);
  });
});

describe("parsers-active fast-path mirror", () => {
  it("tracks the worker's parsersActive signal", () => {
    loadPluginInSandbox("p", ["/*a*/"]);
    expect(sandboxHasParsers()).toBe(false);
    fake.emit({ t: "parsersActive", active: true });
    expect(sandboxHasParsers()).toBe(true);
    fake.emit({ t: "parsersActive", active: false });
    expect(sandboxHasParsers()).toBe(false);
  });
});

describe("ordered transform pipeline", () => {
  beforeEach(() => {
    loadPluginInSandbox("p", ["/*a*/"]);
    fake.emit({ t: "parsersActive", active: true });
  });

  it("posts a transform request and emits the transformed bytes", () => {
    const out: string[] = [];
    enqueueSandboxTransform("s1", enc("hello"), (b) => out.push(dec(b)));
    const req = fake.postsOfType("transform")[0];
    expect(req.sessionId).toBe("s1");
    fake.emit({ t: "transformResult", seq: req.seq, changed: true, bytes: enc("HELLO") });
    expect(out).toEqual(["HELLO"]);
  });

  it("emits the exact original bytes on pass-through (changed:false)", () => {
    const original = enc("unchanged");
    let received: Uint8Array | null = null;
    enqueueSandboxTransform("s1", original, (b) => (received = b));
    const req = fake.postsOfType("transform")[0];
    fake.emit({ t: "transformResult", seq: req.seq, changed: false });
    expect(received).toBe(original); // same reference — byte-exact, no re-encode
  });

  it("drains in arrival order even when results arrive out of order", () => {
    const out: string[] = [];
    enqueueSandboxTransform("s1", enc("A"), (b) => out.push(dec(b)));
    enqueueSandboxTransform("s1", enc("B"), (b) => out.push(dec(b)));
    const [reqA, reqB] = fake.postsOfType("transform");

    // Resolve B first: nothing drains yet because A (the head) is still pending.
    fake.emit({ t: "transformResult", seq: reqB.seq, changed: true, bytes: enc("b") });
    expect(out).toEqual([]);
    // Resolve A: now A then B drain together, in order.
    fake.emit({ t: "transformResult", seq: reqA.seq, changed: true, bytes: enc("a") });
    expect(out).toEqual(["a", "b"]);
  });

  it("keeps two sessions independent", () => {
    const s1: string[] = [];
    const s2: string[] = [];
    enqueueSandboxTransform("s1", enc("1"), (b) => s1.push(dec(b)));
    enqueueSandboxTransform("s2", enc("2"), (b) => s2.push(dec(b)));
    const req1 = fake.postsOfType("transform").find((r) => r.sessionId === "s1")!;
    const req2 = fake.postsOfType("transform").find((r) => r.sessionId === "s2")!;
    fake.emit({ t: "transformResult", seq: req2.seq, changed: false });
    fake.emit({ t: "transformResult", seq: req1.seq, changed: false });
    expect(s1).toEqual(["1"]);
    expect(s2).toEqual(["2"]);
  });

  it("marks a session pending until its slots drain", () => {
    enqueueSandboxTransform("s1", enc("x"), () => {});
    expect(sandboxSessionPending("s1")).toBe(true);
    const req = fake.postsOfType("transform")[0];
    fake.emit({ t: "transformResult", seq: req.seq, changed: false });
    expect(sandboxSessionPending("s1")).toBe(false);
  });

  it("discards a session's in-flight slots on teardown", () => {
    const out: string[] = [];
    enqueueSandboxTransform("s1", enc("x"), (b) => out.push(dec(b)));
    const req = fake.postsOfType("transform")[0];
    discardSandboxSession("s1");
    // A late result for a discarded session is ignored.
    fake.emit({ t: "transformResult", seq: req.seq, changed: false });
    expect(out).toEqual([]);
    expect(sandboxSessionPending("s1")).toBe(false);
  });
});

describe("head-of-line watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadPluginInSandbox("p", ["/*a*/"]);
    fake.emit({ t: "parsersActive", active: true });
  });
  afterEach(() => vi.useRealTimers());

  it("force-passes a stuck head chunk after the timeout", () => {
    const out: string[] = [];
    const original = enc("stuck");
    enqueueSandboxTransform("s1", original, (b) => out.push(dec(b)));
    expect(out).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(out).toEqual(["stuck"]); // passed through untransformed
  });
});

describe("watchdog oldest-pending computation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadPluginInSandbox("p", ["/*a*/"]);
    fake.emit({ t: "parsersActive", active: true });
  });
  afterEach(() => vi.useRealTimers());

  it("force-passes the oldest pending chunk without throwing on a huge backlog", () => {
    // `Math.min(...pending.keys())` spreads every in-flight seq into a call and
    // throws `RangeError: Maximum call stack size exceeded` past ~125k args in
    // V8 — inside the watchdog, the mechanism meant to keep the terminal flowing.
    // A running-min iteration finds the same oldest seq but can never throw.
    const out: string[] = [];
    // seq 0 — the oldest pending slot; must be the one the watchdog force-passes.
    enqueueSandboxTransform("s0", enc("OLDEST"), (b) => out.push(dec(b)));

    // Pile up a backlog far larger than the spread limit, spread across many
    // sessions so no single session trips the per-session cap (they stay pending).
    const filler = new Uint8Array(1);
    const noop = () => {};
    for (let s = 1; s <= 150; s++) {
      const id = `s${s}`;
      for (let i = 0; i < 1000; i++) enqueueSandboxTransform(id, filler, noop);
    }

    // Firing the watchdog must not throw, and must force the oldest slot through.
    expect(() => vi.advanceTimersByTime(600)).not.toThrow();
    expect(out).toEqual(["OLDEST"]);
  });
});

describe("worker error handling", () => {
  beforeEach(() => {
    loadPluginInSandbox("p", ["/*a*/"]);
    fake.emit({ t: "parsersActive", active: true });
    mockedFrontendLog.mockClear();
  });

  it("force-drains outstanding slots and logs on a worker error", () => {
    const s1: string[] = [];
    const s2: string[] = [];
    enqueueSandboxTransform("s1", enc("one"), (b) => s1.push(dec(b)));
    enqueueSandboxTransform("s2", enc("two"), (b) => s2.push(dec(b)));
    expect(sandboxSessionPending("s1")).toBe(true);
    expect(sandboxSessionPending("s2")).toBe(true);

    fake.emitError("kaboom");

    // Every outstanding slot is force-passed untransformed so nothing hangs.
    expect(s1).toEqual(["one"]);
    expect(s2).toEqual(["two"]);
    expect(sandboxSessionPending("s1")).toBe(false);
    expect(sandboxSessionPending("s2")).toBe(false);
    // Surfaced to the LogViewer (never console.*).
    expect(mockedFrontendLog).toHaveBeenCalledWith(
      "plugin_sandbox",
      expect.stringContaining("kaboom")
    );
  });

  it("degrades: chunks after a worker error pass straight through", () => {
    enqueueSandboxTransform("s1", enc("before"), () => {});
    fake.emitError();
    const postsBefore = fake.postsOfType("transform").length;

    const out: string[] = [];
    enqueueSandboxTransform("s1", enc("after"), (b) => out.push(dec(b)));
    // No new worker round-trip; the chunk is passed through immediately, in order.
    expect(fake.postsOfType("transform").length).toBe(postsBefore);
    expect(out).toEqual(["after"]);
  });

  it("also drains and logs on a messageerror", () => {
    const out: string[] = [];
    enqueueSandboxTransform("s1", enc("x"), (b) => out.push(dec(b)));
    fake.emitMessageError();
    expect(out).toEqual(["x"]);
    expect(mockedFrontendLog).toHaveBeenCalledWith(
      "plugin_sandbox",
      expect.stringContaining("messageerror")
    );
  });

  it("tears down a repeatedly-crashing worker and falls back to the fast path", () => {
    expect(sandboxHasParsers()).toBe(true);
    fake.emitError();
    fake.emitError();
    expect(fake.terminated).toBe(false); // still recoverable
    fake.emitError();
    // After the crash threshold the worker is torn down; the terminal reverts to
    // the synchronous fast path (sandboxHasParsers() → false).
    expect(fake.terminated).toBe(true);
    expect(sandboxHasParsers()).toBe(false);
  });

  it("resets the crash counter once the worker makes progress again", () => {
    enqueueSandboxTransform("s1", enc("y"), () => {});
    const transforms = fake.postsOfType("transform");
    const req = transforms[transforms.length - 1];
    fake.emitError();
    fake.emitError();
    // A transform result (any reply) proves the worker recovered → reset the count.
    fake.emit({ t: "transformResult", seq: req.seq, changed: false });
    // Two fresh errors must not trip the (3-strike) teardown now.
    fake.emitError();
    fake.emitError();
    expect(fake.terminated).toBe(false);
    expect(sandboxHasParsers()).toBe(true);
  });
});

describe("crash-teardown recovery (#2857)", () => {
  /** Every worker the factory has built, oldest first. */
  let workers: FakeWorker[];
  const latest = () => workers[workers.length - 1];
  const url = (id: string) => `plugin://localhost/load/${id}/frontend/index.js`;
  /** Crash the current worker enough times in a row to trip the teardown. */
  const crashOut = (filename = "") => {
    const w = latest();
    for (let i = 0; i < 3; i++) w.emitError(`boom ${i}`, filename);
  };
  const logged = () => mockedFrontendLog.mock.calls.map((c) => String(c[1]));

  beforeEach(() => {
    vi.useFakeTimers();
    workers = [];
    __setSandboxWorkerFactory(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w as unknown as Worker;
    });
    loadPluginInSandbox("a", [url("a")]);
    loadPluginInSandbox("b", [url("b")]);
    latest().emit({ t: "parsersActive", active: true });
    mockedFrontendLog.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("rebuilds a fresh worker after a backoff and reloads every plugin", () => {
    crashOut();
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(true);

    vi.advanceTimersByTime(999);
    expect(workers).toHaveLength(1); // still backing off
    vi.advanceTimersByTime(1);
    expect(workers).toHaveLength(2);
    expect(latest().postsOfType("load")).toEqual([
      { t: "load", pluginId: "a", entryUrls: [url("a")] },
      { t: "load", pluginId: "b", entryUrls: [url("b")] },
    ]);
    expect(sandboxLoadedCount()).toBe(2);
    expect(logged().some((m) => m.includes("Rebuilding"))).toBe(true);
    // Parsers come back once the fresh worker reports them.
    latest().emit({ t: "parsersActive", active: true });
    expect(sandboxHasParsers()).toBe(true);
  });

  it("keeps the terminal on the synchronous fast path while the worker is rebuilt", () => {
    crashOut();
    expect(sandboxHasParsers()).toBe(false);
    // Even a straggling enqueue passes through synchronously, byte-exact, without
    // spawning a worker ahead of the backoff.
    const original = enc("live");
    let received: Uint8Array | null = null;
    enqueueSandboxTransform("s1", original, (b) => (received = b));
    expect(received).toBe(original);
    expect(sandboxSessionPending("s1")).toBe(false);
    expect(workers).toHaveLength(1);

    // After the rebuild the fresh worker has no parsers until it says so.
    vi.advanceTimersByTime(1000);
    expect(workers).toHaveLength(2);
    expect(sandboxHasParsers()).toBe(false);
  });

  it("backs off exponentially between successive rebuilds", () => {
    crashOut();
    vi.advanceTimersByTime(1000);
    expect(workers).toHaveLength(2);
    crashOut();
    vi.advanceTimersByTime(1999);
    expect(workers).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(workers).toHaveLength(3);
    crashOut();
    vi.advanceTimersByTime(3999);
    expect(workers).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(workers).toHaveLength(4);
  });

  it("stops rebuilding after a bounded number of attempts (no crash loop)", () => {
    for (let i = 0; i < 10; i++) {
      crashOut();
      vi.advanceTimersByTime(60_000);
    }
    // One original worker + three bounded rebuilds, then it stays degraded.
    expect(workers).toHaveLength(4);
    expect(workers.every((w) => w.terminated)).toBe(true);
    expect(sandboxHasParsers()).toBe(false);
    const giveUp = logged().find((m) => m.includes("giving up"));
    expect(giveUp).toBeDefined();
    // No attribution was possible, so every loaded plugin is named as a suspect.
    expect(giveUp).toContain('"a"');
    expect(giveUp).toContain('"b"');
    // The terminal still flows untransformed.
    const out: string[] = [];
    enqueueSandboxTransform("s1", enc("still"), (b) => out.push(dec(b)));
    expect(out).toEqual(["still"]);
  });

  it("disables only the plugin a crash is attributed to and reloads the rest", () => {
    crashOut(url("b"));
    expect(logged().some((m) => m.includes('"b"') && m.includes("disabled"))).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(workers).toHaveLength(2);
    expect(
      latest()
        .postsOfType("load")
        .map((m) => m.pluginId)
    ).toEqual(["a"]);
    // The quarantined plugin stays tracked (so it can still be unloaded).
    expect(sandboxLoadedCount()).toBe(2);
  });

  it("attributes a crash on the Windows plugin origin too", () => {
    crashOut("http://plugin.localhost/load/b/frontend/index.js");
    vi.advanceTimersByTime(1000);
    expect(
      latest()
        .postsOfType("load")
        .map((m) => m.pluginId)
    ).toEqual(["a"]);
  });

  it("does not rebuild when every loaded plugin was quarantined", () => {
    unloadPluginFromSandbox("a");
    crashOut(url("b"));
    vi.advanceTimersByTime(60_000);
    expect(workers).toHaveLength(1);
    expect(sandboxHasParsers()).toBe(false);
  });

  it("re-enables a quarantined plugin on an explicit unload + reload", () => {
    crashOut(url("b"));
    vi.advanceTimersByTime(1000);
    unloadPluginFromSandbox("b");
    expect(sandboxLoadedCount()).toBe(1);
    loadPluginInSandbox("b", [url("b")]);
    expect(
      latest()
        .postsOfType("load")
        .map((m) => m.pluginId)
    ).toEqual(["a", "b"]);
  });

  it("resets the rebuild budget once a rebuilt worker stays healthy", () => {
    // Burn two rebuilds, then let the third worker run stably for a while.
    crashOut();
    vi.advanceTimersByTime(1000);
    crashOut();
    vi.advanceTimersByTime(2000);
    expect(workers).toHaveLength(3);
    vi.advanceTimersByTime(60_000); // stability window elapses
    // A fresh crash starts again from the first (1s) backoff step.
    crashOut();
    vi.advanceTimersByTime(1000);
    expect(workers).toHaveLength(4);
  });

  it("cancels a pending rebuild when the last plugin unloads", () => {
    crashOut();
    unloadPluginFromSandbox("a");
    unloadPluginFromSandbox("b");
    expect(sandboxLoadedCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(workers).toHaveLength(1);
  });

  it("an explicit load during the backoff rebuilds immediately with every plugin", () => {
    crashOut();
    loadPluginInSandbox("c", [url("c")]);
    expect(workers).toHaveLength(2);
    expect(
      latest()
        .postsOfType("load")
        .map((m) => m.pluginId)
    ).toEqual(["a", "b", "c"]);
    // The cancelled backoff timer must not build yet another worker.
    vi.advanceTimersByTime(60_000);
    expect(workers).toHaveLength(2);
  });

  it("after giving up, an explicit load retries and a stable worker refills the budget", () => {
    for (let i = 0; i < 4; i++) {
      crashOut();
      vi.advanceTimersByTime(60_000);
    }
    expect(workers).toHaveLength(4); // gave up
    loadPluginInSandbox("c", [url("c")]);
    expect(workers).toHaveLength(5);
    vi.advanceTimersByTime(60_000); // stays up → healed
    crashOut();
    vi.advanceTimersByTime(1000); // back to the first backoff step
    expect(workers).toHaveLength(6);
  });

  it("clears the dead worker's widgets so the reload re-materialises them", () => {
    latest().emit({
      t: "widgetUpsert",
      key: "b:w",
      position: "left",
      widgetId: "w",
      node: { tag: "span", text: "x" },
    });
    expect(getStatusBarWidgets("left")).toHaveLength(1);
    crashOut(url("b"));
    expect(getStatusBarWidgets("left")).toHaveLength(0);
  });
});

describe("widget descriptor relay", () => {
  it("materialises upserts into the store and removes on remove", () => {
    loadPluginInSandbox("p", ["/*a*/"]);
    fake.emit({
      t: "widgetUpsert",
      key: "p:cpu",
      position: "left",
      widgetId: "cpu",
      node: { tag: "span", text: "42%" },
    });
    expect(getStatusBarWidgets("left").map((e) => e.key)).toEqual(["p:cpu"]);
    fake.emit({ t: "widgetRemove", key: "p:cpu" });
    expect(getStatusBarWidgets("left")).toHaveLength(0);
  });
});
