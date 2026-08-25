/**
 * Regression tests for the endless-reconnect-loop bug.
 *
 * When an agent/persistent session is destroyed and the user reconnects, the
 * Terminal must NOT reattach to the dead mount-time session id (captured once
 * in `initialSessionIdRef`). Reattaching to a corpse leaves the tab wired to a
 * non-existent session and the reconnect spins forever.
 *
 *  - Plain agent tab  → reconnect must create a brand-new session.
 *  - Persistent tab   → reconnect must restart the persistent session (via the
 *                       store) instead of reattaching to the dead id.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { setSessionBackendReattachEnabled } from "@/store/sessionBridge";
import { setupAgentsRegion, seedAgentsRegion } from "@/test/agentsRegionTestHarness";

// --- Mocks ---

vi.mock("@xterm/xterm", () => {
  class MockXTerm {
    open = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    onCursorMove = vi.fn(() => ({ dispose: vi.fn() }));
    onWriteParsed = vi.fn(() => ({ dispose: vi.fn() }));
    write = vi.fn((_data: unknown, cb?: () => void) => cb?.());
    writeln = vi.fn();
    reset = vi.fn();
    scrollToBottom = vi.fn();
    scrollLines = vi.fn();
    selectAll = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => "");
    attachCustomKeyEventHandler = vi.fn();
    unicode = { activeVersion: "6" };
    cols = 80;
    rows = 24;
    resize = vi.fn();
    focus = vi.fn();
    element = document.createElement("div");
    buffer = { active: { viewportY: 0, baseY: 0, length: 0, getLine: vi.fn() } };
    parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
    options = {};
  }
  return { Terminal: MockXTerm };
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
    dispose = vi.fn();
  }
  return { SearchAddon: MockSearchAddon };
});

vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockCreateTerminal = vi.fn().mockResolvedValue("fresh-session");
const mockGetAgentSessionBuffer = vi.fn().mockResolvedValue(new Uint8Array());

vi.mock("@/services/api", () => ({
  createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
  sendInput: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  detachPersistentTab: vi.fn().mockResolvedValue(0),
  getAgentSessionBuffer: (...args: unknown[]) => mockGetAgentSessionBuffer(...args),
}));

vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: vi.fn(() => vi.fn()),
    subscribeExit: vi.fn(() => vi.fn()),
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  // This suite exercises the client-redrive fallback (a reconnect calling
  // `create_connection` to mint a fresh session). Since #2205 PR-B flipped
  // `sessionBackendReattach` on by default, pin it OFF so the retained
  // instant-revert fallback path is what is under test here.
  setSessionBackendReattachEnabled(false);
  mockCreateTerminal.mockClear();
  mockCreateTerminal.mockResolvedValue("fresh-session");
  mockGetAgentSessionBuffer.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setSessionBackendReattachEnabled(null);
});

const AGENT_CONFIG = {
  type: "remote-session" as const,
  config: { agentId: "agent-1", sessionType: "shell" },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

setupAgentsRegion();

describe("Terminal — fresh session on reconnect", () => {
  it("does not reattach to the dead mount-time session; creates a fresh one on reconnect", async () => {
    // Agent is connected so a fresh session can be spawned immediately.
    seedAgentsRegion({
      remoteAgents: [
        {
          id: "agent-1",
          name: "Agent 1",
          config: {} as never,
          agentSettings: {} as never,
          connectionState: "connected",
          isExpanded: true,
        } as never,
      ],
    });

    // Mount with a session id (as if attached to an existing agent session).
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal
            tabId="tab-1"
            config={AGENT_CONFIG}
            isVisible={true}
            existingSessionId="dead-session"
          />
        </TerminalPortalProvider>
      );
    });
    await act(async () => {
      await wait(50);
    });

    // Initial mount reattaches to the existing session — no new session created.
    expect(mockCreateTerminal).not.toHaveBeenCalled();

    // User clicks "Reconnect" → bumps the retry counter.
    act(() => {
      useAppStore.getState().reconnectTerminal("tab-1");
    });
    await act(async () => {
      await wait(50);
    });

    // The reconnect must start a brand-new session rather than reattaching to
    // the dead "dead-session" id.
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
  });

  it("restarts the persistent session on reconnect instead of reattaching to the dead id", async () => {
    const restartSpy = vi.fn().mockResolvedValue("restarted-session");
    useAppStore.setState({
      restartPersistentSessionForTab: restartSpy as never,
    });
    seedAgentsRegion({
      remoteAgents: [
        {
          id: "agent-1",
          name: "Agent 1",
          config: {} as never,
          agentSettings: {} as never,
          connectionState: "connected",
          isExpanded: true,
        } as never,
      ],
    });

    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal
            tabId="tab-2"
            config={AGENT_CONFIG}
            isVisible={true}
            existingSessionId="dead-persistent"
            persistentConnectionId="agent-1:def-1"
          />
        </TerminalPortalProvider>
      );
    });
    await act(async () => {
      await wait(50);
    });

    act(() => {
      useAppStore.getState().reconnectTerminal("tab-2");
    });
    await act(async () => {
      await wait(50);
    });

    // Reconnect of a persistent tab must restart the persistent session through
    // the store (not create a leaking non-persistent session via createTerminal).
    expect(restartSpy).toHaveBeenCalledWith("tab-2");
    expect(mockCreateTerminal).not.toHaveBeenCalled();
  });

  it("clears the connecting overlay after a persistent reconnect reattaches", async () => {
    const restartSpy = vi.fn().mockResolvedValue("restarted-session");
    useAppStore.setState({
      restartPersistentSessionForTab: restartSpy as never,
    });
    seedAgentsRegion({
      remoteAgents: [
        {
          id: "agent-1",
          name: "Agent 1",
          config: {} as never,
          agentSettings: {} as never,
          connectionState: "connected",
          isExpanded: true,
        } as never,
      ],
    });

    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal
            tabId="tab-3"
            config={AGENT_CONFIG}
            isVisible={true}
            existingSessionId="dead-persistent"
            persistentConnectionId="agent-1:def-1"
          />
        </TerminalPortalProvider>
      );
    });
    await act(async () => {
      await wait(50);
    });

    // reconnectTerminal arms the "connecting" wall-clock deadline to show the
    // overlay at once (#2205 PR-B removed the synchronous local `terminalConnecting`
    // write; the connecting overlay is now driven by the projected status + the
    // connect deadline).
    act(() => {
      useAppStore.getState().reconnectTerminal("tab-3");
    });
    expect(useAppStore.getState().terminalConnectDeadline["tab-3"]?.kind).toBe("connecting");

    await act(async () => {
      await wait(80);
    });

    // Once the persistent session is restarted and reattached, the connecting
    // overlay must be cleared — otherwise SplitView keeps the overlay up, parks
    // the xterm element, and the tab is stuck on a "reconnecting" spinner.
    expect(useAppStore.getState().terminalConnectDeadline["tab-3"]).toBeFalsy();
  });
});
