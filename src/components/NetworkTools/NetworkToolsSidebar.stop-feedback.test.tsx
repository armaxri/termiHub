/**
 * Regression test for gap #10 from the HTTP monitor audit (#1147).
 *
 * The sidebar's stop path previously only logged failures via frontendLog and
 * gave no feedback at all on success. These tests pin that stopping a monitor
 * from the sidebar emits a success toast on success and an error toast on
 * failure (design-system rule 4: every action gives feedback).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorList, networkHttpMonitorStop } from "@/services/networkApi";
import type { HttpMonitorState } from "@/types/network";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import { NetworkToolsSidebar } from "./NetworkToolsSidebar";
import { withTooltip } from "@/test/tooltip";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
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
    paused: false,
  };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("NetworkToolsSidebar — stop feedback (#1147 gap #10)", () => {
  beforeEach(() => {
    useAppStore.setState({ httpMonitors: [makeMonitor("mon-1")] });
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

  it("shows a success toast when a monitor is stopped from the sidebar", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor("mon-1")]);
    await act(async () => {
      root.render(withTooltip(<NetworkToolsSidebar />));
    });
    await flush();

    const stopBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="monitor-row-mon-1"] [aria-label="Stop monitor"]'
    );
    expect(stopBtn).not.toBeNull();
    await act(async () => {
      stopBtn!.click();
    });
    await flush();

    expect(toast.success).toHaveBeenCalledWith("Monitor stopped");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows an error toast when stopping a monitor from the sidebar fails", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor("mon-1")]);
    vi.mocked(networkHttpMonitorStop).mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      root.render(withTooltip(<NetworkToolsSidebar />));
    });
    await flush();

    const stopBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="monitor-row-mon-1"] [aria-label="Stop monitor"]'
    );
    await act(async () => {
      stopBtn!.click();
    });
    await flush();

    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
