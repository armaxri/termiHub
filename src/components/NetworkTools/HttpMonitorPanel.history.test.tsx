/**
 * Persisted check history in the HTTP monitor panel (#3462).
 *
 * A monitor's checks are recorded by the backend, so the panel can show them
 * again after the monitor was stopped and resumed, or after an app restart
 * (a fresh mount listing stopped monitors). These tests pin that the panel
 * rehydrates the chart/table from `list_http_monitor_checks`, keeps streaming
 * live checks on top, keeps the checks visible after a stop, and exports a
 * monitor's full history as CSV.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import {
  networkHttpMonitorList,
  networkHttpMonitorResume,
  onHttpMonitorCheck,
} from "@/services/networkApi";
import { listHttpMonitorChecks } from "@/services/networkHistoryApi";
import type { HttpCheckResult, HttpMonitorState } from "@/types/network";
import { HttpMonitorPanel } from "./HttpMonitorPanel";
import { withTooltip } from "@/test/tooltip";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: vi.fn(() => Promise.resolve("mon-new")),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorRemove: vi.fn(() => Promise.resolve()),
  networkHttpMonitorPause: vi.fn(() => Promise.resolve()),
  networkHttpMonitorResume: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/services/networkHistoryApi", () => ({
  listHttpMonitorChecks: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: vi.fn() }));

function stoppedMonitor(id: string): HttpMonitorState {
  return {
    config: {
      id,
      url: "https://example.com",
      intervalMs: 30_000,
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 10_000,
    },
    running: false,
    paused: false,
  };
}

function check(timestampMs: number, overrides: Partial<HttpCheckResult> = {}): HttpCheckResult {
  return {
    monitorId: "mon-1",
    statusCode: 200,
    latencyMs: 10,
    ok: true,
    timestampMs,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function click(testId: string) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!.click();
  });
  await flush();
}

async function mount() {
  await act(async () => {
    root.render(withTooltip(<HttpMonitorPanel />));
  });
  await flush();
}

/** The most recently registered check listener. */
function lastListener(): (result: HttpCheckResult) => void {
  const calls = vi.mocked(onHttpMonitorCheck).mock.calls;
  return calls[calls.length - 1][0];
}

function historyRows(): number {
  return container.querySelectorAll('[data-testid^="http-monitor-entry-"]').length;
}

describe("HttpMonitorPanel — persisted check history (#3462)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(networkHttpMonitorList).mockResolvedValue([stoppedMonitor("mon-1")]);
    vi.mocked(listHttpMonitorChecks).mockResolvedValue([check(1), check(2, { ok: false })]);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows a stopped monitor's recorded checks after a restart", async () => {
    await mount();
    expect(container.querySelector('[data-testid="http-monitor-history"]')).toBeNull();

    await click("monitor-show-mon-1");

    expect(listHttpMonitorChecks).toHaveBeenCalledWith("mon-1", 120);
    expect(container.querySelector('[data-testid="http-monitor-history"]')).not.toBeNull();
    expect(historyRows()).toBe(2);
    expect(container.querySelector('[data-testid="http-monitor-chart"]')).not.toBeNull();
  });

  it("rehydrates the history on resume and appends live checks", async () => {
    await mount();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Resume monitoring https://example.com"]')!
        .click();
    });
    await flush();

    expect(networkHttpMonitorResume).toHaveBeenCalledWith("mon-1");
    expect(listHttpMonitorChecks).toHaveBeenCalledWith("mon-1", 120);
    expect(historyRows()).toBe(2);

    const listener = lastListener();
    await act(async () => {
      listener(check(3));
      listener(check(4, { monitorId: "other" }));
    });
    await flush();
    expect(historyRows()).toBe(3);
  });

  it("keeps the checks visible after stopping the active monitor", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([]);
    await mount();
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('[data-testid="http-monitor-url"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "https://example.com");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("http-monitor-start");
    const listener = lastListener();
    await act(async () => {
      listener(check(5, { monitorId: "mon-new" }));
    });
    await flush();
    expect(historyRows()).toBe(1);

    vi.mocked(networkHttpMonitorList).mockResolvedValue([
      { ...stoppedMonitor("mon-new"), running: false },
    ]);
    await click("http-monitor-stop");

    expect(historyRows()).toBe(1);
    // The stopped monitor can be started again from the form.
    expect(container.querySelector('[data-testid="http-monitor-start"]')).not.toBeNull();
  });

  it("exports the monitor's full history as CSV", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/out.csv");
    await mount();
    await click("monitor-show-mon-1");

    await click("http-monitor-export");

    // The export fetches the whole stored series, not just the chart window.
    expect(listHttpMonitorChecks).toHaveBeenLastCalledWith("mon-1");
    const [path, csv] = vi.mocked(writeTextFile).mock.calls[0];
    expect(path).toBe("/tmp/out.csv");
    expect(String(csv).split("\n")[0]).toBe("timestamp,status_code,latency_ms,ok,error");
    expect(String(csv).trim().split("\n")).toHaveLength(3);
  });
});
