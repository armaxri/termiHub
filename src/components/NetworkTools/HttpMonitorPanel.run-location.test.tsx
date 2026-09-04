/**
 * The HTTP monitor panel lets the user choose where a monitor runs — This
 * computer (default) or a connected agent — and forwards that choice to the
 * backend start call (#2592). This pins that:
 *   - the "Run on" selector is rendered on the panel, and
 *   - starting a monitor forwards the chosen run-location to
 *     `networkHttpMonitorStart` and records it in the run-location store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorStart } from "@/services/networkApi";
import { useRunLocationStore } from "@/store/runLocationStore";
import { THIS_COMPUTER } from "@/utils/runLocation";
import { HttpMonitorPanel } from "./HttpMonitorPanel";
import { withTooltip } from "@/test/tooltip";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: vi.fn(() => Promise.resolve("mon-1")),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorRemove: vi.fn(() => Promise.resolve()),
  networkHttpMonitorPause: vi.fn(() => Promise.resolve()),
  networkHttpMonitorResume: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("HttpMonitorPanel — run-location", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useRunLocationStore.setState({ monitorLocations: {} });
    vi.mocked(networkHttpMonitorStart).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the Run on selector", async () => {
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    await flush();
    expect(container.querySelector('[data-testid="http-monitor-run-location"]')).not.toBeNull();
  });

  it("forwards the run-location to start and records it in the store", async () => {
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    await flush();

    const urlInput = container.querySelector<HTMLInputElement>('[data-testid="http-monitor-url"]')!;
    setInputValue(urlInput, "https://example.com/health");
    await flush();

    const start = container.querySelector<HTMLButtonElement>('[data-testid="http-monitor-start"]')!;
    await act(async () => {
      start.click();
    });
    await flush();

    // Default vantage is This computer; it is forwarded as the 6th argument.
    expect(networkHttpMonitorStart).toHaveBeenCalledTimes(1);
    const args = vi.mocked(networkHttpMonitorStart).mock.calls[0];
    expect(args[5]).toEqual(THIS_COMPUTER);
    // ...and the chosen location is recorded against the created monitor id.
    expect(useRunLocationStore.getState().monitorLocations["mon-1"]).toEqual(THIS_COMPUTER);
  });
});
