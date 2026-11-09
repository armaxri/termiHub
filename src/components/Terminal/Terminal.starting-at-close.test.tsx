/**
 * A connection still starting when its window close is confirmed (#5112).
 *
 * The Terminal records each in-flight `create_connection` in the store's
 * `startingConnects`, so the close and quit decisions can list the tab as a
 * starting connection. Once the window's sessions are being ended, a create
 * that resolves must be closed at once instead of becoming a live session that
 * nobody owns once the window is gone.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";

// --- Mocks ---

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
    onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
    dispose = vi.fn();
  }
  return { SearchAddon: MockSearchAddon };
});

vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockCreateTerminal = vi.fn();
const mockCloseTerminal = vi.fn().mockResolvedValue(undefined);

vi.mock("@/services/api", () => ({
  createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
  cancelConnecting: vi.fn().mockResolvedValue(undefined),
  sendInput: vi.fn().mockResolvedValue(undefined),
  setSessionLineEnding: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminal: (...args: unknown[]) => mockCloseTerminal(...args),
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

vi.mock("@/components/ui", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    promise: vi.fn(),
    dismiss: vi.fn(),
  },
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
  mockCreateTerminal.mockReset();
  mockCloseTerminal.mockClear();
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

/** A createTerminal that resolves only when the test says so. */
function deferredCreate(): (sessionId: string) => void {
  let resolve: (sessionId: string) => void = () => {};
  mockCreateTerminal.mockImplementation(
    () =>
      new Promise<string>((r) => {
        resolve = r;
      })
  );
  return (sessionId) => resolve(sessionId);
}

async function renderTerminal(tabId: string): Promise<void> {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal tabId={tabId} config={LOCAL_CONFIG} isVisible={true} />
      </TerminalPortalProvider>
    );
  });
  await act(async () => {
    await wait(50);
  });
}

describe("Terminal — connection still starting at window close (#5112)", () => {
  it("marks the tab as starting while its create is in flight", async () => {
    const resolve = deferredCreate();
    await renderTerminal("tab-1");

    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().startingConnects).toEqual({ "tab-1": "tab-1:0" });

    await act(async () => {
      resolve("live-session");
      await wait(20);
    });

    expect(useAppStore.getState().startingConnects).toEqual({});
    expect(mockCloseTerminal).not.toHaveBeenCalled();
  });

  it("closes a session that finishes starting after the close was confirmed", async () => {
    const resolve = deferredCreate();
    await renderTerminal("tab-2");

    useAppStore.setState({ windowSessionsEnding: true });
    await act(async () => {
      resolve("late-session");
      await wait(20);
    });

    expect(mockCloseTerminal).toHaveBeenCalledWith("late-session");
    expect(useAppStore.getState().startingConnects).toEqual({});
  });

  it("clears the starting mark when the create fails", async () => {
    let reject: (err: Error) => void = () => {};
    mockCreateTerminal.mockImplementation(
      () =>
        new Promise<string>((_r, rj) => {
          reject = rj;
        })
    );
    await renderTerminal("tab-3");
    expect(useAppStore.getState().startingConnects).toHaveProperty("tab-3");

    await act(async () => {
      reject(new Error("refused"));
      await wait(20);
    });

    expect(useAppStore.getState().startingConnects).toEqual({});
  });
});
