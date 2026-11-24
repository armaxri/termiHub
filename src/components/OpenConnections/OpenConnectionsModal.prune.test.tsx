/**
 * Tests for the "Prune dead agents" footer action of the Open Connections
 * panel (G6, #1239): a manual escape hatch that sweeps backend agent entries
 * whose I/O task has already died (`alive=false`) but which linger in the
 * manager map. Routing is already safe, so this is pure resource hygiene.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";

const pruneDeadAgents = vi.fn(() => Promise.resolve<string[]>([]));
const toastSuccess = vi.fn();
const toastInfo = vi.fn();
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
    toast: {
      success: (m: string) => toastSuccess(m),
      info: (m: string) => toastInfo(m),
      error: (m: string) => toastError(m),
    },
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
    toastInfo.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
    await flushAsync();
  }

  function pruneButton(): HTMLButtonElement {
    return document.querySelector(
      '[data-testid="open-connections-prune-dead-agents"]'
    ) as HTMLButtonElement;
  }

  it("renders a Prune dead agents footer action", async () => {
    await render();
    expect(pruneButton()).toBeTruthy();
    expect(pruneButton().textContent).toContain("Prune dead agents");
  });

  it("calls pruneDeadAgents; the pruned rows leaving are the feedback (#5859)", async () => {
    pruneDeadAgents.mockResolvedValueOnce(["dead-1", "dead-2"]);
    await render();

    await act(async () => {
      pruneButton().click();
    });
    await flush();

    expect(pruneDeadAgents).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastInfo).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reports when there were no dead agents to prune", async () => {
    pruneDeadAgents.mockResolvedValueOnce([]);
    await render();

    await act(async () => {
      pruneButton().click();
    });
    await flush();

    expect(toastInfo).toHaveBeenCalledWith("No dead agents to prune");
  });

  it("surfaces a failure as an error toast", async () => {
    pruneDeadAgents.mockRejectedValueOnce(new Error("boom"));
    await render();

    await act(async () => {
      pruneButton().click();
    });
    await flush();

    expect(toastError).toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
