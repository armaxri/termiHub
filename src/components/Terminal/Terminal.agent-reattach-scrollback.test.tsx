/**
 * Regression tests for the duplicate-scrollback bug on a backend-driven AGENT
 * re-attach (#2512 / #2515 hardening).
 *
 * When a resilient agent-hosted tab's transport drops and the backend re-attaches
 * the SAME live agent session (#2512), the agent daemon replays its ring buffer as
 * live `connection.output` (`MSG_BUFFER_REPLAY`) to bring the reattached reader up
 * to date. So the server is the authoritative source of the recovered scrollback.
 *
 * The terminal-creation effect ALSO serializes the pre-drop xterm's scrollback on
 * teardown and replays it into the fresh xterm on the reconnect re-run (#1126), so
 * a failed direct reconnect still shows history under the overlay. That local
 * replay must be skipped whenever the server re-supplies the buffer — otherwise the
 * recovered scrollback renders twice (and compounds across reconnect attempts to
 * 3×, as observed live). The persistent-tab path already skips it via
 * `persistentConnectionId`; a backend-driven agent reconnect has NO
 * `persistentConnectionId` but likewise re-attaches to a server session, so it must
 * skip the local snapshot too.
 *
 * These tests drive the reconnect end-to-end via projected region diffs (the path
 * a live agent drop takes) and assert the recovered scrollback is applied to the
 * fresh terminal exactly once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import {
  setSessionBackendReattachEnabled,
  setSessionTransportForTest,
  setSessionIntentsEnabled,
  setSessionRenderFromProjectionEnabled,
  stopSessionSubscription,
} from "@/store/sessionBridge";
import {
  FakeSessionTransport,
  connected as connectedLifecycle,
  reconnecting,
} from "@/test/sessionLifecycleRegionTestHarness";

// The distinctive serialized snapshot the SerializeAddon mock returns, so a test
// can prove whether the fresh xterm replayed the previous instance's local buffer.
const SERIALIZED_SCROLLBACK = "\x1b[32mlocal scrollback snapshot\x1b[0m\r\n";

// Every xterm instance created, in order, with its write() spy — so a test can
// inspect what the fresh (final) instance rendered.
interface TrackedXTerm {
  write: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}
const xtermInstances: TrackedXTerm[] = [];

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
    write = vi.fn((_d: unknown, cb?: () => void) => cb?.());
    writeln = vi.fn();
    reset = vi.fn();
    refresh = vi.fn();
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
    constructor() {
      xtermInstances.push({ write: this.write, dispose: this.dispose });
    }
  }
  return { Terminal: MockXTerm };
});
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
vi.mock("@/services/api", () => ({
  createTerminal: (...a: unknown[]) => mockCreateTerminal(...a),
  cancelConnecting: vi.fn().mockResolvedValue(undefined),
  sendInput: vi.fn().mockResolvedValue(undefined),
  setSessionLineEnding: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  detachPersistentTab: vi.fn().mockResolvedValue(0),
  getAgentSessionBuffer: (...a: unknown[]) => mockGetAgentSessionBuffer(...a),
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
const mockSubscribeExit = vi.fn(() => vi.fn());
const mockClearPendingOutput = vi.fn();
vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: (...a: unknown[]) => mockSubscribeOutput(...(a as [string, () => void])),
    subscribeExit: (...a: unknown[]) => mockSubscribeExit(...(a as [])),
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
  mockSubscribeOutput.mockClear();
  mockSubscribeExit.mockClear();
  mockClearPendingOutput.mockClear();
  for (const key of Object.keys(outputCallbacks)) delete outputCallbacks[key];
  xtermInstances.length = 0;
  transport = new FakeSessionTransport();
  setSessionTransportForTest(transport);
  setSessionIntentsEnabled(true);
  setSessionRenderFromProjectionEnabled(true);
  setSessionBackendReattachEnabled(true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  stopSessionSubscription();
  setSessionTransportForTest(null);
  setSessionBackendReattachEnabled(null);
  setSessionIntentsEnabled(null);
  setSessionRenderFromProjectionEnabled(null);
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

/**
 * Drive a full backend-driven agent drop → reconnect → re-attach to a fresh
 * backend session id (`newSessionId`), via projected region diffs — exactly the
 * sequence the resume path (`Terminal.agent-reconnect-resume.test.tsx`) exercises,
 * which tears down the pre-drop xterm and re-runs the terminal effect.
 */
