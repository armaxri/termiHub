/**
 * `useProjectedAgents` — the agent sidebar & Open Connections read the authoritative
 * `agents` projection region (#2226 PR A). Drives the hook against the in-memory
 * region harness and asserts: it renders the region's projected slice, re-renders on
 * a fresh diff, and (via the appStore→region mirror) reflects a slice seeded through
 * `appStore` — with no `appStore` fallback.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinitionInfo, AgentFolderInfo, AgentSessionInfo } from "@/services/api";
import {
  installAgentsHarness,
  installAgentsRegion,
  seedAgentsRegion,
  type FakeAgentsTransport,
} from "@/test/agentsRegionTestHarness";
import type { RemoteAgentDefinition } from "@/types/connection";

import { type AgentsView } from "./agentsBridge";
import { useProjectedAgents } from "./useProjectedAgents";

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  getSettings: vi.fn(() =>
    Promise.resolve({ version: "1", externalConnectionFiles: [], powerMonitoringEnabled: true })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn(() => vi.fn()) }));

function agent(
  id: string,
  connectionState: RemoteAgentDefinition["connectionState"] = "disconnected"
): RemoteAgentDefinition {
  return {
    id,
    name: `Agent ${id}`,
    config: { host: `h-${id}`, port: 22, authMethod: "password" } as never,
    agentSettings: { autoReconnect: true } as never,
    isExpanded: false,
    connectionState,
  };
}

function session(id: string): AgentSessionInfo {
  return { sessionId: id, title: `s ${id}`, type: "shell", status: "running", attached: true };
}

function definition(id: string): AgentDefinitionInfo {
  return {
    id,
    name: `def ${id}`,
    sessionType: "shell",
    config: {},
    persistent: false,
    folderId: null,
  };
}

function folder(id: string): AgentFolderInfo {
  return { id, name: `F ${id}`, parentId: null, isExpanded: true };
}

/** Render the hook into a throwaway component, exposing the latest return value. */
function renderHook(): { get: () => AgentsView; unmount: () => void } {
  const container = document.createElement("div");
  const root: Root = createRoot(container);
  let latest: AgentsView = {
    remoteAgents: [],
    agentSessions: {},
    agentDefinitions: {},
    agentFolders: {},
  };

  function Probe() {
    latest = useProjectedAgents();
    return null;
  }

  act(() => root.render(<Probe />));
  return { get: () => latest, unmount: () => act(() => root.unmount()) };
}

const flush = () => act(async () => await Promise.resolve());

let teardown: (() => void) | undefined;

beforeEach(() => {
  useAppStore.setState({
    remoteAgents: [],
    agentSessions: {},
    agentDefinitions: {},
    agentFolders: {},
  });
});

afterEach(() => {
  teardown?.();
  teardown = undefined;
});

describe("useProjectedAgents", () => {
  it("renders the slice projected by the region", async () => {
    const remoteAgents = [agent("a1", "connected")];
    const agentSessions = { a1: [session("s1")] };
    const agentDefinitions = { a1: [definition("d1")] };
    const agentFolders = { a1: [folder("f1")] };
    const harness = installAgentsHarness({
      remoteAgents,
      agentSessions,
      agentDefinitions,
      agentFolders,
    });
    teardown = harness.teardown;

    const hook = renderHook();
    await flush();
    await flush();

    expect(hook.get().remoteAgents).toEqual(remoteAgents);
    expect(hook.get().agentSessions).toEqual(agentSessions);
    expect(hook.get().agentDefinitions).toEqual(agentDefinitions);
    expect(hook.get().agentFolders).toEqual(agentFolders);
    hook.unmount();
  });

  it("re-renders when the region emits a fresh diff", async () => {
    const harness = installAgentsHarness({
      remoteAgents: [agent("a1", "disconnected")],
      agentSessions: {},
      agentDefinitions: {},
      agentFolders: {},
    });
    teardown = harness.teardown;

    const hook = renderHook();
    await flush();
    await flush();
    expect(hook.get().remoteAgents[0].connectionState).toBe("disconnected");

    await act(async () => {
      (harness.transport as FakeAgentsTransport).seed({
        remoteAgents: [agent("a1", "connected")],
        agentSessions: { a1: [session("s1")] },
        agentDefinitions: {},
        agentFolders: {},
      });
      await Promise.resolve();
    });
    expect(hook.get().remoteAgents[0].connectionState).toBe("connected");
    expect(hook.get().agentSessions.a1).toHaveLength(1);
    hook.unmount();
  });

  it("reflects a slice seeded directly into the region", async () => {
    teardown = installAgentsRegion();

    const hook = renderHook();
    await flush();

    await act(async () => {
      seedAgentsRegion({
        remoteAgents: [agent("a2", "reconnecting")],
        agentSessions: { a2: [session("s2")] },
      });
      await Promise.resolve();
    });

    expect(hook.get().remoteAgents[0].id).toBe("a2");
    expect(hook.get().remoteAgents[0].connectionState).toBe("reconnecting");
    expect(hook.get().agentSessions.a2).toHaveLength(1);
    hook.unmount();
  });
});
