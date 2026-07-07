/**
 * Regression test for gap #10 from the HTTP monitor audit (#1147).
 *
 * Stopping a monitor previously updated component state but surfaced no
 * feedback — a successful stop was silent and a failed stop only set an inline
 * error string (violating design-system rule 4: every action gives feedback).
 * These tests pin that the panel's stop paths emit a success toast on success
 * and an error toast on failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorStop, networkHttpMonitorList } from "@/services/networkApi";
import type { HttpMonitorState } from "@/types/network";
import { toast } from "@/components/ui";
import { HttpMonitorPanel } from "./HttpMonitorPanel";
import { withTooltip } from "@/test/tooltip";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: vi.fn(() => Promise.resolve("mon-1")),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
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

// LatencyChart draws to a canvas jsdom can't back; stub it out.
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

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

/** Set a React-controlled input's value via the native setter so onChange fires. */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function startActiveMonitor() {
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

describe("HttpMonitorPanel — stop feedback (#1147 gap #10)", () => {
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

  it("shows a success toast when the active monitor stops", async () => {
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    await flush();
    await startActiveMonitor();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="http-monitor-stop"]')!.click();
    });
    await flush();

    expect(toast.success).toHaveBeenCalledWith("Monitor stopped");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows an error toast when stopping the active monitor fails", async () => {
    vi.mocked(networkHttpMonitorStop).mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    await flush();
    await startActiveMonitor();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="http-monitor-stop"]')!.click();
    });
    await flush();

    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shows a success toast when stopping a listed running monitor", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor("mon-2")]);
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    await flush();

    const stopBtn = container.querySelector<HTMLButtonElement>(
      '[aria-label="Stop monitoring https://example.com"]'
    );
    expect(stopBtn).not.toBeNull();
    await act(async () => {
      stopBtn!.click();
    });
    await flush();

    expect(toast.success).toHaveBeenCalledWith("Monitor stopped");
  });

  it("shows an error toast when stopping a listed running monitor fails", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([makeMonitor("mon-2")]);
    vi.mocked(networkHttpMonitorStop).mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    await flush();

    const stopBtn = container.querySelector<HTMLButtonElement>(
      '[aria-label="Stop monitoring https://example.com"]'
    );
    await act(async () => {
      stopBtn!.click();
    });
    await flush();

    expect(toast.error).toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });
});
