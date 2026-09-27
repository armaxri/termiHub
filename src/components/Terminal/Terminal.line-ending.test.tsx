/**
 * MT-SSH-39: the line-ending setting reaches the session. The Terminal must push
 * `resolveLineEnding(perConnection, global)` to the backend via
 * `setSessionLineEnding` once the session is established — so the backend's
 * `send_input` normalizes what Enter sends — and re-push it whenever the global
 * default or this connection's override changes while the terminal is open.
 * A per-connection override wins over the global default; clearing it ("Use
 * global default") makes the session follow the global setting again.
 */

import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { resolveLineEnding } from "@/utils/lineEndings";
import type { LineEnding } from "@/types/terminal";

// --- Mocks ---

vi.mock("@xterm/xterm", async () => (await import("@/test/mockXterm")).createMockXtermModule());

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

const mockCreateTerminal = vi.fn().mockResolvedValue("session-1");
const mockSetSessionLineEnding = vi.fn().mockResolvedValue(undefined);

vi.mock("@/services/api", () => ({
  createTerminal: (...args: unknown[]) => mockCreateTerminal(...args),
  sendInput: vi.fn().mockResolvedValue(undefined),
  setSessionLineEnding: (...args: unknown[]) => mockSetSessionLineEnding(...args),
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
  mockCreateTerminal.mockResolvedValue("session-1");
  mockSetSessionLineEnding.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const TAB_ID = "tab-1";
const SSH_CONFIG = {
  type: "ssh" as const,
  config: { host: "example.test", port: 22, username: "user", authMethod: "password" },
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Set (or clear, with `undefined`) this tab's per-connection line-ending override. */
function setOverride(lineEnding: LineEnding | undefined): void {
  useAppStore.setState((s) => ({
    tabTerminalOptions: { ...s.tabTerminalOptions, [TAB_ID]: { lineEnding } },
  }));
}

function renderTerminal(): void {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal tabId={TAB_ID} config={SSH_CONFIG} isVisible={true} existingSessionId={null} />
      </TerminalPortalProvider>
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await wait(20);
  });
}

/** The line ending most recently pushed for the session. */
function lastPushed(): unknown {
  const calls = mockSetSessionLineEnding.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [sessionId, ending] = calls[calls.length - 1];
  expect(sessionId).toBe("session-1");
  return ending;
}

setupSettingsRegion();

describe("Terminal — line ending reaches the session (MT-SSH-39)", () => {
  it("pushes the global default when the connection has no override", async () => {
    seedSettings({ defaultLineEnding: "crlf" });
    renderTerminal();
    await settle();

    expect(mockSetSessionLineEnding).toHaveBeenCalledWith(
      "session-1",
      resolveLineEnding(undefined, "crlf")
    );
    expect(lastPushed()).toBe("crlf");
  });

  it("lets the per-connection override win over the global default", async () => {
    seedSettings({ defaultLineEnding: "crlf" });
    setOverride("lf");
    renderTerminal();
    await settle();

    expect(lastPushed()).toBe(resolveLineEnding("lf", "crlf"));
    expect(lastPushed()).toBe("lf");
  });

  it("re-pushes live when the global default or the override changes", async () => {
    seedSettings({ defaultLineEnding: "lf" });
    renderTerminal();
    await settle();
    expect(lastPushed()).toBe("lf");

    // Global default changes while the terminal is open.
    await act(async () => {
      seedSettings({ defaultLineEnding: "cr" });
      await wait(20);
    });
    expect(lastPushed()).toBe("cr");

    // A per-connection override takes precedence while it is set…
    await act(async () => {
      setOverride("crlf");
      await wait(20);
    });
    expect(lastPushed()).toBe("crlf");

    // …and "Use global default" (clearing it) follows the global setting again.
    await act(async () => {
      setOverride(undefined);
      await wait(20);
    });
    expect(lastPushed()).toBe("cr");
  });
});
