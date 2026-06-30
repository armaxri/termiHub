/**
 * Regression test for the HTTP monitor first-check race (issue #1002).
 *
 * When a monitor starts, the backend runs an *immediate* first check before the
 * first interval sleep (`http_monitor.rs` calls `check_once` up front). The panel
 * previously attached its `network-http-monitor-check` listener in a `useEffect`
 * gated on `activeMonitorId`, which is only set *after* `networkHttpMonitorStart`
 * resolves — so that immediate check could be emitted before the listener existed
 * and the panel showed an empty history for up to one interval (default 30s).
 *
 * The fix mirrors `PingPanel`: register the listener *before* issuing the start
 * command and filter by the monitor id (set synchronously the moment start
 * resolves). These tests pin that ordering and that the first check renders.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorStart, onHttpMonitorCheck } from "@/services/networkApi";
import type { HttpCheckResult } from "@/types/network";
import { HttpMonitorPanel } from "./HttpMonitorPanel";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: vi.fn(() => Promise.resolve("mon-1")),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

// LatencyChart draws to a canvas jsdom can't back; stub it so the chart section
// (gated on history.length > 0) renders without touching <canvas>.
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function checkResult(monitorId: string): HttpCheckResult {
  return {
    monitorId,
    statusCode: 200,
    latencyMs: 12,
    ok: true,
    timestampMs: 1_700_000_000_000,
  };
}

/** Set a React-controlled input's value via the native setter so onChange fires. */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function clickStart() {
  await act(async () => {
    setInputValue(
      container.querySelector<HTMLInputElement>('[data-testid="http-monitor-url"]')!,
      "https://example.com"
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="http-monitor-start"]')!.click();
  });
  await flush();
}

describe("HttpMonitorPanel — first-check race", () => {
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

  it("registers the check listener before starting the monitor", async () => {
    await act(async () => {
      root.render(<HttpMonitorPanel />);
    });
    await flush();

    await clickStart();

    // The backend emits the immediate first check as soon as the spawned task
    // runs, so the listener must be attached before networkHttpMonitorStart is
    // invoked — otherwise that first check is lost until the next interval.
    const startOrder = vi.mocked(networkHttpMonitorStart).mock.invocationCallOrder[0];
    const listenOrder = vi.mocked(onHttpMonitorCheck).mock.invocationCallOrder[0];
    expect(listenOrder).toBeLessThan(startOrder);
  });

  it("shows the immediate first check for the started monitor", async () => {
    await act(async () => {
      root.render(<HttpMonitorPanel />);
    });
    await flush();

    await clickStart();

    // Emit the immediate first check for the monitor we just started.
    const checkCb = vi.mocked(onHttpMonitorCheck).mock.calls[0][0];
    await act(async () => {
      checkCb(checkResult("mon-1"));
    });
    await flush();

    // The history table appears with the first check rather than staying empty.
    expect(container.querySelector('[data-testid="http-monitor-history"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="http-monitor-entry-0"]')).not.toBeNull();
    expect(container.textContent).toContain("200");
  });

  it("ignores checks for a different monitor id", async () => {
    await act(async () => {
      root.render(<HttpMonitorPanel />);
    });
    await flush();

    await clickStart();

    // A check for an unrelated monitor (the channel is global across monitors)
    // must not pollute the active monitor's history.
    const checkCb = vi.mocked(onHttpMonitorCheck).mock.calls[0][0];
    await act(async () => {
      checkCb(checkResult("some-other-monitor"));
    });
    await flush();

    expect(container.querySelector('[data-testid="http-monitor-history"]')).toBeNull();
  });
});
