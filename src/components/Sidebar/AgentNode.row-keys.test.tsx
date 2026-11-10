/**
 * Keyboard access to the Remote Agents tree's context actions (#5181): on a
 * focused agent header, agent folder or agent saved connection, Shift+F10 /
 * the ContextMenu key open its context menu, F2 opens the editor (where it is
 * renamed) and Delete / Backspace start the same confirmed delete as the
 * menu. Focus returns to the row on cancel and moves to the neighbouring row
 * after a delete. A focused terminal never sees these keys acted on.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { AgentDefinitionInfo, AgentFolderInfo } from "@/services/api";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";

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

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));

const AGENT_ID = "agent-keys";

function makeAgent(): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Keys Agent",
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
  };
}

function def(id: string, folderId: string | null = null): AgentDefinitionInfo {
  return { id, name: `Def ${id}`, sessionType: "shell", config: {}, persistent: false, folderId };
}

const DEFINITIONS = [def("d1"), def("d2"), def("inner", "f1")];
const FOLDERS: AgentFolderInfo[] = [
  { id: "f1", name: "Servers", parentId: null, isExpanded: true },
];

function seed(definitions = DEFINITIONS, folders = FOLDERS) {
  seedAgentsRegion({
    remoteAgents: [makeAgent()],
    agentDefinitions: { [AGENT_ID]: definitions },
    agentFolders: { [AGENT_ID]: folders },
    agentSessions: {},
  });
}

function press(el: HTMLElement, key: string, mods: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...mods }));
  });
}

/** Let Radix's close-autofocus and the focus-rescue poll (real timers) run. */
async function settleFocus() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

setupAgentsRegion();

