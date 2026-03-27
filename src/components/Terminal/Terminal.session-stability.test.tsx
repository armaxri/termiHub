/**
 * Regression tests for the blank-terminal bug introduced in d82fad5.
 *
 * When TerminalRegistry.registerSession calls setTabSessionId, the Zustand
 * store update propagates tab.sessionId back to the Terminal component as the
 * existingSessionId prop. If existingSessionId were in setupTerminal's
 * dependency array, the change would trigger a full re-setup (destroy old
 * xterm, create new empty one), leaving a blank terminal.
 *
 * The fix: capture existingSessionId in a ref at mount time so that later
 * prop changes do not invalidate the setupTerminal callback or the main
 * useEffect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";

// --- Mocks ---

vi.mock("@xterm/xterm", () => {
  class MockXTerm {
    open = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    onWriteParsed = vi.fn(() => ({ dispose: vi.fn() }));
    write = vi.fn();
    writeln = vi.fn();
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

const mockCreateTerminal = vi.fn().mockResolvedValue("session-1");

vi.mock("@/services/api", () => ({
  createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
  sendInput: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: vi.fn(() => vi.fn()),
    subscribeExit: vi.fn(() => vi.fn()),
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
  mockCreateTerminal.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// Stable config reference — in the real app, tab.config is stored in Zustand
// and does not change when only tab.sessionId is updated via setTabSessionId.
// Using a module-level constant matches that stability requirement.
const LOCAL_CONFIG = { type: "local" as const, config: {} };

describe("Terminal — session stability after store update", () => {
  it("does not re-create the session when existingSessionId prop changes after mount", async () => {
    // Initial render: existingSessionId is null (new tab, session not yet created).
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal tabId="tab-1" config={LOCAL_CONFIG} isVisible={true} existingSessionId={null} />
        </TerminalPortalProvider>
      );
    });

    // Wait for async setupTerminal to complete (createTerminal resolves).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);

    // Simulate what happens when TerminalRegistry.registerSession calls
    // setTabSessionId: the store update propagates the new session ID back as
    // the existingSessionId prop. Before the fix, this would trigger a full
    // re-setup and blank the terminal.
    // The config reference is intentionally the same object (as in the real app).
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal
            tabId="tab-1"
            config={LOCAL_CONFIG}
            isVisible={true}
            existingSessionId="session-1"
          />
        </TerminalPortalProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // createTerminal must still have been called exactly once — the prop
    // change must not trigger a second session setup.
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
  });

  it("uses existingSessionId at mount time without calling createTerminal", async () => {
    // Workspace restore: tab already has a session ID from the backend.
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal
            tabId="tab-2"
            config={LOCAL_CONFIG}
            isVisible={true}
            existingSessionId="restored-session"
          />
        </TerminalPortalProvider>
      );
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Should connect to the existing session, not create a new one.
    expect(mockCreateTerminal).not.toHaveBeenCalled();
  });
});
