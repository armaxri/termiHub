/**
 * Regression test for the ping error path.
 *
 * Pinging a host that does not resolve (e.g. a "random host that isn't
 * working") makes the backend emit `network-ping-error` and finish the task.
 * The panel must listen for that event and leave the "running" state — before
 * the fix it ignored the event, stayed stuck showing "running", and the Stop
 * button had nothing left to cancel so it appeared to do nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  networkPingStart,
  networkPingStop,
  onPingError,
  onPingResult,
  onPingComplete,
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

// LatencyChart is gated behind results.length > 0 and isn't reached on the
// error path, but stub it so a stray canvas never touches jsdom.
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("PingPanel — ping error handling", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("registers a network-ping-error listener when starting", async () => {
    await act(async () => {
      root.render(<PingPanel prefillHost="does-not-exist.invalid" />);
    });

    const startBtn = container.querySelector<HTMLButtonElement>('[data-testid="ping-start"]')!;
    await act(async () => {
      startBtn.click();
    });
    await flush();

    expect(networkPingStart).toHaveBeenCalledTimes(1);
    expect(onPingError).toHaveBeenCalledTimes(1);
  });

  it("leaves the running state and shows the error when the host fails", async () => {
    await act(async () => {
      root.render(<PingPanel prefillHost="does-not-exist.invalid" />);
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="ping-start"]')!.click();
    });
    await flush();

    // While running, the Stop button is shown and Start is gone.
    expect(container.querySelector('[data-testid="ping-start"]')).toBeNull();

    // Backend reports a fatal error for our task and finishes the task.
    const errorCb = vi.mocked(onPingError).mock.calls[0][0];
    await act(async () => {
      errorCb({ taskId: "task-1", error: "DNS resolution failed for does-not-exist.invalid" });
    });
    await flush();

    // Panel must return to a non-running state (Start button back) and surface
    // the error instead of staying stuck.
    expect(container.querySelector('[data-testid="ping-start"]')).not.toBeNull();
    expect(container.textContent).toContain("DNS resolution failed");
  });

  it("ignores errors for a different task id", async () => {
    await act(async () => {
      root.render(<PingPanel prefillHost="host" />);
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="ping-start"]')!.click();
    });
    await flush();

    const errorCb = vi.mocked(onPingError).mock.calls[0][0];
    await act(async () => {
      errorCb({ taskId: "some-other-task", error: "unrelated" });
    });
    await flush();

    // Still running — the stray error was for another task.
    expect(container.querySelector('[data-testid="ping-start"]')).toBeNull();
    void networkPingStop;
    void onPingResult;
    void onPingComplete;
  });
});
