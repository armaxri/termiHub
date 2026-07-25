/**
 * Tests for the "Prune dead agents" footer action of the Open Connections
 * panel (G6, #1239): a manual escape hatch that sweeps backend agent entries
 * whose I/O task has already died (`alive=false`) but which linger in the
 * manager map. Routing is already safe, so this is pure resource hygiene.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";

const pruneDeadAgents = vi.fn(() => Promise.resolve<string[]>([]));
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  cancelConnectAgent: vi.fn(() => Promise.resolve(true)),
  pruneDeadAgents: () => pruneDeadAgents(),
  xServerStatus: vi.fn(() =>
    Promise.resolve({ state: "absent", platform: "linux", managed: false, sessionCount: 0 })
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
    toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
  };
});

import { OpenConnectionsModal } from "./OpenConnectionsModal";

/** Flush pending microtasks so async click handlers settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("OpenConnectionsModal — Prune dead agents footer action", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    pruneDeadAgents.mockClear();
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render() {
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
  }

  function pruneButton(): HTMLButtonElement {
    return document.querySelector(
      '[data-testid="open-connections-prune-dead-agents"]'
    ) as HTMLButtonElement;
  }

  it("renders a Prune dead agents footer action", () => {
    render();
    expect(pruneButton()).toBeTruthy();
    expect(pruneButton().textContent).toContain("Prune dead agents");
  });

  it("calls pruneDeadAgents and reports the swept count", async () => {
    pruneDeadAgents.mockResolvedValueOnce(["dead-1", "dead-2"]);
    render();

    await act(async () => {
      pruneButton().click();
    });
    await flush();

    expect(pruneDeadAgents).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledWith("Pruned 2 dead agents");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reports when there were no dead agents to prune", async () => {
    pruneDeadAgents.mockResolvedValueOnce([]);
    render();

    await act(async () => {
      pruneButton().click();
    });
    await flush();

    expect(toastSuccess).toHaveBeenCalledWith("No dead agents to prune");
  });

  it("surfaces a failure as an error toast", async () => {
    pruneDeadAgents.mockRejectedValueOnce(new Error("boom"));
    render();

    await act(async () => {
      pruneButton().click();
    });
    await flush();

    expect(toastError).toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
