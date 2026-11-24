/**
 * Regression test for #5907: an agent's session list must follow its tabs.
 *
 * The agent row listed its live sessions only from the once-per-connect
 * refresh, so a shell opened on an already-connected agent left the row
 * reading "No sessions" while the tab was live. Starting an agent session now
 * refreshes that agent's list, and so does ending one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { setSessionTransportForTest, stopSessionSubscription } from "@/store/sessionBridge";
import { FakeSessionTransport } from "@/test/sessionLifecycleRegionTestHarness";
import { seedAgentsRegion, setupAgentsRegion } from "@/test/agentsRegionTestHarness";
import { DEFAULT_AGENT_SETTINGS } from "@/types/connection";

vi.mock("@xterm/xterm", async () => {
  const { createMockXtermModule } = await import("@/test/mockXterm");
  return createMockXtermModule();
});

vi.mock("@xterm/addon-fit", () => {
  class MockFitAddon {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    dispose = vi.fn();
  }
  return { FitAddon: MockFitAddon };
});

vi.mock("@xterm/addon-unicode11", () => {
  class MockUnicode11Addon {
    dispose = vi.fn();
  }
  return { Unicode11Addon: MockUnicode11Addon };
});

vi.mock("@xterm/addon-search", () => {
  class MockSearchAddon {
    onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
  }
  return { SearchAddon: MockSearchAddon };
});

vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockCreateTerminal = vi.fn();
const mockGetAgentSessionBuffer = vi
  .fn()
  .mockResolvedValue({ data: new Uint8Array(), endOffset: 0, epoch: 1 });
const mockCloseTerminal = vi.fn().mockResolvedValue(undefined);

vi.mock("@/services/api", () => ({
  createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
  sendInput: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: (...args: unknown[]) => mockCloseTerminal(...args),
  detachPersistentTab: vi.fn().mockResolvedValue(0),
  getAgentSessionBuffer: (...args: unknown[]) => mockGetAgentSessionBuffer(...args),
  sessionGetCapabilities: vi.fn().mockResolvedValue({}),
}));

const mockSubscribeOutput = vi.fn(() => vi.fn());
const mockSubscribeExit = vi.fn(() => vi.fn());

vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: (...args: unknown[]) => mockSubscribeOutput(...(args as [])),
    subscribeExit: (...args: unknown[]) => mockSubscribeExit(...(args as [])),
    clearPendingExit: vi.fn(),
    holdOutput: () => ({ drain: () => [], release: vi.fn() }),
  },
}));

vi.mock("@/services/keybindings", () => ({
  processKeyEvent: vi.fn(() => null),
  isAppShortcut: vi.fn(() => false),
  isChordPending: vi.fn(() => false),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: vi.fn().mockResolvedValue(""),
}));

globalThis.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

setupAgentsRegion();

let container: HTMLDivElement;
let root: Root;
let refreshAgentSessions: ReturnType<typeof vi.fn>;

const AGENT_ID = "agent-1";

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  mockCreateTerminal.mockReset();
  mockCloseTerminal.mockClear();
  setSessionTransportForTest(new FakeSessionTransport());
  refreshAgentSessions = vi.fn().mockResolvedValue(undefined);
  useAppStore.setState({ refreshAgentSessions: refreshAgentSessions as never });
  seedAgentsRegion({
    remoteAgents: [
      {
        id: AGENT_ID,
        name: "Test Agent",
        config: { host: "h", port: 22, username: "u", authMethod: "password" },
        connectionState: "connected",
        isExpanded: true,
        agentSettings: DEFAULT_AGENT_SETTINGS,
      },
    ],
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  stopSessionSubscription();
  setSessionTransportForTest(null);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(): Promise<void> {
  await act(async () => {
    await wait(60);
  });
}

function mount(config: { type: string; config: Record<string, unknown> }): void {
  const tabId = useAppStore.getState().addTab("Shell", config.type, config as never, {
    contentType: "terminal",
  });
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal tabId={tabId} config={config as never} isVisible={true} />
      </TerminalPortalProvider>
    );
  });
}

describe("Terminal — the agent's session list follows its tabs (#5907)", () => {
  it("refreshes the agent's sessions once a session on it starts", async () => {
    mockCreateTerminal.mockResolvedValue("session-1");
    mount({ type: "remote-session", config: { agentId: AGENT_ID, sessionType: "shell" } });
    await settle();

    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
    expect(refreshAgentSessions).toHaveBeenCalledWith(AGENT_ID);
  });

  it("refreshes the agent's sessions again once its tab closes the session", async () => {
    mockCreateTerminal.mockResolvedValue("session-1");
    mount({ type: "remote-session", config: { agentId: AGENT_ID, sessionType: "shell" } });
    await settle();
    refreshAgentSessions.mockClear();

    act(() => root.unmount());
    await settle();

    expect(mockCloseTerminal).toHaveBeenCalledWith("session-1");
    expect(refreshAgentSessions).toHaveBeenCalledWith(AGENT_ID);
    root = createRoot(container);
  });

  it("leaves agent lists alone for a direct session", async () => {
    mockCreateTerminal.mockResolvedValue("session-2");
    mount({ type: "local", config: {} });
    await settle();

    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
    expect(refreshAgentSessions).not.toHaveBeenCalled();
  });
});
