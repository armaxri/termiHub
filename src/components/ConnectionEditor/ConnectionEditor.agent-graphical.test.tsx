/**
 * VNC/RDP under an agent in the connection editor (#3241).
 *
 * The agent does not host graphical types; the editor offers this computer's
 * VNC/RDP types under an agent, marks them as tunnelled through the agent, and
 * Save & Connect opens a remote-desktop tab routed through the agent (its
 * config carries `agentId`) instead of an agent terminal session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import { DEFAULT_AGENT_SETTINGS } from "@/types/connection";
import type { ConnectionTypeInfo, RemoteAgentDefinition } from "@/types/connection";

vi.mock("@/components/ui/Toast", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/ui/Toast")>("@/components/ui/Toast");
  return {
    ...actual,
    toast: {
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      loading: vi.fn(),
      dismiss: vi.fn(),
    },
  };
});

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mockedInvoke = vi.mocked(invoke);
const AGENT_ID = "agent-1";

const SHELL_TYPE: ConnectionTypeInfo = {
  typeId: "shell",
  displayName: "Shell",
  icon: "shell",
  schema: {
    groups: [
      {
        key: "general",
        label: "General",
        fields: [{ key: "shell", label: "Shell", fieldType: { type: "text" }, required: false }],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: true },
};

/** This computer's VNC type (the agent registry never reports it). */
const DESKTOP_VNC: ConnectionTypeInfo = {
  typeId: "vnc",
  displayName: "VNC",
  icon: "monitor",
  schema: {
    groups: [
      {
        key: "connection",
        label: "Connection",
        fields: [
          { key: "host", label: "Host", fieldType: { type: "text" }, required: true },
          { key: "port", label: "Port", fieldType: { type: "port" }, required: false },
        ],
      },
      {
        key: "sshTunnel",
        label: "SSH Tunnel",
        fields: [
          {
            key: "useSshTunnel",
            label: "Use SSH Tunnel",
            fieldType: { type: "boolean" },
            required: false,
          },
        ],
      },
    ],
  },
  capabilities: {
    monitoring: false,
    fileBrowser: false,
    resize: true,
    persistent: false,
    terminal: false,
    graphical: true,
  },
};

function makeAgent(): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Jump Box",
    config: { host: "jump.example.com", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    capabilities: {
      connectionTypes: [SHELL_TYPE],
      maxSessions: 10,
      availableShells: ["bash"],
      availableSerialPorts: [],
      availableDockerImages: [],
    },
  };
}

let container: HTMLDivElement;
let root: Root;

function render(agentDefinitionId: string) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId="tab-agent-vnc"
          meta={{ connectionId: AGENT_ID, folderId: null, agentDefinitionId }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);

setupAgentsRegion();

describe("ConnectionEditor — VNC/RDP under an agent (#3241)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      credentialStoreStatus: { mode: "none", status: "unlocked" },
      connectionTypes: [DESKTOP_VNC],
    });
    seedAgentsRegion({
      remoteAgents: [makeAgent()],
      agentDefinitions: {
        [AGENT_ID]: [
          {
            id: "def-vnc",
            name: "Lab desktop",
            sessionType: "vnc",
            config: { host: "10.0.0.5", port: 5901 },
            persistent: false,
            folderId: null,
          },
        ],
      },
    });
    mockedInvoke.mockImplementation(() => Promise.resolve(false));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("edits a VNC connection under the agent as tunnelled through it", async () => {
    render("def-vnc");
    await flush();

    // The VNC schema comes from this computer's registry, minus its SSH tunnel.
    expect(container.textContent).toContain("Host");
    expect(container.textContent).not.toContain("Use SSH Tunnel");
    // The user is told where the target must be reachable from.
    expect(byTestId("connection-editor-agent-tunnel-hint")?.textContent).toContain(
      "reachable from the agent host"
    );
    // No agent-side persistence and no agent-session test for it.
    expect(byTestId("connection-editor-persistent")).toBeNull();
    expect(byTestId("connection-editor-test")).toBeNull();
    expect(byTestId("connection-editor-save-connect")).not.toBeNull();
  });

  it("Save & Connect opens a remote-desktop tab routed through the agent", async () => {
    const updateAgentDef = vi.fn(() => Promise.resolve());
    const addTab = vi.fn();
    useAppStore.setState({ updateAgentDef, addTab });
    // The password lives in this computer's credential store (#3803).
    mockedInvoke.mockImplementation((cmd: string, args?: unknown) =>
      Promise.resolve(
        cmd === "resolve_credential" &&
          (args as { connectionId?: string }).connectionId === `agent-graphical:${AGENT_ID}:def-vnc`
          ? "stored-pw"
          : false
      )
    );

    render("def-vnc");
    await flush();
    const btn = byTestId("connection-editor-save-connect") as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(updateAgentDef).toHaveBeenCalledTimes(1);
    expect(addTab).toHaveBeenCalledTimes(1);
    const [title, connectionType, config, options] = addTab.mock.calls[0] as unknown as [
      string,
      string,
      { type: string; config: Record<string, unknown> },
      { contentType?: string },
    ];
    expect(title).toBe("Lab desktop");
    expect(connectionType).toBe("vnc");
    expect(config.type).toBe("vnc");
    expect(config.config).toMatchObject({
      host: "10.0.0.5",
      port: 5901,
      password: "stored-pw",
      agentId: AGENT_ID,
    });
    expect(options.contentType).toBe("remote-desktop");
  });

  it("Save & Connect prompts when no password is stored, and opens nothing on cancel", async () => {
    const updateAgentDef = vi.fn(() => Promise.resolve());
    const addTab = vi.fn();
    const requestPassword = vi.fn(() => Promise.resolve(null));
    useAppStore.setState({ updateAgentDef, addTab, requestPassword });
    mockedInvoke.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "resolve_credential" ? null : false)
    );

    render("def-vnc");
    await flush();
    const btn = byTestId("connection-editor-save-connect") as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(updateAgentDef).toHaveBeenCalledTimes(1);
    expect(requestPassword).toHaveBeenCalledWith("10.0.0.5", "", "", "password");
    expect(addTab).not.toHaveBeenCalled();
  });

  it("does not show the tunnel hint for an agent-native type", async () => {
    render("new");
    await flush();
    expect(byTestId("connection-editor-agent-tunnel-hint")).toBeNull();
    expect(byTestId("connection-editor-persistent")).not.toBeNull();
  });
});
