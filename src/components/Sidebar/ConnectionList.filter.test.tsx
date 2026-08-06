/**
 * Tests for the connection tree filter/search input (#1356): live filtering by
 * name/host, auto-expanding folders that contain matches, Enter connecting the
 * top hit, and Escape clearing the query.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
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

setupConnectionsRegion();

describe("ConnectionList — filter/search", () => {
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

  it("renders a filter input in the Connections header", () => {
    render(container, root);
    expect(container.querySelector('[data-testid="connection-filter-input"]')).not.toBeNull();
  });

  it("live-filters connections by name", () => {
    seedConnectionsRegion({
      connections: [
        makeConnection({ id: "conn-1", name: "web-server" }),
        makeConnection({ id: "conn-2", name: "database" }),
      ],
    });
    render(container, root);

    const input = container.querySelector(
      '[data-testid="connection-filter-input"]'
    ) as HTMLInputElement;
    typeInto(input, "web");

    expect(container.querySelector('[data-testid="connection-item-conn-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="connection-item-conn-2"]')).toBeNull();
  });

  it("auto-expands a collapsed folder that contains a match", () => {
    seedConnectionsRegion({
      folders: [makeFolder({ id: "folder-1", isExpanded: false })],
      connections: [makeConnection({ id: "conn-1", name: "web-server", folderId: "folder-1" })],
    });
    render(container, root);

    // Collapsed: nested connection not rendered yet.
    expect(container.querySelector('[data-testid="connection-item-conn-1"]')).toBeNull();

    const input = container.querySelector(
      '[data-testid="connection-filter-input"]'
    ) as HTMLInputElement;
    typeInto(input, "web");

    // Filter reveals the match without a manual expand.
    expect(container.querySelector('[data-testid="connection-item-conn-1"]')).not.toBeNull();
  });

  it("Enter connects the top hit", () => {
    const addTab = vi.fn();
    useAppStore.setState({ addTab });
    seedConnectionsRegion({
      connections: [
        makeConnection({ id: "conn-1", name: "database" }),
        makeConnection({ id: "conn-2", name: "web-server" }),
      ],
    });
    render(container, root);

    const input = container.querySelector(
      '[data-testid="connection-filter-input"]'
    ) as HTMLInputElement;
    typeInto(input, "web");
    keydown(input, "Enter");

    expect(addTab).toHaveBeenCalledWith("web-server", "local", expect.anything(), {
      connectionId: "conn-2",
      terminalOptions: undefined,
    });
  });

  it("Escape clears the query and restores all connections", () => {
    seedConnectionsRegion({
      connections: [
        makeConnection({ id: "conn-1", name: "web-server" }),
        makeConnection({ id: "conn-2", name: "database" }),
      ],
    });
    render(container, root);

    const input = container.querySelector(
      '[data-testid="connection-filter-input"]'
    ) as HTMLInputElement;
    typeInto(input, "web");
    expect(container.querySelector('[data-testid="connection-item-conn-2"]')).toBeNull();

    keydown(input, "Escape");

    expect(input.value).toBe("");
    expect(container.querySelector('[data-testid="connection-item-conn-2"]')).not.toBeNull();
  });
});
