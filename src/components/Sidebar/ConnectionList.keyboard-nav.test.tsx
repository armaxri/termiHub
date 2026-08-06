/**
 * Tests for keyboard navigation and ARIA tree semantics in the connection
 * sidebar (#1356): role="tree"/role="treeitem", roving tabindex, arrow-key
 * navigation, and Enter/Space to connect the focused connection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegionFromAppStore } from "@/test/connectionsRegionTestHarness";
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
  AgentNode: ({
    agent,
    sectionRef,
  }: {
    agent: RemoteAgentDefinition;
    sectionRef?: (el: HTMLDivElement | null) => void;
  }) => React.createElement("div", { ref: sectionRef, "data-testid": `agent-node-${agent.id}` }),
}));

function makeConnection(overrides: Partial<SavedConnection> = {}): SavedConnection {
  const id = overrides.id ?? "conn-1";
  return {
    id,
    name: `Connection ${id}`,
    folderId: null,
    config: { type: "local", config: {} } as SavedConnection["config"],
    ...overrides,
  };
}

function makeFolder(overrides: Partial<ConnectionFolder> = {}): ConnectionFolder {
  return { id: "folder-1", name: "Test Folder", parentId: null, isExpanded: true, ...overrides };
}

const baseSettings = {
  version: "1",
  externalConnectionFiles: [] as [],
  powerMonitoringEnabled: false,
  fileBrowserEnabled: false,
  experimentalFeaturesEnabled: false,
};

function render(_container: HTMLElement, root: Root) {
  act(() => {
    root.render(
      React.createElement(TooltipProvider, {
        delayDuration: 0,
        children: React.createElement(ConnectionList),
      })
    );
  });
}

function keydown(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

setupConnectionsRegionFromAppStore();

describe("ConnectionList — keyboard navigation & ARIA", () => {
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

  it("exposes role=tree with treeitem rows", () => {
    useAppStore.setState({
      connections: [makeConnection({ id: "conn-1" }), makeConnection({ id: "conn-2" })],
    });
    render(container, root);

    expect(container.querySelector('[role="tree"]')).not.toBeNull();
    const items = container.querySelectorAll('[role="treeitem"]');
    expect(items.length).toBe(2);
  });

  it("uses roving tabindex: only the first item is tabbable initially", () => {
    useAppStore.setState({
      connections: [makeConnection({ id: "conn-1" }), makeConnection({ id: "conn-2" })],
    });
    render(container, root);

    const item1 = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    const item2 = container.querySelector('[data-testid="connection-item-conn-2"]') as HTMLElement;
    expect(item1.getAttribute("tabindex")).toBe("0");
    expect(item2.getAttribute("tabindex")).toBe("-1");
  });

  it("ArrowDown moves focus (roving tabindex) to the next item", () => {
    useAppStore.setState({
      connections: [makeConnection({ id: "conn-1" }), makeConnection({ id: "conn-2" })],
    });
    render(container, root);

    const item1 = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    const item2 = container.querySelector('[data-testid="connection-item-conn-2"]') as HTMLElement;
    act(() => item1.focus());
    keydown(item1, "ArrowDown");

    expect(item2.getAttribute("tabindex")).toBe("0");
    expect(item1.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(item2);
  });

  it("Enter on a focused connection connects it", () => {
    const addTab = vi.fn();
    useAppStore.setState({
      connections: [makeConnection({ id: "conn-1" })],
      addTab,
    });
    render(container, root);

    const item1 = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    act(() => item1.focus());
    keydown(item1, "Enter");

    expect(addTab).toHaveBeenCalledWith("Connection conn-1", "local", expect.anything(), {
      connectionId: "conn-1",
      terminalOptions: undefined,
    });
  });

  it("folder rows expose aria-expanded and ArrowRight expands a collapsed folder", () => {
    useAppStore.setState({
      folders: [makeFolder({ id: "folder-1", isExpanded: false })],
      connections: [makeConnection({ id: "conn-1", folderId: "folder-1" })],
    });
    render(container, root);

    const folder = container.querySelector('[data-testid="folder-toggle-folder-1"]') as HTMLElement;
    expect(folder.getAttribute("role")).toBe("treeitem");
    expect(folder.getAttribute("aria-expanded")).toBe("false");

    act(() => folder.focus());
    keydown(folder, "ArrowRight");

    const folderAfter = container.querySelector(
      '[data-testid="folder-toggle-folder-1"]'
    ) as HTMLElement;
    expect(folderAfter.getAttribute("aria-expanded")).toBe("true");
  });
});
