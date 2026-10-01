/**
 * Characterization tests for the agent-session connect-failure catch in
 * {@link Terminal} (#3686, MT-AGENT-17/30).
 *
 * When `createTerminal` rejects for an agent-hosted tab, the catch decides what
 * the failure warrants from the agent transport state (`resolveAgentSpawnAction`)
 * and applies the effects. These tests pin the observable behaviour of the real
 * component (they were written against the inline catch before it moved into
 * `agentStateHandlers.applyAgentSpawnFailure`, and must keep passing after):
 *
 * - transport still (re)connecting → park the tab waiting for the agent;
 * - transport gone → park, re-establish the agent once (`connectRemoteAgent`);
 *   if that single reconnect fails, un-park and surface
 *   "Could not reconnect to agent: …" (MT-AGENT-17);
 * - typed auth failure → stop with the classified spawn error, no park.
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
import { DEFAULT_AGENT_SETTINGS, type RemoteAgentDefinition } from "@/types/connection";

// --- Mocks (mirror Terminal.backend-reattach.test.tsx) ---

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
const mockGetAgentSessionBuffer = vi.fn().mockResolvedValue(new Uint8Array());

vi.mock("@/services/api", () => ({
  createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
  sendInput: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
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
    clearPendingOutput: vi.fn(),
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
let connectRemoteAgent: ReturnType<typeof vi.fn>;
let setTerminalDisconnectWithError: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  mockCreateTerminal.mockReset();
  mockSubscribeOutput.mockClear();
  mockSubscribeExit.mockClear();
  setSessionTransportForTest(new FakeSessionTransport());
  connectRemoteAgent = vi.fn();
  setTerminalDisconnectWithError = vi.fn();
  useAppStore.setState({
    connectRemoteAgent: connectRemoteAgent as never,
    setTerminalDisconnectWithError: setTerminalDisconnectWithError as never,
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

const AGENT_ID = "agent-1";
const AGENT_CONFIG = {
  type: "remote-session" as const,
  config: { agentId: AGENT_ID, sessionType: "shell" },
};

function seedAgent(connectionState: RemoteAgentDefinition["connectionState"]): void {
  seedAgentsRegion({
    remoteAgents: [
      {
        id: AGENT_ID,
        name: "Test Agent",
        config: { host: "h", port: 22, username: "u", authMethod: "password" },
        connectionState,
        isExpanded: true,
        agentSettings: DEFAULT_AGENT_SETTINGS,
      },
    ],
  });
}

/** Add a fresh (never-connected) agent tab and mount its Terminal. */
function mountFreshAgentTab(): string {
  const tabId = useAppStore.getState().addTab("Agent Shell", "remote-session", AGENT_CONFIG, {
    contentType: "terminal",
  });
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal tabId={tabId} config={AGENT_CONFIG} isVisible={true} />
      </TerminalPortalProvider>
    );
  });
  return tabId;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(): Promise<void> {
  await act(async () => {
    await wait(60);
  });
}

describe("Terminal — agent connect-failure catch (#3686)", () => {
  it("parks the tab waiting for the agent while the transport is reconnecting", async () => {
    seedAgent("reconnecting");
    mockCreateTerminal.mockRejectedValue(new Error("Agent not connected"));

    const tabId = mountFreshAgentTab();
    await settle();

    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBe(AGENT_ID);
    expect(connectRemoteAgent).not.toHaveBeenCalled();
    expect(useAppStore.getState().terminalSpawnErrors[tabId]).toBeUndefined();
  });

  it("parks the tab waiting for the agent while the transport is still connecting", async () => {
    seedAgent("connecting");
    mockCreateTerminal.mockRejectedValue(new Error("Agent not connected"));

    const tabId = mountFreshAgentTab();
    await settle();

    expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBe(AGENT_ID);
    expect(connectRemoteAgent).not.toHaveBeenCalled();
  });

  it("re-establishes a destroyed agent connection once and stays parked (MT-AGENT-17)", async () => {
    seedAgent("disconnected");
    connectRemoteAgent.mockResolvedValue(undefined);
    mockCreateTerminal.mockRejectedValue(new Error("Agent not connected"));

    const tabId = mountFreshAgentTab();
    await settle();

    expect(connectRemoteAgent).toHaveBeenCalledTimes(1);
    expect(connectRemoteAgent).toHaveBeenCalledWith(AGENT_ID);
    // Parked until TerminalView wakes it on the agent's "connected" event.
    expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBe(AGENT_ID);
    expect(setTerminalDisconnectWithError).not.toHaveBeenCalled();
    // No client retry loop: a single createTerminal attempt.
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
  });

  it("surfaces the error after a single failed agent reconnect (MT-AGENT-17)", async () => {
    seedAgent("disconnected");
    connectRemoteAgent.mockRejectedValue(new Error("host unreachable"));
    mockCreateTerminal.mockRejectedValue(new Error("Agent not connected"));

    const tabId = mountFreshAgentTab();
    await settle();

    expect(connectRemoteAgent).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBeUndefined();
    expect(setTerminalDisconnectWithError).toHaveBeenCalledTimes(1);
    expect(setTerminalDisconnectWithError).toHaveBeenCalledWith(
      tabId,
      "Could not reconnect to agent: host unreachable"
    );
  });

  it("does not clobber a tab no longer parked when the agent reconnect fails", async () => {
    seedAgent("disconnected");
    let rejectConnect: (e: unknown) => void = () => {};
    connectRemoteAgent.mockImplementation(
      () => new Promise<void>((_, reject) => (rejectConnect = reject))
    );
    mockCreateTerminal.mockRejectedValue(new Error("Agent not connected"));

    const tabId = mountFreshAgentTab();
    await settle();
    expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBe(AGENT_ID);

    // Another path un-parked the tab before the reconnect settled.
    act(() => useAppStore.getState().setTerminalWaitingForAgent(tabId, null));
    await act(async () => {
      rejectConnect(new Error("late failure"));
      await wait(10);
    });

    expect(setTerminalDisconnectWithError).not.toHaveBeenCalled();
  });

  it("stops on a typed auth failure without parking or reconnecting", async () => {
    seedAgent("connected");
    mockCreateTerminal.mockRejectedValue({ code: "auth_failed", message: "Authentication failed" });

    const tabId = mountFreshAgentTab();
    await settle();

    expect(connectRemoteAgent).not.toHaveBeenCalled();
    expect(useAppStore.getState().terminalWaitingForAgent[tabId]).toBeUndefined();
    expect(useAppStore.getState().terminalSpawnErrors[tabId]).toBeTruthy();
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
  });
});
