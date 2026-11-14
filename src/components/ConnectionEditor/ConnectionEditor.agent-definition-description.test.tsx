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
import type { RemoteAgentDefinition } from "@/types/connection";
import { DEFAULT_AGENT_SETTINGS } from "@/types/connection";

// ---------------------------------------------------------------------------
// Description on a connection saved ON a remote agent (#5769): the editor shows
// the field only for an agent that advertises `connectionDescription` (protocol
// 0.42.0) — an older agent would ignore the key and the text would vanish — and
// sends it, normalised to one line, on `connections.create` / `.update`.
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

let container: HTMLDivElement;
let root: Root;

function q(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function descriptionInput(): HTMLInputElement | null {
  return q("connection-editor-description-input") as HTMLInputElement | null;
}

function setInput(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function renderEditor(agentId: string, agentDefinitionId: string, tabId: string): void {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId={tabId}
          meta={{ connectionId: agentId, folderId: null, agentDefinitionId }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
}

function clickSave(): void {
  act(() => (q("connection-editor-save") as HTMLButtonElement).click());
}

function isDirty(tabId: string): boolean {
  return useAppStore.getState().editorDirtyTabs[tabId] === true;
}

/** A connected agent; `connectionDescription` says whether it stores descriptions. */
function makeAgent(connectionDescription: boolean): RemoteAgentDefinition {
  return {
    id: connectionDescription ? "agent-new" : "agent-old",
    name: "Lab Agent",
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
      ...(connectionDescription ? { connectionDescription: true } : {}),
    },
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

describe("ConnectionEditor description for agent definitions (#5769)", () => {
  it("hides the field for an agent that cannot store a description", async () => {
    const saveAgentDef = vi.fn(() => Promise.resolve());
    useAppStore.setState({ saveAgentDef });
    const agent = makeAgent(false);
    seedAgentsRegion({ remoteAgents: [agent], agentDefinitions: { [agent.id]: [] } });
    renderEditor(agent.id, "new", "tab-agentdef-old");
    await flush();

    expect(q("connection-editor-name-input")).not.toBeNull();
    expect(descriptionInput()).toBeNull();

    setInput(q("connection-editor-name-input") as HTMLInputElement, "Bench");
    await flush();
    clickSave();
    await flush();

    expect(saveAgentDef).toHaveBeenCalledTimes(1);
    const [, params] = saveAgentDef.mock.calls[0] as unknown as [string, unknown];
    expect(params).toMatchObject({ name: "Bench", description: null });
  });

  it("creates a definition with a one-line description", async () => {
    const saveAgentDef = vi.fn(() => Promise.resolve());
    useAppStore.setState({ saveAgentDef });
    const agent = makeAgent(true);
    seedAgentsRegion({ remoteAgents: [agent], agentDefinitions: { [agent.id]: [] } });
    renderEditor(agent.id, "new", "tab-agentdef-new");
    await flush();

    const input = descriptionInput();
    expect(input).not.toBeNull();
    expect(input!.value).toBe("");
    expect(input!.getAttribute("maxlength")).toBe("80");

    setInput(q("connection-editor-name-input") as HTMLInputElement, "Bench");
    setInput(input!, "  Lab   bench\tconsole ");
    await flush();
    clickSave();
    await flush();

    expect(saveAgentDef).toHaveBeenCalledTimes(1);
    const [agentId, params] = saveAgentDef.mock.calls[0] as unknown as [string, unknown];
    expect(agentId).toBe(agent.id);
    expect(params).toMatchObject({ name: "Bench", description: "Lab bench console" });
  });

  it("loads an existing definition's description clean and clears it on save", async () => {
    const updateAgentDef = vi.fn(() => Promise.resolve());
    useAppStore.setState({ updateAgentDef });
    const agent = makeAgent(true);
    seedAgentsRegion({
      remoteAgents: [agent],
      agentDefinitions: {
        [agent.id]: [
          {
            id: "def-1",
            name: "Bench",
            sessionType: "shell",
            config: {},
            persistent: false,
            folderId: null,
            description: "Lab bench console",
          },
        ],
      },
    });
    renderEditor(agent.id, "def-1", "tab-agentdef-edit");
    await flush();

    const input = descriptionInput();
    expect(input!.value).toBe("Lab bench console");
    expect(isDirty("tab-agentdef-edit")).toBe(false);

    setInput(input!, "   ");
    await flush();
    expect(isDirty("tab-agentdef-edit")).toBe(true);
    clickSave();
    await flush();

    expect(updateAgentDef).toHaveBeenCalledTimes(1);
    const [, params] = updateAgentDef.mock.calls[0] as unknown as [string, unknown];
    expect(params).toMatchObject({ id: "def-1", name: "Bench", description: null });
  });
});
