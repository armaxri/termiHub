/**
 * Regression (#4017): the SSRF guard (SEC-008) blocks loopback and private
 * targets unless the monitor opts in, but the opt-in was never reachable from
 * the UI — so no HTTP monitor could watch `localhost` or a LAN host. The panel
 * now offers an "Allow private network" checkbox, off by default, and forwards
 * it to `networkHttpMonitorStart` as the 7th argument.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorStart } from "@/services/networkApi";
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

describe("HttpMonitorPanel — private-network opt-in", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(networkHttpMonitorStart).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function startMonitor(url: string, allowPrivate: boolean) {
    await act(async () => {
      root.render(withTooltip(<HttpMonitorPanel />));
    });
    await flush();
    const urlInput = container.querySelector<HTMLInputElement>('[data-testid="http-monitor-url"]')!;
    act(() => setInputValue(urlInput, url));
    await flush();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="http-monitor-allow-private"]'
    );
    expect(toggle).not.toBeNull();
    expect(toggle!.getAttribute("aria-checked")).toBe("false");
    if (allowPrivate) {
      await act(async () => {
        toggle!.click();
      });
      expect(toggle!.getAttribute("aria-checked")).toBe("true");
    }
    const start = container.querySelector<HTMLButtonElement>('[data-testid="http-monitor-start"]')!;
    await act(async () => {
      start.click();
    });
    await flush();
    expect(networkHttpMonitorStart).toHaveBeenCalledTimes(1);
    return vi.mocked(networkHttpMonitorStart).mock.calls[0];
  }

  it("keeps private targets blocked by default", async () => {
    const args = await startMonitor("https://example.com/health", false);
    expect(args[6]).toBe(false);
  });

  it("forwards the opt-in so a loopback target can be monitored", async () => {
    const args = await startMonitor("http://127.0.0.1:8080/", true);
    expect(args[6]).toBe(true);
  });
});
