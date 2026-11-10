/**
 * Registry-driven dispatch coverage for {@link useKeyboardShortcuts} (#5174).
 *
 * Unlike `useKeyboardShortcuts.test.ts`, which mocks the keybinding service
 * and feeds the hook a pre-resolved action, this suite runs the REAL service:
 * every binding in {@link DEFAULT_BINDINGS} is pressed as an actual key event
 * (both strokes of a chord) on both platforms' defaults, and the test asserts
 * the matching store action / context command fires. A binding listed in the
 * shortcuts overlay that does nothing when pressed fails here.
 *
 * The table guard at the bottom fails when an action is added to the registry
 * without an entry in {@link DISPATCH} (or an explicit {@link NOT_DISPATCHED}
 * reason), so a new binding cannot ship without a dispatch test.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";

const platform = vi.hoisted(() => ({ mac: false }));

vi.mock("@/utils/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/platform")>()),
  isMac: () => platform.mac,
}));

vi.mock("@/services/landmarkFocus", () => ({
  cycleLandmarkFocus: vi.fn(() => null),
}));

vi.mock("@/services/storage", () => ({
  loadConnections: vi.fn(() =>
    Promise.resolve({ connections: [], folders: [], agents: [], externalErrors: [] })
  ),
  persistConnection: vi.fn(() => Promise.resolve()),
  removeConnection: vi.fn(() => Promise.resolve()),
  persistFolder: vi.fn(() => Promise.resolve()),
  removeFolder: vi.fn(() => Promise.resolve()),
  getSettings: vi.fn(() =>
    Promise.resolve({
      version: "1",
      externalConnectionFiles: [],
      powerMonitoringEnabled: true,
      fileBrowserEnabled: true,
    })
  ),
  saveSettings: vi.fn(() => Promise.resolve()),
  moveConnectionToFile: vi.fn(() => Promise.resolve()),
  reloadExternalConnections: vi.fn(() => Promise.resolve([])),
  getRecoveryWarnings: vi.fn(() => Promise.resolve([])),
}));

vi.mock("@/services/api", () => ({
  sftpOpen: vi.fn(),
  sftpClose: vi.fn(),
  sftpListDir: vi.fn(),
  localListDir: vi.fn(),
  vscodeAvailable: vi.fn(() => Promise.resolve(false)),
}));

import {
  DEFAULT_BINDINGS,
  RELEASE_CHORD_ACTION,
  cancelChord,
  clearOverrides,
  getActionScope,
  isChordPending,
  setOverride,
  unbindAction,
} from "@/services/keybindings";
import { CONTEXT_COMMANDS } from "@/services/contextCommands";
import { cycleLandmarkFocus } from "@/services/landmarkFocus";
import { useAppStore, type AppState } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";
import type { KeyCombo } from "@/types/keybindings";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { layoutState } from "@/test/layoutState";

setupSettingsRegion();

/** How to observe that an action was dispatched. */
interface Effect {
  /** Install a spy on the dispatch target and return it. */
  install: () => Mock;
  /** Arguments the target must be called with. */
  args: unknown[];
}

/** Spy on a root-store action (the hook calls `useAppStore.getState().<name>()`). */
function store(name: keyof AppState, ...args: unknown[]): Effect {
  return {
    install: () => {
      const spy = vi.fn();
      useAppStore.setState({ [name]: spy } as unknown as Partial<AppState>);
      return spy;
    },
    args,
  };
}

/** Spy on a shared context command's `run` (palette and keyboard share it). */
function context(action: string): Effect {
  return {
    install: () => vi.spyOn(CONTEXT_COMMANDS[action], "run").mockImplementation(() => {}) as Mock,
    args: [],
  };
}

/** Landmark focus cycling (F6 family). */
function landmark(delta: 1 | -1): Effect {
  return { install: () => vi.mocked(cycleLandmarkFocus) as unknown as Mock, args: [delta] };
}

