import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LogEntry } from "@/types/terminal";

// A minimal EventTarget stand-in so tests can drive the handlers without a real
// window and without leaking global listeners between cases.
class FakeTarget {
  private handlers = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.handlers.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown): void {
    for (const listener of this.handlers.get(type) ?? []) {
      listener(event as Event);
    }
  }

  count(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

describe("installGlobalErrorHandlers", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("routes an unhandled promise rejection into the frontend ERROR channel", async () => {
    const { installGlobalErrorHandlers } = await import("./globalErrorHandlers");
    const { onFrontendLog } = await import("./frontendLog");

    const received: LogEntry[] = [];
    const unsub = onFrontendLog((e) => received.push(e));

    const target = new FakeTarget();
    const uninstall = installGlobalErrorHandlers(target);

    target.dispatch("unhandledrejection", { reason: new Error("nope") });

    expect(received).toHaveLength(1);
    expect(received[0].level).toBe("ERROR");
    expect(received[0].target).toBe("frontend::unhandled");
    expect(received[0].message).toContain("unhandled promise rejection");
    expect(received[0].message).toContain("nope");

    uninstall();
    unsub();
  });

  it("routes an uncaught error event into the frontend ERROR channel", async () => {
    const { installGlobalErrorHandlers } = await import("./globalErrorHandlers");
    const { onFrontendLog } = await import("./frontendLog");

    const received: LogEntry[] = [];
    const unsub = onFrontendLog((e) => received.push(e));

    const target = new FakeTarget();
    const uninstall = installGlobalErrorHandlers(target);

    target.dispatch("error", {
      error: new Error("kaboom"),
      message: "kaboom",
      filename: "app.js",
      lineno: 12,
      colno: 3,
    });

    expect(received).toHaveLength(1);
    expect(received[0].level).toBe("ERROR");
    expect(received[0].message).toContain("uncaught error");
    expect(received[0].message).toContain("app.js:12:3");
    expect(received[0].message).toContain("kaboom");

    uninstall();
    unsub();
  });

  it("uninstall removes both listeners", async () => {
    const { installGlobalErrorHandlers } = await import("./globalErrorHandlers");

    const target = new FakeTarget();
    const uninstall = installGlobalErrorHandlers(target);

    expect(target.count("unhandledrejection")).toBe(1);
    expect(target.count("error")).toBe(1);

    uninstall();

    expect(target.count("unhandledrejection")).toBe(0);
    expect(target.count("error")).toBe(0);
  });
});
