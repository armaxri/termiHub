/**
 * Keyboard / context-menu alternatives to dragging a connection in the sidebar
 * tree (#4528, WCAG 2.1.1 / 2.5.7).
 *
 * A focused connection row moves within its folder with
 * Ctrl/Cmd+Shift+ArrowUp/Down, and its context menu (reachable with Shift+F10 /
 * the Menu key) offers Move to Folder, Move Up and Move Down. All of them route
 * through the store actions the drag-and-drop path uses.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { checkA11y } from "@/test/axe";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection, ConnectionFolder, RemoteAgentDefinition } from "@/types/connection";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

vi.mock("./AgentNode", () => ({
  AgentNode: ({ agent }: { agent: RemoteAgentDefinition }) =>
    React.createElement("div", { "data-testid": `agent-node-${agent.id}` }),
}));

function conn(id: string, folderId: string | null = null): SavedConnection {
  return {
    id,
    name: `Connection ${id}`,
    folderId,
    config: { type: "local", config: {} } as SavedConnection["config"],
  };
}

function folder(id: string, name: string, parentId: string | null = null): ConnectionFolder {
  return { id, name, parentId, isExpanded: true };
}

const baseSettings = {
  version: "1",
  externalConnectionFiles: [] as [],
  powerMonitoringEnabled: false,
  fileBrowserEnabled: false,
  experimentalFeaturesEnabled: false,
};

setupConnectionsRegion();
setupSettingsRegion();

/**
 * Tree: root holds r1, r2; folder "work" holds w1, w2, w3; "dev" is a subfolder
 * of "work". The store order interleaves them so reorder indices are into the
 * full list, not the per-folder one.
 */
const CONNECTIONS = [
  conn("r1"),
  conn("w1", "work"),
  conn("w2", "work"),
  conn("r2"),
  conn("w3", "work"),
];
const FOLDERS = [folder("work", "Work"), folder("dev", "Dev", "work")];

