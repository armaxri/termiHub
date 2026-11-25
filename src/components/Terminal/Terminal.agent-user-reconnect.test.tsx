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
import type { OutputPosition } from "@/services/events";
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
import { resumedMarker } from "./dropCopy";
import { mockXtermInstances as xtermInstances } from "@/test/mockXterm";

// The distinctive serialized snapshot the SerializeAddon mock returns, so a test
// can prove whether the fresh xterm replayed the previous instance's local buffer.
const SERIALIZED_SCROLLBACK = "\x1b[32mlocal scrollback snapshot\x1b[0m\r\n";

// Every xterm instance created, in order, with its write() spy — so a test can
// inspect what the fresh (final) instance rendered. The shared mock records each
// constructed instance in `mockXtermInstances`.
const inputFrom = vi.hoisted(() => ({ user: true }));
vi.mock("./xtermUserInput", () => ({
  trackUserInput: () => ({ take: () => inputFrom.user, dispose: () => undefined }),
}));
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
const mockGetAgentSessionBuffer = vi
  .fn()
  .mockResolvedValue({ data: new Uint8Array(), endOffset: 0, epoch: 1, coming: false });
const mockSetLineEnding = vi.fn().mockResolvedValue(undefined);
const mockReplayScrollback = vi.fn();
const mockSendInput = vi.fn().mockResolvedValue(undefined);
const mockTakeResumed = vi.fn().mockResolvedValue(false);
vi.mock("@/services/api", () => ({
  createTerminal: (...a: unknown[]) => mockCreateTerminal(...a),
  cancelConnecting: vi.fn().mockResolvedValue(undefined),
  sendInput: (...a: unknown[]) => mockSendInput(...a),
  setSessionLineEnding: (...a: unknown[]) => mockSetLineEnding(...a),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  detachPersistentTab: vi.fn().mockResolvedValue(0),
  getAgentSessionBuffer: (...a: unknown[]) => mockGetAgentSessionBuffer(...a),
  takeResumedAgentSession: (...a: unknown[]) => mockTakeResumed(...a),
  replaySessionScrollback: (...a: unknown[]) => mockReplayScrollback(...a),
  sessionGetCapabilities: vi.fn().mockResolvedValue({}),
}));

// Capture the live-output callback the terminal subscribes with, keyed by session
// id, so a test can deliver the agent's re-forwarded ring buffer as output.
const outputCallbacks: Record<string, (data: Uint8Array, position: OutputPosition) => void> = {};
const mockSubscribeOutput = vi.fn(
  (sid: string, cb: (data: Uint8Array, position: OutputPosition) => void) => {
    outputCallbacks[sid] = cb;
    return vi.fn();
  }
);
// The exit callback per session, so a test can end a session (#5959).
const exitCallbacks: Record<string, (code: number | null, cause?: unknown) => void> = {};
const mockSubscribeExit = vi.fn(
  (sid: string, cb: (code: number | null, cause?: unknown) => void) => {
    exitCallbacks[sid] = cb;
    return vi.fn();
  }
);
vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: (...a: unknown[]) => mockSubscribeOutput(...(a as [string, () => void])),
    subscribeExit: (...a: unknown[]) =>
      mockSubscribeExit(...(a as [string, (code: number | null) => void])),
    clearPendingExit: vi.fn(),
    holdOutput: () => ({ drain: () => [], release: vi.fn() }),
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
  mockGetAgentSessionBuffer.mockResolvedValue({
    data: new Uint8Array(),
    endOffset: 0,
    epoch: 1,
    coming: false,
  });
  mockTakeResumed.mockReset();
  mockTakeResumed.mockResolvedValue(false);
  mockSubscribeOutput.mockClear();
  mockSubscribeExit.mockClear();
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

const decoder = new TextDecoder();

/**
 * The lines termiHub wrote itself, in order: `writeln` markers plus the exit
 * line, which is staged behind pending output and arrives through `write`
 * (#5955).
 */
