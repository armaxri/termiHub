/**
 * Tests for the sidebar Cancel affordance on a connecting agent (G1, #1235).
 *
 * A `connecting` agent is no longer a dead-end: an inline Cancel button fires
 * cancel_connect_agent, which aborts the in-flight SSH + initialize handshake.
 * The backend is the single writer of connectionState, so no optimistic write
 * happens here — the test just verifies the command is invoked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";

const cancelConnectAgent = vi.fn((_id: string) => Promise.resolve(true));

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
  cancelConnectAgent: (id: string) => cancelConnectAgent(id),
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
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));

const AGENT_ID = "agent-cancel-connect-test";

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
    connectionState: "disconnected",
    isExpanded: false,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

describe("AgentNode — cancel connect (G1)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    cancelConnectAgent.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function renderAgent(agent: RemoteAgentDefinition) {
    act(() => {
      root.render(
        React.createElement(
          TooltipProvider,
          { delayDuration: 0 },
          React.createElement(AgentNode, { agent })
        )
      );
    });
  }

  it("shows an inline Cancel button while connecting and fires cancel_connect_agent", () => {
    renderAgent(makeAgent({ connectionState: "connecting" }));

    const cancelBtn = container.querySelector(
      `[data-testid="agent-cancel-connect-${AGENT_ID}"]`
    ) as HTMLButtonElement;
    expect(cancelBtn).not.toBeNull();

    act(() => cancelBtn.click());
    expect(cancelConnectAgent).toHaveBeenCalledWith(AGENT_ID);
  });

  it("does not show the Cancel button when disconnected", () => {
    renderAgent(makeAgent({ connectionState: "disconnected" }));
    const cancelBtn = container.querySelector(`[data-testid="agent-cancel-connect-${AGENT_ID}"]`);
    expect(cancelBtn).toBeNull();
  });

  it("does not show the Cancel button when connected", () => {
    renderAgent(makeAgent({ connectionState: "connected" }));
    const cancelBtn = container.querySelector(`[data-testid="agent-cancel-connect-${AGENT_ID}"]`);
    expect(cancelBtn).toBeNull();
  });
});
