/**
 * Agent-header presentation (#2524):
 *
 *  1. The connection state dot tracks the real `connectionState` — a
 *     disconnected / reconnecting / connecting agent never shows the green
 *     "connected" dot (regression guard for the stale-green bug).
 *  2. The agent name lives in the toggle with the state bubble + compact
 *     markers; the actions are icon buttons in a *sibling* container at the end
 *     of the same row, so they can never squeeze the name (#5851). A connected
 *     agent shows only "+" and one "…" menu, not four bare icons (R-013).
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
vi.mock("@/components/AgentUpdateBanner", () => ({
  AgentUpdateBanner: () => null,
  AgentUpdateMarker: () => null,
  countAgentSessionTabs: () => 0,
}));

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
    // The dot renders via the shared StatusDot primitive, so state now maps to
    // the `--state-*` tones: connected → connected, (re)connecting → connecting,
    // a failed/dropped agent → disconnected, a never-connected one → the neutral
    // disabled tone (UISF-003 follow-up, #5621).
    it("shows the connected tone when connected", () => {
      renderAgent(makeAgent({ connectionState: "connected" }));
      const cls = stateDot()?.className ?? "";
      expect(cls).toContain("status-dot--connected");
    });

    it("shows the disconnected tone — not connected — after a failure", () => {
      renderAgent(makeAgent({ connectionState: "disconnected", lastError: "boom" }));
      const cls = stateDot()?.className ?? "";
      expect(cls).toContain("status-dot--disconnected");
      expect(cls).not.toContain("status-dot--connected");
    });

    it("shows the connecting tone — not connected — while reconnecting", () => {
      renderAgent(makeAgent({ connectionState: "reconnecting" }));
      const cls = stateDot()?.className ?? "";
      expect(cls).toContain("status-dot--connecting");
      expect(cls).not.toContain("status-dot--connected");
    });

    it("shows the connecting tone — not connected — while connecting", () => {
      renderAgent(makeAgent({ connectionState: "connecting" }));
      const cls = stateDot()?.className ?? "";
      expect(cls).toContain("status-dot--connecting");
      expect(cls).not.toContain("status-dot--connected");
    });

    it.each([
      ["connected", "Connected"],
      ["connecting", "Connecting"],
      ["reconnecting", "Reconnecting"],
      ["disconnected", "Disconnected"],
    ] as const)(
      "exposes a non-colour accessible name (%s → %s) for the state dot",
      (connectionState, label) => {
        renderAgent(makeAgent({ connectionState, lastError: "boom" }));
        const dot = stateDot();
        // role=img + aria-label surface the state to AT without hover/colour (A11Y-004).
        expect(dot?.getAttribute("role")).toBe("img");
        expect(dot?.getAttribute("aria-label")).toBe(label);
      }
    );
  });

  describe("two-row layout keeps the agent name visible", () => {
    it("marks the agent header with the two-row modifier", () => {
      renderAgent(makeAgent());
      expect(header()?.className).toContain("connection-list__group-header--agent");
    });

    it("keeps the name + state dot in the toggle and the buttons in a sibling", () => {
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

      // The action buttons are a *sibling* of the toggle, never nested inside
      // it — so they can never crowd the name off its row.
      expect(toggle!.contains(actions)).toBe(false);
      expect(actions!.parentElement).toBe(toggle!.parentElement);
    });
  });

  // R-010 (#5702): the single state action (Connect / Reconnect / Cancel) sits
  // on the agent row itself, beside the name — not on a second header row.
  describe("the state action sits on the agent row", () => {
    const row1 = () => header()?.querySelector<HTMLElement>(":scope > .connection-list__group-row");
    const secondRowActions = () =>
      header()?.querySelector<HTMLElement>(":scope > .connection-list__group-actions") ?? null;

    it.each([
      ["never connected → Connect", { connectionState: "disconnected" as const }, "agent-connect"],
      [
        "failed → Reconnect",
        { connectionState: "disconnected" as const, lastError: "boom" },
        "agent-reconnect",
      ],
      ["connecting → Cancel", { connectionState: "connecting" as const }, "agent-cancel-connect"],
    ])("%s is inline on row 1", (_label, overrides, testIdPrefix) => {
      renderAgent(makeAgent(overrides));

      const row = row1();
      const toggle = container.querySelector<HTMLElement>(".connection-list__group-toggle");
      const action = container.querySelector<HTMLElement>(
        `[data-testid="${testIdPrefix}-${AGENT_ID}"]`
      );
      expect(row).not.toBeNull();
      expect(action).not.toBeNull();
      expect(row!.contains(toggle)).toBe(true);
      expect(row!.contains(action)).toBe(true);
      // Never nested in the toggle button (no button-in-button), and no
      // second header row is spent on a single action.
      expect(toggle!.contains(action)).toBe(false);
      expect(secondRowActions()).toBeNull();
    });

    it("folds a connected agent's actions into '+' and one '…' menu on row 1 (#5851)", () => {
      renderAgent(makeAgent({ connectionState: "connected" }));

      expect(secondRowActions()).toBeNull();
      const actions = row1()!.querySelector<HTMLElement>(".connection-list__group-actions");
      expect(actions).not.toBeNull();
      const buttons = [...actions!.querySelectorAll("button")].map((b) =>
        b.getAttribute("aria-label")
      );
      expect(buttons).toEqual(["New connection", "More actions for Production Box"]);
      // Detach / shutdown are menu entries now, not bare header icons.
      expect(container.querySelector(`[data-testid="agent-disconnect-${AGENT_ID}"]`)).toBeNull();
    });

    it("shows Connect and Reconnect as icon buttons, so the name keeps the width", () => {
      renderAgent(makeAgent({ connectionState: "disconnected" }));
      const connect = container.querySelector(`[data-testid="agent-connect-${AGENT_ID}"]`);
      expect(connect?.textContent).toBe("");
      expect(connect?.getAttribute("aria-label")).toBe("Connect");
      renderAgent(makeAgent({ connectionState: "disconnected", lastError: "boom" }));
      const reconnect = container.querySelector(`[data-testid="agent-reconnect-${AGENT_ID}"]`);
      expect(reconnect?.textContent).toBe("");
      expect(reconnect?.getAttribute("title")).toBe("Reconnect — boom");
    });

    it("puts the description in the name's text column (R-047, #5851)", () => {
      renderAgent(makeAgent({ connectionState: "disconnected", description: "Lab bench" }));
      const title = container.querySelector(`[data-testid="agent-name-${AGENT_ID}"]`);
      const desc = container.querySelector(`[data-testid="agent-description-${AGENT_ID}"]`);
      expect(desc?.textContent).toBe("Lab bench");
      expect(desc?.parentElement).toBe(title?.parentElement);
      expect(title?.parentElement?.className).toBe("connection-list__group-text");
    });
  });
});
