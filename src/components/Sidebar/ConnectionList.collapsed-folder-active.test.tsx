/**
 * A collapsed folder that hides the active tab's connection (#5706): the
 * sidebar follows the active tab (#5642), but the selected row of a connection
 * inside a collapsed folder is not rendered. Instead of changing the persisted
 * expansion, the collapsed ancestor folder is marked (and scrolled into view);
 * expanding it shows the selected row and scrolls it into view.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { getActivePanelId } from "@/store/layoutSelectors";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import type { SavedConnection, ConnectionFolder, RemoteAgentDefinition } from "@/types/connection";
import { flushAsync } from "@/test/flushAsync";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
  deleteConnectionFromBackend: vi.fn(() => Promise.resolve()),
  stopPersistentSession: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

// The folder toggle persists through `persistFolder`; a successful persist is
// what lands the toggle in the region (#2831).
vi.mock("@/services/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/storage")>()),
  persistFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("./AgentNode", () => ({
  AgentNode: ({ agent }: { agent: RemoteAgentDefinition }) =>
    React.createElement("div", { "data-testid": `agent-node-${agent.id}` }),
}));

function makeConnection(id: string, folderId: string | null): SavedConnection {
  return {
    id,
    name: `Connection ${id}`,
    folderId,
    icon: undefined,
    sourceFile: undefined,
    config: { type: "local", config: {} } as SavedConnection["config"],
    terminalOptions: undefined,
  };
}

function makeFolder(id: string, parentId: string | null, isExpanded: boolean): ConnectionFolder {
  return { id, name: `Folder ${id}`, parentId, isExpanded };
}

setupConnectionsRegion();
setupSettingsRegion();

const LOCAL = { type: "local", config: {} };

function openTab(title: string, connectionId?: string): string {
  let id = "";
  act(() => {
    id = useAppStore.getState().addTab(title, "local", LOCAL, connectionId ? { connectionId } : {});
  });
  return id;
}

describe("ConnectionList — collapsed folder hiding the active connection", () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrolled: string[];
  let originalScroll: typeof HTMLElement.prototype.scrollIntoView;

  const q = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  const marker = (folderId: string) => q(`folder-toggle-${folderId}-active-marker`);

  async function mount(folders: ConnectionFolder[], connections: SavedConnection[]) {
    seedConnectionsRegion({ folders, connections });
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

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedSettings({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: false,
      fileBrowserEnabled: false,
      experimentalFeaturesEnabled: false,
    });
    scrolled = [];
    originalScroll = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.getAttribute("data-testid") ?? "");
    };
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    HTMLElement.prototype.scrollIntoView = originalScroll;
    vi.unstubAllGlobals();
  });

  it("marks the collapsed folder, keeps it collapsed and scrolls it into view", async () => {
    await mount([makeFolder("f1", null, false)], [makeConnection("c1", "f1")]);
    openTab("one", "c1");

    expect(q("connection-item-c1")).toBeNull();
    const folder = q("folder-toggle-f1");
    expect(folder?.getAttribute("aria-expanded")).toBe("false");
    expect(folder?.classList.contains("connection-tree__folder--contains-active")).toBe(true);
    expect(marker("f1")?.getAttribute("aria-label")).toBe("Contains the active connection");
    expect(folder?.textContent).not.toContain("undefined");
    expect(scrolled).toContain("folder-toggle-f1");
  });

  it("marks only the outermost rendered folder of a nested collapsed chain", async () => {
    await mount(
      [makeFolder("outer", null, false), makeFolder("inner", "outer", false)],
      [makeConnection("c1", "inner")]
    );
    openTab("one", "c1");
    expect(marker("outer")).not.toBeNull();
    // The inner folder is not rendered while its parent is collapsed.
    expect(q("folder-toggle-inner")).toBeNull();
    expect(scrolled).toEqual(["folder-toggle-outer"]);
  });

  it("does not mark an expanded folder or an unrelated collapsed one", async () => {
    await mount(
      [makeFolder("open", null, true), makeFolder("other", null, false)],
      [makeConnection("c1", "open"), makeConnection("c2", "other")]
    );
    openTab("one", "c1");
    expect(marker("open")).toBeNull();
    expect(marker("other")).toBeNull();
    expect(scrolled).toContain("connection-item-c1");
  });

  it("drops the marker when focus moves to a tab outside the folder", async () => {
    await mount(
      [makeFolder("f1", null, false)],
      [makeConnection("c1", "f1"), makeConnection("c2", null)]
    );
    const first = openTab("one", "c1");
    openTab("two", "c2");
    expect(marker("f1")).toBeNull();
    act(() => useAppStore.getState().setActiveTab(first, getActivePanelId() as string));
    expect(marker("f1")).not.toBeNull();
  });

  it("expanding the folder shows the selected row and scrolls it into view", async () => {
    await mount([makeFolder("f1", null, false)], [makeConnection("c1", "f1")]);
    openTab("one", "c1");
    scrolled = [];

    act(() => q("folder-toggle-f1")?.click());
    // Let the toggle's persist land the expansion in the region.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const row = q("connection-item-c1");
    expect(row).not.toBeNull();
    expect(row?.getAttribute("aria-selected")).toBe("true");
    expect(marker("f1")).toBeNull();
    expect(scrolled).toContain("connection-item-c1");
  });

  it("keeps a selection the user moved elsewhere when expanding", async () => {
    await mount(
      [makeFolder("f1", null, false)],
      [makeConnection("c1", "f1"), makeConnection("c2", null)]
    );
    openTab("one", "c1");
    act(() => q("connection-item-c2")?.click());
    act(() => q("folder-toggle-f1")?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(q("connection-item-c1")?.getAttribute("aria-selected")).toBe("false");
  });
});
