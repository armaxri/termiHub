/**
 * "Update Agent..." on a connected, outdated agent (#4038): the context-menu
 * action lists the other hosts via `agent.list_connections` (the backend drops
 * this desktop's own `client_id`) and opens the Update dialog with them, so the
 * user sees who else is attached before the update runs (#1349).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import type { ConnectedHost } from "@/services/api";

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

const listAgentHostsMock = vi.fn((..._args: unknown[]) => Promise.resolve([] as ConnectedHost[]));
const updateAgentMock = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ kind: "deployed", success: true, installedVersion: "0.5.0" })
);
const updateAgentForceMock = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ kind: "deployed", success: true, installedVersion: "0.5.0" })
);

vi.mock("@/services/api", () => ({
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  cancelConnectAgent: vi.fn(() => Promise.resolve()),
  disconnectAgent: vi.fn(() => Promise.resolve()),
  shutdownAgent: vi.fn(() => Promise.resolve(0)),
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
  listAgentHosts: (...args: unknown[]) => listAgentHostsMock(...args),
  updateAgent: (...args: unknown[]) => updateAgentMock(...args),
  updateAgentForce: (...args: unknown[]) => updateAgentForceMock(...args),
}));

vi.mock("@/hooks/useDesktopVersion", () => ({ useDesktopVersion: () => "0.5.0" }));

const toastError = vi.fn();
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    toast: {
      success: vi.fn(),
      error: (...args: unknown[]) => toastError(...args),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
      promise: vi.fn(),
    },
  };
});

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendError: vi.fn() }));
vi.mock("@/utils/classifyAgentError", () => ({
  classifyAgentError: vi.fn((e) => ({ type: "unknown", message: String(e) })),
}));
vi.mock("@/utils/resolveConnectionCredential", () => ({
  resolveConnectionCredential: vi.fn(() =>
    Promise.resolve({ usedStoredCredential: true, password: "stored-pw" })
  ),
}));
vi.mock("@/utils/ensureCredentialStoreUnlocked", () => ({
  ensureCredentialStoreUnlocked: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));
vi.mock("@/components/AgentUpdateBanner", () => ({ AgentUpdateBanner: () => null }));

const AGENT_ID = "agent-update-test";

function makeAgent(agentVersion: string): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Build Box",
    config: {
      host: "build.example.com",
      port: 22,
      username: "user",
      authMethod: "password",
      savePassword: true,
    },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    capabilities: {
      connectionTypes: [],
      maxSessions: 10,
      availableShells: ["bash"],
      availableSerialPorts: [],
      availableDockerImages: [],
      agentVersion,
    },
  };
}

const OTHER_HOST: ConnectedHost = {
  clientId: "client-other",
  client: "termihub-desktop on laptop",
  clientVersion: "0.5.0",
  connectedSince: new Date(Date.now() - 5 * 60_000).toISOString(),
};

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

setupAgentsRegion();

describe("AgentNode — Update Agent... (#4038)", () => {
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

  function render(agentVersion: string): void {
    const agent = makeAgent(agentVersion);
    seedAgentsRegion({ remoteAgents: [agent] });
    act(() => {
      root.render(React.createElement(AgentNode, { agent }));
    });
  }

  async function openMenu(): Promise<void> {
    const header = container.querySelector(`[data-testid="agent-header-${AGENT_ID}"]`);
    expect(header).not.toBeNull();
    act(() => {
      header!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    await flush();
  }

  async function clickUpdate(): Promise<void> {
    await openMenu();
    const item = document.querySelector('[data-testid="context-agent-update"]') as HTMLElement;
    expect(item).not.toBeNull();
    act(() => item.click());
    await flush();
  }

  it("does not offer Update Agent... for an up-to-date agent", async () => {
    render("0.5.0");
    await openMenu();
    expect(document.querySelector('[data-testid="context-agent-running-sessions"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="context-agent-update"]')).toBeNull();
  });

  it("opens the Update dialog listing the other connected hosts", async () => {
    listAgentHostsMock.mockResolvedValueOnce([OTHER_HOST]);
    render("0.4.0");
    await clickUpdate();

    expect(listAgentHostsMock).toHaveBeenCalledWith(AGENT_ID);
    const dialog = document.querySelector('[data-testid="update-agent-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("v0.4.0");
    expect(dialog?.textContent).toContain("v0.5.0");
    const warning = document.querySelector('[data-testid="update-agent-other-hosts"]');
    expect(warning?.textContent).toContain("termihub-desktop on laptop");
  });

  it("runs the forced update with the resolved password when others are connected", async () => {
    listAgentHostsMock.mockResolvedValueOnce([OTHER_HOST]);
    render("0.4.0");
    await clickUpdate();

    act(() => {
      (document.querySelector('[data-testid="update-agent-confirm"]') as HTMLElement).click();
    });
    await flush();

    expect(updateAgentForceMock).toHaveBeenCalledTimes(1);
    expect(updateAgentMock).not.toHaveBeenCalled();
    const [agentId, config] = updateAgentForceMock.mock.calls[0];
    expect(agentId).toBe(AGENT_ID);
    expect(config).toMatchObject({ host: "build.example.com", password: "stored-pw" });
    expect(document.querySelector('[data-testid="update-agent-dialog"]')).toBeNull();
  });

  it("runs the plain update when no other host is connected", async () => {
    render("0.4.0");
    await clickUpdate();

    expect(document.querySelector('[data-testid="update-agent-other-hosts"]')).toBeNull();
    act(() => {
      (document.querySelector('[data-testid="update-agent-confirm"]') as HTMLElement).click();
    });
    await flush();

    expect(updateAgentMock).toHaveBeenCalledTimes(1);
    expect(updateAgentForceMock).not.toHaveBeenCalled();
  });

  it("shows the late-joining hosts when the guard refuses the plain update", async () => {
    updateAgentMock.mockResolvedValueOnce({
      kind: "otherHostsConnected",
      hosts: [OTHER_HOST],
    } as never);
    render("0.4.0");
    await clickUpdate();

    act(() => {
      (document.querySelector('[data-testid="update-agent-confirm"]') as HTMLElement).click();
    });
    await flush();

    // The dialog stays open and now warns, so the next confirm forces it.
    const warning = document.querySelector('[data-testid="update-agent-other-hosts"]');
    expect(warning?.textContent).toContain("termihub-desktop on laptop");
    act(() => {
      (document.querySelector('[data-testid="update-agent-confirm"]') as HTMLElement).click();
    });
    await flush();
    expect(updateAgentForceMock).toHaveBeenCalledTimes(1);
  });

  it("does not open the dialog when listing the hosts fails", async () => {
    listAgentHostsMock.mockRejectedValueOnce(new Error("agent unreachable"));
    render("0.4.0");
    await clickUpdate();

    expect(document.querySelector('[data-testid="update-agent-dialog"]')).toBeNull();
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
