/**
 * A sidebar monitor row reads like a Services row (F-009): where it runs, the
 * state word, the whole reason with its next step, and only the actions that
 * can be done now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { networkHttpMonitorList } from "@/services/networkApi";
import type { HttpMonitorState } from "@/types/network";
import { useAppStore } from "@/store/appStore";
import { seedAgentsRegion, setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { withTooltip } from "@/test/tooltip";
import { NetworkToolsSidebar } from "./NetworkToolsSidebar";

const { connectAgent } = vi.hoisted(() => ({ connectAgent: vi.fn(() => Promise.resolve()) }));
vi.mock("@/hooks/useConnectAgent", () => ({ useConnectAgent: () => connectAgent }));
vi.mock("@/services/networkApi", () => ({
  networkHttpMonitorList: vi.fn(() => Promise.resolve([])),
  networkHttpMonitorStop: vi.fn(() => Promise.resolve()),
  networkHttpMonitorPause: vi.fn(() => Promise.resolve()),
  networkHttpMonitorResume: vi.fn(() => Promise.resolve()),
  networkHttpMonitorRemove: vi.fn(() => Promise.resolve()),
  onHttpMonitorCheck: vi.fn(() => Promise.resolve(() => {})),
  onHttpMonitorChanged: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

setupAgentsRegion();

const OFFLINE =
  "Its agent is offline. It may still run there; termiHub cannot tell whether it checks.";
const UNREADABLE = "Not started: termiHub cannot read where it runs.";

function monitor(id: string, over: Partial<HttpMonitorState> = {}): HttpMonitorState {
  return {
    config: {
      id,
      url: `https://${id}.example.com/health`,
      intervalMs: 30_000,
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 10_000,
    },
    running: true,
    paused: false,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
const openTab = vi.fn();
const q = (sel: string) => container.querySelector<HTMLElement>(sel);
const labels = (id: string) =>
  [
    ...container.querySelectorAll(
      `[data-testid="monitor-row-${id}"] .sidebar-list-item__actions button`
    ),
  ].map((b) => b.getAttribute("aria-label"));

async function render(monitors: HttpMonitorState[]) {
  vi.mocked(networkHttpMonitorList).mockResolvedValue(monitors);
  await act(async () => root.render(withTooltip(<NetworkToolsSidebar />)));
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  useAppStore.setState({ httpMonitors: [], openNetworkDiagnosticTab: openTab });
  seedAgentsRegion({
    remoteAgents: [
      { id: "edge", name: "Edge gateway", config: {}, connectionState: "disconnected" } as never,
    ],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("a monitor row in the words of Services (F-009)", () => {
  it("says the machine it runs on", async () => {
    await render([
      monitor("far", {
        status: "running",
        config: { ...monitor("far").config, host: { kind: "agent", agentId: "edge" } } as never,
      }),
    ]);
    expect(q('[data-testid="monitor-machine-far"]')?.textContent).toBe("Edge gateway");
    // Cut at its end, never in the middle (F-009 round 2).
    expect(q('[data-testid="monitor-machine-far"] .network-sidebar__monitor-where')).not.toBeNull();
    expect(q('[data-testid="monitor-machine-here"]')).toBeNull();
  });

  it("not reachable: the state word, the whole reason, Connect agent, and no Resume", async () => {
    const far = monitor("far", {
      status: "notReachable",
      reason: OFFLINE,
      config: { ...monitor("far").config, host: { kind: "agent", agentId: "edge" } } as never,
    });
    await render([far]);
    // About its site, not its agent: "Agent offline" (F-009 round 2).
    expect(q('[data-testid="monitor-marker-far"]')?.textContent).toBe("Agent offline");
    expect(q('[data-testid="monitor-reason-far"]')?.textContent).toContain(OFFLINE);
    expect(labels("far")).not.toContain("Resume monitor");
    expect(labels("far")).toContain("Stop monitor");
    const step = q('[data-testid="monitor-step-connectAgent-far"]')!;
    expect(step.textContent).toBe("Connect agent");
    await act(async () => step.click());
    expect(connectAgent).toHaveBeenCalledWith("edge");
    expect(openTab).not.toHaveBeenCalled();
  });

  it("stopping: nothing to run", async () => {
    await render([monitor("bye", { status: "stopping" })]);
    expect(labels("bye")).toEqual([
      "Open monitor https://bye.example.com/health",
      "Delete monitor",
    ]);
  });

  it("cannot read where it runs: a next step that opens it", async () => {
    const odd = monitor("odd", {
      running: false,
      status: "error",
      reason: UNREADABLE,
      config: { ...monitor("odd").config, host: { kind: "fromNewerVersion" } } as never,
    });
    await render([odd]);
    expect(q('[data-testid="monitor-reason-odd"]')?.textContent).toContain(UNREADABLE);
    expect(q('[data-testid="monitor-machine-odd"]')?.textContent).toBe("Location unknown");
    expect(q('[data-testid="monitor-marker-odd"]')?.textContent).toBe("Not started");
    expect(labels("odd")).not.toContain("Resume monitor");
    const step = q('[data-testid="monitor-step-setUpAgain-odd"]')!;
    expect(step.textContent).toBe("Set it up again");
    await act(async () => step.click());
    expect(openTab).toHaveBeenCalled();
  });
});