describe("AgentNode — row action keys (#5181)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let openConnectionEditorTab: Mock<(id: string) => void>;
  let openAgentDefinitionEditorTab: Mock<(agentId: string, defId: string) => void>;
  let deleteRemoteAgent: Mock<(agentId: string) => void>;
  let deleteAgentDef: Mock<(agentId: string, defId: string) => Promise<void>>;
  let deleteAgentFolder: Mock<(agentId: string, folderId: string) => Promise<void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    openConnectionEditorTab = vi.fn();
    openAgentDefinitionEditorTab = vi.fn();
    deleteRemoteAgent = vi.fn();
    // A delete really removes the row (asynchronously, like the store's
    // agent round-trip), so focus restoration can be observed.
    deleteAgentDef = vi.fn(async (_agentId: string, defId: string) => {
      await Promise.resolve();
      seed(DEFINITIONS.filter((d) => d.id !== defId));
    });
    deleteAgentFolder = vi.fn(() => Promise.resolve());
    useAppStore.setState({
      openConnectionEditorTab,
      openAgentDefinitionEditorTab,
      deleteRemoteAgent,
      deleteAgentDef,
      deleteAgentFolder,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    seed();
    await act(async () => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(AgentNode, { agent: makeAgent() }),
        })
      );
    });
    await flushAsync();
  }

  const q = (testId: string) =>
    document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const header = () => q(`agent-header-${AGENT_ID}`) as HTMLElement;
  const headerToggle = () =>
    header().querySelector(".connection-list__group-toggle") as HTMLElement;
  const defRow = (id: string) => q(`agent-definition-${id}`) as HTMLElement;
  const folderRow = () => container.querySelector(".connection-tree__folder") as HTMLElement;

  function focused(el: HTMLElement): HTMLElement {
    act(() => el.focus());
    return el;
  }

  async function openWith(el: HTMLElement, key: string, mods: KeyboardEventInit = {}) {
    press(focused(el), key, mods);
    await flushAsync();
  }

  /**
   * Confirm a delete whose row stays (the store mock removes nothing) and drain
   * the 2 s focus-rescue poll it starts. Left on real timers, that poll outlives
   * the test and, on a slow runner, focuses the next test's agent header the
   * moment a closing dialog leaves focus on `body`.
   */
  function confirmAndDrainFocusRescue() {
    vi.useFakeTimers();
    try {
      act(() => q("confirm-delete-confirm")!.click());
      act(() => {
        vi.runAllTimers();
      });
    } finally {
      vi.useRealTimers();
    }
  }

  describe("context menu", () => {
    it("Shift+F10 on a saved connection opens its menu", async () => {
      await render();
      await openWith(defRow("d1"), "F10", { shiftKey: true });
      expect(q("context-agent-def-edit")).not.toBeNull();
      expect(q("context-agent-def-delete")).not.toBeNull();
    });

    it("the ContextMenu key on a folder opens the folder menu", async () => {
      await render();
      await openWith(folderRow(), "ContextMenu");
      expect(q("context-agent-folder-delete")).not.toBeNull();
    });

    it("Shift+F10 on the agent header toggle opens the agent menu", async () => {
      await render();
      await openWith(headerToggle(), "F10", { shiftKey: true });
      expect(q("context-agent-edit")).not.toBeNull();
      expect(q("context-agent-delete")).not.toBeNull();
    });

    it("Shift+F10 on the focused header itself opens the agent menu", async () => {
      await render();
      const h = header();
      h.tabIndex = 0; // dnd-kit's sortable attributes make it a Tab stop in the app
      await openWith(h, "F10", { shiftKey: true });
      expect(q("context-agent-delete")).not.toBeNull();
    });

    it("Escape returns focus to the row", async () => {
      await render();
      const row = defRow("d1");
      await openWith(row, "F10", { shiftKey: true });
      const menu = document.querySelector('[role="menu"]') as HTMLElement;
      expect(menu.contains(document.activeElement)).toBe(true);
      press(document.activeElement as HTMLElement, "Escape");
      await settleFocus();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(row);
    });
  });

  describe("F2", () => {
    it("opens a saved connection's editor", async () => {
      await render();
      press(focused(defRow("d1")), "F2");
      expect(openAgentDefinitionEditorTab).toHaveBeenCalledWith(AGENT_ID, "d1");
    });

    it("opens the agent's editor from its header", async () => {
      await render();
      press(focused(headerToggle()), "F2");
      expect(openConnectionEditorTab).toHaveBeenCalledWith(AGENT_ID);
    });

    it("does nothing on a folder (folders have no rename)", async () => {
      await render();
      press(focused(folderRow()), "F2");
      expect(openAgentDefinitionEditorTab).not.toHaveBeenCalled();
      expect(q("confirm-delete-dialog")).toBeNull();
    });
  });

  describe("Delete / Backspace", () => {
    it.each(["Delete", "Backspace"])("%s on a saved connection opens its confirm", async (key) => {
      await render();
      await openWith(defRow("d1"), key);
      expect(q("confirm-delete-dialog")?.textContent).toContain("Def d1");
      expect(deleteAgentDef).not.toHaveBeenCalled();
    });

    it("Delete on a folder opens the folder confirm", async () => {
      await render();
      await openWith(folderRow(), "Delete");
      expect(q("confirm-delete-dialog")?.textContent).toContain("Servers");
      confirmAndDrainFocusRescue();
      expect(deleteAgentFolder).toHaveBeenCalledWith(AGENT_ID, "f1");
    });

    it("Delete on the agent header opens the agent confirm", async () => {
      await render();
      await openWith(headerToggle(), "Delete");
      expect(q("confirm-delete-dialog")?.textContent).toContain("Keys Agent");
      confirmAndDrainFocusRescue();
      expect(deleteRemoteAgent).toHaveBeenCalledWith(AGENT_ID);
    });

    it("Delete on a header action button does not delete the agent", async () => {
      await render();
      const newFolder = header().querySelector('[aria-label="New Folder"]') as HTMLElement;
      await openWith(newFolder, "Delete");
      expect(q("confirm-delete-dialog")).toBeNull();
    });

    it("cancel returns focus to the row", async () => {
      await render();
      const row = defRow("d1");
      await openWith(row, "Delete");
      act(() => q("confirm-delete-cancel")!.click());
      await settleFocus();
      expect(deleteAgentDef).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(row);
    });

    it("confirm deletes and moves focus to the next row", async () => {
      await render();
      await openWith(defRow("d1"), "Delete");
      act(() => q("confirm-delete-confirm")!.click());
      expect(deleteAgentDef).toHaveBeenCalledWith(AGENT_ID, "d1");
      // The region update lands asynchronously; focus follows once it has.
      await vi.waitFor(() => {
        expect(defRow("d1")).toBeNull();
        expect(document.activeElement).toBe(defRow("d2"));
      });
    });
  });

  it("announces the keys via aria-keyshortcuts", async () => {
    await render();
    expect(defRow("d1").getAttribute("aria-keyshortcuts")).toBe("Shift+F10 F2 Delete");
    expect(folderRow().getAttribute("aria-keyshortcuts")).toBe("Shift+F10 Delete");
    expect(headerToggle().getAttribute("aria-keyshortcuts")).toBe("Shift+F10 F2 Delete");
  });

  it("does not act on the keys while a terminal has focus", async () => {
    await render();
    const terminal = document.createElement("textarea");
    terminal.className = "xterm-helper-textarea";
    document.body.appendChild(terminal);
    try {
      act(() => terminal.focus());
      for (const [key, mods] of [
        ["F10", { shiftKey: true }],
        ["ContextMenu", {}],
        ["F2", {}],
        ["Delete", {}],
        ["Backspace", {}],
      ] as const) {
        press(terminal, key, mods);
      }
      await flushAsync();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(q("confirm-delete-dialog")).toBeNull();
      expect(openConnectionEditorTab).not.toHaveBeenCalled();
      expect(openAgentDefinitionEditorTab).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(terminal);
    } finally {
      terminal.remove();
    }
  });
});
