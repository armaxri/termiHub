/**
 * Tests for the first-run Connections empty state (UX-001/UX-002/UX-004): a
 * brand-new user with zero connections sees a "No connections yet" card with a
 * primary "New Connection" CTA (wired to the new-connection flow) plus a
 * signpost to the experimental feature areas — and that card is absent as soon
 * as any connection or folder exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { ConnectionList } from "./ConnectionList";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
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

function render(root: Root) {
  act(() => {
    root.render(
      React.createElement(TooltipProvider, {
        delayDuration: 0,
        children: React.createElement(ConnectionList),
      })
    );
  });
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

setupConnectionsRegion();
setupSettingsRegion();

describe("ConnectionList — first-run empty state", () => {
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

  it("renders the empty-state card with a CTA when there are zero connections", () => {
    render(root);

    expect(container.querySelector('[data-testid="connections-empty-state"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="connections-empty-new-connection"]')
    ).not.toBeNull();
  });

  it("shows the experimental-features signpost while the flag is off", () => {
    render(root);

    expect(
      container.querySelector('[data-testid="connections-empty-experimental-link"]')
    ).not.toBeNull();
  });

  it("hides the experimental signpost when experimental features are enabled", () => {
    seedSettings({ ...baseSettings, experimentalFeaturesEnabled: true });
    render(root);

    // The empty state still shows (still zero connections)...
    expect(container.querySelector('[data-testid="connections-empty-state"]')).not.toBeNull();
    // ...but the "enable experimental" signpost is gone.
    expect(
      container.querySelector('[data-testid="connections-empty-experimental-link"]')
    ).toBeNull();
  });

  it("CTA opens the new-connection editor", () => {
    const openConnectionEditorTab = vi.fn();
    useAppStore.setState({ openConnectionEditorTab });
    render(root);

    const cta = container.querySelector(
      '[data-testid="connections-empty-new-connection"]'
    ) as HTMLButtonElement;
    click(cta);

    expect(openConnectionEditorTab).toHaveBeenCalledWith("new");
  });

  it("signpost link deep-links to the General settings category", () => {
    const openSettingsTab = vi.fn();
    useAppStore.setState({ openSettingsTab });
    render(root);

    const link = container.querySelector(
      '[data-testid="connections-empty-experimental-link"]'
    ) as HTMLButtonElement;
    click(link);

    expect(openSettingsTab).toHaveBeenCalledWith({ category: "general" });
  });

  it("does NOT render the empty state once a connection exists", () => {
    seedConnectionsRegion({ connections: [makeConnection({ id: "conn-1", name: "web-server" })] });
    render(root);

    expect(container.querySelector('[data-testid="connections-empty-state"]')).toBeNull();
    expect(container.querySelector('[data-testid="connection-item-conn-1"]')).not.toBeNull();
  });

  it("does NOT render the empty state when only a folder exists", () => {
    seedConnectionsRegion({ folders: [makeFolder({ id: "folder-1" })] });
    render(root);

    expect(container.querySelector('[data-testid="connections-empty-state"]')).toBeNull();
  });
});
