/**
 * Agent-header presentation (#2524):
 *
 *  1. The connection state dot tracks the real `connectionState` — a
 *     disconnected / reconnecting / connecting agent never shows the green
 *     "connected" dot (regression guard for the stale-green bug).
 *  2. The header stacks into two rows: the agent name lives on row 1 alongside
 *     the state bubble + version badge (inside the toggle), while the action
 *     buttons live in a *sibling* container (row 2) so they can never crowd the
 *     name off the row.
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
vi.mock("@/components/AgentUpdateBanner", () => ({ AgentUpdateBanner: () => null }));

// The header's action buttons wrap their icons in the Radix-backed Tooltip, which
// needs a TooltipProvider. Stub it to a passthrough so isolated renders don't
// require the app-root provider.
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return { ...actual, Tooltip: ({ children }: { children: React.ReactNode }) => children };
});

// --- helpers -----------------------------------------------------------------

const AGENT_ID = "agent-header-test";

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Production Box",
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

function stateDot(): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="agent-state-${AGENT_ID}"]`);
}

function header(): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="agent-header-${AGENT_ID}"]`);
}

setupAgentsRegion();

describe("AgentNode — header presentation (#2524)", () => {
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

  describe("state dot tracks connectionState (never stale green)", () => {
    it("shows the connected modifier when connected", () => {
      renderAgent(makeAgent({ connectionState: "connected" }));
      expect(stateDot()?.className).toContain("agent-node__state-dot--connected");
    });

    it("shows the disconnected modifier — not connected — when disconnected", () => {
      renderAgent(makeAgent({ connectionState: "disconnected" }));
      const cls = stateDot()?.className ?? "";
      expect(cls).toContain("agent-node__state-dot--disconnected");
      expect(cls).not.toContain("agent-node__state-dot--connected");
    });

    it("shows the reconnecting modifier — not connected — while reconnecting", () => {
      renderAgent(makeAgent({ connectionState: "reconnecting" }));
      const cls = stateDot()?.className ?? "";
      expect(cls).toContain("agent-node__state-dot--reconnecting");
      expect(cls).not.toContain("agent-node__state-dot--connected");
    });

    it("shows the connecting modifier — not connected — while connecting", () => {
      renderAgent(makeAgent({ connectionState: "connecting" }));
      const cls = stateDot()?.className ?? "";
      expect(cls).toContain("agent-node__state-dot--connecting");
      expect(cls).not.toContain("agent-node__state-dot--connected");
    });
  });

  describe("two-row layout keeps the agent name visible", () => {
    it("marks the agent header with the two-row modifier", () => {
      renderAgent(makeAgent());
      expect(header()?.className).toContain("connection-list__group-header--agent");
    });

    it("keeps the name + state dot on row 1 (the toggle) and buttons in a sibling row", () => {
      renderAgent(makeAgent());

      const toggle = container.querySelector<HTMLElement>(".connection-list__group-toggle");
      const actions = container.querySelector<HTMLElement>(".connection-list__group-actions");
      const title = container.querySelector<HTMLElement>(".connection-list__group-title");

      expect(toggle).not.toBeNull();
      expect(actions).not.toBeNull();
      expect(title?.textContent).toBe("Production Box");

      // Row 1: the state bubble and the agent name live inside the toggle.
      expect(toggle!.contains(stateDot())).toBe(true);
      expect(toggle!.contains(title)).toBe(true);

      // Row 2: the action buttons are a *sibling* of the toggle, never nested
      // inside it — so they can never crowd the name off its row.
      expect(toggle!.contains(actions)).toBe(false);
      expect(actions!.parentElement).toBe(header());
    });
  });
});
