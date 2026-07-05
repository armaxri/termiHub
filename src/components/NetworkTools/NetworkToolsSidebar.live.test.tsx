/**
 * Regression test for #986.
 *
 * The Network Tools sidebar's **Monitors** section only refreshed its list on
 * mount, on the manual Refresh button, and after a stop. So a monitor started
 * (from a panel) while the sidebar was already open never appeared — the list
 * kept showing "No monitors running" until a forced remount or manual refresh.
 *
 * The fix subscribes the sidebar to the live `network-http-monitor-check`
 * event and refetches when a check arrives, so a newly started monitor shows
 * up reactively (its first check fires immediately on start).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorList, onHttpMonitorCheck } from "@/services/networkApi";
import type { HttpMonitorState, HttpCheckResult } from "@/types/network";
import { useAppStore } from "@/store/appStore";
import { NetworkToolsSidebar } from "./NetworkToolsSidebar";
import { TooltipProvider } from "@/components/ui";

// jsdom lacks the observer/pointer-capture APIs Radix Tooltip touches when it
// mounts the tooltip-wrapped icon buttons; shim them so the sidebar renders.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
    ResizeObserverStub;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}

/** Wrap a subtree so the shared Tooltip primitive finds its provider. */
function withTooltip(ui: React.ReactElement): React.ReactElement {
  return <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>;
}

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

function makeMonitor(id: string): HttpMonitorState {
  return {
    config: {
      id,
      url: "https://example.com",
      intervalMs: 30_000,
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 10_000,
    },
    running: true,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("NetworkToolsSidebar — live monitor updates (#986)", () => {
  beforeEach(() => {
    useAppStore.setState({ httpMonitors: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    useAppStore.setState({ httpMonitors: [] });
  });

  it("subscribes to the http-monitor-check event on mount", async () => {
    await act(async () => {
      root.render(withTooltip(<NetworkToolsSidebar />));
    });
    await flush();

    expect(onHttpMonitorCheck).toHaveBeenCalledTimes(1);
  });

  it("shows a monitor started while the sidebar is already open", async () => {
    // Sidebar mounts with no monitors running.
    vi.mocked(networkHttpMonitorList).mockResolvedValueOnce([]);
    await act(async () => {
      root.render(withTooltip(<NetworkToolsSidebar />));
    });
    await flush();

    expect(container.textContent).toContain("No monitors running");

    // A monitor is now started elsewhere; the backend begins emitting checks
    // for it, and a fresh list now includes it.
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor("mon-1")]);
    const checkCb = vi.mocked(onHttpMonitorCheck).mock.calls[0][0];
    const result: HttpCheckResult = {
      monitorId: "mon-1",
      statusCode: 200,
      latencyMs: 42,
      ok: true,
      timestampMs: 1_700_000_000_000,
    };
    await act(async () => {
      checkCb(result);
    });
    await flush();

    // The sidebar refetched on the event and the new monitor row appears.
    expect(container.querySelector('[data-testid="monitor-row-mon-1"]')).not.toBeNull();
    expect(container.textContent).not.toContain("No monitors running");
  });

  it("unsubscribes from the event on unmount", async () => {
    const unlisten = vi.fn();
    vi.mocked(onHttpMonitorCheck).mockResolvedValueOnce(unlisten);
    await act(async () => {
      root.render(withTooltip(<NetworkToolsSidebar />));
    });
    await flush();

    act(() => root.unmount());
    // unmount() is called again in afterEach; guard it from throwing there.
    root = createRoot(container);

    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
