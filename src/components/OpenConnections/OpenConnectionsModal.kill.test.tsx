/**
 * Kill / cancel paths of the Open Connections panel that had no unit coverage
 * (COV-015, #5275): cancel-all-connecting, cancel (all) establishing agents,
 * kill (all) proxy sessions via an agent, close (all) native agent sessions and
 * cancel (all) transfers.
 *
 * Each path is driven through the rendered panel against mocked backend
 * commands and asserts both the backend calls and what the user sees: which
 * rows stay listed, and which toast fires. The partial-failure cases reject the
 * backend call for exactly one row, so the failed row must stay listed (it is
 * still live) while the others disappear (UX-033).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { AgentSessionInfo, LocalSessionInfo } from "@/services/api";
import type { RemoteAgentDefinition, TransferState } from "@/types/connection";
import type { TerminalTab } from "@/types/terminal";
import {
  connecting,
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";

const toastError = vi.fn();
const toastSuccess = vi.fn();
// Hoisted: appStore logs through these during module init, before the
// test-body consts would be initialised.
const { frontendErrorMock, frontendLogMock } = vi.hoisted(() => ({
  frontendErrorMock: vi.fn(),
  frontendLogMock: vi.fn(),
}));

const listLocalSessions = vi.fn<() => Promise<LocalSessionInfo[]>>();
const listAgentSessions = vi.fn<(agentId: string) => Promise<AgentSessionInfo[]>>();
const closeTerminal = vi.fn<(id: string, intentional?: boolean) => Promise<void>>();
const closeAgentSession = vi.fn<(agentId: string, sessionId: string) => Promise<void>>();
const cancelConnecting = vi.fn<(id: string) => Promise<boolean>>();
const cancelConnectAgent = vi.fn<(id: string) => Promise<boolean>>();
const sftpCancelTransfer = vi.fn<(id: string) => Promise<void>>();

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: () => listLocalSessions(),
  listAgentSessions: (agentId: string) => listAgentSessions(agentId),
  closeTerminal: (id: string, intentional?: boolean) => closeTerminal(id, intentional),
  closeAgentSession: (agentId: string, sessionId: string) => closeAgentSession(agentId, sessionId),
  cancelConnecting: (id: string) => cancelConnecting(id),
  cancelConnectAgent: (id: string) => cancelConnectAgent(id),
  sftpCancelTransfer: (id: string) => sftpCancelTransfer(id),
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
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { flushAsync } from "@/test/flushAsync";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";

// ── Fixtures ──────────────────────────────────────────────────────────────

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

function proxySession(id: string, title: string, agentId: string): LocalSessionInfo {
  return { id, title, connectionType: "ssh", alive: true, spawned: false, agentId };
}

function agentSession(sessionId: string, title: string): AgentSessionInfo {
  return {
    sessionId,
    title,
    type: "shell",
    status: "running",
    createdAt: "",
    attached: false,
  } as unknown as AgentSessionInfo;
}

function transfer(transferId: string, fileName: string): TransferState {
  return {
    transferId,
    sessionId: "sftp-1",
    direction: "download",
    fileName,
    transferred: 512,
    total: 1024,
    phase: "transferring",
  };
}

function connectingTab(id: string, title: string, panelId: string): TerminalTab {
  return {
    id,
    sessionId: null,
    title,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId,
    isActive: id === "tab-1",
  };
}

// ── DOM helpers ───────────────────────────────────────────────────────────

function rowsMatching(text: string): Element[] {
  return Array.from(document.querySelectorAll(".oc-row")).filter((r) =>
    r.querySelector(".oc-row__title")?.textContent?.includes(text)
  );
}

function sectionTitles(): string[] {
  return Array.from(document.querySelectorAll(".oc-section__title")).map(
    (t) => t.textContent ?? ""
  );
}

async function clickKill(rowText: string) {
  const row = rowsMatching(rowText)[0];
  expect(row, `row "${rowText}" should be listed`).toBeTruthy();
  const btn = row.querySelector(".oc-row__kill") as HTMLButtonElement;
  expect(btn).not.toBeNull();
  await act(async () => btn.click());
  await flushAsync();
}

/** Click a section's bulk action (by its aria-label) and confirm the dialog. */
async function bulkAndConfirm(ariaLabel: string) {
  const bulk = document.querySelector(`[aria-label="${ariaLabel}"]`) as HTMLButtonElement;
  expect(bulk, `bulk action "${ariaLabel}" should exist`).not.toBeNull();
  await act(async () => bulk.click());
  const confirm = document.querySelector(
    '[data-testid="confirm-dialog-confirm"]'
  ) as HTMLButtonElement;
  expect(confirm).not.toBeNull();
  await act(async () => confirm.click());
  await flushAsync();
}