describe("ConnectionList — move connections without dragging (#4528)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let reorderConnections: Mock<(oldIndex: number, newIndex: number) => void>;
  let moveConnectionToFolder: Mock<(id: string, folderId: string | null) => void>;
  let bulkMoveConnectionsToFolder: Mock<(ids: string[], folderId: string | null) => void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({ ...baseSettings });
    reorderConnections = vi.fn();
    moveConnectionToFolder = vi.fn();
    bulkMoveConnectionsToFolder = vi.fn();
    useAppStore.setState({
      reorderConnections,
      moveConnectionToFolder,
      bulkMoveConnectionsToFolder,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(connections = CONNECTIONS, folders = FOLDERS) {
    seedConnectionsRegion({ connections, folders });
    await act(async () => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      );
    });
    await flushAsync();
  }

  const row = (id: string) =>
    container.querySelector(`[data-testid="connection-item-${id}"]`) as HTMLElement;
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

  async function openMenu(id: string) {
    await act(async () => {
      row(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
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
    await openMenu(id);
    const trigger = menuItem("context-connection-move-folder") as HTMLElement;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await flushAsync();
  }

  describe("keyboard", () => {
    it("Ctrl+Shift+ArrowDown moves a connection below its next sibling in the same folder", async () => {
      await render();
      pressMove(row("w1"), "ArrowDown", "ctrlKey");
      // w1 is index 1, its next sibling w2 is index 2 in the full list.
      expect(reorderConnections).toHaveBeenCalledWith(1, 2);
    });

    it("Cmd+Shift+ArrowUp moves a connection above its previous sibling, skipping other folders", async () => {
      await render();
      pressMove(row("w3"), "ArrowUp", "metaKey");
      // w3 (index 4) jumps over root's r2 (index 3) to w2 (index 2).
      expect(reorderConnections).toHaveBeenCalledWith(4, 2);
    });

    it("reorders top-level connections among themselves", async () => {
      await render();
      pressMove(row("r2"), "ArrowUp", "ctrlKey");
      expect(reorderConnections).toHaveBeenCalledWith(3, 0);
    });

    it("does nothing at the first or last position in the folder", async () => {
      await render();
      pressMove(row("w1"), "ArrowUp", "ctrlKey");
      pressMove(row("w3"), "ArrowDown", "ctrlKey");
      pressMove(row("r1"), "ArrowUp", "ctrlKey");
      pressMove(row("r2"), "ArrowDown", "ctrlKey");
      expect(reorderConnections).not.toHaveBeenCalled();
    });

    it("keeps plain ArrowDown as focus navigation", async () => {
      await render();
      act(() => row("r1").focus());
      act(() => {
        row("r1").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      expect(reorderConnections).not.toHaveBeenCalled();
    });

    it("ignores the move shortcut on folder rows (folders are not draggable)", async () => {
      await render();
      const folderRow = container.querySelector(
        '[data-testid="folder-toggle-work"]'
      ) as HTMLElement;
      pressMove(folderRow, "ArrowDown", "ctrlKey");
      expect(reorderConnections).not.toHaveBeenCalled();
      expect(moveConnectionToFolder).not.toHaveBeenCalled();
    });
  });

  describe("context menu", () => {
    it("Move Up / Move Down reorder the connection within its folder", async () => {
      await render();
      await openMenu("w2");
      await select("context-connection-move-down");
      expect(reorderConnections).toHaveBeenLastCalledWith(2, 4);
      await openMenu("w2");
      await select("context-connection-move-up");
      expect(reorderConnections).toHaveBeenLastCalledWith(2, 1);
    });

    it("disables Move Up on the first connection and Move Down on the last", async () => {
      await render();
      await openMenu("w1");
      expect(isDisabled("context-connection-move-up")).toBe(true);
      expect(isDisabled("context-connection-move-down")).toBe(false);
    });

    it("disables both on a connection alone in its folder", async () => {
      await render([conn("solo", "work")]);
      await openMenu("solo");
      expect(isDisabled("context-connection-move-up")).toBe(true);
      expect(isDisabled("context-connection-move-down")).toBe(true);
    });

    it("Move to Folder lists the top level and every folder by its path", async () => {
      await render();
      await openMoveToFolder("r1");
      expect(menuItem("context-connection-move-folder-submenu")).not.toBeNull();
      expect(menuItem("context-connection-move-folder-root")?.textContent).toContain("Top Level");
      expect(menuItem("context-connection-move-folder-work")?.textContent).toContain("Work");
      expect(menuItem("context-connection-move-folder-dev")?.textContent).toContain("Work / Dev");
    });

    it("moves a connection into a nested folder", async () => {
      await render();
      await openMoveToFolder("r1");
      await select("context-connection-move-folder-dev");
      expect(moveConnectionToFolder).toHaveBeenCalledWith("r1", "dev");
    });

    it("moves a connection out of a folder to the top level", async () => {
      await render();
      await openMoveToFolder("w2");
      await select("context-connection-move-folder-root");
      expect(moveConnectionToFolder).toHaveBeenCalledWith("w2", null);
    });

    it("disables the connection's current folder, including the top level", async () => {
      await render();
      await openMoveToFolder("r1");
      expect(isDisabled("context-connection-move-folder-root")).toBe(true);
      expect(isDisabled("context-connection-move-folder-work")).toBe(false);
    });

    it("offers only Top Level when there are no folders", async () => {
      await render([conn("a"), conn("b")], []);
      await openMoveToFolder("a");
      expect(menuItem("context-connection-move-folder-root")).not.toBeNull();
      expect(
        document.querySelectorAll('[data-testid^="context-connection-move-folder-"]').length
      ).toBe(
        2 // the submenu container + Top Level
      );
    });

    it("moves the whole multi-selection, skipping those already in the target", async () => {
      await render();
      act(() => {
        row("r1").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      act(() => {
        row("w1").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      });
      act(() => {
        row("r2").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      });
      await openMoveToFolder("r1");
      await select("context-connection-move-folder-work");
      expect(bulkMoveConnectionsToFolder).toHaveBeenCalledWith(["r1", "r2"], "work");
      expect(moveConnectionToFolder).not.toHaveBeenCalled();
    });

    it("has no axe violations with the move submenu open", async () => {
      await render();
      await openMoveToFolder("w1");
      expect(await checkA11y()).toHaveNoViolations();
    });
  });
});
