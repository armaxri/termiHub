/**
 * Unmount during a ping start (#4576, follow-up of #4375 / FES2-006).
 *
 * Start registers three listeners and then starts the backend task, all behind
 * awaits. If the panel unmounts while any of that is pending, the listeners
 * that register afterwards must be unlistened at once, and a task whose start
 * resolves after unmount must be stopped rather than left pinging forever.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  networkPingStart,
  networkPingStop,
  onPingResult,
  onPingComplete,
  onPingError,
} from "@/services/networkApi";
import { PingPanel } from "./PingPanel";

vi.mock("@/services/networkApi", () => ({
  networkPingStart: vi.fn(() => Promise.resolve("task-1")),
  networkPingStop: vi.fn(() => Promise.resolve()),
  onPingResult: vi.fn(() => Promise.resolve(() => {})),
  onPingComplete: vi.fn(() => Promise.resolve(() => {})),
  onPingError: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

let container: HTMLDivElement;
let root: Root;
let mounted = false;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function flush(times = 5) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderAndStart() {
  await act(async () => {
    root.render(<PingPanel prefillHost="example.com" />);
  });
  mounted = true;
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="ping-start"]')!.click();
  });
}

function unmount() {
  act(() => root.unmount());
  mounted = false;
}

describe("PingPanel — unmount during start (#4576)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (mounted) unmount();
    container.remove();
  });

  it("unlistens a listener whose registration resolves after unmount", async () => {
    const pending = deferred<() => void>();
    const unlistenResult = vi.fn();
    vi.mocked(onPingResult).mockReturnValueOnce(pending.promise);

    await renderAndStart();
    unmount();

    await act(async () => {
      pending.resolve(unlistenResult);
    });
    await flush();

    expect(unlistenResult).toHaveBeenCalledTimes(1);
    // The run was abandoned: no backend task is started for a gone panel.
    expect(networkPingStart).not.toHaveBeenCalled();
    expect(onPingComplete).not.toHaveBeenCalled();
  });

  it("unlistens every registered listener on unmount", async () => {
    const unlistens = [vi.fn(), vi.fn(), vi.fn()];
    vi.mocked(onPingResult).mockResolvedValueOnce(unlistens[0]);
    vi.mocked(onPingComplete).mockResolvedValueOnce(unlistens[1]);
    vi.mocked(onPingError).mockResolvedValueOnce(unlistens[2]);

    await renderAndStart();
    await flush();
    unmount();

    for (const fn of unlistens) expect(fn).toHaveBeenCalledTimes(1);
  });

  it("stops a ping task whose start resolves after unmount", async () => {
    const start = deferred<string>();
    const unlistenError = vi.fn();
    vi.mocked(onPingError).mockResolvedValueOnce(unlistenError);
    vi.mocked(networkPingStart).mockReturnValueOnce(start.promise);

    await renderAndStart();
    await flush();
    expect(networkPingStart).toHaveBeenCalledTimes(1);
    unmount();
    expect(unlistenError).toHaveBeenCalledTimes(1);
    // No task id yet, so the unmount itself had nothing to stop.
    expect(networkPingStop).not.toHaveBeenCalled();

    await act(async () => {
      start.resolve("late-task");
    });
    await flush();

    expect(networkPingStop).toHaveBeenCalledWith("late-task");
  });
});
