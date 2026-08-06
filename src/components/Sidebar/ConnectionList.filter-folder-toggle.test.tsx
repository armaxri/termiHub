/**
 * Regression tests for #1378: while a search filter is active, folders are
 * force-expanded by the render logic and stored `isExpanded` is ignored. Folder
 * toggles (click and keyboard) must therefore be no-ops while filtering, so
 * clearing the filter restores exactly the expansion state the tree had before.
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
    name: overrides.name ?? `Connection ${id}`,
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

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function keydown(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function folderExpanded(folderId: string): boolean | undefined {
  return useAppStore.getState().folders.find((f) => f.id === folderId)?.isExpanded;
}

setupConnectionsRegionFromAppStore();

describe("ConnectionList — folder toggle ignored while filtering (#1378)", () => {
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

  function filterInput(): HTMLInputElement {
    return container.querySelector('[data-testid="connection-filter-input"]') as HTMLInputElement;
  }

  it("clicking a folder while filtering does not change its stored expansion state", () => {
    useAppStore.setState({
      folders: [makeFolder({ id: "folder-1", isExpanded: true })],
      connections: [makeConnection({ id: "conn-1", name: "web-server", folderId: "folder-1" })],
    });
    render(container, root);

    // Activate a filter that matches the nested connection (force-expands folder).
    typeInto(filterInput(), "web");
    expect(folderExpanded("folder-1")).toBe(true);

    // Click the folder row: previously flipped stored isExpanded to false.
    const folder = container.querySelector('[data-testid="folder-toggle-folder-1"]') as HTMLElement;
    act(() => folder.click());
    expect(folderExpanded("folder-1")).toBe(true);

    // Clearing the filter restores the pre-filter expansion state.
    keydown(filterInput(), "Escape");
    expect(folderExpanded("folder-1")).toBe(true);
    expect(container.querySelector('[data-testid="connection-item-conn-1"]')).not.toBeNull();
  });

  it("keyboard-collapsing a folder while filtering does not change its stored expansion state", () => {
    useAppStore.setState({
      folders: [makeFolder({ id: "folder-1", isExpanded: true })],
      connections: [makeConnection({ id: "conn-1", name: "web-server", folderId: "folder-1" })],
    });
    render(container, root);

    typeInto(filterInput(), "web");
    expect(folderExpanded("folder-1")).toBe(true);

    // ArrowLeft on a (force-)expanded folder previously called toggleFolder.
    const folder = container.querySelector('[data-testid="folder-toggle-folder-1"]') as HTMLElement;
    act(() => folder.focus());
    keydown(folder, "ArrowLeft");
    expect(folderExpanded("folder-1")).toBe(true);

    // Enter/Space on a folder previously toggled it too.
    keydown(folder, "Enter");
    expect(folderExpanded("folder-1")).toBe(true);

    keydown(filterInput(), "Escape");
    expect(folderExpanded("folder-1")).toBe(true);
  });

  it("a collapsed folder stays collapsed after filtering force-expands then toggling it", () => {
    useAppStore.setState({
      folders: [makeFolder({ id: "folder-1", isExpanded: false })],
      connections: [makeConnection({ id: "conn-1", name: "web-server", folderId: "folder-1" })],
    });
    render(container, root);

    // Collapsed: nested connection not rendered.
    expect(container.querySelector('[data-testid="connection-item-conn-1"]')).toBeNull();

    typeInto(filterInput(), "web");
    // Filter force-expands the folder visually but must not mutate stored state.
    expect(container.querySelector('[data-testid="connection-item-conn-1"]')).not.toBeNull();
    expect(folderExpanded("folder-1")).toBe(false);

    const folder = container.querySelector('[data-testid="folder-toggle-folder-1"]') as HTMLElement;
    act(() => folder.click());
    expect(folderExpanded("folder-1")).toBe(false);

    // Clearing the filter returns the folder to its collapsed state.
    keydown(filterInput(), "Escape");
    expect(folderExpanded("folder-1")).toBe(false);
    expect(container.querySelector('[data-testid="connection-item-conn-1"]')).toBeNull();
  });
});
