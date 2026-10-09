/**
 * Mount-level wiring for the terminal's key router and OSC cwd handlers (#4350).
 *
 * The routing decisions themselves are table-tested in terminalInputRouting.test.ts;
 * this file proves Terminal actually hands them to xterm: the handler captured from
 * `attachCustomKeyEventHandler` swallows paste and prevents the native paste (the
 * double-paste guard), and the OSC 7 / OSC 9 handlers feed the tab's cwd.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { mockXtermInstances, type MockXTerm } from "@/test/mockXterm";
import { useAppStore } from "@/store/appStore";

const h = vi.hoisted(() => ({
  action: (_e: KeyboardEvent): string | null => null,
}));

vi.mock("@xterm/xterm", async () => {
  const { MockXTerm } = await import("@/test/mockXterm");
  return { Terminal: MockXTerm };
});

vi.mock("@xterm/addon-web-links", () => {
  class MockWebLinksAddon {
    dispose = vi.fn();
  }
  return { WebLinksAddon: MockWebLinksAddon };
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
    onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
  }
  return { SearchAddon: MockSearchAddon };
});

vi.mock("@xterm/addon-serialize", () => {
  class MockSerializeAddon {
    dispose = vi.fn();
    serialize = vi.fn(() => "");
  }
  return { SerializeAddon: MockSerializeAddon };
});

vi.mock("@xterm/addon-webgl", () => {
  class MockWebglAddon {
    dispose = vi.fn();
    onContextLoss = vi.fn();
  }
  return { WebglAddon: MockWebglAddon };
});

vi.mock("@/themes", () => ({
  getXtermTheme: vi.fn(() => ({})),
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/api", () => ({
  createTerminal: vi.fn().mockResolvedValue("session-1"),
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
  processKeyEvent: (e: KeyboardEvent) => h.action(e),
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
  mockXtermInstances.length = 0;
  h.action = () => null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function renderTerminal(): MockXTerm {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal tabId="tab-1" config={{ type: "local", config: {} }} isVisible={true} />
      </TerminalPortalProvider>
    );
  });
  return mockXtermInstances[mockXtermInstances.length - 1];
}

/** The custom key handler Terminal attached to xterm. */
function keyHandler(xterm: MockXTerm): (e: KeyboardEvent) => boolean {
  const calls = xterm.attachCustomKeyEventHandler.mock.calls as unknown as Array<
    [(e: KeyboardEvent) => boolean]
  >;
  return calls[0][0];
}

/** The OSC handler Terminal registered for `ident`. */
function oscHandler(xterm: MockXTerm, ident: number): (data: string) => boolean {
  const calls = xterm.parser.registerOscHandler.mock.calls as unknown as Array<
    [number, (data: string) => boolean]
  >;
  const call = calls.find(([id]) => id === ident);
  if (!call) throw new Error(`no OSC ${ident} handler registered`);
  return call[1];
}

describe("Terminal key routing wiring (#4350)", () => {
  it("swallows paste and prevents the native paste event", () => {
    const xterm = renderTerminal();
    h.action = () => "paste";
    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, cancelable: true });

    expect(keyHandler(xterm)(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets an unbound key reach the PTY", () => {
    const xterm = renderTerminal();
    const event = new KeyboardEvent("keydown", { key: "a", cancelable: true });

    expect(keyHandler(xterm)(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("Terminal OSC cwd wiring (#4350)", () => {
  it("sets the tab cwd from an OSC 7 file URI and ignores a non-file URI", () => {
    const setTabCwd = vi.fn();
    useAppStore.setState({ setTabCwd });
    const handler = oscHandler(renderTerminal(), 7);

    expect(handler("file:///home/user/my%20dir")).toBe(true);
    expect(handler("http://example.com/x")).toBe(true);

    expect(setTabCwd).toHaveBeenCalledTimes(1);
    expect(setTabCwd).toHaveBeenCalledWith("tab-1", "/home/user/my dir");
  });

  it("sets the tab cwd from an OSC 9;9 path and ignores other OSC 9 payloads", () => {
    const setTabCwd = vi.fn();
    useAppStore.setState({ setTabCwd });
    const handler = oscHandler(renderTerminal(), 9);

    expect(handler("9;C:\\Users\\foo")).toBe(true);
    expect(handler("4;1;50")).toBe(true);

    expect(setTabCwd).toHaveBeenCalledTimes(1);
    expect(setTabCwd).toHaveBeenCalledWith("tab-1", "C:\\Users\\foo");
  });
});
