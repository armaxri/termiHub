/**
 * Regression tests for the Active Sessions reattach flow in AgentNode.
 *
 * When the user double-clicks a running session under "Active Sessions", the
 * handler must route through `adoptAndAttachAgentPersistentSession` so the
 * desktop's persistent-session machinery picks up the agent's existing
 * session ID (and scrollback replay works). Falling back to plain `addTab`
 * would spawn a *new* session on the agent and lose the previous content.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { TooltipProvider } from "@/components/ui";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { AgentDefinitionInfo, AgentSessionInfo } from "@/services/api";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";

// --- mocks required by AgentNode --------------------------------------------

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDndContext: () => ({ active: null }),
  useDndMonitor: () => {},
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

vi.mock("@/services/api", () => ({
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("@/utils/resolveConnectionCredential", () => ({
  resolveConnectionCredential: vi.fn(() =>
    Promise.resolve({ usedStoredCredential: false, password: null })
  ),
}));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({
  ConnectionErrorDialog: () => null,
}));

// --- helpers -----------------------------------------------------------------

const AGENT_ID = "agent-attach-session-test";
const DEFINITION_ID = "def-shell-1";
const AGENT_SESSION_ID = "agent-sess-42";

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Test Agent",
    config: {
      host: "host.example.com",
      port: 22,
      username: "user",
      authMethod: "password",
      password: "secret",
    },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

function makeDefinition(): AgentDefinitionInfo {
  return {
    id: DEFINITION_ID,
    name: "Build Shell",
    sessionType: "shell",
    config: {},
    persistent: true,
    folderId: null,
  };
}

function makeSession(overrides: Partial<AgentSessionInfo> = {}): AgentSessionInfo {
  return {
    sessionId: AGENT_SESSION_ID,
    title: "Build Shell",
    type: "shell",
    status: "running",
    attached: false,
    definitionId: DEFINITION_ID,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

// --- tests -------------------------------------------------------------------

setupAgentsRegion();

describe("AgentNode — Active Sessions reattach", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("routes through adoptAndAttachAgentPersistentSession when definitionId is known", async () => {
    const adopt = vi.fn().mockResolvedValue(undefined);
    const addTab = vi.fn();
    seedAgentsRegion({
      agentDefinitions: { [AGENT_ID]: [makeDefinition()] },
      agentFolders: { [AGENT_ID]: [] },
      agentSessions: { [AGENT_ID]: [makeSession()] },
      remoteAgents: [makeAgent()],
    });
    useAppStore.setState({
      adoptAndAttachAgentPersistentSession: adopt,
      addTab,
    });

    act(() => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(AgentNode, { agent: makeAgent() }),
        })
      );
    });

    const sessionBtn = container.querySelector<HTMLButtonElement>('button[title^="Build Shell"]');
    expect(sessionBtn).not.toBeNull();
    act(() => {
      sessionBtn!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });

    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ id: DEFINITION_ID }),
      AGENT_SESSION_ID
    );
    // The fresh-spawn fallback must NOT fire on the happy path.
    expect(addTab).not.toHaveBeenCalled();
  });

  it("falls back to plain addTab when the session has no definitionId", async () => {
    const adopt = vi.fn().mockResolvedValue(undefined);
    const addTab = vi.fn();
    seedAgentsRegion({
      agentDefinitions: { [AGENT_ID]: [makeDefinition()] },
      agentFolders: { [AGENT_ID]: [] },
      agentSessions: {
        [AGENT_ID]: [makeSession({ definitionId: undefined })],
      },
      remoteAgents: [makeAgent()],
    });
    useAppStore.setState({
      adoptAndAttachAgentPersistentSession: adopt,
      addTab,
    });

    act(() => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(AgentNode, { agent: makeAgent() }),
        })
      );
    });

    const sessionBtn = container.querySelector<HTMLButtonElement>('button[title^="Build Shell"]');
    expect(sessionBtn).not.toBeNull();
    act(() => {
      sessionBtn!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });

    expect(adopt).not.toHaveBeenCalled();
    expect(addTab).toHaveBeenCalledTimes(1);
  });
});
