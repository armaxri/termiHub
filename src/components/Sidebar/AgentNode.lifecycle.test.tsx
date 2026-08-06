/**
 * Tests for agent lifecycle stage 3 (#1237, G9): the connected agent header
 * surfaces two distinct intents.
 *
 *  - **Disconnect (detach)** → `disconnect_agent`: drops the transport, leaves
 *    persistent daemon-backed remote sessions running (they re-list on the next
 *    connect). Must NOT call `shutdown_agent`.
 *  - **Shutdown (stop remote)** → `shutdown_agent`: stops remote sessions and
 *    disconnects, surfacing the returned `detached_sessions` count as a toast.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { currentAgentsView } from "@/store/agentsBridge";

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

const disconnectAgentMock = vi.fn((..._args: unknown[]) => Promise.resolve());
const shutdownAgentMock = vi.fn((..._args: unknown[]) => Promise.resolve(3));

vi.mock("@/services/api", () => ({
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
  disconnectAgent: (...args: unknown[]) => disconnectAgentMock(...args),
  shutdownAgent: (...args: unknown[]) => shutdownAgentMock(...args),
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
// Stub the Radix-backed Tooltip to a passthrough so these isolated renders do
// not need the app-root TooltipProvider, and stub `toast` so we can assert the
// Shutdown success feedback carries the detached-session count.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
      loading: vi.fn(),
      dismiss: vi.fn(),
      promise: vi.fn(),
    },
  };
});

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("@/utils/classifyAgentError", () => ({
  classifyAgentError: vi.fn((e) => ({ type: "unknown", message: String(e) })),
}));
vi.mock("@/utils/resolveConnectionCredential", () => ({
  resolveConnectionCredential: vi.fn(() =>
    Promise.resolve({ usedStoredCredential: false, password: null })
  ),
}));
vi.mock("@/utils/ensureCredentialStoreUnlocked", () => ({
  ensureCredentialStoreUnlocked: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));

const AGENT_ID = "agent-lifecycle-test";

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Test Agent",
    config: {
      host: "host.example.com",
      port: 22,
      username: "user",
      authMethod: "password",
    },
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

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

setupAgentsRegion();

describe("AgentNode — disconnect (detach) vs shutdown (stop remote) (#1237, G9)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedAgentsRegion({ remoteAgents: [makeAgent()] });
    disconnectAgentMock.mockClear();
    shutdownAgentMock.mockClear();
    toastSuccess.mockClear();
    toastError.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(): void {
    act(() => {
      root.render(React.createElement(AgentNode, { agent: makeAgent() }));
    });
  }

  it("exposes a Disconnect (detach) control that routes to disconnect_agent only", async () => {
    render();

    const btn = container.querySelector(
      `[data-testid="agent-disconnect-${AGENT_ID}"]`
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();

    act(() => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(disconnectAgentMock).toHaveBeenCalledTimes(1);
    expect(disconnectAgentMock).toHaveBeenCalledWith(AGENT_ID);
    // Detach must never stop the remote sessions.
    expect(shutdownAgentMock).not.toHaveBeenCalled();
  });

  it("exposes a Shutdown (stop remote) control that routes to shutdown_agent and toasts the detached count", async () => {
    render();

    const btn = container.querySelector(
      `[data-testid="agent-shutdown-${AGENT_ID}"]`
    ) as HTMLButtonElement | null;
    expect(btn).not.toBeNull();

    act(() => {
      btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    await flush();

    expect(shutdownAgentMock).toHaveBeenCalledTimes(1);
    expect(shutdownAgentMock).toHaveBeenCalledWith(AGENT_ID);
    // Detach path must not run for a shutdown.
    expect(disconnectAgentMock).not.toHaveBeenCalled();
    // The returned detached_sessions count (3) is surfaced as a success toast.
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(String(toastSuccess.mock.calls[0][0])).toContain("3");
  });
});

describe("appStore — shutdownRemoteAgent (#1237)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    seedAgentsRegion({
      remoteAgents: [makeAgent()],
      agentSessions: {
        [AGENT_ID]: [
          { sessionId: "s1", title: "s", type: "shell", status: "running", attached: false },
        ],
      },
    });
    disconnectAgentMock.mockClear();
    shutdownAgentMock.mockClear();
    toastSuccess.mockClear();
  });

  it("returns the detached_sessions count and marks the agent disconnected", async () => {
    const count = await useAppStore.getState().shutdownRemoteAgent(AGENT_ID);

    expect(shutdownAgentMock).toHaveBeenCalledWith(AGENT_ID);
    expect(count).toBe(3);
    const agent = currentAgentsView().remoteAgents.find((a) => a.id === AGENT_ID);
    expect(agent?.connectionState).toBe("disconnected");
    expect(currentAgentsView().agentSessions[AGENT_ID]).toEqual([]);
  });
});
