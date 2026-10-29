import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  useSerialPortRescan,
  SERIAL_PORT_RESCAN_INTERVAL_MS,
  SERIAL_PORT_RESCAN_MAX_BACKOFF_MS,
  serialPortRescanDelay,
  type SerialPortRescanOptions,
  type SerialPortRescanResult,
} from "./useSerialPortRescan";

/** Mount the hook in a throwaway component; `result.current` tracks its latest value. */
function renderHook(options: () => SerialPortRescanOptions): {
  result: { current: SerialPortRescanResult };
  unmount: () => void;
} {
  const root = createRoot(document.createElement("div"));
  const result = { current: undefined as unknown as SerialPortRescanResult };
  function Probe() {
    result.current = useSerialPortRescan(options());
    return null;
  }
  act(() => root.render(<Probe />));
  return { result, unmount: () => act(() => root.unmount()) };
}

/** Let pending promise callbacks (the mocked lister) settle under fake timers. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function tick(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(SERIAL_PORT_RESCAN_INTERVAL_MS);
  });
  await flush();
}

function setDocumentVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useSerialPortRescan (#5066)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setDocumentVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    setDocumentVisibility("visible");
  });

  it("scans immediately and returns the ports in natural order", async () => {
    const lister = vi.fn().mockResolvedValue(["COM10", "COM3", "COM27", "COM9"]);
    const { result } = renderHook(() => ({ enabled: true, lister }));
    expect(result.current.loaded).toBe(false);
    await flush();
    expect(lister).toHaveBeenCalledTimes(1);
    expect(result.current.loaded).toBe(true);
    expect(result.current.ports).toEqual(["COM3", "COM9", "COM10", "COM27"]);
  });

  it("picks up a newly plugged port on the next rescan and marks it new", async () => {
    const lister = vi.fn().mockResolvedValueOnce(["COM3"]).mockResolvedValue(["COM3", "COM12"]);
    const { result } = renderHook(() => ({ enabled: true, lister }));
    await flush();
    expect(result.current.newPorts.size).toBe(0);

    await tick();
    expect(result.current.ports).toEqual(["COM3", "COM12"]);
    expect([...result.current.newPorts]).toEqual(["COM12"]);
  });

  it("stops marking a port new after the highlight window", async () => {
    const lister = vi.fn().mockResolvedValueOnce([]).mockResolvedValue(["COM4"]);
    const { result } = renderHook(() => ({ enabled: true, lister }));
    await flush();
    await tick();
    expect(result.current.newPorts.has("COM4")).toBe(true);
    for (let i = 0; i < 5; i++) await tick();
    expect(result.current.newPorts.has("COM4")).toBe(false);
  });

  it("drops an unplugged port on the next rescan", async () => {
    const lister = vi.fn().mockResolvedValueOnce(["COM3", "COM5"]).mockResolvedValue(["COM3"]);
    const { result } = renderHook(() => ({ enabled: true, lister }));
    await flush();
    expect(result.current.ports).toEqual(["COM3", "COM5"]);
    await tick();
    expect(result.current.ports).toEqual(["COM3"]);
  });

  it("keeps the same array identity when a rescan finds no change", async () => {
    const lister = vi.fn().mockResolvedValue(["COM3", "COM5"]);
    const { result } = renderHook(() => ({ enabled: true, lister }));
    await flush();
    const first = result.current.ports;
    await tick();
    expect(lister).toHaveBeenCalledTimes(2);
    expect(result.current.ports).toBe(first);
  });

  it("does not scan at all when disabled", async () => {
    const lister = vi.fn().mockResolvedValue(["COM3"]);
    renderHook(() => ({ enabled: false, lister }));
    await flush();
    await tick();
    await tick();
    expect(lister).not.toHaveBeenCalled();
  });

  it("pauses while the window is hidden and resumes when shown again", async () => {
    const lister = vi.fn().mockResolvedValue(["COM3"]);
    renderHook(() => ({ enabled: true, lister }));
    await flush();
    expect(lister).toHaveBeenCalledTimes(1);

    act(() => setDocumentVisibility("hidden"));
    await tick();
    await tick();
    await tick();
    expect(lister).toHaveBeenCalledTimes(1);

    act(() => setDocumentVisibility("visible"));
    await flush();
    expect(lister).toHaveBeenCalledTimes(2);
    await tick();
    expect(lister).toHaveBeenCalledTimes(3);
  });

  it("stops scanning once unmounted", async () => {
    const lister = vi.fn().mockResolvedValue(["COM3"]);
    const { unmount } = renderHook(() => ({ enabled: true, lister }));
    await flush();
    unmount();
    await tick();
    await tick();
    expect(lister).toHaveBeenCalledTimes(1);
  });

  it("does not stack scans while one is still in flight", async () => {
    let resolve: (ports: string[]) => void = () => {};
    const lister = vi.fn(
      () =>
        new Promise<string[]>((r) => {
          resolve = r;
        })
    );
    renderHook(() => ({ enabled: true, lister }));
    await tick();
    await tick();
    expect(lister).toHaveBeenCalledTimes(1);
    resolve(["COM3"]);
    await flush();
    await tick();
    expect(lister).toHaveBeenCalledTimes(2);
  });

  it("keeps the last good list when a scan fails", async () => {
    const lister = vi
      .fn()
      .mockResolvedValueOnce(["COM3"])
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(["COM3"]);
    const { result } = renderHook(() => ({ enabled: true, lister }));
    await flush();
    await tick();
    expect(result.current.ports).toEqual(["COM3"]);
    expect(result.current.loaded).toBe(true);
  });

  it("doubles the delay after each consecutive failure up to the cap", () => {
    expect(serialPortRescanDelay(0)).toBe(SERIAL_PORT_RESCAN_INTERVAL_MS);
    expect(serialPortRescanDelay(1)).toBe(SERIAL_PORT_RESCAN_INTERVAL_MS * 2);
    expect(serialPortRescanDelay(2)).toBe(SERIAL_PORT_RESCAN_INTERVAL_MS * 4);
    expect(serialPortRescanDelay(50)).toBe(SERIAL_PORT_RESCAN_MAX_BACKOFF_MS);
  });

  it("backs off while scans keep failing so a slow agent link is not flooded (#5069)", async () => {
    const lister = vi.fn().mockRejectedValue(new Error("timed out"));
    renderHook(() => ({ enabled: true, lister }));
    await flush();
    expect(lister).toHaveBeenCalledTimes(1);

    // First retry after 2× the interval, not 1×.
    await tick();
    expect(lister).toHaveBeenCalledTimes(1);
    await tick();
    expect(lister).toHaveBeenCalledTimes(2);

    // Then 4× the interval.
    await tick();
    await tick();
    await tick();
    expect(lister).toHaveBeenCalledTimes(2);
    await tick();
    expect(lister).toHaveBeenCalledTimes(3);
  });

  it("returns to the normal interval after a successful scan", async () => {
    const lister = vi
      .fn()
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValue(["COM3"]);
    const { result } = renderHook(() => ({ enabled: true, lister }));
    await flush();
    await tick();
    await tick();
    expect(lister).toHaveBeenCalledTimes(2);
    expect(result.current.ports).toEqual(["COM3"]);
    await tick();
    expect(lister).toHaveBeenCalledTimes(3);
  });

  it("waits a full interval after a slow scan completes before the next one", async () => {
    let resolve: (ports: string[]) => void = () => {};
    const lister = vi.fn(
      () =>
        new Promise<string[]>((r) => {
          resolve = r;
        })
    );
    renderHook(() => ({ enabled: true, lister }));
    await tick();
    resolve(["COM3"]);
    await flush();
    // Completion restarts the clock: no immediate catch-up scan.
    await act(async () => {
      vi.advanceTimersByTime(SERIAL_PORT_RESCAN_INTERVAL_MS - 1);
    });
    await flush();
    expect(lister).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(lister).toHaveBeenCalledTimes(2);
  });
});
