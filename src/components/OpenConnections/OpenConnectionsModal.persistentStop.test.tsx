/**
 * Single Stop on a persistent (background) session in the Open Connections
 * panel asks first (#5375): such a session exists so that it survives, so one
 * click must not end it. Non-persistent rows keep their one-click Kill.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import type { AgentSessionInfo, LocalSessionInfo } from "@/services/api";
import type { PersistentSessionEntry, RemoteAgentDefinition } from "@/types/connection";
import {
  flushSessionRegion,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";

const listLocalSessions = vi.fn<() => Promise<LocalSessionInfo[]>>();
const listAgentSessions = vi.fn<(agentId: string) => Promise<AgentSessionInfo[]>>();
const closeTerminal = vi.fn<(id: string, intentional?: boolean) => Promise<void>>();
const closeAgentSession = vi.fn<(agentId: string, sessionId: string) => Promise<void>>();

vi.mock("@/services/api", () => ({
  listSessionOwners: vi.fn(() => Promise.resolve({})),
  focusWindow: vi.fn(() => Promise.resolve()),
  listLocalSessions: () => listLocalSessions(),
  listAgentSessions: (agentId: string) => listAgentSessions(agentId),
  closeTerminal: (id: string, intentional?: boolean) => closeTerminal(id, intentional),
  closeAgentSession: (agentId: string, sessionId: string) => closeAgentSession(agentId, sessionId),
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

import { OpenConnectionsModal } from "./OpenConnectionsModal";
import { flushAsync } from "@/test/flushAsync";
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

function localSession(id: string, title: string): LocalSessionInfo {
  return { id, title, connectionType: "local", alive: true, spawned: false };
}

function agentSession(sessionId: string, title: string, definitionId?: string): AgentSessionInfo {
  return { sessionId, title, type: "shell", status: "running", attached: false, definitionId };
}

function running(connectionId: string, sessionId: string): PersistentSessionEntry {
  return { connectionId, sessionId, state: "running", attachedTabIds: [] };
}

function rowKill(title: string): HTMLButtonElement {
  const row = Array.from(document.querySelectorAll(".oc-row")).find((r) =>
    r.querySelector(".oc-row__title")?.textContent?.includes(title)
  );
  expect(row, `row "${title}" should be listed`).toBeTruthy();
  return row!.querySelector(".oc-row__kill") as HTMLButtonElement;
}

async function click(el: Element | null) {
  expect(el).not.toBeNull();
  await act(async () => (el as HTMLElement).click());
  await flushAsync();
}

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`);

setupAgentsRegion();

describe("OpenConnectionsModal — confirm Stop on persistent sessions (#5375)", () => {
  installSessionLifecycleHarness();
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    listLocalSessions.mockReset().mockResolvedValue([]);
    listAgentSessions.mockReset().mockResolvedValue([]);
    closeTerminal.mockReset().mockResolvedValue(undefined);
    closeAgentSession.mockReset().mockResolvedValue(undefined);
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

  it("asks before stopping a persistent local session and stops it on confirm", async () => {
    useAppStore.setState({ persistentSessions: { "conn-1": running("conn-1", "local-1") } });
    listLocalSessions.mockResolvedValue([localSession("local-1", "Build shell")]);
    await renderModal();

    await click(rowKill("Build shell"));
    expect(closeTerminal).not.toHaveBeenCalled();
    expect(byTestId("confirm-stop-session-dialog")?.textContent).toContain(
      'Stop "Build shell"? It is running in the background and will end.'
    );

    await click(byTestId("confirm-stop-session-confirm"));
    expect(closeTerminal).toHaveBeenCalledWith("local-1", true);
  });

  it("cancel leaves the persistent session running", async () => {
    useAppStore.setState({ persistentSessions: { "conn-1": running("conn-1", "local-1") } });
    listLocalSessions.mockResolvedValue([localSession("local-1", "Build shell")]);
    await renderModal();

    await click(rowKill("Build shell"));
    await click(byTestId("confirm-stop-session-cancel"));

    expect(closeTerminal).not.toHaveBeenCalled();
    expect(byTestId("confirm-stop-session-dialog")).toBeNull();
    expect(rowKill("Build shell")).not.toBeNull();
  });

  it("asks before stopping an agent session backing a persistent definition", async () => {
    seedAgentsRegion({ remoteAgents: [agent("a1", "build-box")] });
    useAppStore.setState({ persistentSessions: { "a1:def-1": running("a1:def-1", "other-id") } });
    listAgentSessions.mockResolvedValue([agentSession("s-1", "tmux main", "def-1")]);
    await renderModal();

    await click(rowKill("tmux main"));
    expect(closeAgentSession).not.toHaveBeenCalled();

    await click(byTestId("confirm-stop-session-confirm"));
    expect(closeAgentSession).toHaveBeenCalledWith("a1", "s-1");
  });

  it("kills a non-persistent session at once, without a confirmation", async () => {
    listLocalSessions.mockResolvedValue([localSession("local-2", "Scratch")]);
    await renderModal();

    await click(rowKill("Scratch"));

    expect(byTestId("confirm-stop-session-dialog")).toBeNull();
    expect(closeTerminal).toHaveBeenCalledWith("local-2", true);
  });
});
