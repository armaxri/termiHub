/**
 * Monitoring-row actions of the Open Connections panel driven through the real
 * store actions down to the mocked backend commands (COV-015, #5275): setting
 * the refresh interval, pause/resume, retry, and killing one or every monitor.
 * Each action asserts the backend command it reaches and the toast the user
 * sees, on success and on failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { MonitoringEntry } from "@/types/monitoring";
import { ensureMonitorsSubscribed } from "@/store/systemMonitorBridge";
import {
  installMonitorHarness,
  monitorsView,
  type FakeMonitorTransport,
} from "@/test/systemMonitorHarness";

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

const toastError = vi.fn();
const toastSuccess = vi.fn();
const sessionMonitoringSetInterval = vi.fn<(id: string, ms: number) => Promise<void>>();
const sessionMonitoringSetPaused = vi.fn<(id: string, paused: boolean) => Promise<void>>();
const sessionMonitoringClose = vi.fn<(id: string) => Promise<void>>();
const sessionMonitoringOpen = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  sessionMonitoringSetInterval: (id: string, ms: number) => sessionMonitoringSetInterval(id, ms),
  sessionMonitoringSetPaused: (id: string, paused: boolean) =>
    sessionMonitoringSetPaused(id, paused),
  sessionMonitoringClose: (id: string) => sessionMonitoringClose(id),
  sessionMonitoringOpen: (...args: unknown[]) => sessionMonitoringOpen(...args),
  sessionMonitoringCancel: vi.fn(() => Promise.resolve()),
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

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: {
      ...actual.toast,
      error: (m: string) => toastError(m),
      success: (m: string) => toastSuccess(m),
    },
  };
});

import { OpenConnectionsModal } from "./OpenConnectionsModal";

function monitorEntry(key: string, patch: Partial<MonitoringEntry> = {}): MonitoringEntry {
  return {
    key,
    host: key,
    monitorSessionId: `mon-${key}`,
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

const KEY = "user@host:22";
const OTHER = "root@nas:22";

describe("OpenConnectionsModal — monitoring row actions reach the backend (COV-015)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let transport: FakeMonitorTransport;
  let teardownMonitors: () => void;

  function seed(entries: MonitoringEntry[]) {
    transport.seed(monitorsView(entries));
  }

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    ({ transport, teardown: teardownMonitors } = installMonitorHarness());
    await ensureMonitorsSubscribed();
    toastError.mockClear();
    toastSuccess.mockClear();
    sessionMonitoringSetInterval.mockReset().mockResolvedValue(undefined);
    sessionMonitoringSetPaused.mockReset().mockResolvedValue(undefined);
    sessionMonitoringClose.mockReset().mockResolvedValue(undefined);
    sessionMonitoringOpen.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    teardownMonitors();
  });

  async function renderModal() {
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
    await flushAsync();
  }

  async function click(testId: string) {
    const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    expect(el, `${testId} should exist`).not.toBeNull();
    await act(async () => el!.click());
    await flushAsync();
  }

  /** Open the refresh-interval menu for `key` and pick `ms`. */
  async function pickInterval(key: string, ms: number) {
    const trigger = document.querySelector<HTMLButtonElement>(
      `[data-testid="monitor-interval-${key}"]`
    );
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger!.focus();
      trigger!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flushAsync();
    await click(`monitor-interval-${key}-${ms}`);
  }

  it("setting the interval reconfigures the backend loop and confirms it", async () => {
    seed([monitorEntry(KEY)]);
    await renderModal();

    await pickInterval(KEY, 5000);

    expect(sessionMonitoringSetInterval).toHaveBeenCalledWith(`mon-${KEY}`, 5000);
    expect(toastSuccess).toHaveBeenCalledWith("Refresh interval set to 5s");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("a failed interval change toasts the reason instead of success", async () => {
    sessionMonitoringSetInterval.mockRejectedValue(new Error("loop gone"));
    seed([monitorEntry(KEY)]);
    await renderModal();

    await pickInterval(KEY, 10000);

    expect(sessionMonitoringSetInterval).toHaveBeenCalledWith(`mon-${KEY}`, 10000);
    expect(toastError).toHaveBeenCalledWith("Failed to set interval: loop gone");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("Pause reaches the backend and confirms; a failed Resume toasts the reason", async () => {
    seed([monitorEntry(KEY), monitorEntry(OTHER, { paused: true, status: "paused" })]);
    await renderModal();

    await click(`monitor-pause-${KEY}`);
    expect(sessionMonitoringSetPaused).toHaveBeenCalledWith(`mon-${KEY}`, true);
    expect(toastSuccess).toHaveBeenCalledWith("Monitoring paused");

    sessionMonitoringSetPaused.mockRejectedValueOnce(new Error("busy"));
    await click(`monitor-resume-${OTHER}`);
    expect(sessionMonitoringSetPaused).toHaveBeenCalledWith(`mon-${OTHER}`, false);
    expect(toastError).toHaveBeenCalledWith("Failed to resume monitoring: busy");
  });

  it("Retry closes the stale subscription and reopens it", async () => {
    seed([monitorEntry(KEY, { status: "offline" })]);
    await renderModal();

    await click(`monitor-retry-${KEY}`);

    expect(sessionMonitoringClose).toHaveBeenCalledWith(`mon-${KEY}`);
    expect(sessionMonitoringOpen).toHaveBeenCalledWith(KEY, KEY, 2000, expect.anything());
    expect(toastSuccess).toHaveBeenCalledWith("Retrying monitor");
  });

  it("a failed Retry reopen toasts the reason", async () => {
    sessionMonitoringOpen.mockRejectedValue(new Error("host unreachable"));
    seed([monitorEntry(KEY, { status: "offline" })]);
    await renderModal();

    await click(`monitor-retry-${KEY}`);

    expect(toastError).toHaveBeenCalledWith("Failed to retry monitoring: host unreachable");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("Kill All closes every monitor's backend session", async () => {
    seed([monitorEntry(KEY), monitorEntry(OTHER)]);
    await renderModal();

    const killAll = document.querySelector(
      '[aria-label="Kill All Monitoring"]'
    ) as HTMLButtonElement;
    expect(killAll).not.toBeNull();
    await act(async () => killAll.click());
    const confirm = document.querySelector(
      '[data-testid="confirm-dialog-confirm"]'
    ) as HTMLButtonElement;
    await act(async () => confirm.click());
    await flushAsync();

    expect(sessionMonitoringClose).toHaveBeenCalledWith(`mon-${KEY}`);
    expect(sessionMonitoringClose).toHaveBeenCalledWith(`mon-${OTHER}`);
  });
});
