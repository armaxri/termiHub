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
// Per-connection icon colour + emoji (#5008): both live on the editor's
// react-hook-form top-level form, validated by zod (null = unset, #2467),
// flow into the save payload, gate Save on an invalid emoji, and are hidden
// for agent definitions (which do not persist them).
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

describe("ConnectionEditor icon colour + emoji", () => {
  it("loads both from the existing connection without being dirty", async () => {
    seedExisting({ iconColor: "teal", iconEmoji: "🐳" });
    renderEditor("conn-1");
    await flush();
    openCategory("appearance");

    expect(q("icon-color-swatch-teal")?.getAttribute("aria-checked")).toBe("true");
    expect((q("connection-editor-icon-emoji") as HTMLInputElement).value).toBe("🐳");
    expect(isDirty()).toBe(false);
  });

  it("saves a picked palette colour and a suggested emoji", async () => {
    const addConnection = vi.fn();
    useAppStore.setState({ addConnection });
    renderEditor("new");
    await flush();
    setInput(nameInput(), "Prod");
    await flush();

    openCategory("appearance");
    act(() => (q("icon-color-swatch-red") as HTMLButtonElement).click());
    act(() => (q("icon-emoji-suggestion-0") as HTMLButtonElement).click());
    await flush();
    expect(isDirty()).toBe(true);

    clickSave();
    await flush();

    const saved = addConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.iconColor).toBe("red");
    expect(saved.iconEmoji).toBe("🚀");
  });

  it("blocks Save with an inline error for a non-emoji value", async () => {
    const addConnection = vi.fn();
    useAppStore.setState({ addConnection });
    renderEditor("new");
    await flush();
    setInput(nameInput(), "Bad Emoji");
    await flush();

    openCategory("appearance");
    setInput(q("connection-editor-icon-emoji") as HTMLInputElement, "ab");
    await flush();

    expect(container.textContent).toContain("Enter a single emoji.");
    expect(q("connection-editor-save")?.getAttribute("data-invalid")).toBe("true");
    clickSave();
    await flush();
    expect(addConnection).not.toHaveBeenCalled();
  });

  it("clearing both persists them unset (null-tolerant schema, #2467)", async () => {
    const updateConnection = vi.fn();
    useAppStore.setState({ updateConnection });
    seedExisting({ iconColor: "#ff8800", iconEmoji: "🔥" });
    renderEditor("conn-1");
    await flush();

    openCategory("appearance");
    expect(q("icon-color-swatch-custom")?.getAttribute("aria-checked")).toBe("true");
    act(() => (q("icon-color-swatch-default") as HTMLButtonElement).click());
    act(() => (q("connection-editor-clear-icon-emoji") as HTMLButtonElement).click());
    await flush();
    expect(q("connection-editor-save")?.getAttribute("data-invalid")).toBeNull();

    clickSave();
    await flush();

    const saved = updateConnection.mock.calls[0][0] as SavedConnection;
    expect(saved.iconColor).toBeUndefined();
    expect(saved.iconEmoji).toBeUndefined();
  });

  it("hides the controls for an agent definition", async () => {
    const agent = makeAgent({ id: "agent-x" });
    seedAgentsRegion({ remoteAgents: [agent], agentDefinitions: { [agent.id]: [] } });
    renderEditor(agent.id, { agentDefinitionId: "new" }, "tab-agentdef-icon");
    await flush();

    openCategory("appearance");
    expect(q("connection-editor-icon-picker")).not.toBeNull();
    expect(q("connection-editor-icon-color")).toBeNull();
    expect(q("connection-editor-icon-emoji")).toBeNull();
  });
});
