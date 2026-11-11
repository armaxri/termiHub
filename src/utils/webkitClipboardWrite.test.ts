import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PendingClipboardText,
  armWebKitClipboardWrite,
  isClipboardNotAllowed,
  patchWebKitClipboardWorkaround,
  type WebKitClipboardHost,
} from "./webkitClipboardWrite";

/**
 * #5383: Monaco's WebKit clipboard pre-arm wrote to the clipboard on every
 * click; WebKit refused gesture-less writes (`NotAllowedError`, logged) and the
 * next click's cancellation leaked as an unhandled `Canceled` rejection. These
 * tests use a fake clipboard only — the real one is never touched.
 */

/** Minimal `ClipboardItem` stand-in (jsdom has none). */
class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<string>>) {}
}

function notAllowed(): Error {
  const error = new Error("The request is not allowed by the user agent");
  error.name = "NotAllowedError";
  return error;
}

/** Let pending promise callbacks and unhandled-rejection detection run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
});

afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.unstubAllGlobals();
});

describe("PendingClipboardText", () => {
  it("cancelling it never produces an unhandled rejection", async () => {
    const pending = new PendingClipboardText();
    pending.cancel();
    await flush();
    expect(pending.isSettled).toBe(true);
    expect(unhandled).toEqual([]);
    await expect(pending.p).rejects.toMatchObject({ name: "Canceled", message: "Canceled" });
  });

  it("complete resolves the text and ignores a later cancel", async () => {
    const pending = new PendingClipboardText();
    await pending.complete("hello");
    pending.cancel();
    await expect(pending.p).resolves.toBe("hello");
  });
});

describe("isClipboardNotAllowed", () => {
  it("matches only the NotAllowedError refusal", () => {
    expect(isClipboardNotAllowed(notAllowed())).toBe(true);
    expect(isClipboardNotAllowed(new Error("boom"))).toBe(false);
    expect(isClipboardNotAllowed("NotAllowedError")).toBe(false);
    expect(isClipboardNotAllowed(null)).toBe(false);
  });
});

describe("armWebKitClipboardWrite", () => {
  it("a refused write is silent, disarmed, and leaks no rejection across clicks", async () => {
    const write = vi.fn(() => Promise.reject(notAllowed()));
    const report = vi.fn();
    const host: WebKitClipboardHost = {};

    // Two gesture-less "clicks": the second cancels whatever the first left.
    armWebKitClipboardWrite(host, { write }, report);
    armWebKitClipboardWrite(host, { write }, report);
    await flush();

    expect(write).toHaveBeenCalledTimes(2);
    expect(report).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
    // Disarmed: a later Monaco writeText takes its normal path instead of
    // completing a write WebKit already refused.
    expect(host.webKitPendingClipboardWritePromise).toBeUndefined();
  });

  it("a write that throws synchronously is handled", async () => {
    const write = vi.fn(() => {
      throw notAllowed();
    });
    const report = vi.fn();
    const host: WebKitClipboardHost = {};

    expect(() => armWebKitClipboardWrite(host, { write }, report)).not.toThrow();
    await flush();
    expect(report).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
    expect(host.webKitPendingClipboardWritePromise).toBeUndefined();
  });

  it("an allowed write is completed with the text Monaco copies", async () => {
    let item: FakeClipboardItem | undefined;
    const write = vi.fn((items: ClipboardItems) => {
      item = items[0] as unknown as FakeClipboardItem;
      return item.items["text/plain"].then(() => undefined);
    });
    const host: WebKitClipboardHost = {};

    armWebKitClipboardWrite(host, { write }, vi.fn());
    await host.webKitPendingClipboardWritePromise?.complete("copied");

    await expect(item?.items["text/plain"]).resolves.toBe("copied");
  });

  it("an allowed write superseded by the next click is cancelled quietly", async () => {
    // Like WebKit: the write settles with the item's promise.
    const write = vi.fn((items: ClipboardItems) =>
      (items[0] as unknown as FakeClipboardItem).items["text/plain"].then(() => undefined)
    );
    const report = vi.fn();
    const host: WebKitClipboardHost = {};

    armWebKitClipboardWrite(host, { write }, report);
    const first = host.webKitPendingClipboardWritePromise;
    armWebKitClipboardWrite(host, { write }, report);
    await flush();

    expect(first?.isSettled).toBe(true);
    expect(host.webKitPendingClipboardWritePromise).not.toBe(first);
    expect(report).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it("reports an unexpected write error instead of swallowing it", async () => {
    const boom = new Error("boom");
    const write = vi.fn(() => Promise.reject(boom));
    const report = vi.fn();

    armWebKitClipboardWrite({}, { write }, report);
    await flush();

    expect(report).toHaveBeenCalledWith(boom);
    expect(unhandled).toEqual([]);
  });

  it("does nothing without a clipboard or ClipboardItem", () => {
    const host: WebKitClipboardHost = {};
    armWebKitClipboardWrite(host, undefined, vi.fn());
    expect(host.webKitPendingClipboardWritePromise).toBeUndefined();

    vi.stubGlobal("ClipboardItem", undefined);
    const write = vi.fn();
    armWebKitClipboardWrite(host, { write }, vi.fn());
    expect(write).not.toHaveBeenCalled();
  });
});

describe("patchWebKitClipboardWorkaround", () => {
  it("replaces the installer on the real Monaco BrowserClipboardService", async () => {
    const { BrowserClipboardService } =
      await import("monaco-editor/platform/clipboard/browser/clipboardService");
    // Importing monacoEnvironment (which every monaco importer does first)
    // applies the patch.
    await import("./monacoClipboard");
    const installer = BrowserClipboardService.prototype.installWebKitWriteTextWorkaround;
    expect(typeof installer).toBe("function");
    expect(String(installer)).toContain("armWebKitClipboardWrite");
  });

  it("throws when the Monaco method it patches is gone", () => {
    expect(() => patchWebKitClipboardWorkaround(class {})).toThrow(/#5383/);
  });

  it("the patched installer arms on click and keydown and is disposable", async () => {
    class FakeService {
      installWebKitWriteTextWorkaround(): void {}
    }
    patchWebKitClipboardWorkaround(FakeService);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const write = vi.fn(() => Promise.reject(notAllowed()));
    vi.stubGlobal("navigator", { clipboard: { write } });
    const disposables: Array<{ dispose(): void }> = [];
    const error = vi.fn();
    const service = Object.assign(new FakeService(), {
      layoutService: { mainContainer: container },
      logService: { error },
      _register<T extends { dispose(): void }>(d: T): T {
        disposables.push(d);
        return d;
      },
    });

    service.installWebKitWriteTextWorkaround();
    container.click();
    container.click();
    container.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    await flush();

    expect(write).toHaveBeenCalledTimes(3);
    expect(error).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);

    disposables.forEach((d) => d.dispose());
    container.click();
    expect(write).toHaveBeenCalledTimes(3);
    container.remove();
  });
});
