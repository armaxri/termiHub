/**
 * #4177: the experimental "Combine emoji" setting drives which xterm width
 * tables a terminal uses — Unicode 11 by default, the grapheme-clustering
 * addon when on — both at construction and on a live change.
 */

import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { useAppStore } from "@/store/appStore";
import { mockXtermInstances as xtermInstances } from "@/test/mockXterm";

const graphemes = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock("@xterm/addon-unicode-graphemes", () => {
  class MockUnicodeGraphemesAddon {
    dispose = vi.fn();
    constructor() {
      graphemes.instances.push(this);
    }
  }
  return { UnicodeGraphemesAddon: MockUnicodeGraphemesAddon };
});

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
  graphemes.instances.length = 0;
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

describe("Terminal — combine emoji setting (#4177)", () => {
  async function settle(): Promise<void> {
    await act(async () => {
      await wait(20);
    });
  }

  it("uses the Unicode 11 width tables by default without loading the graphemes addon", async () => {
    renderTerminal();
    await settle();

    expect(xtermInstances).toHaveLength(1);
    expect(xtermInstances[0].unicode.activeVersion).toBe("11");
    expect(graphemes.instances).toHaveLength(0);
  });

  it("loads the graphemes addon and activates it when the setting is on", async () => {
    seedSettings({ combineEmoji: true });
    renderTerminal();
    await settle();

    expect(graphemes.instances).toHaveLength(1);
    expect(xtermInstances[0].loadAddon).toHaveBeenCalledWith(graphemes.instances[0]);
    expect(xtermInstances[0].unicode.activeVersion).toBe("15-graphemes");
  });

  it("switches live in both directions, loading the addon only once", async () => {
    renderTerminal();
    await settle();
    expect(xtermInstances[0].unicode.activeVersion).toBe("11");

    await act(async () => {
      seedSettings({ combineEmoji: true });
      await wait(20);
    });
    expect(xtermInstances[0].unicode.activeVersion).toBe("15-graphemes");

    await act(async () => {
      seedSettings({ combineEmoji: false });
      await wait(20);
    });
    expect(xtermInstances[0].unicode.activeVersion).toBe("11");

    await act(async () => {
      seedSettings({ combineEmoji: true });
      await wait(20);
    });
    expect(xtermInstances[0].unicode.activeVersion).toBe("15-graphemes");
    expect(graphemes.instances).toHaveLength(1);
  });
});
