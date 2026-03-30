import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LogEntry } from "@/types/terminal";

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
});

// Restore module registry after all tests in this file
beforeEach(() => {
  vi.clearAllMocks();
});
