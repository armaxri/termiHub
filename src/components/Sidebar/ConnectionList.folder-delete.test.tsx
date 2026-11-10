/**
 * Folder delete confirmation (#5158): "Delete Folder" no longer deletes on the
 * spot — it confirms first (with a "don't ask again" opt-out, since the delete
 * offers Undo), then runs the undoable delete. The undo itself is covered in
 * `appStore.folderDeleteUndo.test.ts`.
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

const work: ConnectionFolder = { id: "Work", name: "Work", parentId: null, isExpanded: true };
const dev: ConnectionFolder = { id: "Work/Dev", name: "Dev", parentId: "Work", isExpanded: true };
const api: SavedConnection = {
  id: "Work/Dev/api",
  name: "api",
  folderId: "Work/Dev",
  config: { type: "local", config: { shell: "bash" } },
};

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;

setupConnectionsRegion();
setupSettingsRegion();

describe("ConnectionList — folder delete confirmation (#5158)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let deleteFolderWithUndo: Mock<(folderId: string) => void>;
  let updateSettings: Mock<(settings: AppSettings) => Promise<void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    deleteFolderWithUndo = vi.fn<(folderId: string) => void>();
    updateSettings = vi.fn<(settings: AppSettings) => Promise<void>>(() => Promise.resolve());
    useAppStore.setState({ deleteFolderWithUndo, updateSettings });
    seedSettings({ ...baseSettings });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    seedConnectionsRegion({ folders: [work, dev], connections: [api] });
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

  function clickDeleteFolder(id: string) {
    const trigger = q(`folder-toggle-${id}`);
    expect(trigger).not.toBeNull();
    act(() => trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    const del = q("context-folder-delete");
    expect(del).not.toBeNull();
    act(() => del.click());
  }

  it("asks before deleting and says where the contents go", async () => {
    await render();
    clickDeleteFolder("Work/Dev");
    const dialog = q("confirm-delete-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("Dev");
    expect(dialog.textContent).toContain("1 connection will move to “Work”");
    expect(q("confirm-delete-dont-ask-again")).not.toBeNull();
    expect(deleteFolderWithUndo).not.toHaveBeenCalled();
  });

  it("cancel keeps the folder", async () => {
    await render();
    clickDeleteFolder("Work/Dev");
    act(() => q("confirm-delete-cancel").click());
    expect(q("confirm-delete-dialog")).toBeNull();
    expect(deleteFolderWithUndo).not.toHaveBeenCalled();
  });

  it("confirm runs the undoable delete without touching the opt-out", async () => {
    await render();
    clickDeleteFolder("Work/Dev");
    act(() => q("confirm-delete-confirm").click());
    expect(deleteFolderWithUndo).toHaveBeenCalledWith("Work/Dev");
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("persists the opt-out when confirmed with the box ticked", async () => {
    await render();
    clickDeleteFolder("Work/Dev");
    act(() => q("confirm-delete-dont-ask-again").click());
    act(() => q("confirm-delete-confirm").click());
    expect(deleteFolderWithUndo).toHaveBeenCalledWith("Work/Dev");
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ confirmUndoableDelete: false })
    );
  });

  it("deletes without asking once opted out", async () => {
    seedSettings({ ...baseSettings, confirmUndoableDelete: false });
    await render();
    clickDeleteFolder("Work/Dev");
    expect(q("confirm-delete-dialog")).toBeNull();
    expect(deleteFolderWithUndo).toHaveBeenCalledWith("Work/Dev");
  });

  it("does not offer the opt-out on a connection delete", async () => {
    await render();
    const trigger = q("connection-item-Work/Dev/api");
    act(() => trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    act(() => q("context-connection-delete").click());
    expect(q("confirm-delete-dialog")).not.toBeNull();
    expect(q("confirm-delete-dont-ask-again")).toBeNull();
  });
});
