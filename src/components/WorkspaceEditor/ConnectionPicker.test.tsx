/**
 * ConnectionPicker (WorkspaceEditor): the "Add Connection" overlay that offers an
 * inline Local Shell, saved connections (grouped by folder), and per-agent
 * connection definitions. These tests pin the rendered groupings, search filtering,
 * the empty state, the offline/empty-agent branches, and that each choice fires
 * onSelect with the right WorkspaceTabDef. Part of TFE-007 coverage (#2934).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { SavedConnection, ConnectionFolder, RemoteAgentDefinition } from "@/types/connection";
import type { AgentDefinitionInfo } from "@/services/api";
import type { WorkspaceTabDef } from "@/types/workspace";

let mockConnections: SavedConnection[] = [];
let mockFolders: ConnectionFolder[] = [];
let mockRemoteAgents: RemoteAgentDefinition[] = [];
let mockAgentDefinitions: Record<string, AgentDefinitionInfo[]> = {};

vi.mock("@/store/useProjectedConnections", () => ({
  useProjectedConnections: () => ({ connections: mockConnections, folders: mockFolders }),
}));

vi.mock("@/store/useProjectedAgents", () => ({
  useProjectedAgents: () => ({
    remoteAgents: mockRemoteAgents,
    agentDefinitions: mockAgentDefinitions,
    agentSessions: {},
    agentFolders: {},
  }),
}));

import { ConnectionPicker } from "./ConnectionPicker";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function conn(id: string, name: string, type = "ssh", folderId?: string): SavedConnection {
  return { id, name, folderId, config: { type } } as unknown as SavedConnection;
}

function folder(id: string, name: string): ConnectionFolder {
  return { id, name } as unknown as ConnectionFolder;
}

function agent(id: string, name: string, connectionState: string): RemoteAgentDefinition {
  return { id, name, connectionState } as unknown as RemoteAgentDefinition;
}

function def(id: string, name: string, sessionType = "ssh"): AgentDefinitionInfo {
  return { id, name, sessionType } as unknown as AgentDefinitionInfo;
}

interface Handlers {
  onSelect: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
}

function render(h: Handlers = { onSelect: vi.fn(), onCancel: vi.fn() }): Handlers {
  act(() => {
    root.render(<ConnectionPicker onSelect={h.onSelect} onCancel={h.onCancel} />);
  });
  return h;
}

/** Type into the controlled search box, driving the native onChange → setSearch. */
function typeSearch(value: string): void {
  const input = query("connection-picker-search") as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ConnectionPicker", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockConnections = [];
    mockFolders = [];
    mockRemoteAgents = [];
    mockAgentDefinitions = {};
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("always offers the inline Local Shell and selects it with an inline config", () => {
    const h = render();
    const inline = query("connection-picker-inline");
    expect(inline).not.toBeNull();
    expect(inline!.textContent).toContain("Local Shell");
    act(() => inline!.click());
    const tab = h.onSelect.mock.calls[0][0] as WorkspaceTabDef;
    expect(tab.title).toBe("Local Shell");
    expect(tab.inlineConfig).toEqual({ type: "local", config: {} });
  });

  it("renders ungrouped saved connections and selects one by reference", () => {
    mockConnections = [conn("c1", "prod-box", "ssh"), conn("c2", "serial-1", "serial")];
    const h = render();
    expect(query("connection-picker-item-c1")?.textContent).toContain("prod-box");
    expect(query("connection-picker-item-c1")?.textContent).toContain("ssh");
    act(() => query("connection-picker-item-c2")!.click());
    expect(h.onSelect).toHaveBeenCalledWith({ connectionRef: "c2", title: "serial-1" });
  });

  it("groups connections under their folder name", () => {
    mockFolders = [folder("f1", "Datacenter")];
    mockConnections = [conn("c1", "grouped-box", "ssh", "f1")];
    render();
    expect(container.textContent).toContain("Datacenter");
    expect(query("connection-picker-item-c1")).not.toBeNull();
  });

  it("filters connections by the search term", () => {
    mockConnections = [conn("c1", "alpha", "ssh"), conn("c2", "beta", "ssh")];
    render();
    typeSearch("alph");
    expect(query("connection-picker-item-c1")).not.toBeNull();
    expect(query("connection-picker-item-c2")).toBeNull();
  });

  it("shows the empty state when nothing matches", () => {
    mockConnections = [conn("c1", "alpha", "ssh")];
    render();
    typeSearch("zzz-no-match");
    expect(query("connection-picker-item-c1")).toBeNull();
    expect(container.textContent).toContain("No connections match your search.");
  });

  it("lists connected-agent definitions and selects one by agent+definition ref", () => {
    mockRemoteAgents = [agent("a1", "edge-agent", "connected")];
    mockAgentDefinitions = { a1: [def("d1", "web-ssh", "ssh")] };
    const h = render();
    expect(container.textContent).toContain("Remote Agents");
    const defBtn = query("connection-picker-agent-def-d1");
    expect(defBtn?.textContent).toContain("web-ssh");
    act(() => defBtn!.click());
    expect(h.onSelect).toHaveBeenCalledWith({
      agentRef: { agentId: "a1", definitionId: "d1" },
      title: "web-ssh",
    });
  });

  it("shows an offline notice for a disconnected agent and an empty notice for one with no defs", () => {
    mockRemoteAgents = [
      agent("a1", "down-agent", "disconnected"),
      agent("a2", "bare-agent", "connected"),
    ];
    mockAgentDefinitions = { a2: [] };
    render();
    expect(query("connection-picker-agent-offline-a1")).not.toBeNull();
    expect(container.textContent).toContain("Agent not connected");
    expect(query("connection-picker-agent-empty-a2")).not.toBeNull();
    expect(container.textContent).toContain("No connection definitions configured");
  });

  it("invokes onCancel from the close button", () => {
    const h = render();
    act(() => query("connection-picker-close")!.click());
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });
});
