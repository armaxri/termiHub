/**
 * Component tests for the backend-driven AGENT reconnect activation (#2476).
 *
 * When the default-off `sessionBackendReattach` flag is ON, a reconnect of an
 * agent-hosted tab must be driven **entirely by the backend redrive** — the
 * client agent engine (`createTerminal` → `connectRemoteAgent` + park + bounded
 * spawn retries) must NOT run, or it double-drives the very agent transport the
 * redrive is re-establishing. Instead the Terminal:
 *   • re-attaches terminal I/O to the backend-published session id on success, or
 *   • settles the tab disconnected when the backend give-up folds into the region,
 * never calling `createTerminal` on either path.
 *
 * With the flag OFF the reconnect drives the client engine exactly as on develop
 * (a fresh `createTerminal`), pinning byte-identical flag-off parity.
 *
 * Mirrors Terminal.backend-reattach.test.tsx (the direct-SSH #2457 analog).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import {
  ensureSessionSubscribed,
  setSessionBackendReattachEnabled,
  setSessionTransportForTest,
  stopSessionSubscription,
} from "@/store/sessionBridge";
import {
  FakeSessionTransport,
  connected as connectedLifecycle,
  reconnecting,
} from "@/test/sessionLifecycleRegionTestHarness";

// --- Mocks (mirror Terminal.backend-reattach.test.tsx) ---

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
  setSessionBackendReattachEnabled(null);
});

const AGENT_CONFIG = {
  type: "remote-session" as const,
  config: { agentId: "agent-1", sessionType: "shell" },
};

/** Add a live agent (remote-session) tab to the store and return its id. */
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

describe("Terminal — backend-driven agent reconnect (#2476)", () => {
  it("flag ON: re-attaches to the backend-published id, never calling the client engine", async () => {
    setSessionBackendReattachEnabled(true);
    const tabId = addAgentTab("initial-session");

    mount(tabId, "initial-session");
    await act(async () => {
      await wait(50);
    });
    expect(mockCreateTerminal).not.toHaveBeenCalled(); // initial mount reattaches

    // Subscribe the region client (in the real app the drop's `session.reconnect`
    // dispatch does this; here we seed the region directly).
    await ensureSessionSubscribed();
    // A genuine drop folded the region to `reconnecting` (the sole reconnect
    // authority, #2205 PR-B); the backend redrive re-established the transport and
    // published the fresh backend session id. The reconnect must await that
    // outcome and re-attach — never run the client agent engine.
    act(() => {
      transport.setSession(tabId, {
        status: "reconnecting",
        reconnect: { phase: "connecting", attempt: 1, delayMs: 0 },
        sessionId: "agent-new",
      });
    });
    act(() => {
      useAppStore.getState().reconnectTerminal(tabId);
    });
    await act(async () => {
      await wait(80);
    });

    // The client agent engine is suppressed — no createTerminal on the reconnect.
    expect(mockCreateTerminal).not.toHaveBeenCalled();
    // Terminal I/O re-attaches to the backend-chosen id.
    expect(mockSubscribeOutput).toHaveBeenCalledWith("agent-new", expect.any(Function));
    expect(mockSubscribeExit).toHaveBeenCalledWith("agent-new", expect.any(Function));
  });

  it("flag ON: settles disconnected on backend give-up, never calling the client engine", async () => {
    setSessionBackendReattachEnabled(true);
    const tabId = addAgentTab("initial-session");
    mount(tabId, "initial-session");
    await act(async () => {
      await wait(50);
    });

    await ensureSessionSubscribed();
    // The drop folded the region to `reconnecting`; the reconnect awaits the
    // backend outcome (never the client engine).
    act(() => {
      transport.setSession(tabId, reconnecting({ phase: "connecting", attempt: 1, delayMs: 0 }));
    });
    act(() => {
      useAppStore.getState().reconnectTerminal(tabId);
    });
    // Backend park/retry exhausts → folds Failed/gaveup into the region.
    await act(async () => {
      await wait(30);
      transport.setSession(tabId, {
        status: "failed",
        reconnect: { phase: "gaveup", attempt: 3, delayMs: 0 },
        error: "agent unreachable after 3 attempts",
      });
      await wait(80);
    });

    expect(mockCreateTerminal).not.toHaveBeenCalled();
    const state = useAppStore.getState();
    expect(state.terminalDisconnectErrors[tabId]).toBe("agent unreachable after 3 attempts");
    expect(state.terminalExitedTabs[tabId]).toBe(true);
  });

  it("flag OFF: reconnect drives the client engine (createTerminal) — develop parity", async () => {
    setSessionBackendReattachEnabled(false);
    const tabId = addAgentTab("initial-session");
    // Even with a backend id available, the flag-off path ignores it.
    transport.setSession(tabId, { ...connectedLifecycle(), sessionId: "agent-new" });

    mount(tabId, "initial-session");
    await act(async () => {
      await wait(50);
    });
    expect(mockCreateTerminal).not.toHaveBeenCalled();

    act(() => {
      useAppStore.getState().reconnectTerminal(tabId);
    });
    await act(async () => {
      await wait(80);
    });

    // develop behavior: an agent reconnect re-creates the session via the client.
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
    expect(mockSubscribeOutput).not.toHaveBeenCalledWith("agent-new", expect.any(Function));
  });
});
