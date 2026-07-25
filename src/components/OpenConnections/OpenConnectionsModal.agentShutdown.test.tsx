/**
 * Tests for the two teardown intents on a connected agent row in the Open
 * Connections panel (#1277, follow-up to #1237). Each connected agent exposes
 * both Disconnect (detach transport, keep remote sessions) → disconnectRemoteAgent,
 * and Shutdown (stop remote sessions and disconnect) → shutdownRemoteAgent, which
 * toasts the detached-session count.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { RemoteAgentDefinition } from "@/types/connection";

const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  cancelConnectAgent: vi.fn(() => Promise.resolve(true)),
  pruneDeadAgents: vi.fn(() => Promise.resolve([])),
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

function agent(id: string, name: string): RemoteAgentDefinition {
  return {
    id,
    name,
    type: "remote-agent",
    connectionState: "connected",
    isExpanded: false,
    config: {
      host: "h",
      port: 22,
      username: "u",
      authMethod: "password",
    },
  } as unknown as RemoteAgentDefinition;
}

/** Flush pending microtasks so async click handlers settle. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Click the confirm button of the currently-open confirmation dialog. */
async function confirmDialog(): Promise<void> {
  const btn = document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLButtonElement;
  if (!btn) throw new Error("no confirmation dialog is open");
  await act(async () => btn.click());
}

describe("OpenConnectionsModal — agent Disconnect / Shutdown intents", () => {
  let container: HTMLDivElement;
  let root: Root;
  const disconnectRemoteAgent = vi.fn((_id: string) => Promise.resolve());
  const shutdownRemoteAgent = vi.fn((_id: string) => Promise.resolve(0));

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    disconnectRemoteAgent.mockClear();
    disconnectRemoteAgent.mockResolvedValue(undefined);
    shutdownRemoteAgent.mockClear();
    shutdownRemoteAgent.mockResolvedValue(0);
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function renderWithAgent(a: RemoteAgentDefinition) {
    useAppStore.setState({ remoteAgents: [a], disconnectRemoteAgent, shutdownRemoteAgent });
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
  }

  function agentRow(): Element | undefined {
    return Array.from(document.querySelectorAll(".oc-row")).find((r) =>
      r.querySelector(".oc-row__title")?.textContent?.includes("build-box")
    );
  }

  it("exposes both Disconnect and Shutdown actions on a connected agent row", () => {
    renderWithAgent(agent("a1", "build-box"));
    const row = agentRow();
    expect(row).toBeTruthy();
    expect(row?.querySelector('[data-testid="oc-agent-disconnect-a1"]')).toBeTruthy();
    expect(row?.querySelector('[data-testid="oc-agent-shutdown-a1"]')).toBeTruthy();
  });

  it("Disconnect invokes the detach path (disconnectRemoteAgent)", async () => {
    renderWithAgent(agent("a1", "build-box"));
    const btn = agentRow()?.querySelector(
      '[data-testid="oc-agent-disconnect-a1"]'
    ) as HTMLButtonElement;
    await act(async () => btn.click());
    await flush();
    expect(disconnectRemoteAgent).toHaveBeenCalledWith("a1");
    expect(shutdownRemoteAgent).not.toHaveBeenCalled();
  });

  it("Shutdown opens a confirmation and only runs after the user confirms", async () => {
    renderWithAgent(agent("a1", "build-box"));
    const btn = agentRow()?.querySelector(
      '[data-testid="oc-agent-shutdown-a1"]'
    ) as HTMLButtonElement;
    await act(async () => btn.click());
    // Nothing happens until the confirm dialog is accepted.
    expect(shutdownRemoteAgent).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="oc-agent-shutdown-a1-confirm"]')).toBeTruthy();

    await confirmDialog();
    await flush();
    expect(shutdownRemoteAgent).toHaveBeenCalledWith("a1");
  });

  it("Shutdown invokes shutdownRemoteAgent and toasts the stopped-session count", async () => {
    shutdownRemoteAgent.mockResolvedValueOnce(3);
    renderWithAgent(agent("a1", "build-box"));
    const btn = agentRow()?.querySelector(
      '[data-testid="oc-agent-shutdown-a1"]'
    ) as HTMLButtonElement;
    await act(async () => btn.click());
    await confirmDialog();
    await flush();
    expect(shutdownRemoteAgent).toHaveBeenCalledWith("a1");
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("3 sessions"));
    expect(disconnectRemoteAgent).not.toHaveBeenCalled();
  });

  it("Shutdown with a single detached session uses the singular form", async () => {
    shutdownRemoteAgent.mockResolvedValueOnce(1);
    renderWithAgent(agent("a1", "build-box"));
    const btn = agentRow()?.querySelector(
      '[data-testid="oc-agent-shutdown-a1"]'
    ) as HTMLButtonElement;
    await act(async () => btn.click());
    await confirmDialog();
    await flush();
    expect(toastSuccess).toHaveBeenCalledWith(expect.stringContaining("1 session"));
    expect(toastSuccess).not.toHaveBeenCalledWith(expect.stringContaining("1 sessions"));
  });

  it("Shutdown with no detached sessions still reports success", async () => {
    shutdownRemoteAgent.mockResolvedValueOnce(0);
    renderWithAgent(agent("a1", "build-box"));
    const btn = agentRow()?.querySelector(
      '[data-testid="oc-agent-shutdown-a1"]'
    ) as HTMLButtonElement;
    await act(async () => btn.click());
    await confirmDialog();
    await flush();
    expect(toastSuccess).toHaveBeenCalled();
  });
});
