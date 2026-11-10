/**
 * Agent-side deletes confirm first (#5158): a remote agent (whose delete also
 * disconnects it, which the confirm says), an agent's saved connection, and an
 * agent folder. None of them has an Undo, so none offers "don't ask again".
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { AgentDefinitionInfo, AgentFolderInfo } from "@/services/api";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
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
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));

const AGENT_ID = "agent-del";

function makeAgent(
  connectionState: RemoteAgentDefinition["connectionState"]
): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Prod Agent",
    config: { host: "host.example.com", port: 22, username: "user", authMethod: "password" },
    connectionState,
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

const DEFINITIONS: AgentDefinitionInfo[] = [
  {
    id: "d1",
    name: "Build Box",
    sessionType: "shell",
    config: {},
    persistent: false,
    folderId: null,
  },
  { id: "d2", name: "Inner", sessionType: "shell", config: {}, persistent: false, folderId: "f1" },
];
const FOLDERS: AgentFolderInfo[] = [
  { id: "f1", name: "Servers", parentId: null, isExpanded: true },
];

setupAgentsRegion();

describe("AgentNode — delete confirmations (#5158)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let deleteRemoteAgent: Mock<(agentId: string) => void>;
  let deleteAgentDef: Mock<(agentId: string, defId: string) => Promise<void>>;
  let deleteAgentFolder: Mock<(agentId: string, folderId: string) => Promise<void>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    deleteRemoteAgent = vi.fn();
    deleteAgentDef = vi.fn(() => Promise.resolve());
    deleteAgentFolder = vi.fn(() => Promise.resolve());
    useAppStore.setState({ deleteRemoteAgent, deleteAgentDef, deleteAgentFolder });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(state: RemoteAgentDefinition["connectionState"] = "connected") {
    const agent = makeAgent(state);
    seedAgentsRegion({
      remoteAgents: [agent],
      agentDefinitions: { [AGENT_ID]: DEFINITIONS },
      agentFolders: { [AGENT_ID]: FOLDERS },
      agentSessions: {},
    });
    await act(async () => {
      root.render(
        React.createElement(TooltipProvider, {
          delayDuration: 0,
          children: React.createElement(AgentNode, { agent }),
        })
      );
    });
    await flushAsync();
  }

  const q = (testId: string) =>
    document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;

  async function openMenuAndSelect(row: HTMLElement, item: string) {
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await flushAsync();
    const el = q(item);
    expect(el).not.toBeNull();
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushAsync();
  }

  const header = () => q(`agent-header-${AGENT_ID}`) as HTMLElement;
  const defRow = () => q("agent-definition-d1") as HTMLElement;
  const folderRow = () =>
    Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Servers")
    ) as HTMLElement;

  async function click(testId: string) {
    await act(async () => q(testId)!.click());
    await flushAsync();
  }

  describe("remote agent", () => {
    it("confirms, says a connected agent is disconnected, and has no opt-out", async () => {
      await render("connected");
      await openMenuAndSelect(header(), "context-agent-delete");
      const dialog = q("confirm-delete-dialog");
      expect(dialog?.textContent).toContain("Prod Agent");
      expect(dialog?.textContent).toContain("disconnects");
      expect(q("confirm-delete-dont-ask-again")).toBeNull();
      expect(deleteRemoteAgent).not.toHaveBeenCalled();
    });

    it("omits the disconnect warning for a disconnected agent", async () => {
      await render("disconnected");
      await openMenuAndSelect(header(), "context-agent-delete");
      expect(q("confirm-delete-dialog")?.textContent).not.toContain("disconnects");
    });

    it("cancel keeps the agent; confirm deletes it", async () => {
      await render("connected");
      await openMenuAndSelect(header(), "context-agent-delete");
      await click("confirm-delete-cancel");
      expect(q("confirm-delete-dialog")).toBeNull();
      expect(deleteRemoteAgent).not.toHaveBeenCalled();

      await openMenuAndSelect(header(), "context-agent-delete");
      await click("confirm-delete-confirm");
      expect(deleteRemoteAgent).toHaveBeenCalledWith(AGENT_ID);
    });
  });

  describe("agent saved connection", () => {
    it("confirms before deleting; cancel keeps it, confirm deletes it", async () => {
      await render();
      await openMenuAndSelect(defRow(), "context-agent-def-delete");
      expect(q("confirm-delete-dialog")?.textContent).toContain("Build Box");
      await click("confirm-delete-cancel");
      expect(deleteAgentDef).not.toHaveBeenCalled();

      await openMenuAndSelect(defRow(), "context-agent-def-delete");
      await click("confirm-delete-confirm");
      expect(deleteAgentDef).toHaveBeenCalledWith(AGENT_ID, "d1");
    });
  });

  describe("agent folder", () => {
    it("confirms before deleting and says its connections move up", async () => {
      await render();
      await openMenuAndSelect(folderRow(), "context-agent-folder-delete");
      const dialog = q("confirm-delete-dialog");
      expect(dialog?.textContent).toContain("Servers");
      expect(dialog?.textContent).toContain("1 connection will move");
      await click("confirm-delete-cancel");
      expect(deleteAgentFolder).not.toHaveBeenCalled();

      await openMenuAndSelect(folderRow(), "context-agent-folder-delete");
      await click("confirm-delete-confirm");
      expect(deleteAgentFolder).toHaveBeenCalledWith(AGENT_ID, "f1");
    });
  });
});
