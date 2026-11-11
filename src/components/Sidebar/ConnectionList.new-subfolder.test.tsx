/**
 * Inline folder creation from the Connections tree's menus (#5323).
 *
 * - "New Subfolder" in a folder's menu shows a focused name input that stays
 *   open after the menu closes, on an expanded and on a collapsed folder (the
 *   input lives inside the folder's children, so a collapsed folder is
 *   expanded first). Enter creates the folder under its parent through the
 *   real `addFolder` action.
 * - "New Folder" in the tree area's menu does the same at the root.
 *
 * The same bug as #5322 in the agent tree: an input opened while the menu was
 * still closing lost focus to the menu's focus return, and a blur cancels it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { currentConnectionsView } from "@/store/connectionsBridge";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { typeInto } from "@/test/dirtyDismiss";
import { TooltipProvider } from "@/components/ui";
import type { AppSettings, ConnectionFolder } from "@/types/connection";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  isSshKeyEncrypted: vi.fn(() => Promise.resolve(false)),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/services/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/storage")>()),
  persistFolder: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));

const baseSettings: AppSettings = {
  version: "1",
  externalConnectionFiles: [],
  powerMonitoringEnabled: false,
  fileBrowserEnabled: false,
  experimentalFeaturesEnabled: false,
};

function folder(id: string, isExpanded: boolean): ConnectionFolder {
  return { id, name: id, parentId: null, isExpanded };
}

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
const input = () => q("inline-folder-name-input") as HTMLInputElement | null;
const folderRow = (id: string) => q(`folder-toggle-${id}`);

function press(el: HTMLElement, key: string, mods: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...mods }));
  });
}

/** Let the menu finish closing (Radix runs its focus return after a frame). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

setupConnectionsRegion();
setupSettingsRegion();

describe("ConnectionList — inline folder creation from menus (#5323)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({ ...baseSettings });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(folders: ConnectionFolder[]) {
    seedConnectionsRegion({ folders, connections: [] });
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

  async function chooseNewSubfolder(id: string) {
    const row = folderRow(id);
    act(() => row.focus());
    // Shift+F10 opens the folder row's menu (#5181).
    press(row, "F10", { shiftKey: true });
    await flushAsync();
    const item = q("context-folder-new-subfolder");
    expect(item).not.toBeNull();
    act(() => item.click());
    await settle();
  }

  async function nameIt(name: string) {
    typeInto("inline-folder-name-input", name);
    press(input()!, "Enter");
    await flushAsync();
  }

  describe.each([
    ["an expanded", true],
    ["a collapsed", false],
  ])("New Subfolder on %s folder", (_label, isExpanded) => {
    it("shows a focused input that stays open and creates the subfolder", async () => {
      await render([folder("Work", isExpanded)]);

      await chooseNewSubfolder("Work");

      expect(folderRow("Work").getAttribute("aria-expanded")).toBe("true");
      expect(input()).not.toBeNull();
      // The closing menu must not take focus back to the row (a blur cancels).
      expect(document.activeElement).toBe(input());

      await nameIt("Edge");

      expect(input()).toBeNull();
      const created = currentConnectionsView().folders.find((f) => f.name === "Edge");
      expect(created?.parentId).toBe("Work");
      const row = folderRow(created!.id);
      expect(row).not.toBeNull();
      expect(row.getAttribute("aria-level")).toBe("2");
    });
  });

  it("Escape cancels New Subfolder without creating anything", async () => {
    await render([folder("Work", true)]);
    await chooseNewSubfolder("Work");
    typeInto("inline-folder-name-input", "Edge");
    press(input()!, "Escape");
    await flushAsync();

    expect(input()).toBeNull();
    expect(currentConnectionsView().folders).toHaveLength(1);
  });

  it("New Folder in the tree area's menu shows a focused input that stays open", async () => {
    await render([folder("Work", true)]);
    const tree = document.querySelector('[role="tree"][aria-label="Connections"]') as HTMLElement;
    expect(tree).not.toBeNull();
    act(() => {
      tree.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
      );
    });
    await flushAsync();
    const item = q("context-root-new-folder");
    expect(item).not.toBeNull();
    act(() => item.click());
    await settle();

    expect(input()).not.toBeNull();
    expect(document.activeElement).toBe(input());

    await nameIt("Lab");

    expect(input()).toBeNull();
    const created = currentConnectionsView().folders.find((f) => f.name === "Lab");
    expect(created?.parentId).toBeNull();
    expect(folderRow(created!.id)).not.toBeNull();
  });
});
