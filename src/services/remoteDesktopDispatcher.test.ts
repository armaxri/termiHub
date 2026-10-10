import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RemoteDesktopClipboardPayload } from "@/types/remoteDesktop";

const hoisted = vi.hoisted(() => ({
  listeners: {} as Record<string, Array<(p: unknown) => void>>,
  unlistens: [] as Array<ReturnType<typeof vi.fn>>,
  failNext: false,
}));

function fakeListen(name: string) {
  return (cb: (p: unknown) => void) => {
    if (hoisted.failNext) {
      hoisted.failNext = false;
      return Promise.reject(new Error("listen failed"));
    }
    (hoisted.listeners[name] ??= []).push(cb);
    const un = vi.fn(() => {
      hoisted.listeners[name] = hoisted.listeners[name].filter((c) => c !== cb);
    });
    hoisted.unlistens.push(un);
    return Promise.resolve(un);
  };
}

vi.mock("./events", () => ({
  onRemoteDesktopState: fakeListen("state"),
  onRemoteDesktopClipboard: fakeListen("clipboard"),
  onRemoteDesktopCertPrompt: fakeListen("cert"),
}));

import { RemoteDesktopDispatcher } from "./remoteDesktopDispatcher";

function emit(name: string, payload: unknown): void {
  for (const cb of hoisted.listeners[name] ?? []) cb(payload);
}

const clip = (session_id: string, text: string): RemoteDesktopClipboardPayload => ({
  session_id,
  text,
});

describe("RemoteDesktopDispatcher (FEC2-002, #4378)", () => {
  let dispatcher: RemoteDesktopDispatcher;

  beforeEach(() => {
    hoisted.listeners = {};
    hoisted.unlistens = [];
    hoisted.failNext = false;
    dispatcher = new RemoteDesktopDispatcher();
  });

  it("registers one global listener per event type for any number of sessions", async () => {
    await Promise.all([
      dispatcher.subscribeClipboard("a", () => {}),
      dispatcher.subscribeClipboard("b", () => {}),
      dispatcher.subscribeCertPrompt("a", () => {}),
      dispatcher.subscribeState("b", () => {}),
      dispatcher.subscribeAllStates(() => {}),
    ]);
    expect(hoisted.listeners.state).toHaveLength(1);
    expect(hoisted.listeners.clipboard).toHaveLength(1);
    expect(hoisted.listeners.cert).toHaveLength(1);
  });

  it("routes each event only to its own session's subscribers", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const any = vi.fn();
    await dispatcher.subscribeClipboard("a", a);
    await dispatcher.subscribeClipboard("b", b);
    emit("clipboard", clip("b", "hi"));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledExactlyOnceWith(clip("b", "hi"));

    await dispatcher.subscribeState("a", a);
    await dispatcher.subscribeAllStates(any);
    const state = { session_id: "z", state: "active", reconnect_attempt: 0 };
    emit("state", state);
    expect(a).toHaveBeenCalledTimes(0);
    expect(any).toHaveBeenCalledExactlyOnceWith(state);
  });

  it("delivers to a callback registered before the listener resolved", async () => {
    const a = vi.fn();
    const pending = dispatcher.subscribeClipboard("a", a);
    expect(dispatcher.subscriberCount()).toBe(1);
    await pending;
    emit("clipboard", clip("a", "x"));
    expect(a).toHaveBeenCalledOnce();
  });

  it("unsubscribe stops delivery and keeps the shared listener for others", async () => {
    const a = vi.fn();
    const b = vi.fn();
    const unA = await dispatcher.subscribeClipboard("a", a);
    await dispatcher.subscribeClipboard("a", b);
    unA();
    emit("clipboard", clip("a", "x"));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
    expect(hoisted.listeners.clipboard).toHaveLength(1);
    expect(dispatcher.subscriberCount()).toBe(1);
  });

  it("destroy() during a pending init unlistens the late listener", async () => {
    const pending = dispatcher.subscribeClipboard("a", () => {});
    dispatcher.destroy();
    await pending;
    // Every registered listener was torn down; none leaks.
    expect(hoisted.unlistens.every((un) => un.mock.calls.length === 1)).toBe(true);
    expect(dispatcher.subscriberCount()).toBe(0);
  });

  it("drops the callback and retries init after a failed registration", async () => {
    hoisted.failNext = true;
    await expect(dispatcher.subscribeClipboard("a", () => {})).rejects.toThrow("listen failed");
    expect(dispatcher.subscriberCount()).toBe(0);

    const b = vi.fn();
    await dispatcher.subscribeClipboard("b", b);
    emit("clipboard", clip("b", "ok"));
    expect(b).toHaveBeenCalledOnce();
  });
});
