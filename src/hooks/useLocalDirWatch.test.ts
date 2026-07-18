import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";

// Capture the event callback the hook registers so tests can fire a simulated
// `local-dir-changed` event at it, plus the unlisten it returns.
let dirChangeCb: ((watchId: string, path: string) => void) | null = null;
const unlisten = vi.fn();
vi.mock("@/services/events", () => ({
  onLocalDirChanged: vi.fn((cb: (watchId: string, path: string) => void) => {
    dirChangeCb = cb;
    return Promise.resolve(unlisten);
  }),
}));

const watchLocalDir = vi.fn(() => Promise.resolve());
const unwatchLocalDir = vi.fn(() => Promise.resolve());
vi.mock("@/services/api", () => ({
  watchLocalDir: (id: string, path: string) => watchLocalDir(id, path),
  unwatchLocalDir: (id: string) => unwatchLocalDir(id),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

import { useLocalDirWatch } from "./useLocalDirWatch";

/** Minimal harness component that drives the hook with test-controlled props. */
function Harness(props: { enabled: boolean; path: string | null; onChange: () => void }) {
  useLocalDirWatch(props.enabled, props.path, props.onChange);
  return null;
}

describe("useLocalDirWatch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    dirChangeCb = null;
    watchLocalDir.mockClear();
    unwatchLocalDir.mockClear();
    unlisten.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  /** Render/update the harness and flush the hook's async start(). */
  async function renderHarness(props: {
    enabled: boolean;
    path: string | null;
    onChange: () => void;
  }) {
    await act(async () => {
      root.render(createElement(Harness, props));
    });
  }

  it("registers a directory watch when enabled with a path", async () => {
    await renderHarness({ enabled: true, path: "/home/u", onChange: vi.fn() });
    expect(watchLocalDir).toHaveBeenCalledTimes(1);
    expect(watchLocalDir.mock.calls[0][1]).toBe("/home/u");
  });

  it("does not watch when disabled", async () => {
    await renderHarness({ enabled: false, path: "/home/u", onChange: vi.fn() });
    expect(watchLocalDir).not.toHaveBeenCalled();
  });

  it("does not watch when path is null", async () => {
    await renderHarness({ enabled: true, path: null, onChange: vi.fn() });
    expect(watchLocalDir).not.toHaveBeenCalled();
  });

  it("refreshes (debounced) on a matching change event", async () => {
    const onChange = vi.fn();
    await renderHarness({ enabled: true, path: "/home/u", onChange });
    const watchId = watchLocalDir.mock.calls[0][0];

    act(() => {
      dirChangeCb?.(watchId, "/home/u");
    });
    // Debounced: nothing yet.
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of events into one refresh", async () => {
    const onChange = vi.fn();
    await renderHarness({ enabled: true, path: "/home/u", onChange });
    const watchId = watchLocalDir.mock.calls[0][0];

    act(() => {
      dirChangeCb?.(watchId, "/home/u");
      dirChangeCb?.(watchId, "/home/u");
      dirChangeCb?.(watchId, "/home/u");
      vi.advanceTimersByTime(200);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores events for a different watch id", async () => {
    const onChange = vi.fn();
    await renderHarness({ enabled: true, path: "/home/u", onChange });

    act(() => {
      dirChangeCb?.("some-other-id", "/home/u");
      vi.advanceTimersByTime(200);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("unwatches and unsubscribes on unmount", async () => {
    await renderHarness({ enabled: true, path: "/home/u", onChange: vi.fn() });
    const watchId = watchLocalDir.mock.calls[0][0];

    await act(async () => {
      root.render(createElement("div"));
    });
    expect(unwatchLocalDir).toHaveBeenCalledWith(watchId);
    expect(unlisten).toHaveBeenCalled();
  });

  it("re-targets the watch when the path changes", async () => {
    const onChange = vi.fn();
    await renderHarness({ enabled: true, path: "/home/u", onChange });
    expect(watchLocalDir).toHaveBeenCalledTimes(1);

    await renderHarness({ enabled: true, path: "/home/u/sub", onChange });
    // Old watch torn down, new directory watched.
    expect(unwatchLocalDir).toHaveBeenCalled();
    expect(watchLocalDir).toHaveBeenCalledTimes(2);
    expect(watchLocalDir.mock.calls[1][1]).toBe("/home/u/sub");
  });
});
