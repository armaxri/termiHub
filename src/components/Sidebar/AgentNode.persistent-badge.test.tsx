/**
 * Agent persistent-shell badge (#2086, refined by #2099).
 *
 * The ∞ badge appears ONLY on agent persistent shells. A persistent saved
 * definition on a connected agent keeps the ∞ — the session lives on the remote
 * agent and survives closing termiHub AND powering off / restarting this
 * machine. The badge's tooltip states exactly that. A non-persistent definition
 * shows no badge. Every other (non-agent) connection type shows no persistence
 * marker at all — see ConnectionList.persistent.test / Tab.persistent-badge.test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { AgentDefinitionInfo } from "@/services/api";

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
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), isDragging: false }),
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
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
  disconnectAgent: vi.fn(() => Promise.resolve()),
  shutdownAgent: vi.fn(() => Promise.resolve(0)),
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
}));

// Passthrough Tooltip so the isolated render needs no app-root TooltipProvider.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
      promise: vi.fn(),
    },
  };
});

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));

const AGENT_ID = "agent-badge-test";

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Test Agent",
    config: { host: "host.example.com", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    capabilities: {
      connectionTypes: [],
      maxSessions: 10,
      availableShells: ["bash"],
      availableSerialPorts: [],
      availableDockerImages: [],
    },
    ...overrides,
  };
}

function makeDef(overrides: Partial<AgentDefinitionInfo> = {}): AgentDefinitionInfo {
  return {
    id: "def-1",
    name: "Build Shell",
    sessionType: "shell",
    config: {},
    persistent: true,
    folderId: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(): void {
  act(() => {
    root.render(React.createElement(AgentNode, { agent: makeAgent() }));
  });
}

describe("AgentNode — agent-backed persistence badge (#2086)", () => {
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

  it("renders the ∞ badge with a survives-restart tooltip for a persistent definition", () => {
    useAppStore.setState({
      remoteAgents: [makeAgent()],
      agentDefinitions: { [AGENT_ID]: [makeDef({ persistent: true })] },
    });
    render();
    const badge = container.querySelector('[data-testid="persistent-badge-def-1"]');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toContain("∞");
    expect(badge!.getAttribute("title") ?? "").toContain("restarting this machine");
    // Agent-backed rows must not use the desktop-local marker.
    expect(container.querySelector(".tab__local-persistent-badge")).toBeNull();
    expect(container.querySelector(".connection-tree__local-persistent-badge")).toBeNull();
  });

  it("renders no ∞ badge for a non-persistent definition", () => {
    useAppStore.setState({
      remoteAgents: [makeAgent()],
      agentDefinitions: { [AGENT_ID]: [makeDef({ persistent: false })] },
    });
    render();
    expect(container.querySelector('[data-testid="persistent-badge-def-1"]')).toBeNull();
  });
});