/** Expected dispatch target of every action the global shortcut engine fires. */
const DISPATCH: Record<string, Effect> = {
  "toggle-sidebar": store("toggleSidebar"),
  "open-settings": store("openSettingsTab"),
  "command-palette": store("setCommandPaletteOpen", true),
  "new-window": store("openNewWindow"),
  "show-shortcuts": store("setShortcutsOverlayOpen", true),
  "show-shortcuts-outside-terminal": store("setShortcutsOverlayOpen", true),
  "new-terminal": store("addTab", "Terminal", "local"),
  "toggle-macro-recording": store("toggleMacroRecording"),
  "toggle-broadcast": store("toggleBroadcast"),
  "split-right": store("splitPanel", "horizontal"),
  "split-down": store("splitPanel", "vertical"),
  "focus-next-region": landmark(1),
  "focus-prev-region": landmark(-1),
  "focus-next-region-anywhere": landmark(1),
  "focus-prev-region-anywhere": landmark(-1),
  "zoom-panel": store("toggleZoomActiveTab"),
  "zoom-in": store("zoomIn"),
  "zoom-out": store("zoomOut"),
  "zoom-reset": store("zoomReset"),
  "new-tab-group": store("addTabGroup"),
  ...Object.fromEntries(Object.keys(CONTEXT_COMMANDS).map((a) => [a, context(a)])),
};

/** Registry actions that deliberately never fire through the global engine. */
const NOT_DISPATCHED: Record<string, string> = {
  [RELEASE_CHORD_ACTION]: "modifier-only chord read directly by the remote-desktop canvas",
};

/**
 * Bindings for actions that ship unbound (`null` default), so their dispatch
 * is still exercised. Ctrl+Alt+Shift+<digit> collides with no default.
 */
const TEST_BINDINGS: Record<string, KeyCombo> = {};
for (const [i, b] of DEFAULT_BINDINGS.filter(
  (b) => b.macDefault === null || b.winLinuxDefault === null
).entries()) {
  TEST_BINDINGS[b.action] = { key: String(i + 1), ctrl: true, alt: true, shift: true };
}

const DISPATCHED_BINDINGS = DEFAULT_BINDINGS.filter((b) => !(b.action in NOT_DISPATCHED));

function KeyboardHarness() {
  useKeyboardShortcuts();
  return null;
}

/** Press one combo, from the page (`document.body`) or a focused xterm. */
function press(combo: KeyCombo, fromTerminal = false): boolean {
  const event = new KeyboardEvent("keydown", {
    key: combo.key,
    ctrlKey: !!combo.ctrl,
    shiftKey: !!combo.shift,
    altKey: !!combo.alt,
    metaKey: !!combo.meta,
    bubbles: true,
    cancelable: true,
  });
  let target: Element = document.body;
  let xterm: HTMLDivElement | null = null;
  if (fromTerminal) {
    xterm = document.createElement("div");
    xterm.className = "xterm";
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    xterm.appendChild(textarea);
    document.body.appendChild(xterm);
    target = textarea;
  }
  try {
    target.dispatchEvent(event);
  } finally {
    xterm?.remove();
  }
  return event.defaultPrevented;
}

/** Press every stroke of a binding; returns whether the LAST stroke was consumed. */
function pressBinding(binding: KeyCombo | KeyCombo[], fromTerminal = false): boolean {
  const strokes = Array.isArray(binding) ? binding : [binding];
  strokes.slice(0, -1).forEach((leader) => {
    expect(press(leader, fromTerminal)).toBe(true);
    expect(isChordPending()).toBe(true);
  });
  return press(strokes[strokes.length - 1], fromTerminal);
}

