/**
 * Component tests for the backend-driven direct-reconnect re-attach path (#2457,
 * part of the server-side reconnect redrive #2454 / umbrella #2446).
 *
 * When the region has folded a tab to `reconnecting` (the backend redrive owns
 * the loop, now unconditional (the backend redrive is the sole reconnect authority),
 * #2560), a direct-connection reconnect must NOT call `create_connection`. Instead
 * the server-side redrive (#2454) creates the connection itself, mints a new
 * backend session id, and publishes it to the `session-lifecycle` region; the
 * Terminal re-attaches terminal I/O (subscribe output/exit + `setTabSessionId`) to
 * that id. A user-initiated reconnect while the region is NOT reconnecting still
 * starts a fresh client `create_connection`.
 *
 * Full end-to-end drop verification (Reconnecting→Attempt→Connected fully
 * server-side) is deferred to #2454's backend-redrive PR — nothing drives a
 * backend reconnect until that lands. These tests verify the frontend re-attach
 * mechanism in isolation by seeding the region directly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import {
  ensureSessionSubscribed,
  setSessionTransportForTest,
  stopSessionSubscription,
} from "@/store/sessionBridge";
import {
  FakeSessionTransport,
  connected as connectedLifecycle,
} from "@/test/sessionLifecycleRegionTestHarness";

// --- Mocks (mirror Terminal.reconnect-fresh.test.tsx) ---

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
});

// A direct (non-persistent, non-agent) connection.
const DIRECT_CONFIG = {
  type: "ssh" as const,
  config: { host: "example.test", port: 22, username: "u" },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Terminal — backend-driven direct reconnect re-attach (#2457)", () => {
  it("re-attaches to the backend-published session id (region reconnecting) without create_connection", async () => {
    // Mount as if already connected to a (now to-be-dead) direct session.
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal
            tabId="tab-1"
            config={DIRECT_CONFIG}
            isVisible={true}
            existingSessionId="initial-session"
          />
        </TerminalPortalProvider>
      );
    });
    await act(async () => {
      await wait(50);
    });
    // Initial mount reattaches to the existing id — no create_connection.
    expect(mockCreateTerminal).not.toHaveBeenCalled();

    // Subscribe the region client (in the real app the drop's `session.reconnect`
    // dispatch does this) and fold the region to `reconnecting` — the sole
    // reconnect authority (#2205 PR-B). The server-side redrive re-established the
    // transport and published the new backend session id.
    await ensureSessionSubscribed();
    act(() => {
      transport.setSession("tab-1", {
        status: "reconnecting",
        reconnect: { phase: "connecting", attempt: 1, delayMs: 0 },
        sessionId: "backend-new",
      });
    });
    // Reconnect: bump the retry counter so the effect re-runs as a reconnect.
    act(() => {
      useAppStore.getState().reconnectTerminal("tab-1");
    });
    await act(async () => {
      await wait(80);
    });

    // The client redrive is suppressed — no create_connection on the reconnect.
    expect(mockCreateTerminal).not.toHaveBeenCalled();
    // Terminal I/O re-attaches to the backend-chosen id.
    expect(mockSubscribeOutput).toHaveBeenCalledWith("backend-new", expect.any(Function));
    expect(mockSubscribeExit).toHaveBeenCalledWith("backend-new", expect.any(Function));
  });

  it("a user-initiated reconnect (region not reconnecting) drives a fresh create_connection", async () => {
    // Region is `connected`, not `reconnecting`: a user Reconnect click starts a
    // fresh client connect rather than re-attaching to a backend-published id.
    transport.setSession("tab-2", { ...connectedLifecycle(), sessionId: "backend-new" });

    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal
            tabId="tab-2"
            config={DIRECT_CONFIG}
            isVisible={true}
            existingSessionId="initial-session"
          />
        </TerminalPortalProvider>
      );
    });
    await act(async () => {
      await wait(50);
    });
    expect(mockCreateTerminal).not.toHaveBeenCalled();

    act(() => {
      useAppStore.getState().reconnectTerminal("tab-2");
    });
    await act(async () => {
      await wait(80);
    });

    // develop behavior: a direct reconnect creates a fresh session via the client.
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
    // And it never re-attaches to the region's backend id.
    expect(mockSubscribeOutput).not.toHaveBeenCalledWith("backend-new", expect.any(Function));
  });
});
