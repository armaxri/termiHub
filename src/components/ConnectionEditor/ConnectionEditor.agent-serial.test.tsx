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
// The Port field of an agent-hosted serial definition rescans the agent's
// ports (#5069) — but only on an agent advertising `serialPortRescan`; an
// older agent keeps its connect-time `availableSerialPorts` snapshot.
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderEditor(agentId: string): void {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <ConnectionEditor
          tabId="tab-agent-serial"
          meta={{ connectionId: agentId, folderId: null, agentDefinitionId: "def-serial" }}
          isVisible={true}
        />
      </TooltipProvider>
    );
  });
}

function makeAgent(serialPortRescan: boolean): RemoteAgentDefinition {
  return {
    id: "agent-1",
    name: "Lab Agent",
    config: { host: "lab.example.com", port: 22, username: "user", authMethod: "password" },
    connectionState: "connected",
    isExpanded: true,
    agentSettings: DEFAULT_AGENT_SETTINGS,
    capabilities: {
      connectionTypes: [
        {
          typeId: "serial",
          displayName: "Serial",
          icon: "serial",
          schema: {
            groups: [
              {
                key: "general",
                label: "General",
                fields: [
                  {
                    key: "port",
                    label: "Port",
                    fieldType: { type: "serialPort" },
                    required: false,
                  },
                ],
              },
            ],
          },
          capabilities: { monitoring: false, fileBrowser: false, resize: false, persistent: true },
        },
      ],
      maxSessions: 10,
      availableShells: [],
      availableSerialPorts: ["/dev/ttyUSB0"],
      availableDockerImages: [],
      serialPortRescan,
    },
  };
}

function seedAgent(serialPortRescan: boolean): RemoteAgentDefinition {
  const agent = makeAgent(serialPortRescan);
  seedAgentsRegion({
    remoteAgents: [agent],
    agentDefinitions: {
      [agent.id]: [
        {
          id: "def-serial",
          name: "Console",
          sessionType: "serial",
          config: { port: "/dev/ttyUSB0" },
          persistent: false,
          folderId: null,
        },
      ],
    },
  });
  return agent;
}

function serialCalls(cmd: string): unknown[][] {
  return mockedInvoke.mock.calls.filter(([c]) => c === cmd);
}

function portOptions(): string[] {
  const input = q("field-port") as HTMLInputElement;
  const list = container.querySelector(`#${input.getAttribute("list")}`) as HTMLDataListElement;
  return Array.from(list.options).map((o) => o.value);
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
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation((cmd) => {
    if (cmd === "list_agent_serial_ports") {
      return Promise.resolve({ supported: true, ports: ["/dev/ttyUSB0", "/dev/ttyUSB1"] });
    }
    if (cmd === "resolve_credential") return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ConnectionEditor agent-hosted serial Port field (#5069)", () => {
  it("rescans the agent's ports when the agent advertises serialPortRescan", async () => {
    const agent = seedAgent(true);
    renderEditor(agent.id);
    await flush();
    await flush();

    expect(serialCalls("list_agent_serial_ports")).toEqual([
      ["list_agent_serial_ports", { agentId: agent.id }],
    ]);
    expect(serialCalls("list_serial_ports")).toEqual([]);
    expect(portOptions()).toEqual(["/dev/ttyUSB0", "/dev/ttyUSB1"]);
  });

  it("keeps the connect-time snapshot for an older agent", async () => {
    const agent = seedAgent(false);
    renderEditor(agent.id);
    await flush();
    await flush();

    expect(serialCalls("list_agent_serial_ports")).toEqual([]);
    expect(serialCalls("list_serial_ports")).toEqual([]);
    expect(portOptions()).toEqual(["/dev/ttyUSB0"]);
  });
});
