import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo } from "@/types/connection";
import type { SavedConnection, RemoteAgentDefinition } from "@/types/connection";
import { DEFAULT_AGENT_SETTINGS } from "@/types/connection";

// ---------------------------------------------------------------------------
// Sub-component-delegated top-level fields (UISF-011, #3081, part of #3073)
//
// `icon` (Appearance tab), `terminalOptions` (Terminal tab + the Appearance tab
// color), and `agentSettings` (Agent tab) are owned by the editor's
// react-hook-form top-level form and threaded into their dedicated
// sub-components. These tests pin the user-visible behavior of that wiring:
// edit-mode defaults populate, each field flows 1:1 into every save payload
// (connection, agent definition, remote-agent transport), values survive
// category switches and a connection-type switch, and dirty tracking still
// reports edits and "revert to original → clean".
// ---------------------------------------------------------------------------

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

/** Local type with no required config fields — Save gates on the name alone. */
const LOCAL_TYPE: ConnectionTypeInfo = {
  typeId: "local",
  displayName: "Local Shell",
  icon: "local",
  schema: {
    groups: [
      {
        key: "general",
        label: "General",
        fields: [{ key: "shell", label: "Shell", fieldType: { type: "text" }, required: false }],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

/** SSH type with no required fields — used to exercise a type switch. */
const SSH_TYPE: ConnectionTypeInfo = {
  typeId: "ssh",
  displayName: "SSH",
  icon: "ssh",
  schema: {
    groups: [
      {
        key: "conn",
        label: "Connection",
        fields: [{ key: "host", label: "Host", fieldType: { type: "text" }, required: false }],
      },
    ],
  },
  capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: false },
};

let container: HTMLDivElement;
let root: Root;

function q(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function nameInput(): HTMLInputElement {
  return q("connection-editor-name-input") as HTMLInputElement;
}

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderEditor(
  connectionId: string,
  extraMeta: Record<string, unknown> = {},
  tabId = "tab-tl-1"
): void {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId={tabId}
          meta={{ connectionId, folderId: null, ...extraMeta }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
}

/** Open the Radix type-select and return its rendered option elements. */
function openTypeOptions(): HTMLElement[] {
  const trigger = q("connection-editor-type-select");
  if (!trigger) throw new Error("type select trigger not found");
  for (let i = 0; i < 3 && document.querySelectorAll(".ui-select__item").length === 0; i++) {
    act(() => {
      trigger.focus();
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
      );
    });
  }
  return Array.from(document.querySelectorAll<HTMLElement>(".ui-select__item"));
}

function makeAgent(overrides: Partial<RemoteAgentDefinition> = {}): RemoteAgentDefinition {
  return {
    id: "agent-1",
    name: "Prod Agent",
    config: { host: "host.example.com", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    capabilities: {
      connectionTypes: [
        {
          typeId: "shell",
          displayName: "Shell",
          icon: "shell",
          schema: {
            groups: [
              {
                key: "general",
                label: "General",
                fields: [
                  { key: "shell", label: "Shell", fieldType: { type: "text" }, required: false },
                ],
              },
            ],
          },
          capabilities: { monitoring: false, fileBrowser: false, resize: true, persistent: true },
        },
      ],
      maxSessions: 10,
      availableShells: ["bash"],
      availableSerialPorts: [],
      availableDockerImages: [],
    },
    ...overrides,
  };
}

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

const TAB = "tab-tl-1";

function isDirty(tabId = TAB): boolean {
  return useAppStore.getState().editorDirtyTabs[tabId] === true;
}

function openCategory(id: string): void {
  act(() => (q(`settings-nav-${id}`) as HTMLElement).click());
}

function fontFamilyInput(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>(
    'input[placeholder^="Use global default ("]'
  );
  if (!el) throw new Error("font family input not found");
  return el;
}

function startingDirInput(): HTMLInputElement {
  const el = container.querySelector<HTMLInputElement>('input[placeholder="~"]');
  if (!el) throw new Error("starting directory input not found");
  return el;
}

function clickSave(): void {
  act(() => (q("connection-editor-save") as HTMLButtonElement).click());
}

function seedExisting(overrides: Partial<SavedConnection> = {}): SavedConnection {
  const existing: SavedConnection = {
    id: "conn-1",
    name: "Existing",
    config: { type: "local", config: { shell: "bash" } },
    folderId: null,
    ...overrides,
  };
  seedConnectionsRegion({ connections: [existing] });
  return existing;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetRuntimeCache();
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    connectionTypes: [LOCAL_TYPE, SSH_TYPE],
    credentialStoreStatus: { mode: "none", status: "unlocked" },
  });
  seedConnectionsRegion({ connections: [] });
  mockedInvoke.mockImplementation((cmd) => {
    if (cmd === "check_docker_available") return Promise.resolve(false);
    if (cmd === "check_podman_available") return Promise.resolve(false);
    if (cmd === "resolve_credential") return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("ConnectionEditor sub-component fields — edit-mode defaults", () => {
  it("populates terminal options, color and icon from the existing connection", async () => {
    seedExisting({
      terminalOptions: { fontFamily: "Fira Code", color: "#ff8800" },
      icon: "server",
    });
    renderEditor("conn-1");
    await flush();

    openCategory("terminal");
    expect(fontFamilyInput().value).toBe("Fira Code");

    openCategory("appearance");
    expect(q("connection-editor-clear-color")).not.toBeNull();
    expect(q("connection-editor-clear-icon")).not.toBeNull();
    expect(isDirty()).toBe(false);
  });

  it("populates the agent settings from the existing remote agent", async () => {
    const agent = makeAgent({
      id: "agent-s",
      agentSettings: { ...DEFAULT_AGENT_SETTINGS, startingDirectory: "/srv" },
    });
    seedAgentsRegion({ remoteAgents: [agent], agentDefinitions: {} });
    renderEditor(agent.id);
    await flush();

    openCategory("agent");
    expect(startingDirInput().value).toBe("/srv");
    expect(isDirty()).toBe(false);
  });
});

describe("ConnectionEditor sub-component fields — connection save payload", () => {
  it("round-trips unchanged icon + terminal options on a plain save", async () => {
    const updateConnection = vi.fn();
    useAppStore.setState({ updateConnection });
    seedExisting({
      terminalOptions: { fontFamily: "Fira Code", color: "#ff8800" },
      icon: "server",
    });
    renderEditor("conn-1");
    await flush();

    clickSave();
    await flush();

    expect(updateConnection).toHaveBeenCalledTimes(1);
    const saved = updateConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.icon).toBe("server");
    expect(saved.terminalOptions).toEqual({ fontFamily: "Fira Code", color: "#ff8800" });
  });

  it("persists an edited terminal option and marks the editor dirty", async () => {
    const addConnection = vi.fn();
    useAppStore.setState({ addConnection });
    renderEditor("new");
    await flush();
    setInput(nameInput(), "Styled");
    await flush();

    openCategory("terminal");
    setInput(fontFamilyInput(), "JetBrains Mono");
    await flush();
    expect(isDirty()).toBe(true);

    // Switching category away and back keeps the RHF-owned value.
    openCategory("connection");
    openCategory("terminal");
    expect(fontFamilyInput().value).toBe("JetBrains Mono");

    clickSave();
    await flush();

    expect(addConnection).toHaveBeenCalledTimes(1);
    const saved = addConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.terminalOptions).toEqual({ fontFamily: "JetBrains Mono" });
    expect(saved.icon).toBeUndefined();
  });

  it("omits terminalOptions from the payload when every option is cleared", async () => {
    const addConnection = vi.fn();
    useAppStore.setState({ addConnection });
    renderEditor("new");
    await flush();
    setInput(nameInput(), "Plain");
    await flush();

    openCategory("terminal");
    setInput(fontFamilyInput(), "X");
    await flush();
    setInput(fontFamilyInput(), "");
    await flush();

    clickSave();
    await flush();

    const saved = addConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.terminalOptions).toBeUndefined();
  });

  it("reverting a terminal option to its original value returns the editor to clean", async () => {
    seedExisting({ terminalOptions: { fontFamily: "Fira Code" } });
    renderEditor("conn-1");
    await flush();

    openCategory("terminal");
    setInput(fontFamilyInput(), "Other");
    await flush();
    expect(isDirty()).toBe(true);

    setInput(fontFamilyInput(), "Fira Code");
    await flush();
    expect(isDirty()).toBe(false);
  });

  it("clearing the color keeps the other terminal options in the payload", async () => {
    const updateConnection = vi.fn();
    useAppStore.setState({ updateConnection });
    seedExisting({ terminalOptions: { fontFamily: "Fira Code", color: "#ff8800" } });
    renderEditor("conn-1");
    await flush();

    openCategory("appearance");
    act(() => (q("connection-editor-clear-color") as HTMLButtonElement).click());
    await flush();
    expect(q("connection-editor-clear-color")).toBeNull();
    expect(isDirty()).toBe(true);

    clickSave();
    await flush();

    const saved = updateConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.terminalOptions?.fontFamily).toBe("Fira Code");
    expect(saved.terminalOptions?.color).toBeUndefined();
  });

  it("clearing the icon persists an unset icon and marks the editor dirty", async () => {
    const updateConnection = vi.fn();
    useAppStore.setState({ updateConnection });
    seedExisting({ icon: "server" });
    renderEditor("conn-1");
    await flush();

    openCategory("appearance");
    act(() => (q("connection-editor-clear-icon") as HTMLButtonElement).click());
    await flush();
    expect(q("connection-editor-clear-icon")).toBeNull();
    expect(isDirty()).toBe(true);

    clickSave();
    await flush();

    const saved = updateConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.icon).toBeUndefined();
  });

  it("persists an icon chosen through the icon picker", async () => {
    const addConnection = vi.fn();
    useAppStore.setState({ addConnection });
    renderEditor("new");
    await flush();
    setInput(nameInput(), "Iconic");
    await flush();

    openCategory("appearance");
    act(() => (q("connection-editor-icon-picker") as HTMLButtonElement).click());
    await flush();
    const cell = document.querySelector<HTMLElement>('[data-testid^="icon-picker-cell-"]');
    expect(cell).toBeTruthy();
    const iconName = cell!.getAttribute("data-testid")!.replace("icon-picker-cell-", "");
    act(() => cell!.click());
    act(() => (document.querySelector('[data-testid="icon-picker-apply"]') as HTMLElement).click());
    await flush();
    expect(isDirty()).toBe(true);

    clickSave();
    await flush();

    const saved = addConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.icon).toBe(iconName);
  });

  it("keeps terminal options and icon across a connection-type switch", async () => {
    const addConnection = vi.fn();
    useAppStore.setState({ addConnection });
    renderEditor("new");
    await flush();
    setInput(nameInput(), "Switcher");
    await flush();

    openCategory("terminal");
    setInput(fontFamilyInput(), "Mono");
    await flush();

    openCategory("connection");
    const ssh = openTypeOptions().find((o) => o.getAttribute("data-value") === "ssh");
    expect(ssh).toBeTruthy();
    act(() => ssh!.click());
    await flush();

    clickSave();
    await flush();

    const saved = addConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.config.type).toBe("ssh");
    expect(saved.terminalOptions).toEqual({ fontFamily: "Mono" });
  });
});

