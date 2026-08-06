/**
 * Verifies the Sidebar connection-tree row action icons adopt the shared
 * `Tooltip` primitive for their icon-only controls (issue #1159).
 *
 * A tooltip is not an accessible name, so each converted icon button must keep
 * an `aria-label`, must not carry a bare `title=` (which would double as the
 * accessible name), and the Radix tooltip trigger must wire `aria-describedby`
 * when focused. These assertions pin all three across the ConnectionList group
 * actions and the AgentNode persistent-session controls.
 *
 * The truncation `title=` on connection/host/session *names* (non-interactive
 * full-text hovers) is intentionally kept and is asserted to remain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { AgentNode } from "./AgentNode";
import { withTooltip } from "@/test/tooltip";
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
  SortableContext: ({ children }: { children: React.ReactNode }) => children,
  verticalListSortingStrategy: {},
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => children,
  DragOverlay: ({ children }: { children: React.ReactNode }) => children,
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDndContext: () => ({ active: null }),
  useDndMonitor: () => {},
  useSensor: () => ({}),
  useSensors: () => [],
  PointerSensor: class {},
  pointerWithin: () => [],
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
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
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));

const AGENT_ID = "agent-tooltip-test";
const DEFINITION_ID = "def-persistent-1";

function makeAgent(): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Tooltip Agent",
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
  };
}

function makePersistentDefinition(): AgentDefinitionInfo {
  return {
    id: DEFINITION_ID,
    name: "Persistent Shell",
    sessionType: "shell",
    config: {},
    persistent: true,
    folderId: null,
  };
}

let container: HTMLDivElement;
let root: Root;

/** Every converted icon button must have an accessible name and no bare title. */
function expectAccessibleIconButton(btn: HTMLButtonElement | null): void {
  expect(btn).not.toBeNull();
  expect(btn?.getAttribute("aria-label")).toBeTruthy();
  expect(btn?.getAttribute("title")).toBeNull();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  useAppStore.setState(useAppStore.getInitialState());
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

setupAgentsRegion();

describe("Sidebar ConnectionList group actions — tooltip adoption (#1159)", () => {
  function renderList() {
    act(() => {
      root.render(withTooltip(<ConnectionList />));
    });
  }

  it("exposes aria-label and drops the bare title on New Folder / New Connection", () => {
    renderList();

    expectAccessibleIconButton(
      container.querySelector<HTMLButtonElement>('[data-testid="connection-list-new-folder"]')
    );
    expectAccessibleIconButton(
      container.querySelector<HTMLButtonElement>('[data-testid="connection-list-new-connection"]')
    );
  });

  it("wires aria-describedby on the New Connection button when focused", () => {
    renderList();

    const btn = container.querySelector<HTMLButtonElement>(
      '[data-testid="connection-list-new-connection"]'
    )!;
    act(() => {
      btn.focus();
      btn.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });
    // Radix associates the open tooltip with its trigger for screen readers.
    expect(btn.getAttribute("aria-describedby")).toBeTruthy();
  });
});

describe("Sidebar AgentNode persistent controls — tooltip adoption (#1159)", () => {
  function renderAgent() {
    seedAgentsRegion({
      agentDefinitions: { [AGENT_ID]: [makePersistentDefinition()] },
      agentFolders: { [AGENT_ID]: [] },
      agentSessions: { [AGENT_ID]: [] },
      remoteAgents: [makeAgent()],
    });
    act(() => {
      root.render(withTooltip(<AgentNode agent={makeAgent()} />));
    });
  }

  it("exposes aria-label and drops the bare title on the Start session control", () => {
    renderAgent();

    expectAccessibleIconButton(
      container.querySelector<HTMLButtonElement>(
        `[data-testid="persistent-start-${DEFINITION_ID}"]`
      )
    );
  });

  it("keeps the truncation title on the session-definition row (non-interactive name hover)", () => {
    renderAgent();

    const row = container.querySelector<HTMLElement>('[title^="Persistent Shell"]');
    expect(row).not.toBeNull();
  });
});