function written(instance: (typeof xtermInstances)[number]): string[] {
  const calls = [
    ...instance.write.mock.calls.map((call, i) => ({
      order: instance.write.mock.invocationCallOrder[i],
      text: typeof call[0] === "string" ? call[0] : decoder.decode(call[0] as Uint8Array),
    })),
    ...instance.writeln.mock.calls.map((call, i) => ({
      order: instance.writeln.mock.invocationCallOrder[i],
      text: String(call[0]),
    })),
  ];
  return calls.sort((a, b) => a.order - b.order).map((c) => c.text);
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
    mockGetAgentSessionBuffer.mockResolvedValue({
      data: buffer,
      endOffset: buffer.length,
      epoch: 1,
    });

    await disconnectAndReconnect(tabId);

    const fresh = xtermInstances[xtermInstances.length - 1];
    expect(mockGetAgentSessionBuffer).toHaveBeenCalledWith("fresh-session");
    expect(fresh.reset).toHaveBeenCalled();
    expect(fresh.write.mock.calls.some((call) => call[0] === buffer)).toBe(true);
    const lines = written(fresh);
    expect(lines.some((line) => line.includes("session resumed"))).toBe(true);
    expect(lines.some((line) => line.includes("new remote shell"))).toBe(false);
    // The daemon's live re-forward of the same buffer is dropped, what comes
    // after it is not (#5990).
    const before = written(fresh).length;
    act(() => {
      outputCallbacks["fresh-session"]?.(buffer, { offset: 0, epoch: 1 });
      outputCallbacks["fresh-session"]?.(new TextEncoder().encode("later"), {
        offset: buffer.length,
        epoch: 1,
      });
    });
    await act(async () => {
      await wait(40);
    });
    expect(written(fresh).slice(before)).toEqual(["later"]);
  });
});

/** Type into the tab: every data listener that is still registered gets it. */
function type(data: string, fromUser = true): void {
  inputFrom.user = fromUser;
  const { onData } = xtermInstances[xtermInstances.length - 1];
  onData.mock.calls.forEach(([listener], i) => {
    const { dispose } = onData.mock.results[i].value as { dispose: ReturnType<typeof vi.fn> };
    if (dispose.mock.calls.length === 0) (listener as (data: string) => void)(data);
  });
}

/** How often `text` is in what the tab's terminal was given since its reset. */
function timesShown(instance: (typeof xtermInstances)[number], text: string): number {
  const resets = instance.reset.mock.invocationCallOrder;
  const from = resets.length > 0 ? resets[resets.length - 1] : 0;
  const all = instance.write.mock.calls
    .filter((_, i) => instance.write.mock.invocationCallOrder[i] > from)
    .map((call) => (typeof call[0] === "string" ? call[0] : decoder.decode(call[0] as Uint8Array)))
    .join("");
  return all.split(text).length - 1;
}

