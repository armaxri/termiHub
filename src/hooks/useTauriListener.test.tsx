import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

let emit: ((event: { payload: unknown }) => void) | undefined;
let resolveListen: (() => void) | undefined;
let rejectListen: ((err: unknown) => void) | undefined;
const unlisten = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, cb: (event: { payload: unknown }) => void) => {
    emit = cb;
    return new Promise<() => void>((resolve, reject) => {
      resolveListen = () => resolve(unlisten);
      rejectListen = reject;
    });
  }),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { listen } from "@tauri-apps/api/event";
import { frontendLog } from "@/utils/frontendLog";
import { subscribeGuarded, useTauriListener, useTauriSubscription } from "./useTauriListener";

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function ListenerHost({ handler }: { handler: (payload: string) => void }) {
  useTauriListener<string>("some-event", handler, "test_scope");
  return null;
}

describe("useTauriListener (#4375)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    emit = undefined;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  it("unlistens a listener whose registration resolves after unmount", async () => {
    act(() => root.render(<ListenerHost handler={vi.fn()} />));
    act(() => root.unmount());
    expect(unlisten).not.toHaveBeenCalled();
    resolveListen?.();
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unlistens on unmount after registration resolved", async () => {
    act(() => root.render(<ListenerHost handler={vi.fn()} />));
    resolveListen?.();
    await flush();
    act(() => root.unmount());
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("delivers the payload to the latest handler without re-subscribing", async () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() => root.render(<ListenerHost handler={first} />));
    resolveListen?.();
    await flush();
    act(() => root.render(<ListenerHost handler={second} />));
    emit?.({ payload: "hello" });
    expect(listen).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("hello");
    act(() => root.unmount());
  });

  it("drops events that arrive after unmount", async () => {
    const handler = vi.fn();
    act(() => root.render(<ListenerHost handler={handler} />));
    act(() => root.unmount());
    emit?.({ payload: "late" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("logs a failed registration instead of rejecting unhandled", async () => {
    act(() => root.render(<ListenerHost handler={vi.fn()} />));
    rejectListen?.(new Error("no bridge"));
    await flush();
    expect(frontendLog).toHaveBeenCalledWith("test_scope", expect.stringContaining("no bridge"));
    act(() => root.unmount());
  });
});

describe("useTauriSubscription (#4375)", () => {
  it("unlistens a wrapper subscription that resolves after unmount", async () => {
    let resolve: (() => void) | undefined;
    const off = vi.fn();
    const subscribe = vi.fn(
      (_cb: (value: number) => void) =>
        new Promise<() => void>((r) => {
          resolve = () => r(off);
        })
    );
    function Host() {
      useTauriSubscription(subscribe, () => {}, "test_scope");
      return null;
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<Host />));
    act(() => root.unmount());
    resolve?.();
    await flush();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe("subscribeGuarded", () => {
  it("reports a synchronous registration throw via frontendLog", async () => {
    const dispose = subscribeGuarded(
      () => {
        throw new Error("sync boom");
      },
      "test_scope",
      "thing"
    );
    await flush();
    expect(frontendLog).toHaveBeenCalledWith("test_scope", expect.stringContaining("sync boom"));
    dispose();
  });
});
