/**
 * Regression tests for bug #633: agent connection settings (shellIntegration,
 * initialCommand, tab color) not forwarded when opening a saved definition.
 *
 * Previously handleOpenDefinition only extracted `shell` and `port` from
 * def.config, silently dropping every other setting. The fix spreads
 * def.config so all fields reach the backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { AgentNode } from "./AgentNode";
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";
import type { AgentDefinitionInfo } from "@/services/api";

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

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

vi.mock("@/services/api", () => ({
  removeCredential: vi.fn(() => Promise.resolve()),
  storeCredential: vi.fn(() => Promise.resolve()),
  listAgentDefinitions: vi.fn(() => Promise.resolve([])),
  listAgentConnections: vi.fn(() => Promise.resolve({ connections: [], folders: [] })),
  saveAgentDefinition: vi.fn(),
  updateAgentDefinition: vi.fn(),
  deleteAgentDefinition: vi.fn(() => Promise.resolve()),
  createAgentFolder: vi.fn(),
  updateAgentFolder: vi.fn(),
  deleteAgentFolder: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn() }));
vi.mock("@/utils/classifyAgentError", () => ({
  classifyAgentError: vi.fn((e) => ({ type: "unknown", message: String(e) })),
}));
vi.mock("@/utils/resolveConnectionCredential", () => ({
  resolveConnectionCredential: vi.fn(() =>
    Promise.resolve({ usedStoredCredential: false, password: null })
  ),
}));
vi.mock("./AgentSetupDialog", () => ({ AgentSetupDialog: () => null }));
vi.mock("./ConnectionErrorDialog", () => ({ ConnectionErrorDialog: () => null }));
vi.mock("./InlineFolderInput", () => ({ InlineFolderInput: () => null }));

const AGENT_ID = "agent-settings-test";

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Test Agent",
    config: {
      host: "host.example.com",
      port: 22,
      username: "user",
      authMethod: "password",
    },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    capabilities: {
      availableShells: ["bash"],
      availableSerialPorts: [],
      availableDockerContainers: [],
    },
    ...overrides,
  };
}

function makeDefinition(overrides: Partial<AgentDefinitionInfo> = {}): AgentDefinitionInfo {
  return {
    id: "def-1",
    name: "My Shell",
    sessionType: "shell",
    config: {},
    persistent: false,
    folderId: null,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

describe("AgentNode — definition settings forwarding (bug #633)", () => {
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

  it("forwards all config fields when opening a definition (not just shell)", () => {
    const def = makeDefinition({
      config: {
        shell: "bash",
        shellIntegration: false,
        initialCommand: "ls -la",
        startingDirectory: "/home/user",
      },
    });

    useAppStore.setState({
      agentDefinitions: { [AGENT_ID]: [def] },
      agentFolders: { [AGENT_ID]: [] },
      agentSessions: { [AGENT_ID]: [] },
    });

    act(() => {
      root.render(React.createElement(AgentNode, { agent: makeAgent() }));
    });

    const defButton = container.querySelector(".connection-tree__item") as HTMLButtonElement;
    expect(defButton).not.toBeNull();

    act(() => {
      defButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const { rootPanel } = useAppStore.getState();
    const leaf = rootPanel.type === "leaf" ? rootPanel : null;
    const tab = leaf?.tabs[0];
    expect(tab).toBeDefined();

    const cfg = tab!.config.config as Record<string, unknown>;
    expect(cfg.shellIntegration).toBe(false);
    expect(cfg.initialCommand).toBe("ls -la");
    expect(cfg.startingDirectory).toBe("/home/user");
    expect(cfg.shell).toBe("bash");
    expect(cfg.agentId).toBe(AGENT_ID);
    expect(cfg.sessionType).toBe("shell");
  });

  it("applies tab color from definition terminalOptions", () => {
    const def = makeDefinition({
      config: { shell: "bash" },
      terminalOptions: { color: "#c0ffee" },
    });

    useAppStore.setState({
      agentDefinitions: { [AGENT_ID]: [def] },
      agentFolders: { [AGENT_ID]: [] },
      agentSessions: { [AGENT_ID]: [] },
    });

    act(() => {
      root.render(React.createElement(AgentNode, { agent: makeAgent() }));
    });

    const defButton = container.querySelector(".connection-tree__item") as HTMLButtonElement;
    act(() => {
      defButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const { rootPanel, tabColors } = useAppStore.getState();
    const leaf = rootPanel.type === "leaf" ? rootPanel : null;
    const tabId = leaf?.tabs[0]?.id;
    expect(tabId).toBeDefined();
    expect(tabColors[tabId!]).toBe("#c0ffee");
  });

  it("forwards serial port config fields (not just extracting 'port' as 'serialPort')", () => {
    const def = makeDefinition({
      sessionType: "serial",
      config: {
        port: "/dev/ttyUSB0",
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
      },
    });

    useAppStore.setState({
      agentDefinitions: { [AGENT_ID]: [def] },
      agentFolders: { [AGENT_ID]: [] },
      agentSessions: { [AGENT_ID]: [] },
    });

    act(() => {
      root.render(React.createElement(AgentNode, { agent: makeAgent() }));
    });

    const defButton = container.querySelector(".connection-tree__item") as HTMLButtonElement;
    act(() => {
      defButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const { rootPanel } = useAppStore.getState();
    const leaf = rootPanel.type === "leaf" ? rootPanel : null;
    const cfg = leaf?.tabs[0]?.config.config as Record<string, unknown>;

    expect(cfg.port).toBe("/dev/ttyUSB0");
    expect(cfg.baudRate).toBe(115200);
    expect(cfg.dataBits).toBe(8);
    expect(cfg.stopBits).toBe(1);
    // Must NOT convert 'port' to 'serialPort' — the agent serial backend reads 'port'
    expect("serialPort" in cfg).toBe(false);
  });
});
