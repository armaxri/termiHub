/**
 * Inline folder rename in the Remote Agents tree (#5233): the agent folder
 * menu's Rename item and F2 on a focused agent folder row swap the row for a
 * pre-filled input. Enter commits through `updateAgentFolder`, Escape cancels,
 * and focus goes back to the row. An empty name or a sibling folder's name is
 * rejected inline. Agent folder ids are stable, so the children stay put.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { AgentDefinitionInfo, AgentFolderInfo } from "@/services/api";
import type { FolderUpdateParams } from "@/types/generated/FolderUpdateParams";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { typeInto } from "@/test/dirtyDismiss";
import { TooltipProvider } from "@/components/ui";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), isDragging: false }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDndContext: () => ({ active: null }),
  useDndMonitor: () => {},
}));

vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));

vi.mock("@/services/api", () => ({
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));

const AGENT_ID = "agent-rename";

function makeAgent(): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Rename Agent",
    config: { host: "host.example.com", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    capabilities: {
      connectionTypes: [],
      maxSessions: 10,
      availableShells: ["bash"],
      availableSerialPorts: [],
      availableDockerImages: [],
    },
  };
}

function def(id: string, folderId: string | null = null): AgentDefinitionInfo {
  return { id, name: `Def ${id}`, sessionType: "shell", config: {}, persistent: false, folderId };
}

const DEFINITIONS = [def("d1"), def("inner", "f1")];
const FOLDERS: AgentFolderInfo[] = [
  { id: "f1", name: "Servers", parentId: null, isExpanded: true },
  { id: "f2", name: "Lab", parentId: null, isExpanded: true },
];

function seed(folders = FOLDERS) {
  seedAgentsRegion({
    remoteAgents: [makeAgent()],
    agentDefinitions: { [AGENT_ID]: DEFINITIONS },
    agentFolders: { [AGENT_ID]: folders },
    agentSessions: {},
  });
}

function press(el: HTMLElement, key: string, mods: KeyboardEventInit = {}) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...mods }));
  });
}

setupAgentsRegion();

describe("AgentNode — folder rename (#5233)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let updateAgentFolder: Mock<(agentId: string, params: FolderUpdateParams) => Promise<void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    // Like the agent: the folder keeps its id and only its name changes.
    updateAgentFolder = vi.fn(async (_agentId: string, params: FolderUpdateParams) => {
      await Promise.resolve();
      seed(FOLDERS.map((f) => (f.id === params.id ? { ...f, name: params.name ?? f.name } : f)));
    });
    useAppStore.setState({ updateAgentFolder });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    seed();
    await act(async () => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(AgentNode, { agent: makeAgent() }),
        })
      );
    });
    await flushAsync();
  }

  const q = (testId: string) =>
    document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const folderRow = (id = "f1") => q(`agent-folder-toggle-${id}`) as HTMLElement;
  const input = () => q("inline-folder-name-input") as HTMLInputElement | null;

  function startWithF2() {
    const row = folderRow();
    act(() => row.focus());
    press(row, "F2");
  }

  it("the agent folder menu has a Rename item that starts the inline rename", async () => {
    await render();
    const row = folderRow();
    act(() => row.focus());
    press(row, "F10", { shiftKey: true });
    await flushAsync();
    const item = q("context-agent-folder-rename");
    expect(item?.textContent).toContain("Rename");
    act(() => item!.click());
    await flushAsync();
    expect(input()?.value).toBe("Servers");
  });

  it("F2 swaps the row for an input pre-filled with the name", async () => {
    await render();
    startWithF2();
    expect(folderRow()).toBeNull();
    expect(input()?.value).toBe("Servers");
    expect(document.activeElement).toBe(input());
  });

  it("Enter commits via updateAgentFolder, keeps the children and refocuses the row", async () => {
    await render();
    startWithF2();
    typeInto("inline-folder-name-input", "Hosts");
    press(input()!, "Enter");
    await flushAsync();
    expect(updateAgentFolder).toHaveBeenCalledWith(AGENT_ID, { id: "f1", name: "Hosts" });
    expect(input()).toBeNull();
    expect(folderRow().textContent).toContain("Hosts");
    expect(document.activeElement).toBe(folderRow());
    expect(q("agent-definition-inner")).not.toBeNull();
  });

  it("Escape cancels and returns focus to the row", async () => {
    await render();
    startWithF2();
    typeInto("inline-folder-name-input", "Hosts");
    press(input()!, "Escape");
    await flushAsync();
    expect(updateAgentFolder).not.toHaveBeenCalled();
    expect(folderRow().textContent).toContain("Servers");
    expect(document.activeElement).toBe(folderRow());
  });

  it("Enter without a change saves nothing", async () => {
    await render();
    startWithF2();
    press(input()!, "Enter");
    await flushAsync();
    expect(updateAgentFolder).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(folderRow());
  });

  it.each([
    ["an empty name", "", "Enter a name."],
    ["a sibling folder's name", "Lab", "“Lab” already exists here."],
  ])("rejects %s with a message", async (_label, value, message) => {
    await render();
    startWithF2();
    typeInto("inline-folder-name-input", value);
    press(input()!, "Enter");
    await flushAsync();
    expect(updateAgentFolder).not.toHaveBeenCalled();
    expect(q("inline-folder-error")?.textContent).toContain(message);
    expect(input()).not.toBeNull();
  });

  it("announces F2 via aria-keyshortcuts", async () => {
    await render();
    expect(folderRow().getAttribute("aria-keyshortcuts")).toBe("Shift+F10 F2 Delete");
  });
});
