/**
 * Regression test for #1125 — overlapping connects must not cancel each other.
 *
 * The mid-connect cancellation map is keyed by a connect id. Historically that
 * id was the bare `tabId`, so a retry/reconnect that fired while the previous
 * `createTerminal` was still in flight reused the SAME id. The old effect's
 * cleanup then ran `cancelConnecting(tabId)` and aborted the NEW attempt's
 * handshake — landing the tab in a spurious Failed state.
 *
 * The fix threads a UNIQUE per-attempt connect id (`${tabId}:${retryCount}`)
 * through `createTerminal`, and the effect cleanup cancels only ITS OWN id. So
 * a stale cleanup can never touch the fresh attempt's token.
 *
 * This test drives a direct (non-agent) connection whose first `createTerminal`
 * never resolves, triggers a reconnect while it is in flight, and asserts that
 * the fresh attempt's connect id is never passed to `cancelConnecting`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";

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

/**
 * `createTerminal` returns a promise that never resolves, so each attempt stays
 * "in flight" and the cleanup path (which cancels the connect) is exercised.
 * The connect id passed by the caller is recorded for assertions.
 */
const createTerminalConnectIds: (string | undefined)[] = [];
const mockCreateTerminal = vi.fn((_config: unknown, connectId?: string) => {
  createTerminalConnectIds.push(connectId);
  return new Promise<string>(() => {
    /* never resolves — connect stays in flight */
  });
});
const mockCancelConnecting = vi.fn((_connectId: string) => Promise.resolve(true));

vi.mock("@/services/api", () => ({
  createTerminal: (...args: unknown[]) =>
    mockCreateTerminal(args[0], args[1] as string | undefined),
  cancelConnecting: (connectId: string) => mockCancelConnecting(connectId),
  sendInput: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
  detachPersistentTab: vi.fn().mockResolvedValue(0),
  getAgentSessionBuffer: vi.fn().mockResolvedValue(new Uint8Array()),
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
  // This suite exercises the client create loop's per-attempt connect ids
  // (initial connect / user-initiated reconnect with a fresh connect id).
  createTerminalConnectIds.length = 0;
  mockCreateTerminal.mockClear();
  mockCancelConnecting.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// Direct (non-agent) local shell connection so setupTerminal takes the
// createTerminal path rather than reattaching to an existing session.
const DIRECT_CONFIG = {
  type: "local" as const,
  config: {},
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Terminal — overlapping connect cancellation race (#1125)", () => {
  it("uses a unique connect id per attempt so a reconnect-in-flight does not cancel the fresh attempt", async () => {
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal tabId="tab-1" config={DIRECT_CONFIG} isVisible={true} />
        </TerminalPortalProvider>
      );
    });
    await act(async () => {
      await wait(50);
    });

    // First attempt is in flight (createTerminal never resolves).
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
    const firstConnectId = createTerminalConnectIds[0];
    expect(firstConnectId).toBeTruthy();

    // Reconnect while the first connect is still in flight → the effect re-runs
    // (retryCount dep), tearing down the old attempt and starting a new one.
    act(() => {
      useAppStore.getState().reconnectTerminal("tab-1");
    });
    await act(async () => {
      await wait(50);
    });

    // The reconnect started a second connect with a DISTINCT connect id.
    expect(mockCreateTerminal).toHaveBeenCalledTimes(2);
    const secondConnectId = createTerminalConnectIds[1];
    expect(secondConnectId).toBeTruthy();
    expect(secondConnectId).not.toBe(firstConnectId);

    // The old effect's cleanup must cancel only its OWN attempt's id, never the
    // fresh attempt's id. This is the core of the fix: with the bare-tabId id
    // both attempts shared one id and the stale cleanup aborted the new connect.
    const cancelledIds = mockCancelConnecting.mock.calls.map((c) => c[0]);
    expect(cancelledIds).not.toContain(secondConnectId);
  });
});
