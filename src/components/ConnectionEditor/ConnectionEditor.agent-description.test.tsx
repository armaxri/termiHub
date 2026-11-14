import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store/appStore";
import { setupConnectionsRegion } from "@/test/connectionsHarness";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";
import { resetRuntimeCache } from "@/hooks/useAvailableRuntimes";
import { ConnectionEditor } from "./ConnectionEditor";
import { TooltipProvider } from "@/components/ui";
import type { RemoteAgentDefinition } from "@/types/connection";
import { DEFAULT_AGENT_SETTINGS } from "@/types/connection";

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

// ResizeObserver is not available in jsdom
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mockedInvoke = vi.mocked(invoke);

const AGENT_ID = "agent-desc";

function makeAgent(): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Lab Agent",
    description: "Old note",
    config: {
      host: "host.example.com",
      port: 22,
      username: "user",
      authMethod: "password",
    },
    connectionState: "disconnected",
    isExpanded: false,
    agentSettings: DEFAULT_AGENT_SETTINGS,
  };
}

setupSettingsRegion();
setupConnectionsRegion();
setupAgentsRegion();

describe("ConnectionEditor — remote agent description (#5770)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetRuntimeCache();
    mockedInvoke.mockImplementation((cmd) => {
      if (cmd === "check_docker_available") return Promise.resolve(false);
      if (cmd === "check_podman_available") return Promise.resolve(false);
      if (cmd === "resolve_credential") return Promise.resolve(null);
      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function flush() {
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  it("pre-fills the agent's description and saves the edit as one line", async () => {
    seedAgentsRegion({ remoteAgents: [makeAgent()] });
    const updateRemoteAgent = vi.fn();
    useAppStore.setState({ updateRemoteAgent });

    act(() => {
      root.render(
        <TooltipProvider>
          <ConnectionEditor
            tabId="tab-agent-desc"
            meta={{ connectionId: AGENT_ID, folderId: null }}
            isVisible={true}
          />
        </TooltipProvider>
      );
    });
    await flush();

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="connection-editor-description-input"]'
    );
    expect(input).not.toBeNull();
    expect(input!.value).toBe("Old note");
    expect(input!.getAttribute("maxlength")).toBe("80");

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "  Lab   bench ");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="connection-editor-save"]')!.click();
    });
    await flush();

    expect(updateRemoteAgent).toHaveBeenCalledTimes(1);
    const saved = updateRemoteAgent.mock.calls[0][0] as RemoteAgentDefinition;
    expect(saved.description).toBe("Lab bench");
  });
});
