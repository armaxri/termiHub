/**
 * Regression tests for the deterministic session-teardown defer (FEC-014 /
 * WA-FE-009).
 *
 * On unmount the Terminal defers its backend teardown (persistent detach /
 * session close) so a React StrictMode dev unmount→remount — or any same-tick
 * effect re-run such as a reconnect (retryCount bump) — can cancel it before the
 * live backend session is destroyed. The defer used to be a wall-clock
 * `setTimeout(…, 50)` guess; it is now a microtask guarded by a cancellation
 * token that the remount's `setupTerminal` flips synchronously. These tests lock
 * in the two lifecycle facts the mechanism must preserve:
 *
 *   (a) a same-tick unmount→remount (StrictMode / reconnect) does NOT tear down
 *       the session, and
 *   (b) a genuine unmount DOES tear it down, and
 *   (c) the deferred teardown never fires into a replaced session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, StrictMode } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";

// --- Mocks (mirror Terminal.session-stability.test.tsx) ---

vi.mock("@xterm/xterm", async () => {
  const { createMockXtermModule } = await import("@/test/mockXterm");
  return createMockXtermModule();
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
const mockCloseTerminal = vi.fn().mockResolvedValue(undefined);
const mockDetachPersistentTab = vi.fn().mockResolvedValue(0);
const mockGetAgentSessionBuffer = vi.fn().mockResolvedValue(new Uint8Array());

vi.mock("@/services/api", () => ({
  createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
  sendInput: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: (...args: unknown[]) => mockCloseTerminal(...args),
  detachPersistentTab: (...args: unknown[]) => mockDetachPersistentTab(...args),
  getAgentSessionBuffer: (...args: unknown[]) => mockGetAgentSessionBuffer(...args),
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
  mockCreateTerminal.mockClear();
  mockCreateTerminal.mockResolvedValue("fresh-session");
  mockCloseTerminal.mockClear();
  mockDetachPersistentTab.mockClear();
  mockGetAgentSessionBuffer.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  // Drain any teardown microtask scheduled by the unmount above so it is
  // attributed to this test, not a later one.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  container.remove();
});

const LOCAL_CONFIG = { type: "local" as const, config: {} };

/** Flush pending microtasks (the teardown defer) inside act(). */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Let the async setupTerminal settle. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("Terminal — deterministic session teardown (FEC-014)", () => {
  it("closes the backend session on a genuine unmount", async () => {
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
    await settle();
    // Attached to the existing session; nothing created, nothing closed yet.
    expect(mockCreateTerminal).not.toHaveBeenCalled();
    expect(mockCloseTerminal).not.toHaveBeenCalled();

    // Genuine unmount: no remount follows, so the deferred close must fire.
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <></>
        </TerminalPortalProvider>
      );
    });
    // Not torn down yet — the close is deferred to a microtask.
    expect(mockCloseTerminal).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(mockCloseTerminal).toHaveBeenCalledWith("session-1");
  });

  it("does NOT close the session when a same-tick reconnect re-runs the effect", async () => {
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
    await settle();
    expect(mockCloseTerminal).not.toHaveBeenCalled();

    // A reconnect bumps retryCount, which re-runs the creation effect: its
    // cleanup schedules the deferred close of "session-1", and the immediate
    // re-setup (setupTerminal) cancels it in the same tick. The live session
    // must NOT be closed by the defer.
    act(() => {
      useAppStore.getState().reconnectTerminal("tab-1");
    });
    await settle();
    await flushMicrotasks();

    expect(mockCloseTerminal).not.toHaveBeenCalledWith("session-1");
    // The reconnect started a fresh session (direct connections connect fresh).
    expect(mockCreateTerminal).toHaveBeenCalled();
  });

  it("does not tear down the session under React StrictMode", async () => {
    act(() => {
      root.render(
        <StrictMode>
          <TerminalPortalProvider>
            <Terminal
              tabId="tab-1"
              config={LOCAL_CONFIG}
              isVisible={true}
              existingSessionId="session-1"
            />
          </TerminalPortalProvider>
        </StrictMode>
      );
    });
    await settle();
    await flushMicrotasks();

    // StrictMode ran mount→unmount→mount, but the live attached session must
    // survive: the deferred close is cancelled by the remount.
    expect(mockCloseTerminal).not.toHaveBeenCalledWith("session-1");
  });

  it("the deferred teardown fires only for the current session, never a replaced one", async () => {
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
    await settle();

    // Reconnect → fresh "fresh-session" replaces "session-1"; the old defer is
    // cancelled.
    act(() => {
      useAppStore.getState().reconnectTerminal("tab-1");
    });
    await settle();
    await flushMicrotasks();
    expect(mockCloseTerminal).not.toHaveBeenCalledWith("session-1");

    // Now a genuine unmount tears down ONLY the current (replaced) session.
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <></>
        </TerminalPortalProvider>
      );
    });
    await flushMicrotasks();
    expect(mockCloseTerminal).toHaveBeenCalledWith("fresh-session");
    expect(mockCloseTerminal).not.toHaveBeenCalledWith("session-1");
  });

  it("does not close a session that is being moved to another window", async () => {
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
    await settle();

    // The move marks the session as moving before the source view unmounts.
    act(() => {
      useAppStore.setState({ movingSessionIds: ["session-1"] });
    });
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <></>
        </TerminalPortalProvider>
      );
    });
    await flushMicrotasks();

    // The destination window adopts the still-running session — no close, and
    // the moving flag is consumed.
    expect(mockCloseTerminal).not.toHaveBeenCalledWith("session-1");
    expect(useAppStore.getState().isSessionMoving("session-1")).toBe(false);
  });
});

describe("Terminal — deterministic persistent-tab detach (FEC-014)", () => {
  const PERSISTENT_CONFIG = {
    type: "remote-session" as const,
    config: { agentId: "agent-1" },
  };

  it("detaches (not closes) the persistent tab on a genuine unmount", async () => {
    act(() => {
      root.render(
        <TerminalPortalProvider>
          <Terminal
            tabId="tab-p"
            config={PERSISTENT_CONFIG}
            isVisible={true}
            existingSessionId="persist-session"
            persistentConnectionId="conn-1"
          />
        </TerminalPortalProvider>
      );
    });
    await settle();

    act(() => {
      root.render(
        <TerminalPortalProvider>
          <></>
        </TerminalPortalProvider>
      );
    });
    expect(mockDetachPersistentTab).not.toHaveBeenCalled();
    await flushMicrotasks();
    // Persistent teardown detaches the tab; it never closes the backend session.
    expect(mockDetachPersistentTab).toHaveBeenCalledWith("persist-session", "tab-p");
    expect(mockCloseTerminal).not.toHaveBeenCalled();
  });
});
