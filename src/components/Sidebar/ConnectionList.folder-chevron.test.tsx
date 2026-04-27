/**
 * Regression tests for folder chevron placement in the connection sidebar.
 *
 * The expand/collapse chevron must appear on the RIGHT side of the folder row
 * so the icon column (folder icon, connection icon) aligns cleanly at each
 * indent level. Previously the chevron was the first element, making child
 * connection icons appear at the same depth as the parent folder icon.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import type { ConnectionFolder } from "@/types/connection";
import type { RemoteAgentDefinition } from "@/types/connection";

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

describe("ConnectionList — folder chevron placement", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ settings: { ...baseSettings } });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders chevron as the last child of the folder button", () => {
    useAppStore.setState({ folders: [makeFolder()] });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const folderButton = container.querySelector('[data-testid="folder-toggle-folder-1"]');
    expect(folderButton).not.toBeNull();

    const children = Array.from(folderButton!.children);
    const chevronIdx = children.findIndex((el) =>
      el.classList.contains("connection-tree__chevron")
    );

    expect(chevronIdx).toBeGreaterThan(-1);
    expect(chevronIdx).toBe(children.length - 1);
  });

  it("does not render chevron as the first child of the folder button", () => {
    useAppStore.setState({ folders: [makeFolder()] });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const folderButton = container.querySelector('[data-testid="folder-toggle-folder-1"]');
    expect(folderButton).not.toBeNull();

    const firstChild = folderButton!.children[0];
    expect(firstChild.classList.contains("connection-tree__chevron")).toBe(false);
  });

  it("renders chevron at last position for a nested subfolder", () => {
    const parent = makeFolder({ id: "folder-parent", name: "Parent", isExpanded: true });
    const child = makeFolder({ id: "folder-child", name: "Child", parentId: "folder-parent" });
    useAppStore.setState({ folders: [parent, child] });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const childButton = container.querySelector('[data-testid="folder-toggle-folder-child"]');
    expect(childButton).not.toBeNull();

    const children = Array.from(childButton!.children);
    const chevronIdx = children.findIndex((el) =>
      el.classList.contains("connection-tree__chevron")
    );

    expect(chevronIdx).toBe(children.length - 1);
  });
});