async function driveReattach(tabId: string, newSessionId: string) {
  act(() => {
    useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
  });
  await act(async () => {
    await wait(20);
  });
  act(() => {
    transport.setSession(tabId, reconnecting({ phase: "waiting", attempt: 0, delayMs: 1000 }));
  });
  await act(async () => {
    await wait(20);
  });
  act(() => {
    transport.setSession(tabId, reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 }));
  });
  await act(async () => {
    await wait(50);
  });
  act(() => {
    transport.setSession(tabId, { ...connectedLifecycle(), sessionId: newSessionId });
  });
  await act(async () => {
    await wait(80);
  });
}

describe("Terminal — backend-driven agent re-attach must not duplicate scrollback (#2512/#2515)", () => {
  it("does NOT replay the local scrollback snapshot on re-attach (the agent re-forwards it)", async () => {
    const tabId = addAgentTab("S1");
    transport.setSession(tabId, connectedLifecycle());
    mount(tabId, "S1");
    await act(async () => {
      await wait(50);
    });
    expect(mockCreateTerminal).not.toHaveBeenCalled(); // initial mount re-attaches

    await driveReattach(tabId, "S2");

    // The reconnect re-ran the effect: a fresh xterm exists and the pre-drop one
    // was disposed.
    expect(xtermInstances.length).toBeGreaterThan(1);
    // Terminal I/O re-attached to the backend-published id.
    expect(mockSubscribeOutput).toHaveBeenCalledWith("S2", expect.any(Function));

    // The fresh instance must NOT have replayed the local serialized snapshot: the
    // agent daemon re-forwards the ring buffer as live output on re-attach, so a
    // local replay would render the recovered scrollback a second time. Before the
    // fix the snapshot IS written here (only `persistentConnectionId` tabs skipped
    // it), duplicating the scrollback.
    const fresh = xtermInstances[xtermInstances.length - 1];
    const replayedLocalSnapshot = fresh.write.mock.calls.some(
      (call) => call[0] === SERIALIZED_SCROLLBACK
    );
    expect(replayedLocalSnapshot).toBe(false);
  });

  it("renders the agent's re-forwarded ring buffer exactly once", async () => {
    const tabId = addAgentTab("S1");
    transport.setSession(tabId, connectedLifecycle());
    mount(tabId, "S1");
    await act(async () => {
      await wait(50);
    });

    await driveReattach(tabId, "S2");
    expect(mockSubscribeOutput).toHaveBeenCalledWith("S2", expect.any(Function));

    // The agent replays its ring buffer as one live output chunk after re-attach.
    const serverBuffer = new TextEncoder().encode("shell banner\r\n$ echo hello\r\nhello\r\n");
    act(() => {
      outputCallbacks["S2"]?.(serverBuffer);
    });
    await act(async () => {
      await wait(40);
    });

    const fresh = xtermInstances[xtermInstances.length - 1];
    const bufferWrites = fresh.write.mock.calls.filter((call) => call[0] === serverBuffer);
    expect(bufferWrites).toHaveLength(1);
    // And the local snapshot never rode alongside it.
    const snapshotWrites = fresh.write.mock.calls.filter(
      (call) => call[0] === SERIALIZED_SCROLLBACK
    );
    expect(snapshotWrites).toHaveLength(0);
  });

  it("wires the re-attached session's output exactly once (no double-attach)", async () => {
    const tabId = addAgentTab("S1");
    transport.setSession(tabId, connectedLifecycle());
    mount(tabId, "S1");
    await act(async () => {
      await wait(50);
    });

    await driveReattach(tabId, "S2");

    const s2Subscribes = mockSubscribeOutput.mock.calls.filter((call) => call[0] === "S2");
    expect(s2Subscribes).toHaveLength(1);
    // No fresh session was minted — the same live agent session was re-attached.
    expect(mockCreateTerminal).not.toHaveBeenCalled();
  });

  it("flag OFF: still replays the local snapshot on reconnect (develop parity)", async () => {
    setSessionBackendReattachEnabled(false);
    const tabId = addAgentTab("S1");
    mount(tabId, "S1");
    await act(async () => {
      await wait(50);
    });

    // Flag off ⇒ no backend-driven re-attach: the client redrive owns the
    // reconnect and mints a fresh session, so the local snapshot is the ONLY source
    // of the pre-drop scrollback and must still be replayed (unchanged from develop).
    act(() => {
      useAppStore.getState().reconnectTerminal(tabId);
    });
    await act(async () => {
      await wait(60);
    });

    expect(xtermInstances.length).toBeGreaterThan(1);
    const fresh = xtermInstances[xtermInstances.length - 1];
    const replayedLocalSnapshot = fresh.write.mock.calls.some(
      (call) => call[0] === SERIALIZED_SCROLLBACK
    );
    expect(replayedLocalSnapshot).toBe(true);
  });
});
