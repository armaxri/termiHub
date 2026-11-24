import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { mockXtermInstances, type MockXTerm } from "@/test/mockXterm";
import { OSC_133 } from "@/services/commandMarks";
import { createTerminal } from "@/services/api";
import { useShellPromptStore } from "@/store/shellPromptStore";

// #5891: a fresh shell with shell integration on is "starting" (neutral tab dot)
// until its first OSC 133 mark; a shell without integration never waits.

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
  getActionScope: vi.fn(() => "global"),
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
  useShellPromptStore.setState({ awaitingFirstPrompt: {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderTerminal(shellIntegration: boolean): Promise<MockXTerm> {
  await act(async () => {
    root.render(
      <TerminalPortalProvider>
        <Terminal
          tabId="tab-1"
          config={{ type: "local", config: { shell: "zsh", shellIntegration } }}
          isVisible={true}
        />
      </TerminalPortalProvider>
    );
  });
  // Let the connect effect reach createTerminal.
  await act(async () => {
    await vi.waitFor(() => expect(createTerminal).toHaveBeenCalled());
  });
  return mockXtermInstances[mockXtermInstances.length - 1];
}

function osc133Handler(xterm: MockXTerm): (data: string) => boolean {
  const calls = xterm.parser.registerOscHandler.mock.calls as unknown as Array<
    [number, (data: string) => boolean]
  >;
  const found = calls.find(([ident]) => ident === OSC_133);
  if (!found) throw new Error("no OSC 133 handler registered");
  return found[1];
}

const awaiting = () => useShellPromptStore.getState().awaitingFirstPrompt["tab-1"] === true;

describe("Terminal first-prompt wait (#5891)", () => {
  beforeEach(() => vi.mocked(createTerminal).mockClear());

  it("waits for the first prompt when shell integration is on", async () => {
    const xterm = await renderTerminal(true);
    expect(awaiting()).toBe(true);
    // A non-mark OSC 133 payload (properties) does not end the wait.
    osc133Handler(xterm)("P;k=v");
    expect(awaiting()).toBe(true);
    // The prompt mark does, and the tracker still consumes it.
    expect(osc133Handler(xterm)("A")).toBe(true);
    expect(awaiting()).toBe(false);
  });

  it("never waits when shell integration is off", async () => {
    await renderTerminal(false);
    expect(awaiting()).toBe(false);
  });
});
