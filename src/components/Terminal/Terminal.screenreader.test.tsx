/**
 * A11Y-006: the terminal must expose its output to assistive technology when the
 * user enables Screen Reader Mode. xterm's `screenReaderMode` mirrors output into
 * an offscreen live region a screen reader can read; these tests pin that the
 * setting drives that xterm option both at construction and on a live change.
 */

import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
// The shared mock records every constructed instance in `mockXtermInstances`,
// each seeding `options` from its constructor args so the ctor-provided
// `screenReaderMode` is observable (the live-update effect mutates the same object).
import { mockXtermInstances as xtermInstances } from "@/test/mockXterm";

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
  xtermInstances.length = 0;
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

function renderTerminal(): void {
  act(() => {
    root.render(
      <TerminalPortalProvider>
        <Terminal tabId="tab-1" config={LOCAL_CONFIG} isVisible={true} existingSessionId={null} />
      </TerminalPortalProvider>
    );
  });
}

setupSettingsRegion();

describe("Terminal — screen-reader mode reflects the setting (A11Y-006)", () => {
  it("enables xterm screenReaderMode when the setting is on", async () => {
    seedSettings({ screenReaderMode: true });

    renderTerminal();
    await act(async () => {
      await wait(20);
    });

    expect(xtermInstances).toHaveLength(1);
    expect(xtermInstances[0].options.screenReaderMode).toBe(true);
  });

  it("leaves xterm screenReaderMode off by default", async () => {
    renderTerminal();
    await act(async () => {
      await wait(20);
    });

    expect(xtermInstances).toHaveLength(1);
    expect(xtermInstances[0].options.screenReaderMode).toBe(false);
  });

  it("turns xterm screenReaderMode on live when the setting is toggled on", async () => {
    renderTerminal();
    await act(async () => {
      await wait(20);
    });
    expect(xtermInstances[0].options.screenReaderMode).toBe(false);

    await act(async () => {
      seedSettings({ screenReaderMode: true });
      await wait(20);
    });

    expect(xtermInstances[0].options.screenReaderMode).toBe(true);
  });
});
