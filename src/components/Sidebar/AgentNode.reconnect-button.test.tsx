/**
 * G3 (#1236): a disconnected agent header exposes a first-class Reconnect
 * affordance.
 *
 * After auto-reconnect exhausts its retries the backend emits `disconnected`
 * with the terminal error; the store records it as `lastError`. The header must
 * then render a Reconnect button whose tooltip carries that `lastError`, and
 * clicking it must re-invoke the normal connect path (which drives the agent
 * back through disconnected → connecting).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
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
vi.mock("@/utils/ensureCredentialStoreUnlocked", () => ({
  ensureCredentialStoreUnlocked: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));

// The header's other action buttons wrap their icons in the Radix-backed
// Tooltip, which needs a TooltipProvider. Stub it to a passthrough so these
// isolated renders don't require the app-root provider — the Reconnect button
// carries its help text via a native `title`, not this primitive.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, Tooltip: ({ children }: { children: React.ReactNode }) => children };
});

// --- helpers -----------------------------------------------------------------

const AGENT_ID = "agent-reconnect-btn-test";

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
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function renderAgent(agent: RemoteAgentDefinition) {
  seedAgentsRegion({
    agentDefinitions: { [AGENT_ID]: [] },
    agentFolders: { [AGENT_ID]: [] },
    agentSessions: { [AGENT_ID]: [] },
    remoteAgents: [agent],
  });
  act(() => {
    root.render(React.createElement(AgentNode, { agent }));
  });
}

function reconnectButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-testid="agent-reconnect-${AGENT_ID}"]`);
}

// --- tests -------------------------------------------------------------------

setupAgentsRegion();

describe("AgentNode — Reconnect button (G3, #1236)", () => {
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

  it("renders a Reconnect button when the agent is disconnected", () => {
    renderAgent(makeAgent({ lastError: "Failed to reconnect after 10 attempts" }));

    expect(reconnectButton()).not.toBeNull();
  });

  it("does not render a Reconnect button while connected", () => {
    renderAgent(makeAgent({ connectionState: "connected" }));

    expect(reconnectButton()).toBeNull();
  });

  it("carries lastError as the Reconnect button's tooltip/title", () => {
    const error = "Failed to reconnect after 10 attempts";
    renderAgent(makeAgent({ lastError: error }));

    const btn = reconnectButton();
    expect(btn).not.toBeNull();
    // Tooltip content is mirrored onto the accessible title attribute.
    expect(btn!.getAttribute("title")).toContain(error);
  });

  it("invokes the connect path when clicked", async () => {
    const mockConnect = vi.fn().mockResolvedValue(undefined);
    // The connect handler captures connectRemoteAgent at render time, so the
    // mock must be installed before the component renders.
    useAppStore.setState({ connectRemoteAgent: mockConnect });
    renderAgent(makeAgent({ lastError: "boom" }));

    const btn = reconnectButton();
    expect(btn).not.toBeNull();

    await act(async () => {
      btn!.click();
      // Let the async handleConnect chain settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockConnect).toHaveBeenCalled();
    expect(mockConnect.mock.calls[0][0]).toBe(AGENT_ID);
  });
});
