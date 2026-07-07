/**
 * Regression test for HTTP monitor audit gap #11.
 *
 * The sidebar dot only refreshes on check events, so for a long-interval
 * monitor it can show a stale "up" for minutes after the endpoint died. The
 * fix adds a relative "checked N ago" label and a stale/overdue indicator when
 * `now - timestampMs > 2×intervalMs`. This test pins `Date.now()` so the age is
 * deterministic and asserts the rendered indicator.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorList } from "@/services/networkApi";
import type { HttpMonitorState } from "@/types/network";
import { useAppStore } from "@/store/appStore";
import { NetworkToolsSidebar } from "./NetworkToolsSidebar";
import { withTooltip } from "@/test/tooltip";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const NOW = 1_700_000_000_000;

function makeMonitor(id: string, timestampMs: number, intervalMs: number): HttpMonitorState {
  return {
    config: {
      id,
      url: "https://example.com",
      intervalMs,
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 10_000,
    },
    running: true,
    paused: false,
    lastResult: {
      monitorId: id,
      statusCode: 200,
      latencyMs: 42,
      ok: true,
      timestampMs,
    },
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("NetworkToolsSidebar — staleness indicator (#1147, gap #11)", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    useAppStore.setState({ httpMonitors: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    useAppStore.setState({ httpMonitors: [] });
  });

  it("marks a monitor overdue when its last check is older than 2× interval", async () => {
    const interval = 30_000;
    // Last checked 5 minutes ago with a 30s interval → far past 2× interval.
    vi.mocked(networkHttpMonitorList).mockResolvedValue([
      makeMonitor("stale-1", NOW - 5 * 60_000, interval),
    ]);
    await act(async () => {
      root.render(withTooltip(<NetworkToolsSidebar />));
    });
    await flush();

    const row = container.querySelector('[data-testid="monitor-row-stale-1"]');
    expect(row).not.toBeNull();
    const stale = container.querySelector('[data-testid="monitor-stale-stale-1"]');
    expect(stale).not.toBeNull();
    expect(row?.textContent).toContain("overdue");
    // The relative age is shown so the user knows how old the reading is.
    expect(row?.textContent).toContain("5m ago");
  });

  it("does not mark a freshly checked monitor overdue", async () => {
    const interval = 30_000;
    // Last checked 10s ago with a 30s interval → fresh.
    vi.mocked(networkHttpMonitorList).mockResolvedValue([
      makeMonitor("fresh-1", NOW - 10_000, interval),
    ]);
    await act(async () => {
      root.render(withTooltip(<NetworkToolsSidebar />));
    });
    await flush();

    const row = container.querySelector('[data-testid="monitor-row-fresh-1"]');
    expect(row).not.toBeNull();
    expect(container.querySelector('[data-testid="monitor-stale-fresh-1"]')).toBeNull();
    expect(row?.textContent).not.toContain("overdue");
    expect(row?.textContent).toContain("10s ago");
  });
});
