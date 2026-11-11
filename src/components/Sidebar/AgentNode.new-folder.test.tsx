/**
 * The agent header menu's "New Folder" (#5337).
 *
 * The inline name input must show, stay focused once the menu has closed, and
 * create a root folder through the real `createAgentFolder` action. It lives
 * inside the expanded agent, so a collapsed agent is expanded first. Same race
 * as #5322 / #5323: an input opened while the menu was still closing lost focus
 * to the menu's focus return, and a blur cancels it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { flushAsync } from "@/test/flushAsync";
import { useAppStore } from "@/store/appStore";
import { useProjectedAgents } from "@/store/useProjectedAgents";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { AgentFolderInfo } from "@/services/api";
import { createAgentFolder } from "@/services/api";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { typeInto } from "@/test/dirtyDismiss";

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
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
      promise: vi.fn(),
    },
  };
});

vi.mock("@/utils/frontendLog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/frontendLog")>()),
  frontendLog: vi.fn(),
  frontendError: vi.fn(),
}));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));

const AGENT_ID = "agent-new-folder-test";

function makeAgent(isExpanded: boolean): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Folder Agent",
    config: { host: "host.example.com", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded,
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

/** Renders the agent as the sidebar does: from the projected region. */
function ProjectedAgent() {
  const agent = useProjectedAgents().remoteAgents.find((a) => a.id === AGENT_ID);
  return agent ? React.createElement(AgentNode, { agent }) : null;
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const input = () => q("inline-folder-name-input") as HTMLInputElement | null;

let container: HTMLDivElement;
let root: Root;

setupAgentsRegion();

describe("AgentNode — agent menu New Folder (#5337)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(isExpanded: boolean) {
    seedAgentsRegion({
      remoteAgents: [makeAgent(isExpanded)],
      agentDefinitions: { [AGENT_ID]: [] },
      agentFolders: { [AGENT_ID]: [] },
      agentSessions: {},
    });
    await act(async () => root.render(React.createElement(ProjectedAgent)));
    await flushAsync();
  }

  async function chooseNewFolder() {
    const header = q(`agent-header-${AGENT_ID}`) as HTMLElement;
    expect(header).not.toBeNull();
    act(() => {
      header.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })
      );
    });
    await flushAsync();
    const item = q("context-agent-new-folder");
    expect(item).not.toBeNull();
    await act(async () => item!.click());
    // Let the menu finish closing (Radix runs its focus return after a frame).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
  }

  it.each([
    ["an expanded", true],
    ["a collapsed", false],
  ])(
    "on %s agent shows a focused input that stays open and creates the folder",
    async (_l, open) => {
      const created: AgentFolderInfo = {
        id: "new",
        name: "Edge",
        parentId: null,
        isExpanded: true,
      };
      vi.mocked(createAgentFolder).mockResolvedValue(created);
      await render(open);

      await chooseNewFolder();

      expect(input()).not.toBeNull();
      // The closing menu must not take focus back to the header (a blur cancels).
      expect(document.activeElement).toBe(input());

      typeInto("inline-folder-name-input", "Edge");
      await act(async () => {
        input()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      await flushAsync();

      expect(createAgentFolder).toHaveBeenCalledWith(AGENT_ID, "Edge", null);
      expect(input()).toBeNull();
      expect(q("agent-folder-toggle-new")?.textContent).toContain("Edge");
    }
  );
});
