import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { setupConnectionsRegion, seedConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { ConnectionTypeInfo } from "@/types/connection";
import type { SavedConnection, RemoteAgentDefinition } from "@/types/connection";
import { DEFAULT_AGENT_SETTINGS } from "@/types/connection";

// ---------------------------------------------------------------------------
// Top-level metadata migration (UISF-011, #3073)
//
// The editor's hand-rolled scalar fields — connection name, storage-file target,
// and the agent-definition "persistent" flag — were migrated to
// react-hook-form + zod. These tests pin the user-visible behavior of that slice:
// edit-mode defaults populate, the zod Save-gate blocks blank/duplicate names,
// each field flows through to the saved payload, switching the (still local)
// connection type preserves the top-level name, and Cancel persists nothing.
// The schema-driven per-type config stays on DynamicForm and is covered
// elsewhere.
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

describe("ConnectionEditor top-level fields — edit-mode defaults", () => {
  it("populates the name input from the existing connection", async () => {
    const existing: SavedConnection = {
      id: "conn-1",
      name: "Existing Name",
      config: { type: "local", config: { shell: "bash" } },
      folderId: null,
    };
    seedConnectionsRegion({ connections: [existing] });
    renderEditor("conn-1");
    await flush();

    expect(nameInput().value).toBe("Existing Name");
  });

  it("populates the storage-file picker from the existing connection's sourceFile", async () => {
    seedSettings({ externalConnectionFiles: [{ path: "/tmp/team.json", enabled: true }] });
    const existing: SavedConnection = {
      id: "conn-src",
      name: "Team Conn",
      config: { type: "local", config: { shell: "bash" } },
      folderId: null,
      sourceFile: "/tmp/team.json",
    };
    seedConnectionsRegion({ connections: [existing] });
    renderEditor("conn-src");
    await flush();

    const trigger = q("connection-editor-source-file");
    expect(trigger?.getAttribute("data-value")).toBe("/tmp/team.json");
  });

  it("populates the persistent toggle from an existing agent definition", async () => {
    const agent = makeAgent({ id: "agent-p" });
    seedAgentsRegion({
      remoteAgents: [agent],
      agentDefinitions: {
        [agent.id]: [
          {
            id: "def-1",
            name: "My Session",
            sessionType: "shell",
            config: { shell: "bash" },
            persistent: true,
            folderId: null,
          },
        ],
      },
    });
    renderEditor(agent.id, { agentDefinitionId: "def-1" });
    await flush();

    expect(q("connection-editor-persistent")?.getAttribute("aria-checked")).toBe("true");
  });
});

describe("ConnectionEditor top-level fields — Save gate (zod)", () => {
  it("blocks Save while the name is blank and persists nothing", async () => {
    const addConnection = vi.fn();
    useAppStore.setState({ addConnection });
    renderEditor("new");
    await flush();

    // Blank name → the gate marks Save invalid.
    expect(q("connection-editor-save")?.getAttribute("data-invalid")).toBe("true");

    act(() => (q("connection-editor-save") as HTMLButtonElement).click());
    await flush();
    expect(addConnection).not.toHaveBeenCalled();
  });

  it("enables Save and persists the name once a valid name is entered", async () => {
    const addConnection = vi.fn();
    useAppStore.setState({ addConnection });
    renderEditor("new");
    await flush();

    setInput(nameInput(), "Fresh Connection");
    await flush();

    expect(q("connection-editor-save")?.getAttribute("data-invalid")).toBeNull();

    act(() => (q("connection-editor-save") as HTMLButtonElement).click());
    await flush();

    expect(addConnection).toHaveBeenCalledTimes(1);
    const saved = addConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.name).toBe("Fresh Connection");
    expect(saved.config.type).toBe("local");
  });

  it("blocks Save and shows an inline error on a duplicate name in the same folder", async () => {
    const addConnection = vi.fn();
    useAppStore.setState({ addConnection });
    seedConnectionsRegion({
      connections: [
        {
          id: "dup-1",
          name: "Duplicate",
          config: { type: "local", config: { shell: "bash" } },
          folderId: null,
        },
      ],
    });
    renderEditor("new");
    await flush();

    setInput(nameInput(), "Duplicate");
    await flush();

    expect(q("connection-editor-name-error")?.textContent).toMatch(/already exists/i);
    expect(q("connection-editor-save")?.getAttribute("data-invalid")).toBe("true");

    act(() => (q("connection-editor-save") as HTMLButtonElement).click());
    await flush();
    expect(addConnection).not.toHaveBeenCalled();
  });

  it("does not render an inline error for a merely-blank name (gate only)", async () => {
    renderEditor("new");
    await flush();
    expect(q("connection-editor-name-error")).toBeNull();
  });
});

