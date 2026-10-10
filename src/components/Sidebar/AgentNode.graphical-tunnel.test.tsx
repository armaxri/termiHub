/**
 * Opening a VNC/RDP connection saved under an agent (#3241): it runs on this
 * computer and tunnels through the agent's port forwarding, so the sidebar opens
 * a remote-desktop tab whose config carries the agent route — never an agent
 * terminal session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { TooltipProvider } from "@/components/ui";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resolveCredential } from "@/services/api";

// --- mocks required by AgentNode --------------------------------------------

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
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDndContext: () => ({ active: null }),
  useDndMonitor: () => {},
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

vi.mock("@/services/api", () => ({
  resolveCredential: vi.fn(() => Promise.resolve("stored-pw")),
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("@/utils/resolveConnectionCredential", () => ({
  resolveConnectionCredential: vi.fn(() =>
    Promise.resolve({ usedStoredCredential: false, password: null })
  ),
}));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({
  ConnectionErrorDialog: () => null,
}));

// --- helpers -----------------------------------------------------------------

const AGENT_ID = "agent-graphical-tunnel-test";

function makeAgent(): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Jump Box",
    config: { host: "jump.example.com", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
  };
}

function def(id: string, name: string, sessionType: string, config: Record<string, unknown>) {
  return { id, name, sessionType, config, persistent: false, folderId: null };
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function renderAndOpen(title: string) {
  act(() => {
    root.render(
      React.createElement(TooltipProvider, {
        delayDuration: 0,
        children: React.createElement(AgentNode, { agent: makeAgent() }),
      })
    );
  });
  const row = container.querySelector<HTMLButtonElement>(`button[title^="${title}"]`);
  expect(row).not.toBeNull();
  act(() => {
    row!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
}

// --- tests -------------------------------------------------------------------

setupAgentsRegion();

describe("AgentNode — VNC/RDP connections tunnelled through the agent (#3241)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    seedAgentsRegion({
      agentDefinitions: {
        [AGENT_ID]: [
          def("def-vnc", "Lab desktop", "vnc", { host: "10.0.0.5", port: 5901 }),
          def("def-rdp", "Build server", "rdp", { host: "win-build", username: "ci" }),
          def("def-shell", "Plain shell", "shell", {}),
        ],
      },
      agentFolders: { [AGENT_ID]: [] },
      agentSessions: { [AGENT_ID]: [] },
      remoteAgents: [makeAgent()],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("opens a VNC definition as a remote-desktop tab routed through the agent", async () => {
    const addTab = vi.fn();
    useAppStore.setState({ addTab });

    renderAndOpen("Lab desktop");
    await flush();

    // The password comes from this computer's credential store (#3803).
    expect(resolveCredential).toHaveBeenCalledWith(
      `agent-graphical:${AGENT_ID}:def-vnc`,
      "password",
      null
    );
    expect(addTab).toHaveBeenCalledTimes(1);
    expect(addTab).toHaveBeenCalledWith(
      "Lab desktop",
      "vnc",
      {
        type: "vnc",
        config: { host: "10.0.0.5", port: 5901, password: "stored-pw", agentId: AGENT_ID },
      },
      { contentType: "remote-desktop" }
    );
  });

  it("opens an RDP definition the same way", async () => {
    const addTab = vi.fn();
    useAppStore.setState({ addTab });

    renderAndOpen("Build server");
    await flush();

    expect(addTab).toHaveBeenCalledWith(
      "Build server",
      "rdp",
      {
        type: "rdp",
        config: { host: "win-build", username: "ci", password: "stored-pw", agentId: AGENT_ID },
      },
      { contentType: "remote-desktop" }
    );
  });

  it("prompts for the password when none is stored, and opens nothing on cancel", async () => {
    vi.mocked(resolveCredential).mockResolvedValueOnce(null);
    const addTab = vi.fn();
    const requestPassword = vi.fn(() => Promise.resolve(null));
    useAppStore.setState({ addTab, requestPassword });

    renderAndOpen("Build server");
    await flush();

    // The definition's name titles the prompt (#4475).
    expect(requestPassword).toHaveBeenCalledWith("win-build", "ci", "", "password", {
      label: "Build server",
    });
    expect(addTab).not.toHaveBeenCalled();
  });

  it("connects with the prompted password", async () => {
    vi.mocked(resolveCredential).mockResolvedValueOnce(null);
    const addTab = vi.fn();
    const requestPassword = vi.fn(() =>
      Promise.resolve({ password: "typed-pw", shouldSave: false })
    );
    useAppStore.setState({ addTab, requestPassword });

    renderAndOpen("Lab desktop");
    await flush();

    expect(addTab).toHaveBeenCalledTimes(1);
    const [, , config] = addTab.mock.calls[0];
    expect(config).toMatchObject({ config: { password: "typed-pw", agentId: AGENT_ID } });
  });

  it("still opens an agent-native definition as an agent terminal session", () => {
    const addTab = vi.fn();
    useAppStore.setState({ addTab });

    renderAndOpen("Plain shell");

    expect(addTab).toHaveBeenCalledTimes(1);
    const [, connectionType, config] = addTab.mock.calls[0];
    expect(connectionType).toBe("remote-session");
    expect(config).toMatchObject({
      type: "remote-session",
      config: { agentId: AGENT_ID, sessionType: "shell" },
    });
  });
});
