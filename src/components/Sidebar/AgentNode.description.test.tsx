/**
 * Agent definition rows show the definition's description muted under the
 * name (#5769), like a local saved connection's row, and the Remote Agents
 * search matches it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { AgentDefinitionInfo } from "@/services/api";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";

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

const AGENT_ID = "agent-description-test";

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
    persistent: false,
    folderId: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

setupAgentsRegion();

describe("AgentNode — definition description (#5769)", () => {
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

  const q = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  function renderWith(defs: AgentDefinitionInfo[], filterQuery = ""): void {
    seedAgentsRegion({ remoteAgents: [makeAgent()], agentDefinitions: { [AGENT_ID]: defs } });
    act(() => {
      root.render(React.createElement(AgentNode, { agent: makeAgent(), filterQuery }));
    });
  }

  it("shows the description muted under the name, and nothing extra without one", () => {
    renderWith([
      makeDef({ id: "described", name: "Bench", description: "Lab bench console" }),
      makeDef({ id: "plain", name: "Plain" }),
    ]);

    const described = q("agent-definition-described")!;
    expect(described.querySelector(".connection-tree__label")?.textContent).toBe("Bench");
    const text = q("agent-definition-description-described");
    expect(text?.textContent).toBe("Lab bench console");
    expect(text?.className).toBe("connection-tree__description");

    const plain = q("agent-definition-plain")!;
    expect(plain.querySelector(".connection-tree__label")?.textContent).toBe("Plain");
    expect(q("agent-definition-description-plain")).toBeNull();
    expect(plain.querySelector(".connection-tree__text")).toBeNull();
  });

  it("finds a definition by its description in the search", () => {
    renderWith(
      [
        makeDef({ id: "described", name: "Bench", description: "Lab bench console" }),
        makeDef({ id: "other", name: "Other" }),
      ],
      "console"
    );

    expect(q("agent-definition-described")).not.toBeNull();
    expect(q("agent-definition-other")).toBeNull();
  });
});
