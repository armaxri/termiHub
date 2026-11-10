/**
 * Keyboard access to the Connections tree's context actions (#5181): on a
 * focused connection or folder row, Shift+F10 / the ContextMenu key open its
 * context menu, F2 opens a connection's editor (where it is renamed), and
 * Delete / Backspace start the same confirmed delete as the menu. Focus
 * returns to the row when the menu or dialog closes, and moves to the
 * neighbouring row once the row is deleted. A focused terminal never sees
 * these keys acted on.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import React, { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import type { AppSettings, ConnectionFolder, SavedConnection } from "@/types/connection";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));

const baseSettings: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: false,
  fileBrowserEnabled: false,
  experimentalFeaturesEnabled: false,
};

const work: ConnectionFolder = { id: "work", name: "Work", parentId: null, isExpanded: true };
function conn(id: string, folderId: string | null = null): SavedConnection {
  return { id, name: `Conn ${id}`, folderId, config: { type: "local", config: {} } };
}
const CONNECTIONS = [conn("a", "work"), conn("b"), conn("c")];

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;

function press(el: HTMLElement, key: string, mods: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...mods }));
  });
}

/** Let the focus-rescue poll (real timers) run. */
async function settleFocus() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

setupConnectionsRegion();
setupSettingsRegion();

describe("ConnectionList — row action keys (#5181)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let openConnectionEditorTab: Mock<(id: string, folderId?: string | null) => void>;
  let deleteConnection: Mock<(id: string) => void>;
  let deleteFolderWithUndo: Mock<(id: string) => void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    openConnectionEditorTab = vi.fn();
    // A delete really removes the row, so focus restoration can be observed.
    deleteConnection = vi.fn((id: string) => {
      seedConnectionsRegion({
        folders: [work],
        connections: CONNECTIONS.filter((c) => c.id !== id),
      });
    });
    deleteFolderWithUndo = vi.fn((id: string) => {
      seedConnectionsRegion({
        folders: [],
        connections: CONNECTIONS.map((c) => (c.folderId === id ? { ...c, folderId: null } : c)),
      });
    });
    useAppStore.setState({ openConnectionEditorTab, deleteConnection, deleteFolderWithUndo });
    seedSettings({ ...baseSettings });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    seedConnectionsRegion({ folders: [work], connections: CONNECTIONS });
    await act(async () =>
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(ConnectionList),
        })
      )
    );
    await flushAsync();
  }

  const connRow = (id: string) => q(`connection-item-${id}`);
  const folderRow = (id: string) => q(`folder-toggle-${id}`);

  function focused(el: HTMLElement): HTMLElement {
    act(() => el.focus());
    return el;
  }

  describe("context menu", () => {
    it.each([
      ["Shift+F10", "F10", { shiftKey: true }],
      ["the ContextMenu key", "ContextMenu", {}],
    ])("%s on a connection opens its menu", async (_label, key, mods) => {
      await render();
      press(focused(connRow("b")), key, mods);
      await flushAsync();
      expect(q("context-connection-connect")).not.toBeNull();
      expect(q("context-connection-delete")).not.toBeNull();
    });

    it("Shift+F10 on a folder opens the folder menu", async () => {
      await render();
      press(focused(folderRow("work")), "F10", { shiftKey: true });
      await flushAsync();
      expect(q("context-folder-new-connection")).not.toBeNull();
      expect(q("context-folder-delete")).not.toBeNull();
    });

    it("the menu takes focus and Escape returns it to the row", async () => {
      await render();
      const row = focused(connRow("b"));
      press(row, "F10", { shiftKey: true });
      await flushAsync();
      const menu = document.querySelector('[role="menu"]') as HTMLElement;
      expect(menu).not.toBeNull();
      expect(menu.contains(document.activeElement)).toBe(true);
      press(document.activeElement as HTMLElement, "Escape");
      await settleFocus();
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(row);
    });
  });

  describe("F2", () => {
    it("opens the connection's editor", async () => {
      await render();
      press(focused(connRow("b")), "F2");
      expect(openConnectionEditorTab).toHaveBeenCalledWith("b");
    });

    it("does nothing on a folder (folders have no rename)", async () => {
      await render();
      press(focused(folderRow("work")), "F2");
      expect(openConnectionEditorTab).not.toHaveBeenCalled();
      expect(q("confirm-delete-dialog")).toBeNull();
    });
  });

  describe("Delete / Backspace", () => {
    it.each(["Delete", "Backspace"])("%s on a connection opens the delete confirm", async (key) => {
      await render();
      press(focused(connRow("b")), key);
      await flushAsync();
      const dialog = q("confirm-delete-dialog");
      expect(dialog).not.toBeNull();
      expect(dialog.textContent).toContain("Conn b");
      expect(deleteConnection).not.toHaveBeenCalled();
    });

    it("Delete on a folder opens the undoable folder confirm", async () => {
      await render();
      press(focused(folderRow("work")), "Delete");
      await flushAsync();
      expect(q("confirm-delete-dialog")).not.toBeNull();
      expect(q("confirm-delete-dont-ask-again")).not.toBeNull();
      expect(deleteFolderWithUndo).not.toHaveBeenCalled();
    });

    it("a modified Delete does nothing", async () => {
      await render();
      press(focused(connRow("b")), "Delete", { ctrlKey: true });
      press(connRow("b"), "Backspace", { metaKey: true });
      await flushAsync();
      expect(q("confirm-delete-dialog")).toBeNull();
    });

    it("cancel returns focus to the row", async () => {
      await render();
      const row = focused(connRow("b"));
      press(row, "Delete");
      await flushAsync();
      act(() => q("confirm-delete-cancel").click());
      await settleFocus();
      expect(deleteConnection).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(row);
    });

    it("confirm deletes and moves focus to the next row", async () => {
      await render();
      press(focused(connRow("b")), "Delete");
      await flushAsync();
      act(() => q("confirm-delete-confirm").click());
      await settleFocus();
      expect(deleteConnection).toHaveBeenCalledWith("b");
      expect(connRow("b")).toBeNull();
      expect(document.activeElement).toBe(connRow("c"));
    });

    it("confirm on the last row moves focus to the new last row", async () => {
      await render();
      press(focused(connRow("c")), "Delete");
      await flushAsync();
      act(() => q("confirm-delete-confirm").click());
      await settleFocus();
      expect(document.activeElement).toBe(connRow("b"));
    });

    it("a folder delete moves focus to the row now in its place", async () => {
      await render();
      press(focused(folderRow("work")), "Delete");
      await flushAsync();
      act(() => q("confirm-delete-confirm").click());
      await settleFocus();
      expect(deleteFolderWithUndo).toHaveBeenCalledWith("work");
      expect(folderRow("work")).toBeNull();
      expect((document.activeElement as HTMLElement).getAttribute("role")).toBe("treeitem");
    });
  });

  it("announces the keys via aria-keyshortcuts", async () => {
    await render();
    expect(connRow("b").getAttribute("aria-keyshortcuts")).toBe("Shift+F10 F2 Delete");
    expect(folderRow("work").getAttribute("aria-keyshortcuts")).toBe("Shift+F10 Delete");
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
      expect(document.activeElement).toBe(terminal);
    } finally {
      terminal.remove();
    }
  });
});
