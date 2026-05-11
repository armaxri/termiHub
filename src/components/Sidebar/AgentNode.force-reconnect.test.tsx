/**
 * Tests for the "Force Reconnect" flow in AgentNode.
 *
 * handleForceReconnect is always passed to ConnectionErrorDialog as
 * onForceReconnect. We capture it via a mock and verify the disconnect →
 * reconnect sequence without relying on context-menu interaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { ClassifiedAgentError } from "@/utils/classifyAgentError";

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

// --- ConnectionErrorDialog mock that captures its props ----------------------

interface CapturedDialogProps {
  onForceReconnect?: () => void | Promise<void>;
  error: ClassifiedAgentError | null;
}

let capturedDialogProps: CapturedDialogProps = { onForceReconnect: undefined, error: null };

vi.mock("./ConnectionErrorDialog", () => ({
  ConnectionErrorDialog: (props: CapturedDialogProps) => {
    capturedDialogProps = props;
    return null;
  },
}));

// --- helpers -----------------------------------------------------------------

const AGENT_ID = "agent-force-reconnect-test";

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

// --- tests -------------------------------------------------------------------

describe("AgentNode — force reconnect wiring", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    capturedDialogProps = { onForceReconnect: undefined, error: null };
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("always passes onForceReconnect to ConnectionErrorDialog", () => {
    act(() => {
      root.render(React.createElement(AgentNode, { agent: makeAgent() }));
    });

    expect(capturedDialogProps.onForceReconnect).toBeTypeOf("function");
  });

  it("onForceReconnect calls disconnectRemoteAgent then connectRemoteAgent", async () => {
    const mockDisconnect = vi.fn().mockResolvedValue(undefined);
    const mockConnect = vi.fn().mockResolvedValue(undefined);

    useAppStore.setState({
      agentDefinitions: { [AGENT_ID]: [] },
      agentFolders: { [AGENT_ID]: [] },
      agentSessions: { [AGENT_ID]: [] },
      disconnectRemoteAgent: mockDisconnect,
      connectRemoteAgent: mockConnect,
      remoteAgents: [makeAgent()],
    });

    act(() => {
      root.render(React.createElement(AgentNode, { agent: makeAgent() }));
    });

    await act(async () => {
      await capturedDialogProps.onForceReconnect!();
    });

    expect(mockDisconnect).toHaveBeenCalledWith(AGENT_ID);
    expect(mockConnect).toHaveBeenCalled();
  });

  it("calls disconnectRemoteAgent before connectRemoteAgent", async () => {
    const callOrder: string[] = [];
    const mockDisconnect = vi.fn().mockImplementation(async () => {
      callOrder.push("disconnect");
    });
    const mockConnect = vi.fn().mockImplementation(async () => {
      callOrder.push("connect");
    });

    useAppStore.setState({
      agentDefinitions: { [AGENT_ID]: [] },
      agentFolders: { [AGENT_ID]: [] },
      agentSessions: { [AGENT_ID]: [] },
      disconnectRemoteAgent: mockDisconnect,
      connectRemoteAgent: mockConnect,
      remoteAgents: [makeAgent()],
    });

    act(() => {
      root.render(React.createElement(AgentNode, { agent: makeAgent() }));
    });

    await act(async () => {
      await capturedDialogProps.onForceReconnect!();
    });

    expect(callOrder).toEqual(["disconnect", "connect"]);
  });
});
