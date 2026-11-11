/**
 * A failed agent disconnect from the Open Connections panel, driven through the
 * real `disconnectRemoteAgent` store action with the backend `disconnect_agent`
 * rejecting (#5278).
 *
 * The store action rejects without toasting, so every panel path shows exactly
 * one accurate message: a failed single stop shows one error and no success,
 * a bulk action with failures shows one summary instead of one toast per agent,
 * and a successful action keeps its success feedback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { RemoteAgentDefinition } from "@/types/connection";

const toastError = vi.fn();
const toastSuccess = vi.fn();
// Hoisted: appStore logs through these during module init.
const { frontendErrorMock, frontendLogMock } = vi.hoisted(() => ({
  frontendErrorMock: vi.fn(),
  frontendLogMock: vi.fn(),
}));

const disconnectAgent = vi.fn<(id: string, opts?: unknown) => Promise<void>>();
const cancelConnectAgent = vi.fn<(id: string) => Promise<boolean>>();

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  closeTerminal: vi.fn(() => Promise.resolve()),
  closeAgentSession: vi.fn(() => Promise.resolve()),
  cancelConnecting: vi.fn(() => Promise.resolve(true)),
  cancelConnectAgent: (id: string) => cancelConnectAgent(id),
  disconnectAgent: (id: string, opts?: unknown) =>
    opts === undefined ? disconnectAgent(id) : disconnectAgent(id, opts),
  sftpCancelTransfer: vi.fn(() => Promise.resolve()),
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
    toast: {
      ...actual.toast,
      error: (m: string) => toastError(m),
      success: (m: string) => toastSuccess(m),
    },
  };
});

vi.mock("@/utils/frontendLog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/frontendLog")>();
  return {
    ...actual,
    frontendError: (target: string, message: string) => frontendErrorMock(target, message),
    frontendLog: (target: string, message: string) => frontendLogMock(target, message),
  };
});

import { OpenConnectionsModal } from "./OpenConnectionsModal";
import { flushAsync } from "@/test/flushAsync";
import { currentAgentsView } from "@/store/agentsBridge";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";

function agent(
  id: string,
  name: string,
  connectionState: RemoteAgentDefinition["connectionState"] = "connected"
): RemoteAgentDefinition {
  return {
    id,
    name,
    type: "remote-agent",
    connectionState,
    isExpanded: false,
    config: { host: "h", port: 22, username: "u", authMethod: "password" },
  } as unknown as RemoteAgentDefinition;
}

function rowsMatching(text: string): Element[] {
  return Array.from(document.querySelectorAll(".oc-row")).filter((r) =>
    r.querySelector(".oc-row__title")?.textContent?.includes(text)
  );
}

function connectionStateOf(id: string): string | undefined {
  return currentAgentsView().remoteAgents.find((a) => a.id === id)?.connectionState;
}

async function click(btn: HTMLButtonElement | null) {
  expect(btn).not.toBeNull();
  await act(async () => btn!.click());
  await flushAsync();
}

/** Click a section's bulk action (by its aria-label) and confirm the dialog. */
async function bulkAndConfirm(ariaLabel: string) {
  await click(document.querySelector(`[aria-label="${ariaLabel}"]`));
  await click(document.querySelector('[data-testid="confirm-dialog-confirm"]'));
}

setupAgentsRegion();

describe("OpenConnectionsModal — failed agent disconnect through the real store action (#5278)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    for (const m of [toastError, toastSuccess, frontendErrorMock, frontendLogMock]) m.mockClear();
    disconnectAgent.mockReset().mockResolvedValue(undefined);
    cancelConnectAgent.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderWith(agents: RemoteAgentDefinition[]) {
    seedAgentsRegion({ remoteAgents: agents });
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
    await flushAsync();
  }

  function killButton(rowText: string): HTMLButtonElement | null {
    return rowsMatching(rowText)[0]?.querySelector(".oc-row__kill") ?? null;
  }

  // ── Establishing / recovering ───────────────────────────────────────────

  it("a failed reconnect stop shows one error toast and no success toast", async () => {
    disconnectAgent.mockRejectedValue(new Error("agent hung"));
    await renderWith([agent("a2", "edge", "reconnecting")]);

    await click(killButton("edge"));

    expect(disconnectAgent).toHaveBeenCalledWith("a2");
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Failed to cancel: agent hung");
    expect(toastSuccess).not.toHaveBeenCalled();
    // The reconnect was not stopped, so the row stays.
    expect(connectionStateOf("a2")).toBe("reconnecting");
    expect(rowsMatching("edge")).toHaveLength(1);
  });

  it("a successful reconnect stop keeps its success toast", async () => {
    await renderWith([agent("a2", "edge", "reconnecting")]);

    await click(killButton("edge"));

    expect(toastSuccess).toHaveBeenCalledWith("Reconnect stopped");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("Cancel All with a failed reconnect stop shows one summary toast", async () => {
    disconnectAgent.mockRejectedValue(new Error("agent hung"));
    await renderWith([agent("a1", "build-box", "connecting"), agent("a2", "edge", "reconnecting")]);

    await bulkAndConfirm("Cancel All Establishing / recovering");

    expect(cancelConnectAgent).toHaveBeenCalledWith("a1");
    expect(disconnectAgent).toHaveBeenCalledWith("a2");
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Failed to cancel 1 agent");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(frontendErrorMock).toHaveBeenCalledWith(
      "open_connections",
      expect.stringContaining("a2")
    );
  });

  it("Cancel All counts every failure in one pluralised summary", async () => {
    cancelConnectAgent.mockRejectedValue(new Error("x"));
    disconnectAgent.mockRejectedValue(new Error("y"));
    await renderWith([agent("a1", "build-box", "connecting"), agent("a2", "edge", "reconnecting")]);

    await bulkAndConfirm("Cancel All Establishing / recovering");

    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Failed to cancel 2 agents");
  });

  // ── Agent Connections ───────────────────────────────────────────────────

  it("a failed Disconnect shows one error toast and keeps the agent listed", async () => {
    disconnectAgent.mockRejectedValue(new Error("socket stuck"));
    await renderWith([agent("a1", "build-box")]);

    await click(document.querySelector('[data-testid="oc-agent-disconnect-a1"]'));

    expect(disconnectAgent).toHaveBeenCalledWith("a1");
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Failed to disconnect agent: socket stuck");
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(connectionStateOf("a1")).toBe("connected");
    expect(rowsMatching("build-box")).toHaveLength(1);
  });

  it("Kill All with one failed disconnect shows one summary toast", async () => {
    disconnectAgent.mockImplementation((id) =>
      id === "a2" ? Promise.reject(new Error("socket stuck")) : Promise.resolve()
    );
    await renderWith([agent("a1", "build-box"), agent("a2", "edge")]);

    await bulkAndConfirm("Kill All Agent Connections");

    expect(disconnectAgent).toHaveBeenCalledWith("a1");
    expect(disconnectAgent).toHaveBeenCalledWith("a2");
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("Failed to disconnect 1 agent");
    // Only the failed agent is still connected.
    expect(connectionStateOf("a1")).toBe("disconnected");
    expect(connectionStateOf("a2")).toBe("connected");
    expect(frontendErrorMock).toHaveBeenCalledWith(
      "open_connections",
      expect.stringContaining("a2")
    );
  });

  it("Kill All with every disconnect succeeding shows no error", async () => {
    await renderWith([agent("a1", "build-box"), agent("a2", "edge")]);

    await bulkAndConfirm("Kill All Agent Connections");

    expect(disconnectAgent).toHaveBeenCalledTimes(2);
    expect(toastError).not.toHaveBeenCalled();
  });
});
