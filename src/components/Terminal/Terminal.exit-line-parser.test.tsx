/**
 * The exit line with a frontend-plugin protocol parser active (#5965).
 *
 * With a parser registered, output reaches the terminal through the sandbox
 * worker, out of band. The exit line must still come after every chunk the
 * parser has not returned yet, so it queues behind them.
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
  getAgentSessionBuffer: vi.fn().mockResolvedValue({ data: new Uint8Array(), endOffset: 0 }),
}));

type ExitHandler = (code: number | null, endCause: string | null) => void;
const exitHandlers = vi.hoisted(() => new Map<string, ExitHandler>());
type OutputHandler = (data: Uint8Array) => void;
const outputHandlers = vi.hoisted(() => new Map<string, OutputHandler>());

vi.mock("@/services/events", () => ({
  terminalDispatcher: {
    init: vi.fn().mockResolvedValue(undefined),
    subscribeOutput: vi.fn((sessionId: string, cb: OutputHandler) => {
      outputHandlers.set(sessionId, cb);
      return vi.fn();
    }),
    subscribeExit: vi.fn((sessionId: string, cb: ExitHandler) => {
      exitHandlers.set(sessionId, cb);
      return vi.fn();
    }),
    clearPendingExit: vi.fn(),
    holdOutput: () => ({ drain: () => [], release: vi.fn() }),
  },
}));

// A controllable sandbox host: a protocol parser is registered, and each
// output chunk stays in flight until the test releases it (#5965). Pass-through
// entries queue behind the in-flight chunks in arrival order, as the real
// host's FIFO does.
const sandbox = vi.hoisted(() => {
  type Sink = (bytes: Uint8Array) => void;
  const fifo: Array<{ bytes: Uint8Array; sink: Sink; done: boolean }> = [];
  const drain = () => {
    while (fifo.length > 0 && fifo[0].done) {
      const head = fifo.shift()!;
      head.sink(head.bytes);
    }
  };
  return {
    fifo,
    releaseAll: () => {
      for (const entry of fifo) entry.done = true;
      drain();
    },
    enqueue: (bytes: Uint8Array, sink: Sink) => {
      fifo.push({ bytes, sink, done: false });
    },
    passthrough: (bytes: Uint8Array): boolean => {
      if (fifo.length === 0) return false;
      fifo.push({ bytes, sink: fifo[fifo.length - 1].sink, done: true });
      drain();
      return true;
    },
  };
});

vi.mock("@/plugins/sandbox/pluginSandboxHost", () => ({
  sandboxHasParsers: () => true,
  sandboxSessionPending: () => sandbox.fifo.length > 0,
  enqueueSandboxTransform: (_id: string, bytes: Uint8Array, sink: (b: Uint8Array) => void) =>
    sandbox.enqueue(bytes, sink),
  enqueueSandboxPassthrough: (_id: string, bytes: Uint8Array) => sandbox.passthrough(bytes),
  sandboxNotifySessionStart: vi.fn(),
  sandboxNotifySessionEnd: vi.fn(),
  discardSandboxSession: vi.fn(),
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
  outputHandlers.clear();
  sandbox.fifo.length = 0;
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

const decoder = new TextDecoder();

/** Everything the latest xterm instance got through `write` and `writeln`, in order. */
function written(): string {
  const xterm = xtermInstances[xtermInstances.length - 1];
  const calls = [
    ...xterm.write.mock.calls.map((call, i) => ({
      order: xterm.write.mock.invocationCallOrder[i],
      text: typeof call[0] === "string" ? call[0] : decoder.decode(call[0] as Uint8Array),
    })),
    ...xterm.writeln.mock.calls.map((call, i) => ({
      order: xterm.writeln.mock.invocationCallOrder[i],
      text: String(call[0]),
    })),
  ];
  return calls
    .sort((a, b) => a.order - b.order)
    .map((c) => c.text)
    .join("\n");
}

describe("Terminal — exit line with a protocol parser (#5965)", () => {
  it("writes the exit line after output still in the parser sandbox", async () => {
    await mount({ type: "local", config: { shell: "/bin/zsh" } });
    const onOutput = outputHandlers.get("session-1");
    expect(onOutput).toBeDefined();
    await act(async () => {
      // The last line is still in the parser worker when the shell exits.
      onOutput?.(new TextEncoder().encode("parsed last line\r\n"));
      exitHandlers.get("session-1")?.(3, null);
      await wait(30);
    });
    await act(async () => {
      sandbox.releaseAll();
      await wait(30);
    });
    const text = written();
    expect(text).toContain("parsed last line");
    expect(text).toContain("[Process exited with code 3]");
    expect(text.indexOf("parsed last line")).toBeLessThan(
      text.indexOf("[Process exited with code 3]")
    );
  });

  it("writes the exit line at once when nothing is in flight", async () => {
    await mount({ type: "local", config: { shell: "/bin/zsh" } });
    await act(async () => {
      exitHandlers.get("session-1")?.(0, null);
      await wait(30);
    });
    expect(written()).toContain("[Process exited with code 0]");
  });
});
