/**
 * Tests for the per-host monitoring controls in the Open Connections panel
 * (#1233): each live monitoring row gains a Pause/Resume toggle, a refresh
 * interval selector, and — when offline — a Retry, composed from shared
 * primitives with feedback-on-every-action. The rows are driven by the store's
 * keyed `monitors` map (only entries with a live `monitorSessionId` are shown).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { MonitoringEntry } from "@/types/monitoring";

// jsdom lacks the observer/pointer-capture APIs Radix touches on mount.
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

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  xServerStatus: vi.fn(() =>
    Promise.resolve({ state: "absent", platform: "linux", managed: false })
  ),
  xServerStop: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorStopAll: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
}));

import { OpenConnectionsModal } from "./OpenConnectionsModal";

const KEY = "user@host:22";

function monitorEntry(patch: Partial<MonitoringEntry> = {}): MonitoringEntry {
  return {
    key: KEY,
    host: KEY,
    monitorSessionId: "sess-1",
    stats: null,
    loading: false,
    error: null,
    status: "live",
    sampleCount: 2,
    paused: false,
    intervalMs: 2000,
    ...patch,
  };
}

function monitorSection(): HTMLElement | null {
  const title = Array.from(document.querySelectorAll(".oc-section__title")).find(
    (t) => t.textContent === "Monitoring"
  );
  return (title?.closest("div")?.parentElement as HTMLElement) ?? null;
}

describe("OpenConnectionsModal — per-host monitoring controls (#1233)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderModal() {
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
  }

  it("renders Pause and interval controls on a live monitoring row", () => {
    useAppStore.setState({ monitors: { [KEY]: monitorEntry() } });
    renderModal();

    expect(monitorSection()).not.toBeNull();
    expect(document.querySelector(`[data-testid="monitor-pause-${KEY}"]`)).not.toBeNull();
    const interval = document.querySelector(`[data-testid="monitor-interval-${KEY}"]`);
    expect(interval).not.toBeNull();
    expect(interval!.textContent).toContain("2s");
  });

  it("Pause invokes setMonitoringPaused(key, true)", async () => {
    const setMonitoringPaused = vi.fn(() => Promise.resolve());
    useAppStore.setState({ monitors: { [KEY]: monitorEntry() }, setMonitoringPaused });
    renderModal();

    const pause = document.querySelector(
      `[data-testid="monitor-pause-${KEY}"]`
    ) as HTMLButtonElement;
    await act(async () => {
      pause.click();
    });
    expect(setMonitoringPaused).toHaveBeenCalledWith(KEY, true);
  });

  it("shows a Resume control (not Pause) when the entry is paused", () => {
    useAppStore.setState({ monitors: { [KEY]: monitorEntry({ paused: true, status: "paused" }) } });
    renderModal();

    expect(document.querySelector(`[data-testid="monitor-resume-${KEY}"]`)).not.toBeNull();
    expect(document.querySelector(`[data-testid="monitor-pause-${KEY}"]`)).toBeNull();
    const badge = monitorSection()?.querySelector(".oc-row__badge");
    expect(badge?.textContent).toBe("paused");
  });

  it("shows a Retry control and error badge when the entry is offline", async () => {
    const connectMonitoring = vi.fn(() => Promise.resolve());
    const disconnectMonitoring = vi.fn(() => Promise.resolve());
    useAppStore.setState({
      monitors: { [KEY]: monitorEntry({ status: "offline" }) },
      connectMonitoring,
      disconnectMonitoring,
    });
    renderModal();

    const retry = document.querySelector(
      `[data-testid="monitor-retry-${KEY}"]`
    ) as HTMLButtonElement;
    expect(retry).not.toBeNull();
    const badge = monitorSection()?.querySelector(".oc-row__badge");
    expect(badge?.textContent).toBe("error");

    await act(async () => {
      retry.click();
    });
    // Retry tears down the stale subscription and re-subscribes (#1232/#1233).
    expect(disconnectMonitoring).toHaveBeenCalledWith(KEY);
    expect(connectMonitoring).toHaveBeenCalledWith(KEY, KEY);
  });

  it("does not render a Retry control while live", () => {
    useAppStore.setState({ monitors: { [KEY]: monitorEntry({ status: "live" }) } });
    renderModal();
    expect(document.querySelector(`[data-testid="monitor-retry-${KEY}"]`)).toBeNull();
  });
});
