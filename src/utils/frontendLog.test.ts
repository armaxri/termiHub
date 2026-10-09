import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LogEntry } from "@/types/terminal";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

const invokeMock = vi.mocked(invoke);

// Each test that exercises the startup buffer uses vi.resetModules() + dynamic
// import so the module-level `startupBuffer` and `listeners` arrays start fresh.

describe("frontendLog", () => {
  describe("listener-based delivery (no buffer)", () => {
    it("calls a registered listener immediately with the emitted entry", async () => {
      vi.resetModules();
      const { frontendLog, onFrontendLog } = await import("./frontendLog");

      const received: LogEntry[] = [];
      const unsub = onFrontendLog((e) => received.push(e));

      frontendLog("test_module", "hello world");

      expect(received).toHaveLength(1);
      expect(received[0].level).toBe("DEBUG");
      expect(received[0].target).toBe("frontend::test_module");
      expect(received[0].message).toBe("hello world");
      expect(received[0].timestamp).toBeTruthy();
      unsub();
    });

    it("delivers to multiple listeners", async () => {
      vi.resetModules();
      const { frontendLog, onFrontendLog } = await import("./frontendLog");

      const a: LogEntry[] = [];
      const b: LogEntry[] = [];
      const unsubA = onFrontendLog((e) => a.push(e));
      const unsubB = onFrontendLog((e) => b.push(e));

      frontendLog("mod", "msg");

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
      unsubA();
      unsubB();
    });

    it("stops delivering to a listener after unsubscribe", async () => {
      vi.resetModules();
      const { frontendLog, onFrontendLog } = await import("./frontendLog");

      const received: LogEntry[] = [];
      const unsub = onFrontendLog((e) => received.push(e));
      frontendLog("mod", "before");
      unsub();
      frontendLog("mod", "after");

      expect(received).toHaveLength(1);
      expect(received[0].message).toBe("before");
    });
  });

  describe("startup buffer", () => {
    it("buffers entries before any listener registers", async () => {
      vi.resetModules();
      const { frontendLog, onFrontendLog } = await import("./frontendLog");

      frontendLog("early", "buffered entry");

      // No listener yet — entry should be in the buffer, not delivered
      const received: LogEntry[] = [];
      const unsub = onFrontendLog((e) => received.push(e));

      // Flushed to listener on subscribe
      expect(received).toHaveLength(1);
      expect(received[0].message).toBe("buffered entry");
      unsub();
    });

    it("clears the buffer after the first listener flushes it", async () => {
      vi.resetModules();
      const { frontendLog, onFrontendLog } = await import("./frontendLog");

      frontendLog("early", "buffered entry");

      const first: LogEntry[] = [];
      const unsubFirst = onFrontendLog((e) => first.push(e));
      expect(first).toHaveLength(1);
      unsubFirst();

      // A second subscriber should NOT receive the already-flushed buffered entry
      const second: LogEntry[] = [];
      const unsubSecond = onFrontendLog((e) => second.push(e));
      expect(second).toHaveLength(0);
      unsubSecond();
    });

    it("respects the startup buffer limit (500 entries)", async () => {
      vi.resetModules();
      const { frontendLog, onFrontendLog } = await import("./frontendLog");

      for (let i = 0; i < 600; i++) {
        frontendLog("mod", `entry ${i}`);
      }

      const received: LogEntry[] = [];
      const unsub = onFrontendLog((e) => received.push(e));

      expect(received).toHaveLength(500);
      unsub();
    });

    it("delivers buffered entries in order", async () => {
      vi.resetModules();
      const { frontendLog, onFrontendLog } = await import("./frontendLog");

      frontendLog("mod", "first");
      frontendLog("mod", "second");
      frontendLog("mod", "third");

      const received: LogEntry[] = [];
      const unsub = onFrontendLog((e) => received.push(e));

      expect(received.map((e) => e.message)).toEqual(["first", "second", "third"]);
      unsub();
    });
  });

  describe("entry shape", () => {
    it("prefixes target with frontend::", async () => {
      vi.resetModules();
      const { frontendLog, onFrontendLog } = await import("./frontendLog");

      const received: LogEntry[] = [];
      const unsub = onFrontendLog((e) => received.push(e));

      frontendLog("my_component", "test");

      expect(received[0].target).toBe("frontend::my_component");
      expect(received[0].level).toBe("DEBUG");
      unsub();
    });
  });

  describe("log levels", () => {
    it("frontendError emits an ERROR-level entry the LogViewer receives", async () => {
      vi.resetModules();
      const { frontendError, onFrontendLog } = await import("./frontendLog");

      const received: LogEntry[] = [];
      const unsub = onFrontendLog((e) => received.push(e));

      frontendError("mod", "boom");

      expect(received).toHaveLength(1);
      expect(received[0].level).toBe("ERROR");
      expect(received[0].target).toBe("frontend::mod");
      expect(received[0].message).toBe("boom");
      unsub();
    });

    it("frontendWarn emits a WARN-level entry", async () => {
      vi.resetModules();
      const { frontendWarn, onFrontendLog } = await import("./frontendLog");

      const received: LogEntry[] = [];
      const unsub = onFrontendLog((e) => received.push(e));

      frontendWarn("mod", "careful");

      expect(received).toHaveLength(1);
      expect(received[0].level).toBe("WARN");
      unsub();
    });

    it("frontendInfo emits an INFO-level entry", async () => {
      vi.resetModules();
      const { frontendInfo, onFrontendLog } = await import("./frontendLog");

      const received: LogEntry[] = [];
      const unsub = onFrontendLog((e) => received.push(e));

      frontendInfo("mod", "fyi");

      expect(received).toHaveLength(1);
      expect(received[0].level).toBe("INFO");
      unsub();
    });

    it("buffers non-DEBUG levels before a listener subscribes", async () => {
      vi.resetModules();
      const { frontendError, onFrontendLog } = await import("./frontendLog");

      frontendError("early", "buffered error");

      const received: LogEntry[] = [];
      const unsub = onFrontendLog((e) => received.push(e));

      expect(received).toHaveLength(1);
      expect(received[0].level).toBe("ERROR");
      expect(received[0].message).toBe("buffered error");
      unsub();
    });
  });
});