describe.each([
  ["mac", true],
  ["win/linux", false],
] as const)("useKeyboardShortcuts dispatch (%s defaults)", (_label, mac) => {
  let container: HTMLDivElement;
  let root: Root;

  /** The binding to press for an action on this platform. */
  function bindingFor(action: string): KeyCombo | KeyCombo[] {
    const b = DEFAULT_BINDINGS.find((x) => x.action === action)!;
    return (mac ? b.macDefault : b.winLinuxDefault) ?? TEST_BINDINGS[action];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    platform.mac = mac;
    useAppStore.setState(useAppStore.getInitialState());
    for (const [action, combo] of Object.entries(TEST_BINDINGS)) setOverride(action, combo);
    // Terminal-scoped actions only fire against an active terminal tab.
    const tabId = useAppStore.getState().addTab("Shell", "local");
    const panel = getAllLeaves(layoutState().rootPanel)[0];
    useAppStore.getState().setActiveTab(tabId, panel.id);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(KeyboardHarness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    cancelChord();
    clearOverrides();
    vi.restoreAllMocks();
  });

  describe.each(DISPATCHED_BINDINGS.map((b) => b.action))("%s", (action) => {
    it("fires its action with no terminal focused", () => {
      const spy = DISPATCH[action].install();

      expect(pressBinding(bindingFor(action))).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(...DISPATCH[action].args);
    });

    const scope = getActionScope(action);
    const yieldsInTerminal = scope === "yields-to-terminal" || scope === "editor-delegated";

    it(
      yieldsInTerminal
        ? "passes through to a focused terminal (not fired, not consumed)"
        : "still fires from a focused terminal",
      () => {
        const spy = DISPATCH[action].install();

        const consumed = pressBinding(bindingFor(action), true);

        expect(consumed).toBe(!yieldsInTerminal);
        expect(spy).toHaveBeenCalledTimes(yieldsInTerminal ? 0 : 1);
      }
    );
  });

  describe("chord cancel", () => {
    // macOS ships the only default chord (Cmd+K Cmd+S); give win/linux one too.
    const chord: KeyCombo[] = mac
      ? [
          { key: "k", meta: true },
          { key: "s", meta: true },
        ]
      : [
          { key: "k", ctrl: true, alt: true, shift: true },
          { key: "s", ctrl: true, alt: true, shift: true },
        ];

    beforeEach(() => {
      if (!mac) setOverride("show-shortcuts", chord);
    });

    it("shows the pending chord in the status bar state after the leader", () => {
      expect(press(chord[0])).toBe(true);
      expect(useAppStore.getState().chordPending).toEqual(expect.any(String));
    });

    it("Escape cancels the chord, clears the status bar state and fires nothing", () => {
      const spy = DISPATCH["show-shortcuts"].install();
      press(chord[0]);

      expect(press({ key: "Escape" })).toBe(false);

      expect(isChordPending()).toBe(false);
      expect(useAppStore.getState().chordPending).toBeNull();
      // The second stroke alone no longer completes the cancelled chord.
      press(chord[1]);
      expect(spy).not.toHaveBeenCalled();
    });

    it("times out and clears the status bar state", () => {
      vi.useFakeTimers();
      try {
        press(chord[0]);
        vi.advanceTimersByTime(1500);
        expect(isChordPending()).toBe(false);
        expect(useAppStore.getState().chordPending).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a non-completing binding cancels the chord and fires its own action", () => {
      const overlay = DISPATCH["show-shortcuts"].install();
      const sidebar = DISPATCH["toggle-sidebar"].install();
      press(chord[0]);

      expect(pressBinding(bindingFor("toggle-sidebar"))).toBe(true);

      expect(sidebar).toHaveBeenCalledTimes(1);
      expect(overlay).not.toHaveBeenCalled();
      expect(useAppStore.getState().chordPending).toBeNull();
    });
  });

  describe("zoom-panel honours the effective binding", () => {
    const zoomDefault = (): KeyCombo => bindingFor("zoom-panel") as KeyCombo;

    it("does not zoom on the default combo once zoom-panel is unbound", () => {
      unbindAction("zoom-panel");
      const spy = DISPATCH["zoom-panel"].install();

      expect(press(zoomDefault())).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    it("moves the zoom to a rebound combo and frees the old default", () => {
      setOverride("zoom-panel", { key: "z", alt: true, shift: true });
      const spy = DISPATCH["zoom-panel"].install();

      expect(press(zoomDefault())).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      expect(press({ key: "z", alt: true, shift: true })).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("does not zoom on the other platform's modifier", () => {
      const spy = DISPATCH["zoom-panel"].install();
      const other: KeyCombo = mac
        ? { key: "Enter", ctrl: true, shift: true }
        : { key: "Enter", meta: true, shift: true };

      press(other);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});

describe("dispatch table guard", () => {
  it("every registry action has a dispatch expectation or an explicit exclusion", () => {
    const missing = DEFAULT_BINDINGS.map((b) => b.action).filter(
      (a) => !(a in DISPATCH) && !(a in NOT_DISPATCHED)
    );
    expect(missing).toEqual([]);
  });

  it("the dispatch table names no action that is not in the registry", () => {
    const known = new Set(DEFAULT_BINDINGS.map((b) => b.action));
    expect(Object.keys(DISPATCH).filter((a) => !known.has(a))).toEqual([]);
  });
});
