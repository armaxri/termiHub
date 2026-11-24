/**
 * #5953: the tab's Reconnect after a user agent Disconnect.
 *
 * A user Disconnect detaches the agent's sessions and ends the tab with a
 * Reconnect. That reconnect connects through the client (not the backend
 * redrive), so before the fix the tab skipped its own scrollback snapshot as if
 * the agent would re-forward it, and wrote no reconnect marker: the tab came
 * back with only the new shell's banner. Now it keeps its scrollback and says
 * what happened — "new remote shell" for a new session, "session resumed" when
 * the backend re-attached the tab's own session (then the session's own buffer
 * repaints the tab and its live re-forward is discarded).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import {
  clearAgentDisconnectIntent,
  markAgentDisconnectIntent,
} from "@/store/agentDisconnectIntent";
import { setSessionTransportForTest, stopSessionSubscription } from "@/store/sessionBridge";
import {
  FakeSessionTransport,
  connected as connectedLifecycle,
  disconnected,
} from "@/test/sessionLifecycleRegionTestHarness";
import { mockXtermInstances as xtermInstances } from "@/test/mockXterm";

// The distinctive serialized snapshot the SerializeAddon mock returns, so a test
// can prove whether the fresh xterm replayed the previous instance's local buffer.
const SERIALIZED_SCROLLBACK = "\x1b[32mlocal scrollback snapshot\x1b[0m\r\n";

// Every xterm instance created, in order, with its write() spy — so a test can
// inspect what the fresh (final) instance rendered. The shared mock records each
// constructed instance in `mockXtermInstances`.
vi.mock("@xterm/xterm", async () => (await import("@/test/mockXterm")).createMockXtermModule());
vi.mock("@xterm/addon-fit", () => {
  class M {
    fit = vi.fn();
    proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
    dispose = vi.fn();
  }
  return { FitAddon: M };
});
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class {
    dispose = vi.fn();
  },
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
  },
}));
// Return the distinctive snapshot so the teardown captures it and any local
// replay is observable on the fresh instance's write spy.
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class {
    serialize = vi.fn(() => SERIALIZED_SCROLLBACK);
    dispose = vi.fn();
  },
}));
vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockCreateTerminal = vi.fn().mockResolvedValue("fresh-session");
const mockGetAgentSessionBuffer = vi.fn().mockResolvedValue(new Uint8Array());
const mockTakeResumed = vi.fn().mockResolvedValue(false);
vi.mock("@/services/api", () => ({
  createTerminal: (...a: unknown[]) => mockCreateTerminal(...a),
  cancelConnecting: vi.fn().mockResolvedValue(undefined),
  sendInput: vi.fn().mockResolvedValue(undefined),
  setSessionLineEnding: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  detachPersistentTab: vi.fn().mockResolvedValue(0),
  getAgentSessionBuffer: (...a: unknown[]) => mockGetAgentSessionBuffer(...a),
  takeResumedAgentSession: (...a: unknown[]) => mockTakeResumed(...a),
  replaySessionScrollback: vi.fn().mockResolvedValue(new Uint8Array()),
  sessionGetCapabilities: vi.fn().mockResolvedValue({}),
}));

// Capture the live-output callback the terminal subscribes with, keyed by session
// id, so a test can deliver the agent's re-forwarded ring buffer as output.
const outputCallbacks: Record<string, (data: Uint8Array) => void> = {};
const mockSubscribeOutput = vi.fn((sid: string, cb: (data: Uint8Array) => void) => {
  outputCallbacks[sid] = cb;
  return vi.fn();
});
// The exit callback per session, so a test can end a session (#5959).
const exitCallbacks: Record<string, (code: number | null, cause?: unknown) => void> = {};
const mockSubscribeExit = vi.fn(
  (sid: string, cb: (code: number | null, cause?: unknown) => void) => {
    exitCallbacks[sid] = cb;
    return vi.fn();
  }
);
const mockClearPendingOutput = vi.fn();
vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: (...a: unknown[]) => mockSubscribeOutput(...(a as [string, () => void])),
    subscribeExit: (...a: unknown[]) =>
      mockSubscribeExit(...(a as [string, (code: number | null) => void])),
    clearPendingExit: vi.fn(),
    clearPendingOutput: (...a: unknown[]) => mockClearPendingOutput(...(a as [])),
  },
}));
vi.mock("@/services/keybindings", () => ({
  processKeyEvent: vi.fn(() => null),
  isAppShortcut: vi.fn(() => false),
  isChordPending: vi.fn(() => false),
  isShellReservedKey: vi.fn(() => false),
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
let transport: FakeSessionTransport;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  mockCreateTerminal.mockClear();
  mockCreateTerminal.mockResolvedValue("fresh-session");
  mockGetAgentSessionBuffer.mockClear();
  mockGetAgentSessionBuffer.mockResolvedValue(new Uint8Array());
  mockTakeResumed.mockReset();
  mockTakeResumed.mockResolvedValue(false);
  mockSubscribeOutput.mockClear();
  mockSubscribeExit.mockClear();
  mockClearPendingOutput.mockClear();
  for (const key of Object.keys(outputCallbacks)) delete outputCallbacks[key];
  xtermInstances.length = 0;
  transport = new FakeSessionTransport();
  setSessionTransportForTest(transport);
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

const AGENT_CONFIG = {
  type: "remote-session" as const,
  config: { agentId: "agent-1", sessionType: "shell" },
};
function addAgentTab(sessionId: string): string {
  return useAppStore.getState().addTab("Agent Shell", "remote-session", AGENT_CONFIG, {
    contentType: "terminal",
    sessionId,
  });
}
const mount = (tabId: string, existingSessionId: string) => {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal
          tabId={tabId}
          config={AGENT_CONFIG}
          isVisible={true}
          existingSessionId={existingSessionId}
        />
      </TerminalPortalProvider>
    );
  });
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The user's agent Disconnect ends the tab; its Reconnect connects again. */
async function disconnectAndReconnect(tabId: string) {
  act(() => {
    useAppStore.getState().setTerminalAgentDisconnected(tabId);
    transport.setSession(tabId, disconnected("user"));
  });
  await act(async () => {
    await wait(30);
  });
  act(() => {
    useAppStore.getState().reconnectTerminal(tabId);
  });
  await act(async () => {
    await wait(120);
  });
}

