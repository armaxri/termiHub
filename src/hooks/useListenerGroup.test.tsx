import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useListenerGroup, type ListenerGroup } from "./useTauriListener";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let group: ListenerGroup;

function Host() {
  group = useListenerGroup();
  return null;
}

describe("useListenerGroup (#4576)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let mounted: boolean;

  beforeEach(async () => {
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root.render(<Host />));
    mounted = true;
  });

  afterEach(() => {
    if (mounted) act(() => root.unmount());
  });

  function unmount() {
    act(() => root.unmount());
    mounted = false;
  }

  it("holds attached listeners and unlistens them on unmount", async () => {
    const a = vi.fn();
    const b = vi.fn();
    await expect(group.attach(async () => a)).resolves.toBe(true);
    await expect(group.attach(async () => b)).resolves.toBe(true);
    expect(group.isDisposed()).toBe(false);
    unmount();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(group.isDisposed()).toBe(true);
  });

  it("unlistens a registration that resolves after unmount", async () => {
    const pending = deferred<() => void>();
    const fn = vi.fn();
    const attached = group.attach(() => pending.promise);
    unmount();
    pending.resolve(fn);
    await expect(attached).resolves.toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("unlistens a registration that resolves after release", async () => {
    const pending = deferred<() => void>();
    const fn = vi.fn();
    const attached = group.attach(() => pending.promise);
    group.release();
    pending.resolve(fn);
    await expect(attached).resolves.toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    // A later attach is held again.
    const next = vi.fn();
    await expect(group.attach(async () => next)).resolves.toBe(true);
    group.release();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("propagates a registration error", async () => {
    await expect(group.attach(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
  });
});
