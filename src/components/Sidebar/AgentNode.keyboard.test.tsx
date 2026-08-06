/**
 * Keyboard-navigation + ARIA tree semantics + search filter for the Remote
 * Agents tree (#1379).
 *
 * The agent tree adopts the same roving-tabindex arrow-key model + tree ARIA
 * roles as the Connections tree: one row is tabbable at a time, arrows move the
 * roving focus, Enter activates the focused row, and a header filter narrows the
 * saved definitions (auto-expanding matching folders).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { AgentDefinitionInfo, AgentFolderInfo } from "@/services/api";
import { setupAgentsRegionMirror } from "@/test/agentsRegionTestHarness";

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

vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));

vi.mock("@/services/api", () => ({
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
}));

const addTabMock = vi.fn();

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

const AGENT_ID = "agent-kbd-test";

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

function def(id: string, name: string, folderId: string | null = null): AgentDefinitionInfo {
  return { id, name, sessionType: "shell", config: {}, persistent: false, folderId };
}

function folder(id: string, name: string, isExpanded = true): AgentFolderInfo {
  return { id, name, parentId: null, isExpanded };
}

let container: HTMLDivElement;
let root: Root;

function query(sel: string): HTMLElement | null {
  return container.querySelector(sel);
}

function seed(definitions: AgentDefinitionInfo[], folders: AgentFolderInfo[] = []) {
  useAppStore.setState(useAppStore.getInitialState());
  useAppStore.setState({
    remoteAgents: [makeAgent()],
    agentDefinitions: { [AGENT_ID]: definitions },
    agentFolders: { [AGENT_ID]: folders },
    agentSessions: {},
    addTab: addTabMock,
  });
}

function render(filterQuery?: string) {
  act(() => {
    root.render(React.createElement(AgentNode, { agent: makeAgent(), filterQuery }));
  });
}

function press(row: HTMLElement, key: string) {
  act(() => {
    row.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

setupAgentsRegionMirror();

describe("AgentNode — keyboard navigation + filter (#1379)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("marks the agent tree as a tree with treeitem rows", () => {
    seed([def("d1", "alpha"), def("d2", "bravo")]);
    render();
    const tree = query('[role="tree"]');
    expect(tree).not.toBeNull();
    const rows = container.querySelectorAll('[role="treeitem"]');
    expect(rows.length).toBe(2);
    expect(rows[0].getAttribute("aria-level")).toBe("1");
  });

  it("keeps a single roving-tabindex row and moves it with ArrowDown", () => {
    seed([def("d1", "alpha"), def("d2", "bravo")]);
    render();
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    expect(rows[0].getAttribute("tabindex")).toBe("0");
    expect(rows[1].getAttribute("tabindex")).toBe("-1");
    press(rows[0], "ArrowDown");
    expect(document.activeElement).toBe(rows[1]);
    expect(rows[1].getAttribute("tabindex")).toBe("0");
  });

  it("opens the focused definition on Enter", () => {
    seed([def("d1", "alpha"), def("d2", "bravo")]);
    render();
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    press(rows[0], "ArrowDown");
    press(rows[1], "Enter");
    expect(addTabMock).toHaveBeenCalledTimes(1);
    // The opened definition is the second row (bravo).
    expect(addTabMock.mock.calls[0][0]).toBe("bravo");
  });

  it("marks folder rows with aria-expanded", () => {
    seed([def("d1", "alpha", "f1")], [folder("f1", "Prod")]);
    render();
    const folderRow = container.querySelector("[aria-expanded]");
    expect(folderRow).not.toBeNull();
    expect(folderRow!.getAttribute("aria-expanded")).toBe("true");
  });

  it("filters the tree to matching definitions", () => {
    seed([def("d1", "web-server"), def("d2", "database")]);
    render("web");
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const labels = rows.map((r) => r.textContent);
    expect(labels.some((l) => l?.includes("web-server"))).toBe(true);
    expect(labels.some((l) => l?.includes("database"))).toBe(false);
  });
});
