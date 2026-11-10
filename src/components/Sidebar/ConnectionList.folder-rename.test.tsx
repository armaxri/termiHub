/**
 * Inline folder rename in the Connections tree (#5233): the folder menu's
 * Rename item and F2 on a focused folder row swap the row for a pre-filled
 * input. Enter commits through `updateFolder`, Escape cancels, and focus goes
 * back to the row — also after the backend re-ids the renamed folder, whose id
 * is its path. An empty name or a sibling's name is rejected inline.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import React, { act } from "react";
import { flushAsync } from "@/test/flushAsync";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { typeInto } from "@/test/dirtyDismiss";
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
const home: ConnectionFolder = { id: "Home", name: "Home", parentId: null, isExpanded: true };
function conn(name: string, folderId: string | null = null): SavedConnection {
  const id = folderId ? `${folderId}/${name}` : name;
  return { id, name, folderId, config: { type: "local", config: {} } };
}
const CONNECTIONS = [conn("db", "Work"), conn("laptop")];

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
const input = () => q("inline-folder-name-input") as HTMLInputElement | null;
const folderRow = (id: string) => q(`folder-toggle-${id}`);

function press(el: HTMLElement, key: string, mods: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...mods }));
  });
}

setupConnectionsRegion();
setupSettingsRegion();

describe("ConnectionList — folder rename (#5233)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let updateFolder: Mock<(folder: ConnectionFolder) => void>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    // Like the backend: a rename re-ids the folder and its children by path.
    updateFolder = vi.fn((folder: ConnectionFolder) => {
      const newId = folder.name;
      seedConnectionsRegion({
        folders: [{ ...folder, id: newId }, home],
        connections: CONNECTIONS.map((c) =>
          c.folderId === folder.id ? { ...c, id: `${newId}/${c.name}`, folderId: newId } : c
        ),
      });
    });
    useAppStore.setState({ updateFolder });
    seedSettings({ ...baseSettings });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    seedConnectionsRegion({ folders: [work, home], connections: CONNECTIONS });
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

  function startWithF2(id = "Work") {
    const row = folderRow(id);
    act(() => row.focus());
    press(row, "F2");
  }

  it("the folder menu has a Rename item that starts the inline rename", async () => {
    await render();
    const row = folderRow("Work");
    act(() => row.focus());
    press(row, "F10", { shiftKey: true });
    await flushAsync();
    const item = q("context-folder-rename");
    expect(item).not.toBeNull();
    expect(item.textContent).toContain("Rename");
    act(() => item.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(input()?.value).toBe("Work");
    // The closing menu must not steal focus back (which would blur-cancel).
    expect(document.activeElement).toBe(input());
  });

  it("F2 swaps the row for an input pre-filled with the name", async () => {
    await render();
    startWithF2();
    expect(folderRow("Work")).toBeNull();
    expect(input()?.value).toBe("Work");
    expect(document.activeElement).toBe(input());
    expect(input()?.getAttribute("aria-label")).toBe("Rename folder Work");
  });

  it("Enter commits via updateFolder and focus follows the re-keyed row", async () => {
    await render();
    startWithF2();
    typeInto("inline-folder-name-input", "  Jobs  ");
    press(input()!, "Enter");
    await flushAsync();
    expect(updateFolder).toHaveBeenCalledWith({ ...work, name: "Jobs" });
    expect(input()).toBeNull();
    expect(folderRow("Work")).toBeNull();
    expect(document.activeElement).toBe(folderRow("Jobs"));
    // The child connection is still inside the renamed folder.
    expect(q("connection-item-Jobs/db")).not.toBeNull();
  });

  it("Enter without a change saves nothing and returns focus", async () => {
    await render();
    startWithF2();
    press(input()!, "Enter");
    await flushAsync();
    expect(updateFolder).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(folderRow("Work"));
  });

  it("Escape cancels and returns focus to the row", async () => {
    await render();
    startWithF2();
    typeInto("inline-folder-name-input", "Jobs");
    press(input()!, "Escape");
    await flushAsync();
    expect(updateFolder).not.toHaveBeenCalled();
    expect(input()).toBeNull();
    expect(folderRow("Work").textContent).toContain("Work");
    expect(document.activeElement).toBe(folderRow("Work"));
  });

  it("leaving the input by blur cancels without pulling focus back", async () => {
    await render();
    startWithF2();
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    try {
      act(() => elsewhere.focus());
      await flushAsync();
      expect(updateFolder).not.toHaveBeenCalled();
      expect(input()).toBeNull();
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  it.each([
    ["an empty name", "   ", "Enter a name."],
    ["a sibling folder's name", "Home", "“Home” already exists here."],
    ["a sibling connection's name", "laptop", "“laptop” already exists here."],
  ])("rejects %s with a message", async (_label, value, message) => {
    await render();
    startWithF2();
    typeInto("inline-folder-name-input", value);
    press(input()!, "Enter");
    await flushAsync();
    expect(updateFolder).not.toHaveBeenCalled();
    const error = q("inline-folder-error");
    expect(error?.textContent).toContain(message);
    expect(error?.getAttribute("role")).toBe("alert");
    expect(input()?.getAttribute("aria-invalid")).toBe("true");
    expect(input()?.getAttribute("aria-describedby")).toBe(error?.id);
    // Typing clears the message; a valid name then commits.
    typeInto("inline-folder-name-input", "Jobs");
    expect(q("inline-folder-error")).toBeNull();
    press(input()!, "Enter");
    await flushAsync();
    expect(updateFolder).toHaveBeenCalledWith({ ...work, name: "Jobs" });
  });

  it("a name only a connection elsewhere uses is accepted", async () => {
    await render();
    startWithF2();
    // `db` lives inside Work, not next to it.
    typeInto("inline-folder-name-input", "db");
    press(input()!, "Enter");
    await flushAsync();
    expect(updateFolder).toHaveBeenCalledWith({ ...work, name: "db" });
  });

  it("the Confirm button commits", async () => {
    await render();
    startWithF2();
    typeInto("inline-folder-name-input", "Jobs");
    act(() => {
      q("inline-folder-confirm").dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      );
    });
    await flushAsync();
    expect(updateFolder).toHaveBeenCalledWith({ ...work, name: "Jobs" });
  });
});