describe("ConnectionEditor sub-component fields — agent payloads", () => {
  it("persists edited agent settings in the remote-agent transport save", async () => {
    const updateRemoteAgent = vi.fn();
    // `updateStrategy` is a required AGENT_SCHEMA select; seed it so the
    // transport form is valid and Save is not gated.
    const agent = makeAgent({
      id: "agent-t",
      config: {
        host: "host.example.com",
        port: 22,
        username: "user",
        authMethod: "password",
        updateStrategy: "immediate",
      },
    });
    seedAgentsRegion({ remoteAgents: [agent], agentDefinitions: {} });
    useAppStore.setState({ updateRemoteAgent });
    renderEditor(agent.id);
    await flush();

    openCategory("agent");
    setInput(startingDirInput(), "/opt/work");
    await flush();
    expect(isDirty()).toBe(true);

    openCategory("connection");
    clickSave();
    await flush();

    expect(updateRemoteAgent).toHaveBeenCalledTimes(1);
    const saved = updateRemoteAgent.mock.calls[0][0] as RemoteAgentDefinition;
    expect(saved.agentSettings).toEqual({
      ...DEFAULT_AGENT_SETTINGS,
      startingDirectory: "/opt/work",
    });
  });

  it("reverting an agent setting returns the editor to clean", async () => {
    const agent = makeAgent({ id: "agent-r" });
    seedAgentsRegion({ remoteAgents: [agent], agentDefinitions: {} });
    renderEditor(agent.id);
    await flush();

    openCategory("agent");
    const original = startingDirInput().value;
    setInput(startingDirInput(), "/changed");
    await flush();
    expect(isDirty()).toBe(true);
    setInput(startingDirInput(), original);
    await flush();
    expect(isDirty()).toBe(false);
  });

  it("carries terminal options and icon into the agent-definition update payload", async () => {
    const agent = makeAgent({ id: "agent-d" });
    const updateAgentDef = vi.fn((_agentId: string, _def: Record<string, unknown>) =>
      Promise.resolve()
    );
    seedAgentsRegion({
      remoteAgents: [agent],
      agentDefinitions: {
        [agent.id]: [
          {
            id: "def-1",
            name: "Session",
            sessionType: "shell",
            config: { shell: "bash" },
            persistent: false,
            folderId: null,
            icon: "server",
            terminalOptions: { fontFamily: "Fira Code" },
          },
        ],
      },
    });
    useAppStore.setState({ updateAgentDef });
    renderEditor(agent.id, { agentDefinitionId: "def-1" });
    await flush();

    openCategory("terminal");
    expect(fontFamilyInput().value).toBe("Fira Code");
    setInput(fontFamilyInput(), "Hack");
    await flush();

    openCategory("appearance");
    act(() => (q("connection-editor-clear-icon") as HTMLButtonElement).click());
    await flush();

    clickSave();
    await flush();

    expect(updateAgentDef).toHaveBeenCalledTimes(1);
    const payload = updateAgentDef.mock.calls[0][1];
    expect(payload.terminal_options).toEqual({ fontFamily: "Hack" });
    expect(payload.icon).toBeNull();
    // AGT-028 regression: the connection type goes out under the wire key `type`
    // (it used to be sent as `session_type`, which the agent silently dropped).
    expect(payload.type).toBe("shell");
    expect(payload).not.toHaveProperty("session_type");
  });

  it("sends null terminal options and icon for a new agent definition left at defaults", async () => {
    const agent = makeAgent({ id: "agent-n" });
    const saveAgentDef = vi.fn((_agentId: string, _def: Record<string, unknown>) =>
      Promise.resolve()
    );
    seedAgentsRegion({ remoteAgents: [agent], agentDefinitions: { [agent.id]: [] } });
    useAppStore.setState({ saveAgentDef });
    renderEditor(agent.id, { agentDefinitionId: "new" }, "tab-agentdef");
    await flush();

    setInput(nameInput(), "Fresh Def");
    await flush();
    clickSave();
    await flush();

    // The canonical connections.create form carries every key (AGT-028).
    const payload = saveAgentDef.mock.calls[0][1];
    expect(payload.terminal_options).toBeNull();
    expect(payload.icon).toBeNull();
    expect(payload.folder_id).toBeNull();
  });
});
