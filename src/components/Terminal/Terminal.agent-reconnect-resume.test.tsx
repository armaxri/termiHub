/**
 * Backend-driven AGENT reconnect **resume-after-restore** chain (#2476 / #2480),
 * driven end-to-end by projected region diffs — the path a live agent drop takes.
 *
 * The sibling `Terminal.agent-reconnect.test.tsx` pins the outcome behaviour by
 * calling `reconnectTerminal` directly. This covers the missing link: a resilient
 * agent tab whose reconnect is driven **only** by the backend — the drop arms the
 * loop, the backend reconnect timer fires the `Waiting → Connecting` edge (a
 * region diff), the frontend reconcile re-runs the terminal effect, and the
 * redrive's published fresh session id is re-attached — with the client agent
 * engine never engaged. This is the exact scenario that regressed live: drop →
 * Reconnecting worked, restore → re-attach did not.
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
vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockCreateTerminal = vi.fn().mockResolvedValue("fresh-session");
const mockGetAgentSessionBuffer = vi.fn().mockResolvedValue(new Uint8Array());
vi.mock("@/services/api", () => ({
  createTerminal: (...a: unknown[]) => mockCreateTerminal(...a),
  sendInput: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  detachPersistentTab: vi.fn().mockResolvedValue(0),
  getAgentSessionBuffer: (...a: unknown[]) => mockGetAgentSessionBuffer(...a),
  sessionGetCapabilities: vi.fn().mockResolvedValue({}),
}));

const mockSubscribeOutput = vi.fn(() => vi.fn());
const mockSubscribeExit = vi.fn(() => vi.fn());
vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: (...a: unknown[]) => mockSubscribeOutput(...(a as [])),
    subscribeExit: (...a: unknown[]) => mockSubscribeExit(...(a as [])),
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
  mockSubscribeOutput.mockClear();
  mockSubscribeExit.mockClear();
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

describe("Terminal — backend-driven agent reconnect RESUME via reconcile (#2476)", () => {
  it("re-attaches to the redrive's fresh session id, driven only by region diffs", async () => {
    const tabId = addAgentTab("S1");
    transport.setSession(tabId, connectedLifecycle());
    mount(tabId, "S1");
    await act(async () => {
      await wait(50);
    });
    expect(mockCreateTerminal).not.toHaveBeenCalled(); // initial mount reattaches

    // Drop: arm the resilient loop + wire the backend-timer reconcile — exactly
    // what setTerminalExited("dropped") does for a resilient agent tab.
    act(() => {
      useAppStore.getState().setTerminalExited(tabId, { code: null, reason: "dropped" });
    });
    await act(async () => {
      await wait(20);
    });

    // Backend reconnect timer: Waiting, then it fires the attempt (→ Connecting).
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

    // Backend redrive minted S2 and published it (connected).
    act(() => {
      transport.setSession(tabId, { ...connectedLifecycle(), sessionId: "S2" });
    });
    await act(async () => {
      await wait(80);
    });

    // Client agent engine stays suppressed; terminal I/O re-attaches to S2.
    expect(mockCreateTerminal).not.toHaveBeenCalled();
    expect(mockSubscribeOutput).toHaveBeenCalledWith("S2", expect.any(Function));
    expect(mockSubscribeExit).toHaveBeenCalledWith("S2", expect.any(Function));
  });
});
