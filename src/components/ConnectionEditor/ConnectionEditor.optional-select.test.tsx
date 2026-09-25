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

/**
 * Regression for #3298: `AGENT_SCHEMA.updateStrategy` is an optional select
 * (`required: false`, default "immediate"), but `remoteAgentConfigToRecord`
 * only emits it when set. `settingsSchemaToZod` used to map every select to a
 * bare `z.string()`, so editing an existing agent whose stored config lacked
 * the key left the form invalid and Save silently disabled.
 */

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

const AGENT_ID = "agent-legacy";

/** A remote agent saved before `updateStrategy` existed — the key is absent. */
function makeLegacyAgent(): RemoteAgentDefinition {
  return {
    id: AGENT_ID,
    name: "Legacy Agent",
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

describe("ConnectionEditor — optional select absent from stored agent config (#3298)", () => {
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

  it("keeps Save enabled and saves the agent without inventing an updateStrategy", async () => {
    const legacy = makeLegacyAgent();
    expect("updateStrategy" in legacy.config).toBe(false);
    seedAgentsRegion({ remoteAgents: [legacy] });

    const updateRemoteAgent = vi.fn();
    useAppStore.setState({ updateRemoteAgent });

    act(() => {
      root.render(
        <TooltipProvider>
          <ConnectionEditor
            tabId="tab-optional-select"
            meta={{ connectionId: AGENT_ID, folderId: null }}
            isVisible={true}
          />
        </TooltipProvider>
      );
    });
    await flush();

    const save = container.querySelector(
      '[data-testid="connection-editor-save"]'
    ) as HTMLButtonElement | null;
    expect(save).not.toBeNull();
    expect(save!.getAttribute("data-invalid")).toBeNull();
    expect(save!.getAttribute("aria-disabled")).not.toBe("true");

    await act(async () => {
      save!.click();
    });
    await flush();

    expect(updateRemoteAgent).toHaveBeenCalledTimes(1);
    const saved = updateRemoteAgent.mock.calls[0][0] as RemoteAgentDefinition;
    expect(saved.id).toBe(AGENT_ID);
    expect(saved.config.host).toBe("host.example.com");
    // Payload shape unchanged for existing configs: the absent key stays absent.
    expect("updateStrategy" in saved.config).toBe(false);
  });
});
