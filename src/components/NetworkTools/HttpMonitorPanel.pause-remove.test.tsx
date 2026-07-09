/**
 * Tests for HTTP monitor Pause/Resume and Stop-vs-Remove (#1147 gaps #5, #6).
 *
 * Gap #6: "Stop" must cancel the poll loop but keep the monitor listed
 * (running:false) so it can be resumed; a separate "Remove" deletes it.
 * Gap #5: "Pause" suspends polling (running stays true, paused:true) and
 * "Resume" restarts it with the same config.
 *
 * These pin the panel's per-monitor controls to the correct backend calls and
 * feedback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import {
  networkHttpMonitorPause,
  networkHttpMonitorResume,
  networkHttpMonitorRemove,
  networkHttpMonitorList,
} from "@/services/networkApi";
import type { HttpMonitorState } from "@/types/network";
import { toast } from "@/components/ui";
import { HttpMonitorPanel } from "./HttpMonitorPanel";
import { withTooltip } from "@/test/tooltip";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: vi.fn(() => Promise.resolve("mon-1")),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorPause: vi.fn(() => Promise.resolve()),
  networkHttpMonitorResume: vi.fn(() => Promise.resolve()),
  networkHttpMonitorRemove: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

vi.mock("@/components/ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/ui")>("@/components/ui");
  return {
    ...actual,
    toast: { success: vi.fn(), error: vi.fn() },
  };
});

vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

function makeMonitor(id: string, overrides: Partial<HttpMonitorState> = {}): HttpMonitorState {
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
    paused: false,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderPanel() {
  await act(async () => {
    root.render(withTooltip(<HttpMonitorPanel />));
  });
  await flush();
}

describe("HttpMonitorPanel — pause/resume + stop vs remove (#1147 gaps #5, #6)", () => {
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

  it("a running monitor exposes Pause and Remove controls", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor("mon-1")]);
    await renderPanel();

    expect(
      container.querySelector('[aria-label="Pause monitoring https://example.com"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Remove monitor https://example.com"]')
    ).not.toBeNull();
  });

  it("Pause calls the pause API and toasts", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor("mon-1")]);
    await renderPanel();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Pause monitoring https://example.com"]')!
        .click();
    });
    await flush();

    expect(networkHttpMonitorPause).toHaveBeenCalledWith("mon-1");
    expect(toast.success).toHaveBeenCalled();
  });

  it("a paused monitor exposes a Resume control that calls the resume API", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor("mon-1", { paused: true })]);
    await renderPanel();

    const resumeBtn = container.querySelector<HTMLButtonElement>(
      '[aria-label="Resume monitoring https://example.com"]'
    );
    expect(resumeBtn).not.toBeNull();

    await act(async () => {
      resumeBtn!.click();
    });
    await flush();

    expect(networkHttpMonitorResume).toHaveBeenCalledWith("mon-1");
  });

  it("a stopped monitor stays listed and exposes a Resume control", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor("mon-1", { running: false })]);
    await renderPanel();

    expect(container.querySelector('[data-testid="monitor-row-mon-1"]')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Resume monitoring https://example.com"]')
    ).not.toBeNull();
  });

  it("Remove calls the remove API (not stop) and toasts", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor("mon-1")]);
    await renderPanel();

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[aria-label="Remove monitor https://example.com"]')!
        .click();
    });
    await flush();

    expect(networkHttpMonitorRemove).toHaveBeenCalledWith("mon-1");
    expect(toast.success).toHaveBeenCalled();
  });
});
