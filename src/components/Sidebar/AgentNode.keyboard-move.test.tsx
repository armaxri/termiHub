/**
 * Keyboard / context-menu alternatives to dragging in the Remote Agents tree
 * (#4641, WCAG 2.1.1 / 2.5.7), following the Connections tree pattern (#4528).
 *
 * - An agent header reorders with Ctrl/Cmd+Shift+ArrowUp/Down and offers Move
 *   Up / Move Down in its context menu.
 * - An agent's saved connection offers Move to Folder (the agent's folders plus
 *   its top level), calling the store actions the drag path uses.
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
import { checkA11y } from "@/test/axe";
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

const AGENT_ID = "agent-move";

function makeAgent(): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Move Agent",
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

function folder(id: string, name: string, parentId: string | null = null): AgentFolderInfo {
  return { id, name, parentId, isExpanded: true };
}

/** Root holds r1, r2; folder "prod" holds p1; "web" is a subfolder of "prod". */
const DEFINITIONS = [def("r1"), def("r2"), def("p1", "prod")];
const FOLDERS = [folder("prod", "Prod"), folder("web", "Web", "prod")];

setupAgentsRegion();

describe("AgentNode — move without dragging (#4641)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let moveAgentDefToFolder: Mock<
    (agentId: string, defId: string, folderId: string | null) => Promise<void>
  >;
  let bulkMoveAgentDefsToFolder: Mock<
    (agentId: string, defIds: string[], folderId: string | null) => Promise<void>
  >;
  let onMoveBy: Mock<(agentId: string, delta: -1 | 1) => void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    moveAgentDefToFolder = vi.fn(() => Promise.resolve());
    bulkMoveAgentDefsToFolder = vi.fn(() => Promise.resolve());
    onMoveBy = vi.fn();
    useAppStore.setState({ moveAgentDefToFolder, bulkMoveAgentDefsToFolder });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(
    options: {
      definitions?: AgentDefinitionInfo[];
      folders?: AgentFolderInfo[];
      canMoveUp?: boolean;
      canMoveDown?: boolean;
      reorder?: boolean;
    } = {}
  ) {
    const {
      definitions = DEFINITIONS,
      folders = FOLDERS,
      canMoveUp = true,
      canMoveDown = true,
      reorder = true,
    } = options;
    seedAgentsRegion({
      remoteAgents: [makeAgent()],
      agentDefinitions: { [AGENT_ID]: definitions },
      agentFolders: { [AGENT_ID]: folders },
      agentSessions: {},
    });
    const canMoveBy = (_id: string, delta: -1 | 1) => (delta === -1 ? canMoveUp : canMoveDown);
    await act(async () => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(AgentNode, {
            agent: makeAgent(),
            ...(reorder ? { canMoveBy, onMoveBy } : {}),
          }),
        })
      );
    });
    await flushAsync();
  }

  const header = () =>
    container.querySelector(`[data-testid="agent-header-${AGENT_ID}"]`) as HTMLElement;
  const headerToggle = () => header().querySelector("button") as HTMLElement;
  const defRow = (id: string) =>
    container.querySelector(`[data-testid="agent-definition-${id}"]`) as HTMLElement;
  const menuItem = (testId: string) =>
    document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const isDisabled = (testId: string) => menuItem(testId)?.hasAttribute("data-disabled");

  function pressMove(el: HTMLElement, key: "ArrowUp" | "ArrowDown", mod: "ctrlKey" | "metaKey") {
    act(() => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key, shiftKey: true, [mod]: true, bubbles: true })
      );
    });
  }

  async function openMenu(el: HTMLElement) {
    await act(async () => {
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await flushAsync();
  }

  async function select(testId: string) {
    const item = menuItem(testId) as HTMLElement;
    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushAsync();
  }

  async function openMoveToFolder(id: string) {
    await openMenu(defRow(id));
    const trigger = menuItem("context-agent-def-move-folder") as HTMLElement;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await flushAsync();
  }

  describe("agent reorder", () => {
    it("Ctrl+Shift+ArrowDown on the focused agent header moves it down", async () => {
      await render();
      pressMove(headerToggle(), "ArrowDown", "ctrlKey");
      expect(onMoveBy).toHaveBeenCalledWith(AGENT_ID, 1);
    });

    it("Cmd+Shift+ArrowUp on the agent header moves it up", async () => {
      await render();
      pressMove(header(), "ArrowUp", "metaKey");
      expect(onMoveBy).toHaveBeenCalledWith(AGENT_ID, -1);
    });

    it("plain arrows on the header do not reorder", async () => {
      await render();
      act(() => {
        headerToggle().dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
        );
      });
      expect(onMoveBy).not.toHaveBeenCalled();
    });

    it("the move shortcut on a saved-connection row does not reorder the agent", async () => {
      await render();
      pressMove(defRow("r1"), "ArrowDown", "ctrlKey");
      expect(onMoveBy).not.toHaveBeenCalled();
    });

    it("Move Up / Move Down in the agent menu call the reorder", async () => {
      await render();
      await openMenu(header());
      await select("context-agent-move-down");
      expect(onMoveBy).toHaveBeenLastCalledWith(AGENT_ID, 1);
      await openMenu(header());
      await select("context-agent-move-up");
      expect(onMoveBy).toHaveBeenLastCalledWith(AGENT_ID, -1);
    });

    it("disables Move Up on the first agent and Move Down on the last", async () => {
      await render({ canMoveUp: false, canMoveDown: true });
      await openMenu(header());
      expect(isDisabled("context-agent-move-up")).toBe(true);
      expect(isDisabled("context-agent-move-down")).toBe(false);
    });

    it("disables both for a single agent", async () => {
      await render({ canMoveUp: false, canMoveDown: false });
      await openMenu(header());
      expect(isDisabled("context-agent-move-up")).toBe(true);
      expect(isDisabled("context-agent-move-down")).toBe(true);
    });

    it("omits the reorder items when no reorder handler is given", async () => {
      await render({ reorder: false });
      await openMenu(header());
      expect(menuItem("context-agent-edit")).not.toBeNull();
      expect(menuItem("context-agent-move-up")).toBeNull();
    });

    it("has no axe violations with the agent menu open", async () => {
      await render();
      await openMenu(header());
      expect(await checkA11y()).toHaveNoViolations();
    });
  });

  describe("Move to Folder for agent connections", () => {
    it("lists the agent's top level and every folder by its path", async () => {
      await render();
      await openMoveToFolder("r1");
      expect(menuItem("context-agent-def-move-folder-submenu")).not.toBeNull();
      expect(menuItem("context-agent-def-move-folder-root")?.textContent).toContain("Top Level");
      expect(menuItem("context-agent-def-move-folder-prod")?.textContent).toContain("Prod");
      expect(menuItem("context-agent-def-move-folder-web")?.textContent).toContain("Prod / Web");
    });

    it("moves a connection into a nested folder", async () => {
      await render();
      await openMoveToFolder("r1");
      await select("context-agent-def-move-folder-web");
      expect(moveAgentDefToFolder).toHaveBeenCalledWith(AGENT_ID, "r1", "web");
    });

    it("moves a connection out of a folder to the agent's top level", async () => {
      await render();
      await openMoveToFolder("p1");
      await select("context-agent-def-move-folder-root");
      expect(moveAgentDefToFolder).toHaveBeenCalledWith(AGENT_ID, "p1", null);
    });

    it("disables the connection's current folder, including the top level", async () => {
      await render();
      await openMoveToFolder("r1");
      expect(isDisabled("context-agent-def-move-folder-root")).toBe(true);
      expect(isDisabled("context-agent-def-move-folder-prod")).toBe(false);
    });

    it("disables the folder a connection is already in", async () => {
      await render();
      await openMoveToFolder("p1");
      expect(isDisabled("context-agent-def-move-folder-prod")).toBe(true);
      expect(isDisabled("context-agent-def-move-folder-root")).toBe(false);
    });

    it("offers only Top Level when the agent has no folders", async () => {
      await render({ definitions: [def("a"), def("b")], folders: [] });
      await openMoveToFolder("a");
      expect(menuItem("context-agent-def-move-folder-root")).not.toBeNull();
      expect(
        document.querySelectorAll('[data-testid^="context-agent-def-move-folder-"]').length
      ).toBe(
        2 // the submenu container + Top Level
      );
    });

    it("moves the whole multi-selection, skipping those already in the target", async () => {
      await render();
      act(() => {
        defRow("r1").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      act(() => {
        defRow("r2").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      });
      act(() => {
        defRow("p1").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      });
      await openMoveToFolder("r1");
      await select("context-agent-def-move-folder-prod");
      expect(bulkMoveAgentDefsToFolder).toHaveBeenCalledWith(AGENT_ID, ["r1", "r2"], "prod");
      expect(moveAgentDefToFolder).not.toHaveBeenCalled();
    });

    it("has no axe violations with the move submenu open", async () => {
      await render();
      await openMoveToFolder("r1");
      expect(await checkA11y()).toHaveNoViolations();
    });
  });
});
