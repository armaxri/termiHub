/**
 * A monitor whose machine termiHub cannot read is set up again from its row
 * (F-009): its settings fill the form, where Run on is chosen next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorList } from "@/services/networkApi";
import type { HttpMonitorState } from "@/types/network";
import { withTooltip } from "@/test/tooltip";
import { HttpMonitorPanel } from "./HttpMonitorPanel";

vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: vi.fn(() => Promise.resolve("mon-1")),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorRemove: vi.fn(() => Promise.resolve()),
  networkHttpMonitorPause: vi.fn(() => Promise.resolve()),
  networkHttpMonitorResume: vi.fn(() => Promise.resolve()),
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
  onHttpMonitorChanged: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("./LatencyChart", () => ({ LatencyChart: () => null }));

const ODD: HttpMonitorState = {
  config: {
    id: "odd",
    url: "https://status.cloud/",
    intervalMs: 45_000,
    method: "HEAD",
    expectedStatus: 204,
    timeoutMs: 7_000,
    name: "Cloud status",
    description: "The provider's page",
    host: { kind: "cloud" } as never,
  },
  running: false,
  paused: false,
  status: "error",
  reason: "Not started: termiHub cannot read where it runs.",
};

let container: HTMLDivElement;
let root: Root;
const value = (id: string) =>
  container.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)!.value;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("set it up again (F-009)", () => {
  it("fills the form with its settings for Run on to be chosen", async () => {
    vi.mocked(networkHttpMonitorList).mockResolvedValue([ODD]);
    await act(async () => root.render(withTooltip(<HttpMonitorPanel />)));
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="monitor-resume-odd"]')).toBeNull();
    await act(async () =>
      container.querySelector<HTMLElement>('[data-testid="monitor-step-setUpAgain-odd"]')!.click()
    );
    expect(value("http-monitor-url")).toBe("https://status.cloud/");
    expect(value("http-monitor-interval")).toBe("45");
    expect(value("http-monitor-expected-status")).toBe("204");
    expect(value("http-monitor-timeout")).toBe("7");
    expect(value("http-monitor-name")).toBe("Cloud status");
    expect(value("http-monitor-description")).toBe("The provider's page");
    expect(
      container.querySelector('[data-testid="http-monitor-method"]')?.getAttribute("data-value")
    ).toBe("HEAD");
  });
});
