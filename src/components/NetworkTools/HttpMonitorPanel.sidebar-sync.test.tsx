/**
 * Regression test for #5814: stopping, pausing or resuming an HTTP monitor
 * from its panel must update the shared `httpMonitors` slice the Network Tools
 * sidebar renders, so the sidebar row flips to "Stopped" / "Paused" at once
 * instead of keeping the last running state (red "Down") until a remount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  networkHttpMonitorList,
  networkHttpMonitorPause,
  networkHttpMonitorStop,
} from "@/services/networkApi";
import type { HttpMonitorState } from "@/types/network";
import { useAppStore } from "@/store/appStore";
import { HttpMonitorPanel } from "./HttpMonitorPanel";
import { NetworkToolsSidebar } from "./NetworkToolsSidebar";
import { withTooltip } from "@/test/tooltip";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: vi.fn(() => Promise.resolve("mon-1")),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorPause: vi.fn(() => Promise.resolve()),
  networkHttpMonitorResume: vi.fn(() => Promise.resolve()),
  networkHttpMonitorRemove: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
  onHttpMonitorChanged: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
// LatencyChart draws to a canvas jsdom can't back; stub it out.
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

function makeMonitor(over: Partial<HttpMonitorState> = {}): HttpMonitorState {
  return {
    config: {
      id: "mon-2",
      url: "https://example.com",
      intervalMs: 30_000,
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 10_000,
    },
    running: true,
    paused: false,
    lastResult: {
      monitorId: "mon-2",
      timestampMs: Date.now(),
      ok: false,
      error: "connection refused",
    },
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("HttpMonitorPanel — keeps the sidebar slice in sync (#5814)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState({ httpMonitors: [] });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("stopping from the panel flips the sidebar row to Stopped", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor()]);
    await act(async () => {
      root.render(
        withTooltip(
          <>
            <NetworkToolsSidebar />
            <HttpMonitorPanel />
          </>
        )
      );
    });
    await flush();
    expect(useAppStore.getState().httpMonitors[0]?.running).toBe(true);

    // The backend now reports the monitor stopped; the panel emits no check event.
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor({ running: false })]);
    const stopButtons = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Stop monitoring https://example.com"]'
    );
    // The panel renders after the sidebar, so its Stop is the last match.
    const stop = stopButtons[stopButtons.length - 1];
    expect(stop).toBeTruthy();
    await act(async () => {
      stop.click();
    });
    await flush();

    expect(networkHttpMonitorStop).toHaveBeenCalledWith("mon-2");
    expect(useAppStore.getState().httpMonitors[0]?.running).toBe(false);
    expect(container.textContent).toContain("Stopped");
  });

  it("pausing from the panel updates the shared slice", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor()]);
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    await flush();

    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor({ paused: true })]);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Pause monitoring https://example.com"]')!
        .click();
    });
    await flush();

    expect(networkHttpMonitorPause).toHaveBeenCalledWith("mon-2");
    expect(useAppStore.getState().httpMonitors[0]?.paused).toBe(true);
  });
});
