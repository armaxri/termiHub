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

const { start, remove } = vi.hoisted(() => ({
  start: vi.fn(() => Promise.resolve("new-1")),
  remove: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorStart: start,
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorRemove: remove,
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

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function openRepair() {
  vi.mocked(networkHttpMonitorList).mockResolvedValue([ODD]);
  await act(async () => root.render(withTooltip(<HttpMonitorPanel />)));
  await act(async () => {
    await Promise.resolve();
  });
  expect(q("monitor-resume-odd")).toBeNull();
  await act(async () => q("monitor-step-setUpAgain-odd")!.click());
}

describe("set it up again (F-009)", () => {
  it("fills the form with its settings for Run on to be chosen", async () => {
    await openRepair();
    expect(value("http-monitor-url")).toBe("https://status.cloud/");
    expect(value("http-monitor-interval")).toBe("45");
    expect(value("http-monitor-expected-status")).toBe("204");
    expect(value("http-monitor-timeout")).toBe("7");
    expect(value("http-monitor-name")).toBe("Cloud status");
    expect(value("http-monitor-description")).toBe("The provider's page");
    expect(q("http-monitor-method")?.getAttribute("data-value")).toBe("HEAD");
  });

  it("is a repair screen: its title, Run on to choose, Save and start, Cancel (round 2)", async () => {
    await openRepair();
    expect(q("http-monitor-title")?.textContent).toBe("Set up Cloud status again");
    expect(q("http-monitor-run-location")?.getAttribute("data-value")).toBe("");
    expect(container.textContent).toContain("Choose where it runs");
    const save = q("http-monitor-start") as HTMLButtonElement;
    expect(save.textContent).toContain("Save and start");
    expect(save.disabled).toBe(true);
    await act(async () => q("http-monitor-repair-cancel")!.click());
    expect(q("http-monitor-title")?.textContent).toBe("HTTP Monitor");
    expect(value("http-monitor-url")).toBe("https://");
    expect(q("http-monitor-run-location")?.getAttribute("data-value")).toBe("this");
  });
});
