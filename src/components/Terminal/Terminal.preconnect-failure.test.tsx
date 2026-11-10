/**
 * A tab opened on a failed saved-credential pre-connect (#5180) shows that
 * failure instead of connecting again — the user never waits out a second
 * timeout — and its Retry then connects normally.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { stashPreconnectFailure } from "@/utils/preconnect";

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

const mockCreateTerminal = vi.fn().mockResolvedValue("live-session");

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

const mockToastSuccess = vi.fn();

vi.mock("@/components/ui", () => ({
  toast: {
    success: (...args: unknown[]) => mockToastSuccess(...args),
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
  mockCreateTerminal.mockClear();
  mockCreateTerminal.mockResolvedValue("live-session");
  mockToastSuccess.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const SSH_CONFIG = {
  type: "ssh" as const,
  config: { host: "unreachable.example", username: "ops", authMethod: "password", password: "pw" },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function renderTab(tabId: string): void {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal tabId={tabId} config={SSH_CONFIG} isVisible={true} />
      </TerminalPortalProvider>
    );
  });
}

describe("Terminal — a failed pre-connect is not repeated (#5180)", () => {
  it("lands on the handed-over failure without a second connect", async () => {
    stashPreconnectFailure("tab-pre", {
      code: "timeout",
      message: "Connection timed out",
      details: null,
    });
    renderTab("tab-pre");
    await act(async () => {
      await wait(50);
    });

    expect(mockCreateTerminal).not.toHaveBeenCalled();
    expect(useAppStore.getState().terminalSpawnErrors["tab-pre"]).toBe("Connection timed out");
    expect(useAppStore.getState().terminalSpawnErrorKinds["tab-pre"]).toBe("timeout");
  });

  it("connects on Retry, once the handed-over failure is shown", async () => {
    stashPreconnectFailure("tab-retry", new Error("Connection refused"));
    renderTab("tab-retry");
    await act(async () => {
      await wait(50);
    });
    expect(mockCreateTerminal).not.toHaveBeenCalled();

    await act(async () => {
      useAppStore.getState().retryTerminalSpawn("tab-retry");
      await wait(50);
    });
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
  });

  it("connects as usual when no pre-connect failure was handed over", async () => {
    renderTab("tab-plain");
    await act(async () => {
      await wait(50);
    });
    expect(mockCreateTerminal).toHaveBeenCalledTimes(1);
  });
});