setupAgentsRegion();

describe("OpenConnectionsModal — kill / cancel paths (COV-015)", () => {
  const harness = installSessionLifecycleHarness();
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    for (const m of [toastError, toastSuccess, frontendErrorMock, frontendLogMock]) m.mockClear();
    listLocalSessions.mockReset().mockResolvedValue([]);
    listAgentSessions.mockReset().mockResolvedValue([]);
    closeTerminal.mockReset().mockResolvedValue(undefined);
    closeAgentSession.mockReset().mockResolvedValue(undefined);
    cancelConnecting.mockReset().mockResolvedValue(true);
    cancelConnectAgent.mockReset().mockResolvedValue(true);
    sftpCancelTransfer.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderModal() {
    await act(async () => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <OpenConnectionsModal open={true} onOpenChange={() => {}} />
        </TooltipProvider>
      );
    });
    await flushSessionRegion();
    await flushAsync();
  }

  // ── Connecting (in-flight handshakes) ───────────────────────────────────

  describe("Connecting section", () => {
    let leafId: string;
    const closeTab = vi.fn();

    function seedConnecting() {
      leafId = layoutState().rootPanel.id;
      const tabs = [
        connectingTab("tab-1", "app-server", leafId),
        connectingTab("tab-2", "db-server", leafId),
      ];
      seedLayoutState({
        rootPanel: { type: "leaf", id: leafId, tabs, activeTabId: "tab-1" },
        activePanelId: leafId,
      });
      harness.transport.setSession("tab-1", connecting());
      harness.transport.setSession("tab-2", connecting());
      closeTab.mockReset();
      useAppStore.setState({ closeTab });
    }

    it("Cancel All cancels every handshake and closes every tab without an error", async () => {
      seedConnecting();
      await renderModal();
      expect(rowsMatching("app-server")).toHaveLength(1);
      expect(rowsMatching("db-server")).toHaveLength(1);

      await bulkAndConfirm("Kill All Connecting");

      expect(cancelConnecting).toHaveBeenCalledWith("tab-1");
      expect(cancelConnecting).toHaveBeenCalledWith("tab-2");
      expect(closeTab).toHaveBeenCalledWith("tab-1", leafId);
      expect(closeTab).toHaveBeenCalledWith("tab-2", leafId);
      expect(toastError).not.toHaveBeenCalled();
      expect(frontendErrorMock).not.toHaveBeenCalled();
    });

    it("Cancel All reports the one failed cancel and still closes both tabs", async () => {
      seedConnecting();
      cancelConnecting.mockImplementation((id) =>
        id === "tab-2" ? Promise.reject(new Error("handshake stuck")) : Promise.resolve(true)
      );
      await renderModal();

      await bulkAndConfirm("Kill All Connecting");

      expect(cancelConnecting).toHaveBeenCalledTimes(2);
      expect(closeTab).toHaveBeenCalledTimes(2);
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError).toHaveBeenCalledWith("Failed to cancel 1 connection");
      expect(frontendErrorMock).toHaveBeenCalledTimes(1);
      expect(frontendErrorMock).toHaveBeenCalledWith(
        "open_connections",
        expect.stringContaining("tab-2")
      );
    });

    it("Cancel All pluralises the toast when several cancels fail", async () => {
      seedConnecting();
      cancelConnecting.mockRejectedValue(new Error("down"));
      await renderModal();

      await bulkAndConfirm("Kill All Connecting");

      expect(toastError).toHaveBeenCalledWith("Failed to cancel 2 connections");
      expect(frontendErrorMock).toHaveBeenCalledTimes(2);
    });

    it("a single failed cancel toasts the reason and still closes the tab", async () => {
      seedConnecting();
      cancelConnecting.mockRejectedValue(new Error("gone"));
      await renderModal();

      await clickKill("app-server");

      expect(cancelConnecting).toHaveBeenCalledWith("tab-1");
      expect(closeTab).toHaveBeenCalledWith("tab-1", leafId);
      expect(toastError).toHaveBeenCalledWith("Failed to cancel connection: gone");
      expect(frontendErrorMock).toHaveBeenCalledWith(
        "open_connections",
        expect.stringContaining("tab-1")
      );
    });
  });

  // ── Establishing / recovering agents ─────────────────────────────────────

  describe("Establishing / recovering section", () => {
    const disconnectRemoteAgent = vi.fn<(id: string) => Promise<void>>();

    async function renderEstablishing() {
      disconnectRemoteAgent.mockReset().mockResolvedValue(undefined);
      useAppStore.setState({ disconnectRemoteAgent });
      seedAgentsRegion({
        remoteAgents: [agent("a1", "build-box", "connecting"), agent("a2", "edge", "reconnecting")],
      });
      await renderModal();
    }

    it("Cancel All cancels the connecting agent and stops the reconnecting one", async () => {
      await renderEstablishing();

      await bulkAndConfirm("Cancel All Establishing / recovering");

      expect(cancelConnectAgent).toHaveBeenCalledWith("a1");
      expect(cancelConnectAgent).not.toHaveBeenCalledWith("a2");
      expect(disconnectRemoteAgent).toHaveBeenCalledWith("a2");
      expect(disconnectRemoteAgent).not.toHaveBeenCalledWith("a1");
      expect(toastError).not.toHaveBeenCalled();
    });

    it("Cancel All reports the failed agent and names it in the log", async () => {
      await renderEstablishing();
      cancelConnectAgent.mockRejectedValue(new Error("no such agent"));

      await bulkAndConfirm("Cancel All Establishing / recovering");

      expect(disconnectRemoteAgent).toHaveBeenCalledWith("a2");
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError).toHaveBeenCalledWith("Failed to cancel 1 agent");
      expect(frontendErrorMock).toHaveBeenCalledWith(
        "open_connections",
        expect.stringContaining("a1")
      );
    });

    it("Cancel All pluralises the toast when both agents fail", async () => {
      await renderEstablishing();
      cancelConnectAgent.mockRejectedValue(new Error("x"));
      disconnectRemoteAgent.mockRejectedValue(new Error("y"));

      await bulkAndConfirm("Cancel All Establishing / recovering");

      expect(toastError).toHaveBeenCalledWith("Failed to cancel 2 agents");
      expect(frontendErrorMock).toHaveBeenCalledTimes(2);
    });

    it("a single cancel confirms success for a connecting and a reconnecting agent", async () => {
      await renderEstablishing();

      await clickKill("build-box");
      expect(cancelConnectAgent).toHaveBeenCalledWith("a1");
      expect(toastSuccess).toHaveBeenCalledWith("Connect cancelled");

      await clickKill("edge");
      expect(disconnectRemoteAgent).toHaveBeenCalledWith("a2");
      expect(toastSuccess).toHaveBeenCalledWith("Reconnect stopped");
      expect(toastError).not.toHaveBeenCalled();
    });

    it("a single failed cancel toasts the reason instead of success", async () => {
      await renderEstablishing();
      cancelConnectAgent.mockRejectedValue(new Error("refused"));

      await clickKill("build-box");

      expect(toastError).toHaveBeenCalledWith("Failed to cancel: refused");
      expect(toastSuccess).not.toHaveBeenCalled();
      expect(frontendLogMock).toHaveBeenCalledWith(
        "open_connections",
        expect.stringContaining("refused")
      );
    });
  });

  // ── Proxy sessions (desktop sessions routed via an agent) ────────────────

  describe("Connections via an agent (proxy sessions)", () => {
    async function renderProxy() {
      seedAgentsRegion({ remoteAgents: [agent("a1", "build-box")] });
      listLocalSessions.mockResolvedValue([
        proxySession("p-ok", "Good Proxy", "a1"),
        proxySession("p-bad", "Bad Proxy", "a1"),
      ]);
      await renderModal();
      expect(sectionTitles()).toContain("Connections via build-box");
    }

    it("lists proxy sessions under their agent, not under Local Sessions", async () => {
      await renderProxy();
      expect(sectionTitles()).not.toContain("Local Sessions");
      expect(rowsMatching("Good Proxy")).toHaveLength(1);
      expect(rowsMatching("Bad Proxy")).toHaveLength(1);
    });

    it("Kill All kills every proxy session and drops the section", async () => {
      await renderProxy();

      await bulkAndConfirm("Kill All Connections via build-box");

      expect(closeTerminal).toHaveBeenCalledWith("p-ok", true);
      expect(closeTerminal).toHaveBeenCalledWith("p-bad", true);
      expect(rowsMatching("Good Proxy")).toHaveLength(0);
      expect(rowsMatching("Bad Proxy")).toHaveLength(0);
      expect(sectionTitles()).not.toContain("Connections via build-box");
      // Both kills succeeded, so both intentional-kill markers stay armed.
      const killed = useAppStore.getState().intentionallyKilledSessions;
      expect(killed["p-ok"]).toBe(true);
      expect(killed["p-bad"]).toBe(true);
      expect(toastError).not.toHaveBeenCalled();
    });

    it("Kill All keeps only the session whose kill failed", async () => {
      closeTerminal.mockImplementation((id) =>
        id === "p-bad" ? Promise.reject(new Error("stuck")) : Promise.resolve()
      );
      await renderProxy();

      await bulkAndConfirm("Kill All Connections via build-box");

      expect(rowsMatching("Good Proxy")).toHaveLength(0);
      expect(rowsMatching("Bad Proxy")).toHaveLength(1);
      const killed = useAppStore.getState().intentionallyKilledSessions;
      expect(killed["p-ok"]).toBe(true);
      expect(killed["p-bad"]).toBeUndefined();
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError).toHaveBeenCalledWith("Failed to kill 1 session");
      expect(frontendErrorMock).toHaveBeenCalledWith(
        "open_connections",
        expect.stringMatching(/p-bad.*a1/)
      );
    });

    it("a single proxy kill drops only that row", async () => {
      await renderProxy();

      await clickKill("Good Proxy");

      expect(closeTerminal).toHaveBeenCalledWith("p-ok", true);
      expect(rowsMatching("Good Proxy")).toHaveLength(0);
      expect(rowsMatching("Bad Proxy")).toHaveLength(1);
      expect(useAppStore.getState().intentionallyKilledSessions["p-ok"]).toBe(true);
    });

    it("a single failed proxy kill keeps the row, clears the marker and toasts", async () => {
      closeTerminal.mockRejectedValue(new Error("agent gone"));
      await renderProxy();

      await clickKill("Bad Proxy");

      expect(closeTerminal).toHaveBeenCalledWith("p-bad", true);
      expect(rowsMatching("Bad Proxy")).toHaveLength(1);
      expect(useAppStore.getState().intentionallyKilledSessions["p-bad"]).toBeUndefined();
      expect(toastError).toHaveBeenCalledWith("Failed to kill session: agent gone");
      expect(frontendErrorMock).toHaveBeenCalledWith(
        "open_connections",
        expect.stringMatching(/p-bad.*a1/)
      );
    });
  });

  // ── Native agent sessions ───────────────────────────────────────────────

  describe("Sessions on an agent", () => {
    async function renderAgentSessions() {
      seedAgentsRegion({ remoteAgents: [agent("a1", "build-box")] });
      listAgentSessions.mockResolvedValue([
        agentSession("s-ok", "bash ok"),
        agentSession("s-bad", "bash bad"),
      ]);
      await renderModal();
      expect(sectionTitles()).toContain("Sessions on build-box");
    }

    it("closes a single agent session via close_agent_session and drops its row", async () => {
      await renderAgentSessions();

      await clickKill("bash ok");

      expect(closeAgentSession).toHaveBeenCalledWith("a1", "s-ok");
      expect(rowsMatching("bash ok")).toHaveLength(0);
      expect(rowsMatching("bash bad")).toHaveLength(1);
      expect(toastError).not.toHaveBeenCalled();
    });

    it("a single failed close keeps the row and toasts the reason", async () => {
      closeAgentSession.mockRejectedValue(new Error("not found"));
      await renderAgentSessions();

      await clickKill("bash bad");

      expect(closeAgentSession).toHaveBeenCalledWith("a1", "s-bad");
      expect(rowsMatching("bash bad")).toHaveLength(1);
      expect(toastError).toHaveBeenCalledWith("Failed to kill session: not found");
      expect(frontendErrorMock).toHaveBeenCalledWith(
        "open_connections",
        expect.stringMatching(/s-bad.*a1/)
      );
    });

    it("Kill All closes every agent session and drops the section", async () => {
      await renderAgentSessions();

      await bulkAndConfirm("Kill All Sessions on build-box");

      expect(closeAgentSession).toHaveBeenCalledWith("a1", "s-ok");
      expect(closeAgentSession).toHaveBeenCalledWith("a1", "s-bad");
      expect(sectionTitles()).not.toContain("Sessions on build-box");
      expect(toastError).not.toHaveBeenCalled();
    });

    it("Kill All keeps only the session whose close failed", async () => {
      closeAgentSession.mockImplementation((_agentId, sessionId) =>
        sessionId === "s-bad" ? Promise.reject(new Error("busy")) : Promise.resolve()
      );
      await renderAgentSessions();

      await bulkAndConfirm("Kill All Sessions on build-box");

      expect(rowsMatching("bash ok")).toHaveLength(0);
      expect(rowsMatching("bash bad")).toHaveLength(1);
      expect(toastError).toHaveBeenCalledTimes(1);
      expect(toastError).toHaveBeenCalledWith("Failed to kill 1 session");
      expect(frontendErrorMock).toHaveBeenCalledWith(
        "open_connections",
        expect.stringContaining("s-bad")
      );
    });

    it("Kill All pluralises the toast when every close fails", async () => {
      closeAgentSession.mockRejectedValue(new Error("busy"));
      await renderAgentSessions();

      await bulkAndConfirm("Kill All Sessions on build-box");

      expect(rowsMatching("bash ok")).toHaveLength(1);
      expect(rowsMatching("bash bad")).toHaveLength(1);
      expect(toastError).toHaveBeenCalledWith("Failed to kill 2 sessions");
    });
  });

  // ── Transfers ──────────────────────────────────────────────────────────

  describe("Transfers section", () => {
    async function renderTransfers() {
      useAppStore.setState({
        transfers: {
          t1: transfer("t1", "big.iso"),
          t2: transfer("t2", "notes.txt"),
        },
      });
      await renderModal();
      expect(document.querySelectorAll('[data-testid="open-connections-transfer"]')).toHaveLength(
        2
      );
    }

    async function cancelOne(fileName: string) {
      const btn = document.querySelector(
        `[aria-label="Cancel transfer of ${fileName}"]`
      ) as HTMLButtonElement;
      expect(btn).not.toBeNull();
      await act(async () => btn.click());
      await flushAsync();
    }

    it("renders progress for each in-flight transfer", async () => {
      await renderTransfers();
      expect(document.body.textContent).toContain("50%");
    });

    it("cancels a single transfer via sftp_cancel_transfer and confirms it", async () => {
      await renderTransfers();

      await cancelOne("big.iso");

      expect(sftpCancelTransfer).toHaveBeenCalledWith("t1");
      expect(sftpCancelTransfer).toHaveBeenCalledTimes(1);
      expect(toastSuccess).toHaveBeenCalledWith("Transfer cancelled");
      expect(toastError).not.toHaveBeenCalled();
    });

    it("a failed single cancel toasts the reason instead of success", async () => {
      sftpCancelTransfer.mockRejectedValue(new Error("already done"));
      await renderTransfers();

      await cancelOne("notes.txt");

      expect(sftpCancelTransfer).toHaveBeenCalledWith("t2");
      expect(toastError).toHaveBeenCalledWith("Failed to cancel transfer: already done");
      expect(toastSuccess).not.toHaveBeenCalled();
    });

    it("Cancel All cancels every transfer and confirms it", async () => {
      await renderTransfers();

      await bulkAndConfirm("Cancel All Transfers");

      expect(sftpCancelTransfer).toHaveBeenCalledWith("t1");
      expect(sftpCancelTransfer).toHaveBeenCalledWith("t2");
      expect(toastSuccess).toHaveBeenCalledWith("All transfers cancelled");
      expect(toastError).not.toHaveBeenCalled();
    });

    it("Cancel All reports a failure when one cancel rejects", async () => {
      sftpCancelTransfer.mockImplementation((id) =>
        id === "t2" ? Promise.reject(new Error("io error")) : Promise.resolve()
      );
      await renderTransfers();

      await bulkAndConfirm("Cancel All Transfers");

      expect(sftpCancelTransfer).toHaveBeenCalledWith("t1");
      expect(sftpCancelTransfer).toHaveBeenCalledWith("t2");
      expect(toastError).toHaveBeenCalledWith("Failed to cancel transfers: io error");
      expect(toastSuccess).not.toHaveBeenCalled();
    });
  });
});
