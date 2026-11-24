/**
 * Regression tests for folder chevron placement in the connection sidebar.
 *
 * #5855: the expand/collapse chevron leads the folder row, on the LEFT like the
 * section headers (SAVED, REMOTE AGENTS) and the agent rows; it used to trail
 * on the right (#640). Connection rows reserve the same chevron column, so the
 * icon column (folder icon, connection icon) still lines up at each depth —
 * the alignment #640 was after.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionFolder, RemoteAgentDefinition, SavedConnection } from "@/types/connection";
import { flushAsync } from "@/test/flushAsync";

vi.mock("@/services/api", () => ({
  listAvailableShells: vi.fn(() => Promise.resolve([])),
  createTerminal: vi.fn(() => Promise.resolve({ sessionId: "s1" })),
  removeCredential: vi.fn(),
  storeCredential: vi.fn(),
  resolveCredential: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@/utils/frontendLog", () => ({
  frontendLog: vi.fn(),
}));

vi.mock("./AgentNode", () => ({
  AgentNode: ({
    agent,
    sectionRef,
  }: {
    agent: RemoteAgentDefinition;
    sectionRef?: (el: HTMLDivElement | null) => void;
  }) =>
    React.createElement("div", {
      ref: sectionRef,
      "data-testid": `agent-node-${agent.id}`,
    }),
}));

function makeConnection(overrides: Partial<SavedConnection> = {}): SavedConnection {
  return {
    id: "conn-1",
    name: "Box",
    config: { type: "local", config: {} },
    folderId: null,
    ...overrides,
  } as SavedConnection;
}

function makeFolder(overrides: Partial<ConnectionFolder> = {}): ConnectionFolder {
  return {
    id: "folder-1",
    name: "Test Folder",
    parentId: null,
    isExpanded: false,
    ...overrides,
  };
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

/** Mount the list and let its projection subscriptions settle inside act (#3860). */
async function renderList(root: Root): Promise<void> {
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

describe("ConnectionList — folder chevron placement", () => {
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

  const button = (testId: string) => {
    const el = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    if (!el) throw new Error(`no ${testId}`);
    return el;
  };
  const leadsWithChevron = (el: HTMLElement) =>
    el.children[0]?.classList.contains("connection-tree__chevron") ?? false;

  it("renders the chevron as the first child of the folder button", async () => {
    seedConnectionsRegion({ folders: [makeFolder()] });
    await renderList(root);
    expect(leadsWithChevron(button("folder-toggle-folder-1"))).toBe(true);
  });

  it("matches the section header's chevron side", async () => {
    seedConnectionsRegion({ folders: [makeFolder()] });
    await renderList(root);
    const header = container.querySelector<HTMLElement>(".connection-list__group-toggle");
    expect(header).not.toBeNull();
    expect(leadsWithChevron(header!)).toBe(true);
    expect(leadsWithChevron(button("folder-toggle-folder-1"))).toBe(true);
  });

  it("leads with the chevron on a nested subfolder", async () => {
    const parent = makeFolder({ id: "folder-parent", name: "Parent", isExpanded: true });
    const child = makeFolder({ id: "folder-child", name: "Child", parentId: "folder-parent" });
    seedConnectionsRegion({ folders: [parent, child] });
    await renderList(root);
    expect(leadsWithChevron(button("folder-toggle-folder-child"))).toBe(true);
  });

  it("indents connection rows past the chevron column so icons line up", async () => {
    const folder = makeFolder({ isExpanded: true });
    seedConnectionsRegion({
      folders: [folder],
      connections: [
        makeConnection({ id: "root-conn", name: "Root" }),
        makeConnection({ id: "inner-conn", name: "Inner", folderId: folder.id }),
      ],
    });
    await renderList(root);
    // Folder at depth 0: 8px indent, then the 16px chevron + 4px gap, so the
    // folder icon starts at 28px — where a root connection's icon starts.
    expect(button("folder-toggle-folder-1").style.paddingLeft).toBe("8px");
    expect(button("connection-item-root-conn").style.paddingLeft).toBe("28px");
    expect(button("connection-item-inner-conn").style.paddingLeft).toBe("44px");
  });
});
