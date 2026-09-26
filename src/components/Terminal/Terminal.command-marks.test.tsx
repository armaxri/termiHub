import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { mockXtermInstances, type MockXTerm } from "@/test/mockXterm";
import { getCommandMarkTracker, OSC_133 } from "@/services/commandMarks";

// OSC 133 command marks (#3415, PROD-059): Terminal wires an OSC 133 handler to
// a per-tab CommandMarkTracker, registers that tracker for the command bridge /
// palette, tears both down on unmount, and lets the prompt-navigation shortcuts
// fall through to the shell when it emits no marks (no behaviour change).

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
  isAppShortcut: vi.fn(() => true),
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
let unmounted = false;

function unmountOnce() {
  if (unmounted) return;
  unmounted = true;
  act(() => root.unmount());
}

beforeEach(() => {
  mockXtermInstances.length = 0;
  h.action = () => null;
  unmounted = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  unmountOnce();
  container.remove();
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

/** The OSC 133 registration on the mock xterm: `[ident, handler]` and its disposable. */
function osc133Registration(xterm: MockXTerm) {
  const calls = xterm.parser.registerOscHandler.mock.calls as unknown as Array<
    [number, (data: string) => boolean]
  >;
  const index = calls.findIndex(([ident]) => ident === OSC_133);
  const results = xterm.parser.registerOscHandler.mock.results as Array<{
    value: { dispose: ReturnType<typeof vi.fn> };
  }>;
  return index < 0 ? undefined : { handler: calls[index][1], disposable: results[index].value };
}

/** The custom key handler Terminal attached to xterm. */
function keyHandler(xterm: MockXTerm): (e: KeyboardEvent) => boolean {
  const calls = xterm.attachCustomKeyEventHandler.mock.calls as unknown as Array<
    [(e: KeyboardEvent) => boolean]
  >;
  return calls[0][0];
}

describe("Terminal OSC 133 command marks (#3415)", () => {
  it("registers an OSC 133 handler and a tracker for the tab", () => {
    const xterm = renderTerminal();
    const registration = osc133Registration(xterm);
    expect(registration).toBeDefined();
    // The handler consumes the sequence and never throws, even on garbage.
    expect(registration!.handler("garbage")).toBe(true);
    expect(getCommandMarkTracker("tab-1")).toBeDefined();
    expect(getCommandMarkTracker("tab-1")!.hasMarks()).toBe(false);
  });

  it("disposes the handler and unregisters the tracker on teardown", () => {
    const xterm = renderTerminal();
    const registration = osc133Registration(xterm)!;
    const tracker = getCommandMarkTracker("tab-1")!;
    const dispose = vi.spyOn(tracker, "dispose");

    unmountOnce();

    expect(registration.disposable.dispose).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(getCommandMarkTracker("tab-1")).toBeUndefined();
  });

  it("resets the tracker on a shell RIS (ESC c) and lets xterm reset too (#3420)", () => {
    const xterm = renderTerminal();
    const calls = xterm.parser.registerEscHandler.mock.calls as unknown as Array<
      [{ final: string }, () => boolean]
    >;
    const index = calls.findIndex(([id]) => id.final === "c");
    expect(index).toBeGreaterThanOrEqual(0);
    const reset = vi.spyOn(getCommandMarkTracker("tab-1")!, "reset");
    // false = not consumed: xterm's own full reset still runs.
    expect(calls[index][1]()).toBe(false);
    expect(reset).toHaveBeenCalledTimes(1);

    const results = xterm.parser.registerEscHandler.mock.results as Array<{
      value: { dispose: ReturnType<typeof vi.fn> };
    }>;
    unmountOnce();
    expect(results[index].value.dispose).toHaveBeenCalled();
  });

  it("lets prompt-navigation keys reach the shell when it emits no OSC 133", () => {
    const xterm = renderTerminal();
    h.action = () => "jump-prev-prompt";
    const key = new KeyboardEvent("keydown", { key: "ArrowUp", metaKey: true });
    // true = xterm handles the key (sends it to the shell), exactly as before.
    expect(keyHandler(xterm)(key)).toBe(true);
  });

  it("claims prompt-navigation keys once the shell emits marks", () => {
    const xterm = renderTerminal();
    vi.spyOn(getCommandMarkTracker("tab-1")!, "hasMarks").mockReturnValue(true);
    h.action = () => "jump-next-prompt";
    const key = new KeyboardEvent("keydown", { key: "ArrowDown", metaKey: true });
    expect(keyHandler(xterm)(key)).toBe(false);
  });

  it("keeps blocking unrelated app shortcuts regardless of marks", () => {
    const xterm = renderTerminal();
    h.action = () => "toggle-sidebar";
    const key = new KeyboardEvent("keydown", { key: "b", metaKey: true });
    expect(keyHandler(xterm)(key)).toBe(false);
  });
});
