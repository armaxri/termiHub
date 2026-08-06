/**
 * Save-feedback tests for the connection editor (#1342).
 *
 * A failed agent-definition save used to be fully silent (swallowed to
 * console). These tests pin that saving an agent definition confirms with a
 * success toast, and that a failing save rejects so the async Button surfaces a
 * recoverable error toast instead of failing silently.
 *
 * (Regular local connections get their success/error feedback from the store's
 * async persist — addConnection/updateConnection — so the editor deliberately
 * does not double-toast those; that path is covered by the store's behavior.)
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
import type { RemoteAgentDefinition } from "@/types/connection";

const toastSuccess = vi.fn();
const toastError = vi.fn();

// Mock the Toast module itself (not the @/components/ui barrel): the barrel
// re-exports `toast` from here AND the async Button imports it directly from
// "./Toast", so mocking here captures both the editor's success toast and the
// Button's error-path toast that fires when handleSave rejects.
vi.mock("@/components/ui/Toast", async () => {
  const actual =
    await vi.importActual<typeof import("@/components/ui/Toast")>("@/components/ui/Toast");
  return {
    ...actual,
    toast: {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
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

function makeAgent(): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Production Server",
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
  };
}

let container: HTMLDivElement;
let root: Root;

function renderAgentDef() {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId="tab-agentdef-1"
          meta={{ connectionId: AGENT_ID, folderId: null, agentDefinitionId: "new" }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
}

function typeName(value: string) {
  const input = container.querySelector<HTMLInputElement>(
    '[data-testid="connection-editor-name-input"]'
  )!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function clickSave() {
  const btn = container.querySelector<HTMLButtonElement>('[data-testid="connection-editor-save"]')!;
  act(() => {
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

setupAgentsRegion();

describe("ConnectionEditor — agent-definition save feedback (#1342)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      credentialStoreStatus: { mode: "none", status: "unlocked" },
    });
    seedAgentsRegion({
      remoteAgents: [makeAgent()],
      agentDefinitions: { [AGENT_ID]: [] },
    });
    mockedInvoke.mockImplementation(() => Promise.resolve(false));
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("shows a success toast when the agent-definition save succeeds", async () => {
    const saveAgentDef = vi.fn(() => Promise.resolve());
    useAppStore.setState({ saveAgentDef });

    renderAgentDef();
    await flush();
    typeName("My Session");
    await flush();

    clickSave();
    await flush();

    expect(saveAgentDef).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("surfaces an error toast (not a silent failure) when the save rejects", async () => {
    const saveAgentDef = vi.fn(() => Promise.reject(new Error("agent unreachable")));
    useAppStore.setState({ saveAgentDef });

    renderAgentDef();
    await flush();
    typeName("My Session");
    await flush();

    clickSave();
    await flush();

    expect(saveAgentDef).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();
    // The async Button's error path surfaces the rejection instead of swallowing it.
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
