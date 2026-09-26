/**
 * PROD-057: inline images (SIXEL + iTerm2 IIP) via @xterm/addon-image. These
 * tests pin that the Terminal loads the addon — lazily, with the conservative
 * memory caps — when the "Inline Images" setting is on (the default), skips it
 * when off, toggles it live, disposes it on teardown, and that the scrollback
 * snapshot/replay path (#1126) is unaffected by the image addon.
 */

import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Terminal } from "./Terminal";
import { TerminalPortalProvider } from "./TerminalRegistry";
import { INLINE_IMAGE_ADDON_OPTIONS } from "./inlineImages";
import { useAppStore } from "@/store/appStore";
import { mockXtermInstances as xtermInstances } from "@/test/mockXterm";

// Shared state reachable from the hoisted vi.mock factories below.
const h = vi.hoisted(() => {
  const imageInstances: Array<{ options: unknown; dispose: ReturnType<typeof vi.fn> }> = [];
  const serializeInstances: Array<{ serialize: ReturnType<typeof vi.fn> }> = [];
  return { imageInstances, serializeInstances };
});

vi.mock("@xterm/addon-image", () => {
  class MockImageAddon {
    options: unknown;
    dispose = vi.fn();
    activate = vi.fn();
    constructor(options?: unknown) {
      this.options = options;
      h.imageInstances.push(this);
    }
  }
  return { ImageAddon: MockImageAddon };
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
    serialize = vi.fn(() => "previous scrollback");
    dispose = vi.fn();
    constructor() {
      h.serializeInstances.push(this);
    }
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

let unmounted = false;
function unmountOnce(): void {
  if (unmounted) return;
  unmounted = true;
  act(() => root.unmount());
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  xtermInstances.length = 0;
  h.imageInstances.length = 0;
  h.serializeInstances.length = 0;
  mockCreateTerminal.mockClear();
  mockCreateTerminal.mockResolvedValue("session-1");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  unmounted = false;
});

afterEach(() => {
  unmountOnce();
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

/** Let the lazy `import()` of the addon and the connect flow settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await wait(20);
  });
}

function loadedImageAddons(): unknown[] {
  const loadAddon = xtermInstances[0].loadAddon as ReturnType<typeof vi.fn>;
  return loadAddon.mock.calls
    .map((call) => call[0])
    .filter((addon) => h.imageInstances.includes(addon as never));
}

setupSettingsRegion();

describe("Terminal — inline images (PROD-057)", () => {
  it("loads the image addon by default with the conservative memory limits", async () => {
    renderTerminal();
    await settle();

    expect(h.imageInstances).toHaveLength(1);
    expect(loadedImageAddons()).toEqual([h.imageInstances[0]]);
    expect(h.imageInstances[0].options).toEqual(INLINE_IMAGE_ADDON_OPTIONS);
    expect(h.imageInstances[0].options).toMatchObject({
      pixelLimit: 2048 * 2048,
      storageLimit: 32,
      sixelSizeLimit: 8_000_000,
      iipSizeLimit: 8_000_000,
    });
  });

  it("does not load the image addon when the setting is off", async () => {
    seedSettings({ terminalInlineImages: false });
    renderTerminal();
    await settle();

    expect(h.imageInstances).toHaveLength(0);
  });

  it("toggles the addon live when the setting changes", async () => {
    renderTerminal();
    await settle();
    const first = h.imageInstances[0];
    expect(first.dispose).not.toHaveBeenCalled();

    await act(async () => {
      seedSettings({ terminalInlineImages: false });
      await wait(20);
    });
    expect(first.dispose).toHaveBeenCalledTimes(1);

    await act(async () => {
      seedSettings({ terminalInlineImages: true });
      await wait(20);
    });
    expect(h.imageInstances).toHaveLength(2);
    expect(loadedImageAddons()).toEqual([first, h.imageInstances[1]]);
  });

  it("disposes the image addon on teardown", async () => {
    renderTerminal();
    await settle();
    const addon = h.imageInstances[0];

    unmountOnce();

    expect(addon.dispose).toHaveBeenCalledTimes(1);
  });

  it("still snapshots the scrollback on teardown with the image addon loaded", async () => {
    renderTerminal();
    await settle();
    expect(h.imageInstances).toHaveLength(1);

    unmountOnce();

    // The #1126 snapshot is taken from the serialize addon (text only); the
    // image addon must not interfere with it.
    expect(h.serializeInstances[0].serialize).toHaveBeenCalledTimes(1);
    expect(h.imageInstances[0].dispose).toHaveBeenCalledTimes(1);
  });
});
