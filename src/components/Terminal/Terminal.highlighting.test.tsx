/**
 * Lifecycle tests for wiring the syntax-highlighting engine into the terminal
 * (epic #1696, child #1700).
 *
 * These verify the *wiring* in Terminal.tsx — not the engine internals, which
 * are covered by `src/services/syntaxHighlighting.test.ts`. The engine class is
 * mocked so the assertions focus on the terminal lifecycle:
 *
 *  - an engine is instantiated per xterm instance and bound to it,
 *  - it is left disabled when highlighting is off (the shipped default),
 *  - it is enabled with the resolved active rules when highlighting is on,
 *  - toggling the global switch off live disables it,
 *  - a per-session toggle overrides the resolved state, and
 *  - it is disposed on unmount so no decorations or listeners leak.
 */

import { setupSettingsRegionMirror } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { defaultHighlightingConfig } from "@/services/syntaxHighlightingConfig";
import type { SyntaxHighlightingConfig } from "@/types/syntaxHighlighting";

// --- Mocks ---

// Capture every engine instance the component constructs so assertions can
// inspect the enable/disable/dispose calls made against the live terminal.
const { engineInstances, MockEngine } = vi.hoisted(() => {
  class MockEngine {
    enable = vi.fn();
    disable = vi.fn();
    updateRules = vi.fn();
    dispose = vi.fn();
    xterm: unknown;
    constructor(xterm: unknown) {
      this.xterm = xterm;
      instances.push(this);
    }
  }
  const instances: MockEngine[] = [];
  return { engineInstances: instances, MockEngine };
});

vi.mock("@/services/syntaxHighlighting", () => ({
  SyntaxHighlightingEngine: MockEngine,
}));

vi.mock("@xterm/xterm", () => {
  class MockXTerm {
    open = vi.fn();
    dispose = vi.fn();
    loadAddon = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() }));
    onScroll = vi.fn(() => ({ dispose: vi.fn() }));
    onCursorMove = vi.fn(() => ({ dispose: vi.fn() }));
    onWriteParsed = vi.fn(() => ({ dispose: vi.fn() }));
    write = vi.fn((_data: unknown, cb?: () => void) => cb?.());
    writeln = vi.fn();
    scrollToBottom = vi.fn();
    scrollLines = vi.fn();
    selectAll = vi.fn();
    hasSelection = vi.fn(() => false);
    getSelection = vi.fn(() => "");
    attachCustomKeyEventHandler = vi.fn();
    unicode = { activeVersion: "6" };
    cols = 80;
    rows = 24;
    resize = vi.fn();
    focus = vi.fn();
    element = document.createElement("div");
    buffer = { active: { viewportY: 0, baseY: 0, length: 0, getLine: vi.fn() } };
    parser = { registerOscHandler: vi.fn(() => ({ dispose: vi.fn() })) };
    options = {};
  }
  return { Terminal: MockXTerm };
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

vi.mock("@xterm/addon-serialize", () => {
  class MockSerializeAddon {
    serialize = vi.fn(() => "");
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

globalThis.ResizeObserver = class {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
} as unknown as typeof ResizeObserver;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  engineInstances.length = 0;
  mockCreateTerminal.mockClear();
  mockCreateTerminal.mockResolvedValue("session-1");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const LOCAL_CONFIG = { type: "local" as const, config: {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setHighlighting(config: SyntaxHighlightingConfig | undefined): void {
  useAppStore.setState((s) => ({
    settings: { ...s.settings, syntaxHighlighting: config },
  }));
}

function renderTerminal(existingSessionId: string | null = null): void {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal
          tabId="tab-1"
          config={LOCAL_CONFIG}
          isVisible={true}
          existingSessionId={existingSessionId}
        />
      </TerminalPortalProvider>
    );
  });
}

setupSettingsRegionMirror();

describe("Terminal — syntax-highlighting engine wiring", () => {
  it("constructs one engine bound to the xterm and leaves it disabled by default", async () => {
    // Default settings ship highlighting off.
    renderTerminal();
    await act(async () => {
      await wait(20);
    });

    expect(engineInstances).toHaveLength(1);
    const engine = engineInstances[0];
    expect(engine.xterm).toBeTruthy();
    expect(engine.disable).toHaveBeenCalled();
    expect(engine.enable).not.toHaveBeenCalled();
  });

  it("enables the engine with the resolved active rules when highlighting is on", async () => {
    setHighlighting({ ...defaultHighlightingConfig(), enabled: true });

    renderTerminal();
    await act(async () => {
      await wait(20);
    });

    expect(engineInstances).toHaveLength(1);
    const engine = engineInstances[0];
    expect(engine.enable).toHaveBeenCalled();
    // The shipped P0/P1 built-ins resolve to a non-empty active-rule list.
    const rules = engine.enable.mock.calls[0][0];
    expect(Array.isArray(rules)).toBe(true);
    expect(rules.length).toBeGreaterThan(0);
  });

  it("toggles the engine off live when the global switch is turned off", async () => {
    setHighlighting({ ...defaultHighlightingConfig(), enabled: true });

    renderTerminal();
    await act(async () => {
      await wait(20);
    });

    const engine = engineInstances[0];
    expect(engine.enable).toHaveBeenCalled();
    engine.disable.mockClear();

    act(() => {
      setHighlighting({ ...defaultHighlightingConfig(), enabled: false });
    });
    await act(async () => {
      await wait(20);
    });

    expect(engine.disable).toHaveBeenCalled();
  });

  it("lets a per-session toggle force highlighting on even when the global switch is off", async () => {
    // Global off — the engine starts disabled.
    renderTerminal();
    await act(async () => {
      await wait(20);
    });

    const engine = engineInstances[0];
    expect(engine.enable).not.toHaveBeenCalled();

    // The status-bar quick toggle (#1704) forces this live session on. The prop
    // update mirrors the store writing the session id back after connect.
    act(() => {
      useAppStore.getState().setSessionHighlighting("session-1", true);
    });
    renderTerminal("session-1");
    await act(async () => {
      await wait(20);
    });

    expect(engine.enable).toHaveBeenCalled();
  });

  it("disposes the engine on unmount", async () => {
    renderTerminal();
    await act(async () => {
      await wait(20);
    });

    const engine = engineInstances[0];
    act(() => root.unmount());

    expect(engine.dispose).toHaveBeenCalled();
  });
});
