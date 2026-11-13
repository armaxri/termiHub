/**
 * Scrollback separators for dropped sessions (#5619, #5660).
 *
 * A dropped serial device or network link is not a process exit, so the
 * terminal writes "— device disconnected hh:mm:ss —" / "— connection lost
 * hh:mm:ss —" instead of "[Process exited]"; a real local process exit keeps
 * "[Process exited]". After a reconnect, a "— reconnected hh:mm:ss —" marker
 * separates the old scrollback from the new session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { mockXtermInstances as xtermInstances } from "@/test/mockXterm";
import type { ConnectionConfig } from "@/types/terminal";

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

vi.mock("@xterm/addon-serialize", () => {
  class MockSerializeAddon {
    serialize = vi.fn(() => "old scrollback\r\n");
    dispose = vi.fn();
  }
  return { SerializeAddon: MockSerializeAddon };
});

vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

const mockCreateTerminal = vi.fn().mockResolvedValue("session-1");

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

const exitHandlers = vi.hoisted(() => new Map<string, (code: number | null) => void>());

vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: vi.fn(() => vi.fn()),
    subscribeExit: vi.fn((sessionId: string, cb: (code: number | null) => void) => {
      exitHandlers.set(sessionId, cb);
      return vi.fn();
    }),
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
  exitHandlers.clear();
  xtermInstances.length = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(config: ConnectionConfig): Promise<void> {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal tabId="tab-1" config={config} isVisible={true} />
      </TerminalPortalProvider>
    );
  });
  await act(async () => {
    await wait(50);
  });
}

/** Everything the latest xterm instance got through `writeln`. */
function written(): string {
  const xterm = xtermInstances[xtermInstances.length - 1];
  return xterm.writeln.mock.calls.map((call) => String(call[0])).join("\n");
}

async function fireExit(code: number | null): Promise<void> {
  const onExit = exitHandlers.get("session-1");
  expect(onExit).toBeDefined();
  await act(async () => {
    onExit?.(code);
    await wait(0);
  });
}

const CLOCK = /\d{2}:\d{2}:\d{2}/.source;

describe("Terminal — drop separators (#5619)", () => {
  it("writes a connection-lost line, not [Process exited], when an SSH link drops", async () => {
    await mount({ type: "ssh", config: { host: "bastion", username: "me" } });
    await fireExit(null);
    expect(written()).toMatch(new RegExp(`— connection lost ${CLOCK} —`));
    expect(written()).not.toContain("[Process exited]");
  });

  it("writes a device-disconnected line when a serial device is unplugged", async () => {
    await mount({ type: "serial", config: { port: "/dev/ttyUSB0", baudRate: 9600 } });
    await fireExit(null);
    expect(written()).toMatch(new RegExp(`— device disconnected ${CLOCK} —`));
    expect(written()).not.toContain("[Process exited]");
  });

  it("writes a connection-lost line when the telnet server closes the connection", async () => {
    await mount({ type: "telnet", config: { host: "router", port: 23 } });
    await fireExit(null);
    expect(written()).toMatch(new RegExp(`— connection lost ${CLOCK} —`));
  });

  it("keeps [Process exited] for a local shell", async () => {
    await mount({ type: "local", config: { shell: "/bin/bash" } });
    await fireExit(null);
    expect(written()).toContain("[Process exited]");
  });

  it("keeps the exit code for a remote process that exited", async () => {
    await mount({ type: "ssh", config: { host: "bastion" } });
    await fireExit(0);
    expect(written()).toContain("[Process exited with code 0]");
  });
});

describe("Terminal — reconnected marker (#5660)", () => {
  it("writes a reconnected marker into the fresh terminal after a reconnect", async () => {
    await mount({ type: "ssh", config: { host: "bastion" } });
    expect(written()).not.toContain("reconnected");

    act(() => {
      useAppStore.getState().reconnectTerminal("tab-1");
    });
    await act(async () => {
      await wait(50);
    });

    expect(written()).toMatch(new RegExp(`— reconnected ${CLOCK} —`));
  });
});