async function mountConnected(): Promise<string> {
  const tabId = addAgentTab("S1");
  transport.setSession(tabId, connectedLifecycle());
  mount(tabId, "S1");
  await act(async () => {
    await wait(50);
  });
  return tabId;
}

function written(instance: (typeof xtermInstances)[number]): string[] {
  return instance.writeln.mock.calls.map((call) => String(call[0]));
}

describe("Terminal — agent tab Reconnect after a user Disconnect (#5953)", () => {
  it("keeps the scrollback and marks a new remote shell", async () => {
    const tabId = await mountConnected();

    await disconnectAndReconnect(tabId);

    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
    expect(mockTakeResumed).toHaveBeenCalledWith("fresh-session");
    const fresh = xtermInstances[xtermInstances.length - 1];
    expect(fresh.write.mock.calls.some((call) => call[0] === SERIALIZED_SCROLLBACK)).toBe(true);
    expect(written(fresh).some((line) => line.includes("new remote shell"))).toBe(true);
    expect(fresh.reset).not.toHaveBeenCalled();
  });

  it("repaints a resumed session from its own buffer and says so", async () => {
    const tabId = await mountConnected();
    const buffer = new TextEncoder().encode("$ echo before\r\nbefore\r\n");
    mockTakeResumed.mockResolvedValue(true);
    mockGetAgentSessionBuffer.mockResolvedValue(buffer);

    await disconnectAndReconnect(tabId);

    const fresh = xtermInstances[xtermInstances.length - 1];
    expect(mockGetAgentSessionBuffer).toHaveBeenCalledWith("fresh-session");
    expect(fresh.reset).toHaveBeenCalled();
    expect(fresh.write.mock.calls.some((call) => call[0] === buffer)).toBe(true);
    const lines = written(fresh);
    expect(lines.some((line) => line.includes("session resumed"))).toBe(true);
    expect(lines.some((line) => line.includes("new remote shell"))).toBe(false);
    // The daemon's live re-forward of the same buffer is dropped.
    expect(mockClearPendingOutput).toHaveBeenCalledWith("fresh-session");
  });
});

describe("Terminal — the line a user agent Disconnect leaves (#5959)", () => {
  it("writes 'disconnected by you', not 'connection lost'", async () => {
    await mountConnected();
    markAgentDisconnectIntent("agent-1");
    try {
      act(() => {
        exitCallbacks["S1"]?.(null, null);
      });
    } finally {
      clearAgentDisconnectIntent("agent-1");
    }
    const lines = written(xtermInstances[xtermInstances.length - 1]);
    expect(lines.some((line) => line.includes("disconnected by you"))).toBe(true);
    expect(lines.some((line) => line.includes("connection lost"))).toBe(false);
  });

  it("still says 'connection lost' for a real drop", async () => {
    await mountConnected();
    act(() => {
      exitCallbacks["S1"]?.(null, null);
    });
    const lines = written(xtermInstances[xtermInstances.length - 1]);
    expect(lines.some((line) => line.includes("connection lost"))).toBe(true);
  });
});
