/**
 * A failed agent says why in a row under its header, with the next step
 * (#6160), not only in the Reconnect button's tooltip.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { useAgentSetupStatus } from "@/store/agentSetupStatus";

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
vi.mock("./ConnectionErrorDialog", () => ({
  ConnectionErrorDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement("div", { "data-testid": "connection-error-dialog" }) : null,
}));
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

const AGENT_ID = "agent-failure-row";

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Edge gateway",
    config: { host: "edge.example", port: 22, username: "ops", authMethod: "password" },
    connectionState: "disconnected",
    isExpanded: false,
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

const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const reasonRow = () => q(`agent-reason-${AGENT_ID}`);

setupAgentsRegion();

describe("AgentNode — a failed agent says why in its row (#6160)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAgentSetupStatus.setState({ phases: {}, tabs: {} });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows the reason and its next step under the header, without hovering", () => {
    renderAgent(makeAgent({ lastError: "[thub-code:unreachable] connect timed out" }));
    expect(reasonRow()?.textContent).toContain("Could not reach edge.example.");
    expect(q(`agent-reason-step-edit-${AGENT_ID}`)?.textContent).toBe("Edit connection");
    expect(q(`agent-reason-step-details-${AGENT_ID}`)?.textContent).toBe("Details");
  });

  it("offers Set up agent for a host without the agent", () => {
    renderAgent(makeAgent({ lastError: "[thub-code:agent_missing] not found" }));
    expect(reasonRow()?.textContent).toContain("not installed on edge.example");
    expect(q(`agent-reason-step-setup-${AGENT_ID}`)).not.toBeNull();
  });

  it("Details opens the full error", () => {
    renderAgent(makeAgent({ lastError: "Broken pipe (os error 32)" }));
    act(() => q(`agent-reason-step-details-${AGENT_ID}`)!.click());
    expect(q("connection-error-dialog")).not.toBeNull();
  });

  it("shows no reason while connected, or while a setup installs it", () => {
    renderAgent(
      makeAgent({ connectionState: "connected", lastError: "[thub-code:unreachable] x" })
    );
    expect(reasonRow()).toBeNull();
    act(() => useAgentSetupStatus.getState().markInstalling(AGENT_ID));
    renderAgent(makeAgent({ lastError: "[thub-code:agent_missing] x" }));
    expect(reasonRow()).toBeNull();
  });

  it("shows no reason for an agent that never failed", () => {
    renderAgent(makeAgent());
    expect(reasonRow()).toBeNull();
  });
});
