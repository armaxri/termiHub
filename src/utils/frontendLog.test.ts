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