describe("ConnectionEditor top-level fields — payload flow", () => {
  it("persists the chosen storage file in the saved payload", async () => {
    seedSettings({ externalConnectionFiles: [{ path: "/tmp/team.json", enabled: true }] });
    const addConnection = vi.fn();
    useAppStore.setState({ addConnection });
    renderEditor("new");
    await flush();

    setInput(nameInput(), "Stored Elsewhere");
    await flush();

    // Pick the external storage file from the Controller-wired Select.
    const trigger = q("connection-editor-source-file") as HTMLElement;
    for (let i = 0; i < 3 && document.querySelectorAll(".ui-select__item").length === 0; i++) {
      act(() => {
        trigger.focus();
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })
        );
      });
    }
    const fileOption = Array.from(document.querySelectorAll<HTMLElement>(".ui-select__item")).find(
      (o) => o.getAttribute("data-value") === "/tmp/team.json"
    );
    expect(fileOption).toBeTruthy();
    act(() => fileOption!.click());
    await flush();

    act(() => (q("connection-editor-save") as HTMLButtonElement).click());
    await flush();

    expect(addConnection).toHaveBeenCalledTimes(1);
    const saved = addConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.sourceFile).toBe("/tmp/team.json");
  });

  it("persists the persistent flag in the agent-definition save payload", async () => {
    const agent = makeAgent({ id: "agent-save" });
    const saveAgentDef = vi.fn((_agentId: string, _def: Record<string, unknown>) =>
      Promise.resolve()
    );
    seedAgentsRegion({ remoteAgents: [agent], agentDefinitions: { [agent.id]: [] } });
    useAppStore.setState({ saveAgentDef });
    renderEditor(agent.id, { agentDefinitionId: "new" }, "tab-agentdef");
    await flush();

    setInput(nameInput(), "Persistent Session");
    await flush();

    // Toggle persistent on via the Controller-wired Toggle.
    act(() => (q("connection-editor-persistent") as HTMLElement).click());
    await flush();

    act(() => (q("connection-editor-save") as HTMLButtonElement).click());
    await flush();

    expect(saveAgentDef).toHaveBeenCalledTimes(1);
    const payload = saveAgentDef.mock.calls[0][1];
    expect(payload.name).toBe("Persistent Session");
    expect(payload.persistent).toBe(true);
    expect(payload.type).toBe("shell");
  });
});

describe("ConnectionEditor top-level fields — type switch", () => {
  it("preserves the typed name when the connection type changes", async () => {
    renderEditor("new");
    await flush();

    setInput(nameInput(), "Keep Me");
    await flush();
    expect(nameInput().value).toBe("Keep Me");

    // Switch the (local-state) connection type to SSH — this resets the
    // schema-driven config but must not clobber the RHF-owned top-level name.
    const options = openTypeOptions();
    const ssh = options.find((o) => o.getAttribute("data-value") === "ssh");
    expect(ssh).toBeTruthy();
    act(() => ssh!.click());
    await flush();

    expect(nameInput().value).toBe("Keep Me");
    // The config form now reflects the SSH schema (defaults were rebuilt).
    expect(q("field-host")).not.toBeNull();
  });
});

describe("ConnectionEditor top-level fields — cancel discards", () => {
  it("does not persist anything when Cancel is clicked after editing the name", async () => {
    const addConnection = vi.fn();
    useAppStore.setState({ addConnection });
    renderEditor("new");
    await flush();

    setInput(nameInput(), "Abandoned Draft");
    await flush();

    // The edit registered as dirty (so Cancel routes through the unsaved-changes
    // guard rather than a silent discard).
    expect(useAppStore.getState().editorDirtyTabs["tab-tl-1"]).toBe(true);

    act(() => (q("connection-editor-cancel") as HTMLButtonElement).click());
    await flush();

    // Cancel never persists the draft.
    expect(addConnection).not.toHaveBeenCalled();
  });
});
