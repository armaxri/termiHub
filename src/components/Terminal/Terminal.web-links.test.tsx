import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";

// PROD-056: URLs in terminal output become clickable via @xterm/addon-web-links.
// A clicked link must be handed to the app's scheme-allowlisted external-open
// path (safeOpenExternal, SEC-012) — never a raw OS opener — so a disallowed
// scheme (file:, javascript:, …) can never reach the OS handler. These tests
// lock in that the addon is wired with such a handler, that the handler enforces
// the allowlist, and that the addon is disposed on teardown.

// Shared state reachable from the hoisted vi.mock factories below.
const h = vi.hoisted(() => {
  const webLinksInstances: Array<{
    handler: ((event: MouseEvent, uri: string) => void) | undefined;
    dispose: ReturnType<typeof vi.fn>;
  }> = [];
  return { webLinksInstances };
});

// The real openUrl is the sole side effect inside safeOpenExternal; mocking it
// (instead of safeOpenExternal itself) exercises the real allowlist, so the
// "disallowed scheme is blocked" assertion is genuine.
const mockOpenUrl = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => mockOpenUrl(...args),
}));

vi.mock("@xterm/xterm", async () => {
  const { MockXTerm } = await import("@/test/mockXterm");
  return { Terminal: MockXTerm };
});

vi.mock("@xterm/addon-web-links", () => {
  class MockWebLinksAddon {
    handler: ((event: MouseEvent, uri: string) => void) | undefined;
    dispose = vi.fn();
    constructor(handler?: (event: MouseEvent, uri: string) => void) {
      this.handler = handler;
      h.webLinksInstances.push(this);
    }
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
let unmounted = false;

function unmountOnce() {
  if (unmounted) return;
  unmounted = true;
  act(() => root.unmount());
}

beforeEach(() => {
  h.webLinksInstances.length = 0;
  mockOpenUrl.mockClear();
  unmounted = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  unmountOnce();
  container.remove();
});

function renderTerminal() {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal tabId="tab-1" config={{ type: "local", config: {} }} isVisible={true} />
      </TerminalPortalProvider>
    );
  });
}

describe("Terminal clickable web links (PROD-056)", () => {
  it("registers the web-links addon with a click handler", () => {
    renderTerminal();
    expect(h.webLinksInstances).toHaveLength(1);
    expect(typeof h.webLinksInstances[0].handler).toBe("function");
  });

  it("routes an allowed link through safeOpenExternal to the OS opener", async () => {
    renderTerminal();
    const handler = h.webLinksInstances[0].handler!;

    await act(async () => {
      handler(new MouseEvent("click"), "https://example.com/path");
      // Let the fire-and-forget safeOpenExternal promise settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com/path");
  });

  it("blocks a disallowed scheme — the OS opener is never called", async () => {
    renderTerminal();
    const handler = h.webLinksInstances[0].handler!;

    await act(async () => {
      handler(new MouseEvent("click"), "file:///etc/passwd");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOpenUrl).not.toHaveBeenCalled();
  });

  it("disposes the web-links addon on teardown", () => {
    renderTerminal();
    const addon = h.webLinksInstances[0];
    expect(addon.dispose).not.toHaveBeenCalled();

    unmountOnce();

    expect(addon.dispose).toHaveBeenCalledTimes(1);
  });
});
