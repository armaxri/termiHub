/**
 * "New shell session" on a connected agent names the agent (#5829). The
 * product-run UI review saw the agent's tab read "Shell: /bin/bash" and its
 * session "local session": with two agents nobody could tell which tab runs
 * where. The tab now reads "<agent> · bash", numbered when taken, and the
 * session on the agent gets the same title.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";

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

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

vi.mock("@/services/api", () => ({
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
  disconnectAgent: vi.fn(() => Promise.resolve()),
  shutdownAgent: vi.fn(() => Promise.resolve(0)),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
  listSerialPorts: vi.fn(() => Promise.resolve([])),
  listAgentSerialPorts: vi.fn(() => Promise.resolve({ supported: true, ports: [] })),
}));

vi.mock("@/hooks/useDesktopVersion", () => ({ useDesktopVersion: () => "0.5.0" }));
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
  };
});
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));
vi.mock("@/components/AgentUpdateBanner", () => ({
  AgentUpdateBanner: () => null,
  AgentUpdateMarker: () => null,
  countAgentSessionTabs: () => 0,
}));

const AGENT_ID = "agent-shell-title-test";

function makeAgent(shells: string[]): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Lab Box",
    config: { host: "lab.example.com", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    capabilities: {
      connectionTypes: [],
      maxSessions: 10,
      availableShells: shells,
      availableSerialPorts: [],
      availableDockerImages: [],
      agentVersion: "0.5.0",
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let addTab: ReturnType<typeof vi.fn<(...args: unknown[]) => string>>;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

setupAgentsRegion();

describe("AgentNode — new shell session title (#5829)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  /** Replace `addTab` with a spy, after any real tabs the test opened. */
  function spyAddTab(): void {
    addTab = vi.fn((..._args: unknown[]) => "tab-id");
    useAppStore.setState({ addTab });
  }

  async function newShellSession(agent: RemoteAgentDefinition): Promise<void> {
    seedAgentsRegion({ remoteAgents: [agent] });
    act(() => {
      root.render(React.createElement(AgentNode, { agent }));
    });
    const header = container.querySelector(`[data-testid="agent-header-${AGENT_ID}"]`);
    expect(header).not.toBeNull();
    act(() => {
      header!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await flush();
    const item = document.querySelector<HTMLElement>('[data-testid="context-agent-new-shell"]');
    expect(item).not.toBeNull();
    act(() => item!.click());
    await flush();
  }

  it("names the agent and the shell, and gives the session the same title", async () => {
    spyAddTab();
    await newShellSession(makeAgent(["/bin/bash"]));
    expect(addTab).toHaveBeenCalledWith(
      "Lab Box · bash",
      "remote-session",
      expect.objectContaining({
        config: expect.objectContaining({
          agentId: AGENT_ID,
          shell: "/bin/bash",
          title: "Lab Box · bash",
        }),
      })
    );
  });

  it("numbers a second shell tab of the same agent", async () => {
    useAppStore.getState().addTab("Lab Box · bash", "remote-session");
    spyAddTab();
    await newShellSession(makeAgent(["/bin/bash"]));
    expect(addTab).toHaveBeenCalledWith(
      "Lab Box · bash 2",
      "remote-session",
      expect.objectContaining({
        config: expect.objectContaining({ title: "Lab Box · bash 2" }),
      })
    );
  });

  it("still names the agent when it reports no shell", async () => {
    spyAddTab();
    await newShellSession(makeAgent([]));
    const [title] = addTab.mock.calls[0];
    expect(title).toBe("Lab Box · shell");
    expect(title).not.toMatch(/Shell:|local/u);
  });
});
