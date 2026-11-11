/**
 * The test bridge's JS error buffer and the `getJsErrors` verb (#5364).
 */
import { describe, expect, it, vi } from "vitest";
import { dispatchCommand, type BridgeDeps } from "./dispatcher";
import {
  JS_ERROR_BUFFER_LIMIT,
  JS_ERROR_MESSAGE_LIMIT,
  JS_ERROR_STACK_LINES,
  JsErrorBuffer,
  installJsErrorCapture,
  shortStack,
  type JsErrorConsole,
} from "./jsErrors";
import type { JsErrorsResult } from "./protocol";

/** Minimal deps: `getJsErrors` touches nothing but its own dep. */
function deps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    root: document,
    readTerminal: () => undefined,
    scrollTerminal: () => false,
    getTerminalViewport: () => undefined,
    getActiveTabId: () => undefined,
    getState: () => ({}),
    sendTerminalInput: async () => false,
    resizeWindow: async () => {},
    screenshot: async () => "data:image/png;base64,AAAA",
    emitEvent: async () => {},
    ...overrides,
  };
}

/** A detached event target plus a fake console, so the real ones stay untouched. */
function harness() {
  const target = new EventTarget() as unknown as Window;
  const original = vi.fn();
  const fakeConsole: JsErrorConsole = { error: original };
  const buffer = new JsErrorBuffer(() => 1234, "page-1");
  const uninstall = installJsErrorCapture(buffer, target, fakeConsole);
  return { target, original, fakeConsole, buffer, uninstall };
}

function rejection(reason: unknown): Event {
  const event = new Event("unhandledrejection");
  Object.assign(event, { reason });
  return event;
}

describe("JsErrorBuffer", () => {
  it("numbers records and reads from a since-cursor", () => {
    const buffer = new JsErrorBuffer(() => 7, "p");
    buffer.record("console.error", { message: "a" });
    buffer.record("error", { message: "b" });
    const all = buffer.read();
    expect(all.pageId).toBe("p");
    expect(all.cursor).toBe(2);
    expect(all.errors.map((e) => [e.seq, e.message, e.timestampMs])).toEqual([
      [0, "a", 7],
      [1, "b", 7],
    ]);
    buffer.record("error", { message: "c" });
    const fresh = buffer.read(all.cursor);
    expect(fresh.cursor).toBe(3);
    expect(fresh.errors.map((e) => e.message)).toEqual(["c"]);
    expect(buffer.read(3).errors).toEqual([]);
  });

  it("stays bounded and counts what it dropped", () => {
    const buffer = new JsErrorBuffer();
    for (let i = 0; i < JS_ERROR_BUFFER_LIMIT + 5; i++) {
      buffer.record("error", { message: `e${i}` });
    }
    const result = buffer.read();
    expect(result.errors).toHaveLength(JS_ERROR_BUFFER_LIMIT);
    expect(result.dropped).toBe(5);
    expect(result.errors[0].seq).toBe(5);
    expect(result.cursor).toBe(JS_ERROR_BUFFER_LIMIT + 5);
  });

  it("clips long messages", () => {
    const buffer = new JsErrorBuffer();
    buffer.record("error", { message: "x".repeat(JS_ERROR_MESSAGE_LIMIT + 10) });
    expect(buffer.read().errors[0].message).toHaveLength(JS_ERROR_MESSAGE_LIMIT + 1);
  });

  it("gives every buffer its own page id", () => {
    expect(new JsErrorBuffer().pageId).not.toBe(new JsErrorBuffer().pageId);
  });
});

describe("shortStack", () => {
  it("keeps only the first frames", () => {
    const stack = Array.from({ length: 20 }, (_, i) => `at f${i}`).join("\n");
    expect(shortStack(stack)?.split("\n")).toHaveLength(JS_ERROR_STACK_LINES);
    expect(shortStack(undefined)).toBeUndefined();
    expect(shortStack("\n\n")).toBeUndefined();
  });
});

describe("installJsErrorCapture", () => {
  it("records unhandled rejections with message and short stack", () => {
    const { target, buffer } = harness();
    target.dispatchEvent(rejection(new TypeError("boom")));
    target.dispatchEvent(rejection("Canceled"));
    const [first, second] = buffer.read().errors;
    expect(first.kind).toBe("unhandledrejection");
    expect(first.message).toBe("TypeError: boom");
    expect(first.stack).toBeTruthy();
    expect(second.message).toBe("Canceled");
    expect(second.stack).toBeUndefined();
  });

  it("records uncaught errors with their source location", () => {
    const { target, buffer } = harness();
    target.dispatchEvent(
      new ErrorEvent("error", {
        error: new Error("kaput"),
        message: "kaput",
        filename: "app.js",
        lineno: 3,
        colno: 9,
      })
    );
    const [entry] = buffer.read().errors;
    expect(entry.kind).toBe("error");
    expect(entry.message).toBe("kaput (app.js:3:9)");
  });

  it("records console.error and still forwards it", () => {
    const { fakeConsole, original, buffer } = harness();
    fakeConsole.error("failed:", { code: 1 }, new Error("inner"));
    expect(original).toHaveBeenCalledWith("failed:", { code: 1 }, expect.any(Error));
    const [entry] = buffer.read().errors;
    expect(entry.kind).toBe("console.error");
    expect(entry.message).toBe('failed: {"code":1} inner');
    expect(entry.stack).toBeTruthy();
  });

  it("uninstalls cleanly", () => {
    const { target, fakeConsole, original, buffer, uninstall } = harness();
    uninstall();
    expect(fakeConsole.error).toBe(original);
    target.dispatchEvent(rejection("late"));
    fakeConsole.error("late");
    expect(buffer.read().errors).toEqual([]);
  });
});

describe("dispatchCommand getJsErrors", () => {
  it("answers the buffer from the requested cursor", async () => {
    const buffer = new JsErrorBuffer(() => 1, "page");
    buffer.record("error", { message: "old" });
    buffer.record("error", { message: "new" });
    const d = deps({ readJsErrors: (since) => buffer.read(since) });
    const all = await dispatchCommand({ action: "getJsErrors" }, d);
    expect(all.ok).toBe(true);
    expect((all.value as JsErrorsResult).errors).toHaveLength(2);
    const since = await dispatchCommand({ action: "getJsErrors", since: 1 }, d);
    expect((since.value as JsErrorsResult).errors.map((e) => e.message)).toEqual(["new"]);
    // A Python client sends an explicit null for "from the start".
    const nulled = await dispatchCommand(
      { action: "getJsErrors", since: null as unknown as number },
      d
    );
    expect((nulled.value as JsErrorsResult).errors).toHaveLength(2);
  });

  it("rejects a malformed cursor", async () => {
    const d = deps({ readJsErrors: () => new JsErrorBuffer().read() });
    const res = await dispatchCommand({ action: "getJsErrors", since: -1 }, d);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/non-negative integer/);
  });

  it("fails when the buffer is not wired", async () => {
    const res = await dispatchCommand({ action: "getJsErrors" }, deps());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not available/);
  });
});
