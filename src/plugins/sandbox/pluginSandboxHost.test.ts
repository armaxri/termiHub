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

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), onFrontendLog: vi.fn() }));

/** A fake Worker capturing host→worker posts and dispatching worker→host messages. */
class FakeWorker {
  posted: HostToWorkerMessage[] = [];
  terminated = false;
  private handler: ((e: MessageEvent<WorkerToHostMessage>) => void) | null = null;

  addEventListener(_type: "message", handler: (e: MessageEvent<WorkerToHostMessage>) => void) {
    this.handler = handler;
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
