/**
 * Regression test for #1126 — reconnect must preserve the xterm scrollback.
 *
 * `reconnectTerminal` bumps `terminalRetryCounters`, which is a dependency of
 * the terminal-creation effect. That re-runs the effect: the cleanup disposes
 * the current xterm instance and a fresh one is created. For a *direct*
 * connection there is no server-side buffer to re-fetch, so without an explicit
 * snapshot/replay the scrollback the disconnect overlay promises
 * ("Scrollback is preserved below") is gone — and if the reconnect then fails,
 * the pane is blank, contradicting the overlay copy.
 *
 * The fix serializes the old instance's scrollback in cleanup (before dispose)
 * and replays it into the fresh instance right after `xterm.open()`, before the
 * new session resolves. This test asserts that replay happens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";

// --- Mocks ---

// A distinctive serialized snapshot the SerializeAddon mock returns, so the
// test can prove the fresh instance replayed the previous instance's buffer.
const SERIALIZED_SCROLLBACK = "\x1b[32mprevious scrollback line\x1b[0m\r\n";

// Track every xterm instance created, in order, with its write() spy so the
// test can distinguish the disposed instance from the fresh one.
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
    constructor() {
      xtermInstances.push({ write: this.write, dispose: this.dispose });
    }
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

// The SerializeAddon returns the distinctive snapshot only once a session has
// been established (i.e. the instance has "content"). We approximate that by
// returning the snapshot unconditionally; the production guard only replays a
// non-empty snapshot, and only for a subsequent instance.
vi.mock("@xterm/addon-serialize", () => {
  class MockSerializeAddon {
    serialize = vi.fn(() => SERIALIZED_SCROLLBACK);
    dispose = vi.fn();
  }
  return { SerializeAddon: MockSerializeAddon };
});

vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockCreateTerminal = vi.fn().mockResolvedValue("fresh-session");

vi.mock("@/services/api", () => ({
  createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
  cancelConnecting: vi.fn().mockResolvedValue(undefined),
  sendInput: vi.fn().mockResolvedValue(undefined),
  setSessionLineEnding: vi.fn().mockResolvedValue(undefined),
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

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  mockCreateTerminal.mockClear();
  mockCreateTerminal.mockResolvedValue("fresh-session");
  xtermInstances.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const LOCAL_CONFIG = {
  type: "local" as const,
  config: { shell: "/bin/bash" },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Terminal — scrollback survives reconnect (#1126)", () => {
  it("replays the prior xterm scrollback into the fresh instance on reconnect", async () => {
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal tabId="tab-1" config={LOCAL_CONFIG} isVisible={true} />
        </TerminalPortalProvider>
      );
    });
    await act(async () => {
      await wait(50);
    });

    // One xterm instance created on mount; it connected the initial session.
    const initialInstanceCount = xtermInstances.length;
    expect(initialInstanceCount).toBeGreaterThanOrEqual(1);
    const firstInstance = xtermInstances[initialInstanceCount - 1];

    // User clicks "Reconnect": bumps the retry counter, which re-runs the
    // terminal-creation effect (dispose old xterm → create new xterm).
    act(() => {
      useAppStore.getState().reconnectTerminal("tab-1");
    });
    await act(async () => {
      await wait(50);
    });

    // A fresh xterm instance must have been created for the reconnect, and the
    // previous instance disposed.
    expect(xtermInstances.length).toBeGreaterThan(initialInstanceCount);
    expect(firstInstance.dispose).toHaveBeenCalled();

    // The fresh instance must have replayed the previous instance's serialized
    // scrollback — this is what keeps "Scrollback is preserved below" true when
    // a reconnect fails. Without the fix, the fresh instance never receives it.
    const freshInstance = xtermInstances[xtermInstances.length - 1];
    const replayed = freshInstance.write.mock.calls.some(
      (call) => call[0] === SERIALIZED_SCROLLBACK
    );
    expect(replayed).toBe(true);
  });
});