describe("fireAndForget", () => {
  it("logs a rejection at WARN (default) tagged with the reason, without throwing", async () => {
    vi.resetModules();
    const { fireAndForget, onFrontendLog } = await import("./frontendLog");

    const received: LogEntry[] = [];
    const unsub = onFrontendLog((e) => received.push(e));

    expect(() =>
      fireAndForget(Promise.reject(new Error("boom")), "cleanup temp file")
    ).not.toThrow();

    // The rejection is handled on a microtask — let it settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0].level).toBe("WARN");
    expect(received[0].target).toBe("frontend::fire_and_forget");
    expect(received[0].message).toBe("cleanup temp file: boom");
    unsub();
  });

  it("logs at ERROR when the level is 'error' (leak-risk teardown)", async () => {
    vi.resetModules();
    const { fireAndForget, onFrontendLog } = await import("./frontendLog");

    const received: LogEntry[] = [];
    const unsub = onFrontendLog((e) => received.push(e));

    fireAndForget(Promise.reject(new Error("still live")), "close session on teardown", "error");
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toHaveLength(1);
    expect(received[0].level).toBe("ERROR");
    expect(received[0].message).toBe("close session on teardown: still live");
    unsub();
  });

  it("does not log when the promise resolves", async () => {
    vi.resetModules();
    const { fireAndForget, onFrontendLog } = await import("./frontendLog");

    const received: LogEntry[] = [];
    const unsub = onFrontendLog((e) => received.push(e));

    fireAndForget(Promise.resolve("ok"), "should not log");
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toHaveLength(0);
    unsub();
  });
});