describe("Terminal — a resumed session and the tab's own scrollback (#5990)", () => {
  /** The session's buffer as the agent's history comes as live output. */
  async function emitLate(text: string): Promise<void> {
    act(() => {
      outputCallbacks["fresh-session"]?.(new TextEncoder().encode(text), { offset: 0, epoch: 1 });
    });
    await act(async () => {
      await wait(40);
    });
  }

  function emptyRepaint(coming: boolean) {
    return { data: new Uint8Array(), endOffset: 0, epoch: 1, coming };
  }

  it("shows the history once when the buffer is not here yet and comes as live output", async () => {
    const tabId = await mountConnected();
    mockTakeResumed.mockResolvedValue(true);
    mockGetAgentSessionBuffer.mockResolvedValue(emptyRepaint(true));

    await disconnectAndReconnect(tabId);
    const fresh = xtermInstances[xtermInstances.length - 1];
    expect(fresh.reset, "nothing replaces the scrollback yet").not.toHaveBeenCalled();
    await emitLate(SERIALIZED_SCROLLBACK);

    expect(timesShown(fresh, SERIALIZED_SCROLLBACK)).toBe(1);
    expect(fresh.reset).toHaveBeenCalledTimes(1);
    expect(written(fresh).some((line) => line.includes("session resumed"))).toBe(true);
  });

  it("keeps the scrollback of a session that keeps no history", async () => {
    const tabId = await mountConnected();
    mockTakeResumed.mockResolvedValue(true);
    mockGetAgentSessionBuffer.mockResolvedValue(emptyRepaint(false));

    await disconnectAndReconnect(tabId);
    await emitLate("$ ");

    const fresh = xtermInstances[xtermInstances.length - 1];
    expect(fresh.reset).not.toHaveBeenCalled();
    expect(timesShown(fresh, SERIALIZED_SCROLLBACK)).toBe(1);
    expect(written(fresh).slice(-1)).toEqual(["$ "]);
  });

  it("keeps the scrollback when the session ended while its buffer was read", async () => {
    const tabId = await mountConnected();
    mockTakeResumed.mockResolvedValue(true);
    mockGetAgentSessionBuffer.mockRejectedValue(new Error("Session not found"));

    await disconnectAndReconnect(tabId);

    const fresh = xtermInstances[xtermInstances.length - 1];
    expect(fresh.reset).not.toHaveBeenCalled();
    expect(timesShown(fresh, SERIALIZED_SCROLLBACK)).toBe(1);
  });

  it("sends keys typed while the buffer is read, but no reply to what is repainted", async () => {
    const tabId = await mountConnected();
    mockTakeResumed.mockResolvedValue(true);
    let answer: (value: unknown) => void = () => {};
    mockGetAgentSessionBuffer.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    await disconnectAndReconnect(tabId);
    const fresh = xtermInstances[xtermInstances.length - 1];
    mockSendInput.mockClear();

    type("l");
    type("s\r");
    expect(mockSendInput, "the session is not wired yet").not.toHaveBeenCalled();
    // The repaint asks the terminal something: xterm answers as it parses it.
    fresh.write.mockImplementationOnce((_data: unknown, done?: () => void) => {
      type("\x1b[0n", false);
      done?.();
    });
    await act(async () => {
      answer({ data: new TextEncoder().encode("\x1b[5n"), endOffset: 4, epoch: 1, coming: false });
      await wait(60);
    });
    type("pwd");

    expect(mockSendInput.mock.calls.map((call) => call[1])).toEqual(["l", "s\r", "pwd"]);
    expect(new Set(mockSendInput.mock.calls.map((call) => call[0]))).toEqual(
      new Set(["fresh-session"])
    );
  });

  it("does not wipe a repaint of a window that regained the session before its history came", async () => {
    const tabId = await mountConnected();
    mockTakeResumed.mockResolvedValue(true);
    mockGetAgentSessionBuffer.mockResolvedValue(emptyRepaint(true));
    await disconnectAndReconnect(tabId);
    const fresh = xtermInstances[xtermInstances.length - 1];
    const history = new TextEncoder().encode("history ");
    mockReplayScrollback.mockResolvedValue({
      data: history,
      endOffset: history.length,
      epoch: 1,
      coming: false,
    });

    act(() => useAppStore.getState().setSessionOwners({ "fresh-session": "win-1" }));
    act(() => useAppStore.getState().setSessionOwners({ "fresh-session": "main" }));
    await act(async () => {
      await wait(40);
    });
    act(() => {
      outputCallbacks["fresh-session"]?.(new TextEncoder().encode("live"), {
        offset: history.length,
        epoch: 1,
      });
    });
    await act(async () => {
      await wait(40);
    });

    expect(fresh.reset).toHaveBeenCalledTimes(1);
    expect(timesShown(fresh, "history live")).toBe(1);
  });

  it("sends keys typed from the read until the tab is wired, but nothing xterm answers", async () => {
    const tabId = await mountConnected();
    mockTakeResumed.mockResolvedValue(true);
    let wired: () => void = () => {};
    mockSetLineEnding.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        wired = resolve;
      })
    );
    mockGetAgentSessionBuffer.mockImplementation(() => {
      const fresh = xtermInstances[xtermInstances.length - 1];
      fresh.write.mockImplementationOnce((_data: unknown, done?: () => void) => {
        type("a");
        type("\x1b[0n", false);
        done?.();
      });
      return Promise.resolve({
        data: new TextEncoder().encode("\x1b[5n"),
        endOffset: 4,
        epoch: 1,
        coming: false,
      });
    });
    await disconnectAndReconnect(tabId);
    mockSendInput.mockClear();
    type("b");
    type("\x1b[?1;2c", false);
    await act(async () => {
      wired();
      await wait(40);
    });
    type("c");

    expect(mockSendInput.mock.calls.map((call) => call[1])).toEqual(["a", "b", "c"]);
  });

  it("stamps the resumed line with the time the repaint ended", async () => {
    const tabId = await mountConnected();
    mockTakeResumed.mockResolvedValue(true);
    let answer: (value: unknown) => void = () => {};
    mockGetAgentSessionBuffer.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      })
    );
    await disconnectAndReconnect(tabId);
    const later = new Date(2030, 0, 2, 3, 4, 5);
    vi.setSystemTime(later);
    try {
      await act(async () => {
        answer(emptyRepaint(false));
        await wait(40);
      });
    } finally {
      vi.useRealTimers();
    }
    const fresh = xtermInstances[xtermInstances.length - 1];
    expect(written(fresh).some((line) => line.includes(resumedMarker(later)))).toBe(true);
  });
});

/** The exit line is staged behind pending output (#5955): let the flush run. */
async function flushStagedOutput(): Promise<void> {
  await act(async () => {
    await wait(50);
  });
}

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
    await flushStagedOutput();
    const lines = written(xtermInstances[xtermInstances.length - 1]);
    expect(lines.some((line) => line.includes("disconnected by you"))).toBe(true);
    expect(lines.some((line) => line.includes("connection lost"))).toBe(false);
  });

  it("still says 'connection lost' for a real drop", async () => {
    await mountConnected();
    act(() => {
      exitCallbacks["S1"]?.(null, null);
    });
    await flushStagedOutput();
    const lines = written(xtermInstances[xtermInstances.length - 1]);
    expect(lines.some((line) => line.includes("connection lost"))).toBe(true);
  });
});
