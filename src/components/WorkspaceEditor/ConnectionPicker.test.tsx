/**
 * ConnectionPicker (WorkspaceEditor): the "Add Connection" overlay that offers an
 * inline Local Shell, saved connections (grouped by folder), and per-agent
 * connection definitions. These tests pin the rendered groupings, search filtering,
 * the empty state, the offline/empty-agent branches, and that each choice fires
 * onSelect with the right WorkspaceTabDef. Part of TFE-007 coverage (#2934).
 *
 * The picker is built on the shared ui/Modal (A11Y2-005 / UISF2-001, #4332): it
 * renders into a portal as a labelled dialog that traps focus and closes on
 * Escape, and its search box is a combobox driving an accessible listbox.
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

/** The picker renders into a Radix portal, so look it up from the document. */
function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function dialog(): HTMLElement {
  return query("connection-picker")!;
}

function searchBox(): HTMLInputElement {
  return query("connection-picker-search") as HTMLInputElement;
}

/** Dispatch a keydown on `el` the way a real keystroke would. */
function press(el: HTMLElement, key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init })
    );
  });
}

/** The option the combobox currently points at via aria-activedescendant. */
function activeOption(): HTMLElement | null {
  const id = searchBox().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
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

function render(onSelect = vi.fn(), onCancel = vi.fn()) {
  act(() => {
    root.render(<ConnectionPicker onSelect={onSelect} onCancel={onCancel} />);
  });
  return { onSelect, onCancel };
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
    expect(dialog().textContent).toContain("Datacenter");
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
    expect(dialog().textContent).toContain("No connections match your search.");
  });

  it("lists connected-agent definitions and selects one by agent+definition ref", () => {
    mockRemoteAgents = [agent("a1", "edge-agent", "connected")];
    mockAgentDefinitions = { a1: [def("d1", "web-ssh", "ssh")] };
    const h = render();
    expect(dialog().textContent).toContain("Remote Agents");
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
    expect(dialog().textContent).toContain("Agent not connected");
    expect(query("connection-picker-agent-empty-a2")).not.toBeNull();
    expect(dialog().textContent).toContain("No connection definitions configured");
  });

  it("invokes onCancel from the named close button", () => {
    const h = render();
    const close = dialog().querySelector<HTMLButtonElement>('[data-testid="modal-close"]')!;
    expect(close.getAttribute("aria-label")).toBe("Close");
    act(() => close.click());
    expect(h.onCancel).toHaveBeenCalledTimes(1);
  });

  describe("dialog semantics (A11Y2-005 / UISF2-001)", () => {
    it("opens as a modal dialog labelled by its 'Add Connection' title", () => {
      render();
      const el = dialog();
      expect(el.getAttribute("role")).toBe("dialog");
      const labelId = el.getAttribute("aria-labelledby");
      expect(labelId).toBeTruthy();
      expect(document.getElementById(labelId!)?.textContent).toBe("Add Connection");
      // Rendered into a portal, not inline in the editor that opened it.
      expect(container.contains(el)).toBe(false);
    });

    it("focuses the search box on open", () => {
      render();
      expect(document.activeElement).toBe(searchBox());
    });

    it("traps focus inside the dialog: Tab wraps between its first and last stops", () => {
      render();
      const close = dialog().querySelector<HTMLButtonElement>('[data-testid="modal-close"]')!;
      // The search box is the last tabbable stop; Tab wraps back to the X.
      press(searchBox(), "Tab");
      expect(document.activeElement).toBe(close);
      press(close, "Tab", { shiftKey: true });
      expect(document.activeElement).toBe(searchBox());
    });

    it("closes on Escape", () => {
      const h = render();
      press(searchBox(), "Escape");
      expect(h.onCancel).toHaveBeenCalledTimes(1);
    });

    it("keeps the bespoke overlay and unnamed close button out of the DOM", () => {
      render();
      expect(document.querySelector(".connection-picker__overlay")).toBeNull();
      expect(query("connection-picker-close")).toBeNull();
    });
  });

  describe("searchable listbox (combobox pattern)", () => {
    it("wires the search box as a combobox controlling the listbox", () => {
      render();
      const input = searchBox();
      expect(input.getAttribute("role")).toBe("combobox");
      expect(input.getAttribute("aria-expanded")).toBe("true");
      expect(input.getAttribute("aria-autocomplete")).toBe("list");
      expect(input.getAttribute("aria-label")).toBeTruthy();
      const list = document.getElementById(input.getAttribute("aria-controls")!);
      expect(list?.getAttribute("role")).toBe("listbox");
      expect(list?.getAttribute("aria-label")).toBeTruthy();
    });

    it("exposes every choice as an option and groups folders and agents", () => {
      mockFolders = [folder("f1", "Datacenter")];
      mockConnections = [conn("c1", "loose", "ssh"), conn("c2", "racked", "ssh", "f1")];
      mockRemoteAgents = [agent("a1", "edge-agent", "connected")];
      mockAgentDefinitions = { a1: [def("d1", "web-ssh")] };
      render();
      for (const id of [
        "connection-picker-inline",
        "connection-picker-item-c1",
        "connection-picker-item-c2",
        "connection-picker-agent-def-d1",
      ]) {
        expect(query(id)?.getAttribute("role")).toBe("option");
      }
      const folderGroup = query("connection-picker-item-c2")!.closest('[role="group"]')!;
      const folderLabel = document.getElementById(folderGroup.getAttribute("aria-labelledby")!);
      expect(folderLabel?.textContent).toBe("Datacenter");
      const agentGroup = query("connection-picker-agent-def-d1")!.closest('[role="group"]')!;
      expect(agentGroup.getAttribute("aria-label")).toContain("edge-agent");
    });

    it("marks the offline / empty agent notices as disabled options", () => {
      mockRemoteAgents = [agent("a1", "down", "disconnected"), agent("a2", "bare", "connected")];
      mockAgentDefinitions = { a2: [] };
      render();
      for (const id of ["connection-picker-agent-offline-a1", "connection-picker-agent-empty-a2"]) {
        expect(query(id)?.getAttribute("role")).toBe("option");
        expect(query(id)?.getAttribute("aria-disabled")).toBe("true");
      }
    });

    it("starts on the first option and moves the active option with the arrow keys", () => {
      mockConnections = [conn("c1", "alpha"), conn("c2", "beta")];
      render();
      expect(activeOption()).toBe(query("connection-picker-inline"));
      expect(activeOption()?.getAttribute("aria-selected")).toBe("true");
      press(searchBox(), "ArrowDown");
      expect(activeOption()).toBe(query("connection-picker-item-c1"));
      press(searchBox(), "ArrowDown");
      expect(activeOption()).toBe(query("connection-picker-item-c2"));
      // Wraps at the end, and ArrowUp wraps back to the bottom.
      press(searchBox(), "ArrowDown");
      expect(activeOption()).toBe(query("connection-picker-inline"));
      press(searchBox(), "ArrowUp");
      expect(activeOption()).toBe(query("connection-picker-item-c2"));
      expect(query("connection-picker-inline")?.getAttribute("aria-selected")).toBe("false");
    });

    it("skips the disabled agent notices during keyboard navigation", () => {
      mockConnections = [conn("c1", "alpha")];
      mockRemoteAgents = [agent("a1", "down", "disconnected")];
      render();
      press(searchBox(), "ArrowDown");
      press(searchBox(), "ArrowDown");
      expect(activeOption()).toBe(query("connection-picker-inline"));
    });

    it("selects the active option with Enter after searching by keyboard", () => {
      mockConnections = [conn("c1", "alpha"), conn("c2", "beta"), conn("c3", "betamax")];
      const h = render();
      typeSearch("beta");
      // The search narrows the list, and the top hit becomes active.
      expect(query("connection-picker-item-c1")).toBeNull();
      expect(activeOption()).toBe(query("connection-picker-inline"));
      press(searchBox(), "ArrowDown");
      press(searchBox(), "ArrowDown");
      expect(activeOption()).toBe(query("connection-picker-item-c3"));
      press(searchBox(), "Enter");
      expect(h.onSelect).toHaveBeenCalledWith({ connectionRef: "c3", title: "betamax" });
    });

    it("selects an agent definition with Enter", () => {
      mockRemoteAgents = [agent("a1", "edge", "connected")];
      mockAgentDefinitions = { a1: [def("d1", "web-ssh")] };
      const h = render();
      press(searchBox(), "ArrowUp");
      expect(activeOption()).toBe(query("connection-picker-agent-def-d1"));
      press(searchBox(), "Enter");
      expect(h.onSelect).toHaveBeenCalledWith({
        agentRef: { agentId: "a1", definitionId: "d1" },
        title: "web-ssh",
      });
    });

    it("ignores Enter while an IME is composing", () => {
      const h = render();
      press(searchBox(), "Enter", { isComposing: true });
      expect(h.onSelect).not.toHaveBeenCalled();
    });

    it("follows the pointer so a click and the active option agree", () => {
      mockConnections = [conn("c1", "alpha")];
      render();
      act(() => {
        query("connection-picker-item-c1")!.dispatchEvent(
          new MouseEvent("mousemove", { bubbles: true })
        );
      });
      expect(activeOption()).toBe(query("connection-picker-item-c1"));
    });

    it("announces an empty search result as a status", () => {
      mockConnections = [conn("c1", "alpha")];
      render();
      typeSearch("zzz-no-match");
      const empty = query("connection-picker-empty");
      expect(empty?.getAttribute("role")).toBe("status");
    });
  });
});