describe("durable-log forwarding (OBS-001)", () => {
  // Emulate the Tauri webview so the durability forward is active.
  beforeEach(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    invokeMock.mockClear();
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("forwards ERROR entries to record_frontend_log with the prefix stripped", async () => {
    vi.resetModules();
    const { frontendError } = await import("./frontendLog");

    frontendError("store", "save failed");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("record_frontend_log", {
      level: "ERROR",
      target: "store",
      message: "save failed",
    });
  });

  it("forwards WARN entries", async () => {
    vi.resetModules();
    const { frontendWarn } = await import("./frontendLog");

    frontendWarn("net", "slow response");

    expect(invokeMock).toHaveBeenCalledWith("record_frontend_log", {
      level: "WARN",
      target: "net",
      message: "slow response",
    });
  });

  it("does NOT forward DEBUG or INFO entries", async () => {
    vi.resetModules();
    const { frontendLog, frontendInfo } = await import("./frontendLog");

    frontendLog("mod", "debug detail");
    frontendInfo("mod", "informational");

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("forwards frontendDurableInfo entries at INFO (#4110)", async () => {
    vi.resetModules();
    const { frontendDurableInfo } = await import("./frontendLog");

    frontendDurableInfo("file_drag", "drag start");

    expect(invokeMock).toHaveBeenCalledWith("record_frontend_log", {
      level: "INFO",
      target: "file_drag",
      message: "drag start",
    });
  });

  it("does not throw when the backend invoke rejects", async () => {
    vi.resetModules();
    invokeMock.mockRejectedValueOnce(new Error("ipc down"));
    const { frontendError } = await import("./frontendLog");

    expect(() => frontendError("mod", "boom")).not.toThrow();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

// Restore module registry after all tests in this file
beforeEach(() => {
  vi.clearAllMocks();
});

// #4327 (OBS2-004): the Log Viewer replays the frontend history on mount so it
// never needs the backend's echo of a forwarded WARN/ERROR to show it.
describe("frontendLog history replay (#4327)", () => {
  it("replays every retained entry to a replaying subscriber, even after a flush", async () => {
    vi.resetModules();
    const { frontendLog, frontendWarn, onFrontendLog } = await import("./frontendLog");

    frontendLog("mod", "before any listener");
    const first: LogEntry[] = [];
    const unsubFirst = onFrontendLog((e) => first.push(e));
    frontendWarn("mod", "while first listener is live");
    unsubFirst();

    const replayed: LogEntry[] = [];
    const unsub = onFrontendLog((e) => replayed.push(e), { replayHistory: true });
    expect(replayed.map((e) => e.message)).toEqual([
      "before any listener",
      "while first listener is live",
    ]);

    frontendLog("mod", "live");
    expect(replayed.map((e) => e.message)).toContain("live");
    expect(replayed).toHaveLength(3);
    unsub();
  });

  it("consumes the startup buffer so a later plain subscriber does not re-receive it", async () => {
    vi.resetModules();
    const { frontendLog, onFrontendLog } = await import("./frontendLog");

    frontendLog("mod", "early");
    const unsubReplay = onFrontendLog(() => undefined, { replayHistory: true });
    unsubReplay();

    const plain: LogEntry[] = [];
    const unsub = onFrontendLog((e) => plain.push(e));
    expect(plain).toHaveLength(0);
    unsub();
  });

  it("bounds the history to the most recent entries", async () => {
    vi.resetModules();
    const { frontendLog, onFrontendLog, FRONTEND_LOG_HISTORY_LIMIT } =
      await import("./frontendLog");

    for (let i = 0; i < FRONTEND_LOG_HISTORY_LIMIT + 10; i++) {
      frontendLog("mod", `entry ${i}`);
    }
    const replayed: LogEntry[] = [];
    const unsub = onFrontendLog((e) => replayed.push(e), { replayHistory: true });
    expect(replayed).toHaveLength(FRONTEND_LOG_HISTORY_LIMIT);
    expect(replayed[0].message).toBe("entry 10");
    unsub();
  });
});
