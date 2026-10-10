/**
 * Regression tests for #4377 (ERR2-003): the Open Connections panel used to hide
 * an agent's live sessions when listing them failed (the failure collapsed to
 * an empty list, so the "Sessions on <agent>" section vanished), and "Kill All"
 * on Agent Connections swallowed disconnect failures with no feedback.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { RemoteAgentDefinition } from "@/types/connection";
import type { LogEntry } from "@/types/terminal";

const toastSuccess = vi.fn();
const toastError = vi.fn();
const listAgentSessions = vi.fn((_id: string): Promise<unknown[]> => Promise.resolve([]));

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: vi.fn(() => Promise.resolve([])),
  listAgentSessions: (id: string) => listAgentSessions(id),
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
import { onFrontendLog } from "@/utils/frontendLog";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";

function agent(id: string, name: string): RemoteAgentDefinition {
  return {
    id,
    name,
    type: "remote-agent",
    connectionState: "connected",
    isExpanded: false,
    config: { host: "h", port: 22, username: "u", authMethod: "password" },
  } as unknown as RemoteAgentDefinition;
}

function session(sessionId: string, title: string) {
  return { sessionId, title, type: "shell", status: "running", createdAt: "", attached: false };
}

setupAgentsRegion();

describe("OpenConnectionsModal — agent session-list and kill-all errors (#4377)", () => {
  let container: HTMLDivElement;
  let root: Root;
  const disconnectRemoteAgent = vi.fn((_id: string) => Promise.resolve());

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    listAgentSessions.mockReset();
    listAgentSessions.mockResolvedValue([]);
    disconnectRemoteAgent.mockReset();
    disconnectRemoteAgent.mockResolvedValue(undefined);
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(agents: RemoteAgentDefinition[]) {
    useAppStore.setState({ disconnectRemoteAgent });
    seedAgentsRegion({ remoteAgents: agents });
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
    await flushAsync();
  }

  function errorRow(agentId: string): Element | null {
    return document.querySelector(`[data-testid="oc-agent-sessions-error-${agentId}"]`);
  }

  it("shows an inline error row with the reason when listing an agent's sessions fails", async () => {
    listAgentSessions.mockRejectedValue(new Error("agent busy"));
    const entries: LogEntry[] = [];
    const unsubscribe = onFrontendLog((e) => entries.push(e));
    await render([agent("a1", "build-box")]);
    unsubscribe();

    const row = errorRow("a1");
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Could not list sessions: agent busy");
    // The section stays visible so the failure is not mistaken for "no sessions".
    expect(document.body.textContent).toContain("Sessions on build-box");
    expect(
      entries.some(
        (e) => e.level === "ERROR" && e.message.includes("list sessions of agent a1: agent busy")
      )
    ).toBe(true);
  });

  it("Retry reloads the agent's sessions and replaces the error row with them", async () => {
    listAgentSessions.mockRejectedValueOnce(new Error("timeout"));
    await render([agent("a1", "build-box")]);
    expect(errorRow("a1")).toBeTruthy();

    listAgentSessions.mockResolvedValueOnce([session("s1", "bash on build-box")]);
    const retry = document.querySelector(
      '[data-testid="oc-agent-sessions-retry-a1"]'
    ) as HTMLButtonElement;
    expect(retry).toBeTruthy();
    await act(async () => retry.click());
    await flushAsync();

    expect(listAgentSessions).toHaveBeenCalledTimes(2);
    expect(errorRow("a1")).toBeNull();
    expect(document.body.textContent).toContain("bash on build-box");
  });

  it("only the failed agent shows an error row; healthy agents list normally", async () => {
    listAgentSessions.mockImplementation((id: string) =>
      id === "a1"
        ? Promise.reject(new Error("transport blip"))
        : Promise.resolve([session("s2", "nas shell")])
    );
    await render([agent("a1", "build-box"), agent("a2", "nas")]);
    expect(errorRow("a1")).toBeTruthy();
    expect(errorRow("a2")).toBeNull();
    expect(document.body.textContent).toContain("nas shell");
  });

  it("reports a partial Kill All failure on Agent Connections instead of swallowing it", async () => {
    disconnectRemoteAgent.mockImplementation((id: string) =>
      id === "a2" ? Promise.reject(new Error("socket closed")) : Promise.resolve()
    );
    const entries: LogEntry[] = [];
    const unsubscribe = onFrontendLog((e) => entries.push(e));
    await render([agent("a1", "build-box"), agent("a2", "nas")]);

    const killAll = document.querySelector(
      '[aria-label="Kill All Agent Connections"]'
    ) as HTMLButtonElement;
    expect(killAll).toBeTruthy();
    await act(async () => killAll.click());
    const confirm = document.querySelector(
      '[data-testid="confirm-dialog-confirm"]'
    ) as HTMLButtonElement;
    await act(async () => confirm.click());
    await flushAsync();
    unsubscribe();

    expect(disconnectRemoteAgent).toHaveBeenCalledWith("a1");
    expect(disconnectRemoteAgent).toHaveBeenCalledWith("a2");
    expect(toastError).toHaveBeenCalledWith("Failed to disconnect 1 agent");
    expect(
      entries.some(
        (e) =>
          e.level === "ERROR" && e.message.includes("a2") && e.message.includes("socket closed")
      )
    ).toBe(true);
  });
});
