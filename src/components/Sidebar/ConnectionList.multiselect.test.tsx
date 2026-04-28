/**
 * Tests for multi-select behavior in the connection sidebar.
 *
 * Ctrl/Meta+Click toggles individual selection, Shift+Click range-selects,
 * plain click single-selects, Escape and clicking empty space clear selection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import type { SavedConnection, ConnectionFolder } from "@/types/connection";
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

function makeConnection(overrides: Partial<SavedConnection> = {}): SavedConnection {
  const id = overrides.id ?? "conn-1";
  return {
    id,
    name: `Connection ${id}`,
    folderId: null,
    icon: undefined,
    sourceFile: undefined,
    config: { type: "local", config: {} } as SavedConnection["config"],
    terminalOptions: undefined,
    ...overrides,
  };
}

function makeFolder(overrides: Partial<ConnectionFolder> = {}): ConnectionFolder {
  return {
    id: "folder-1",
    name: "Test Folder",
    parentId: null,
    isExpanded: true,
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

describe("ConnectionList — multi-select", () => {
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

  it("plain click selects a single connection", () => {
    useAppStore.setState({
      connections: [makeConnection({ id: "conn-1" }), makeConnection({ id: "conn-2" })],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const item = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    act(() => {
      item.click();
    });

    expect(item.classList.contains("connection-tree__item--selected")).toBe(true);
    const item2 = container.querySelector('[data-testid="connection-item-conn-2"]') as HTMLElement;
    expect(item2.classList.contains("connection-tree__item--selected")).toBe(false);
  });

  it("plain click on a different connection moves selection", () => {
    useAppStore.setState({
      connections: [makeConnection({ id: "conn-1" }), makeConnection({ id: "conn-2" })],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const item1 = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    const item2 = container.querySelector('[data-testid="connection-item-conn-2"]') as HTMLElement;

    act(() => {
      item1.click();
    });
    act(() => {
      item2.click();
    });

    expect(item1.classList.contains("connection-tree__item--selected")).toBe(false);
    expect(item2.classList.contains("connection-tree__item--selected")).toBe(true);
  });

  it("Ctrl+Click adds a second connection to the selection", () => {
    useAppStore.setState({
      connections: [makeConnection({ id: "conn-1" }), makeConnection({ id: "conn-2" })],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const item1 = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    const item2 = container.querySelector('[data-testid="connection-item-conn-2"]') as HTMLElement;

    act(() => {
      item1.click();
    });
    act(() => {
      item2.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });

    expect(item1.classList.contains("connection-tree__item--selected")).toBe(true);
    expect(item2.classList.contains("connection-tree__item--selected")).toBe(true);
  });

  it("Ctrl+Click on an already-selected connection deselects it", () => {
    useAppStore.setState({
      connections: [makeConnection({ id: "conn-1" }), makeConnection({ id: "conn-2" })],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const item1 = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    const item2 = container.querySelector('[data-testid="connection-item-conn-2"]') as HTMLElement;

    act(() => {
      item1.click();
    });
    act(() => {
      item2.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });
    // Both selected; now Ctrl+Click item1 to deselect it
    act(() => {
      item1.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });

    expect(item1.classList.contains("connection-tree__item--selected")).toBe(false);
    expect(item2.classList.contains("connection-tree__item--selected")).toBe(true);
  });

  it("Meta+Click (macOS) also toggles selection", () => {
    useAppStore.setState({
      connections: [makeConnection({ id: "conn-1" }), makeConnection({ id: "conn-2" })],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const item1 = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    const item2 = container.querySelector('[data-testid="connection-item-conn-2"]') as HTMLElement;

    act(() => {
      item1.click();
    });
    act(() => {
      item2.dispatchEvent(new MouseEvent("click", { metaKey: true, bubbles: true }));
    });

    expect(item1.classList.contains("connection-tree__item--selected")).toBe(true);
    expect(item2.classList.contains("connection-tree__item--selected")).toBe(true);
  });

  it("Shift+Click selects a range of connections in order", () => {
    useAppStore.setState({
      connections: [
        makeConnection({ id: "conn-1" }),
        makeConnection({ id: "conn-2" }),
        makeConnection({ id: "conn-3" }),
      ],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const item1 = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    const item2 = container.querySelector('[data-testid="connection-item-conn-2"]') as HTMLElement;
    const item3 = container.querySelector('[data-testid="connection-item-conn-3"]') as HTMLElement;

    act(() => {
      item1.click();
    });
    act(() => {
      item3.dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
    });

    expect(item1.classList.contains("connection-tree__item--selected")).toBe(true);
    expect(item2.classList.contains("connection-tree__item--selected")).toBe(true);
    expect(item3.classList.contains("connection-tree__item--selected")).toBe(true);
  });

  it("Shift+Click range works in reverse direction", () => {
    useAppStore.setState({
      connections: [
        makeConnection({ id: "conn-1" }),
        makeConnection({ id: "conn-2" }),
        makeConnection({ id: "conn-3" }),
      ],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const item1 = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    const item2 = container.querySelector('[data-testid="connection-item-conn-2"]') as HTMLElement;
    const item3 = container.querySelector('[data-testid="connection-item-conn-3"]') as HTMLElement;

    act(() => {
      item3.click();
    });
    act(() => {
      item1.dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
    });

    expect(item1.classList.contains("connection-tree__item--selected")).toBe(true);
    expect(item2.classList.contains("connection-tree__item--selected")).toBe(true);
    expect(item3.classList.contains("connection-tree__item--selected")).toBe(true);
  });

  it("Escape key clears the selection", () => {
    useAppStore.setState({
      connections: [makeConnection({ id: "conn-1" }), makeConnection({ id: "conn-2" })],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const item1 = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    const item2 = container.querySelector('[data-testid="connection-item-conn-2"]') as HTMLElement;

    act(() => {
      item1.click();
    });
    act(() => {
      item2.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true }));
    });

    expect(container.querySelectorAll(".connection-tree__item--selected").length).toBe(2);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(container.querySelectorAll(".connection-tree__item--selected").length).toBe(0);
  });

  it("clicking on empty space in the tree clears selection", () => {
    useAppStore.setState({
      connections: [makeConnection({ id: "conn-1" })],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const item = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    act(() => {
      item.click();
    });

    expect(item.classList.contains("connection-tree__item--selected")).toBe(true);

    // Click on the tree container (empty space), not on a connection item
    const tree = container.querySelector(".connection-list__tree") as HTMLElement;
    act(() => {
      tree.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(item.classList.contains("connection-tree__item--selected")).toBe(false);
  });

  it("connections inside expanded folders are included in Shift+Click range", () => {
    const folder = makeFolder({ id: "folder-1", isExpanded: true });
    useAppStore.setState({
      folders: [folder],
      connections: [
        makeConnection({ id: "conn-1", folderId: "folder-1" }),
        makeConnection({ id: "conn-2", folderId: "folder-1" }),
        makeConnection({ id: "conn-3" }),
      ],
    });

    act(() => {
      root.render(React.createElement(ConnectionList));
    });

    const item1 = container.querySelector('[data-testid="connection-item-conn-1"]') as HTMLElement;
    const item3 = container.querySelector('[data-testid="connection-item-conn-3"]') as HTMLElement;
    const item2 = container.querySelector('[data-testid="connection-item-conn-2"]') as HTMLElement;

    act(() => {
      item1.click();
    });
    act(() => {
      item3.dispatchEvent(new MouseEvent("click", { shiftKey: true, bubbles: true }));
    });

    expect(item1.classList.contains("connection-tree__item--selected")).toBe(true);
    expect(item2.classList.contains("connection-tree__item--selected")).toBe(true);
    expect(item3.classList.contains("connection-tree__item--selected")).toBe(true);
  });
});
