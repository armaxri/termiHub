/**
 * Regression test for #1214 — the connect in-flight guard must be tracked PER
 * attempt, not as a single shared boolean.
 *
 * Each connect attempt already carries a unique connect id (`${tabId}:${retryCount}`)
 * and the effect cleanup cancels only its own id (#1125). But the in-flight
 * *guard* used to be a single shared `useRef(false)`: set true before
 * `createTerminal`, reset to false in a `finally`. Because the boolean was
 * shared across overlapping attempts, a stale attempt that settled late cleared
 * the flag out from under the live attempt:
 *
 *   1. Attempt A (`tab:0`) starts and stays in flight.
 *   2. A reconnect starts attempt B (`tab:1`); A's cleanup already ran.
 *   3. A's `createTerminal` finally settles (late) → its `finally` sets the
 *      shared flag to false.
 *   4. The tab is torn down while B is STILL in flight → B's cleanup sees the
 *      shared flag as false and SKIPS `cancelConnecting(tab:1)`, orphaning B's
 *      backend handshake (the exact orphan-session class of #1122).
 *
 * The fix tracks in-flight state per connect id (a Set): the cleanup cancels iff
 * its OWN connect id is still in flight, so a stale attempt's late settle can no
 * longer suppress the live attempt's cancel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { setSessionBackendReattachEnabled } from "@/store/sessionBridge";

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
 * Each `createTerminal` call returns a promise whose resolve/reject is captured
 * so the test can settle a specific attempt on demand while another stays in
 * flight. The connect id passed by the caller is recorded for assertions.
 */
interface PendingConnect {
  connectId?: string;
  resolve: (sessionId: string) => void;
  reject: (err: unknown) => void;
}
const pendingConnects: PendingConnect[] = [];
const mockCreateTerminal = vi.fn((_config: unknown, connectId?: string) => {
  return new Promise<string>((resolve, reject) => {
    pendingConnects.push({ connectId, resolve, reject });
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
  // This suite exercises the client-redrive fallback (per-attempt
  // `create_connection` in-flight tracking). Since #2205 PR-B flipped
  // `sessionBackendReattach` on by default, pin it OFF so the retained
  // instant-revert fallback path is what is under test here.
  setSessionBackendReattachEnabled(false);
  pendingConnects.length = 0;
  mockCreateTerminal.mockClear();
  mockCancelConnecting.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setSessionBackendReattachEnabled(null);
});

// Direct (non-agent) local shell connection so setupTerminal takes the
// createTerminal path rather than reattaching to an existing session.
const DIRECT_CONFIG = {
  type: "local" as const,
  config: {},
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Terminal — per-attempt connect in-flight tracking (#1214)", () => {
  it("still cancels the live attempt on teardown after a stale attempt settled late", async () => {
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

    // Attempt A is in flight (its createTerminal promise is captured, unsettled).
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
    const attemptA = pendingConnects[0];
    expect(attemptA.connectId).toBeTruthy();

    // Reconnect while A is still in flight → the effect re-runs (retryCount dep):
    // A's cleanup runs (cancelling A) and attempt B starts.
    act(() => {
      useAppStore.getState().reconnectTerminal("tab-1");
    });
    await act(async () => {
      await wait(50);
    });

    expect(mockCreateTerminal).toHaveBeenCalledTimes(2);
    const attemptB = pendingConnects[1];
    expect(attemptB.connectId).toBeTruthy();
    expect(attemptB.connectId).not.toBe(attemptA.connectId);

    // A settles LATE (after B has started). With a shared boolean this cleared
    // the in-flight flag out from under B, which is still connecting.
    await act(async () => {
      attemptA.reject(new Error("stale attempt failed late"));
      await wait(50);
    });

    // B is still in flight. Tear the tab down.
    act(() => root.unmount());
    await act(async () => {
      await wait(20);
    });

    // The teardown MUST cancel B's still-in-flight handshake. With the shared
    // boolean, A's late settle had cleared the flag, so B's cleanup skipped the
    // cancel and orphaned the handshake.
    const cancelledIds = mockCancelConnecting.mock.calls.map((c) => c[0]);
    expect(cancelledIds).toContain(attemptB.connectId);
  });
});
