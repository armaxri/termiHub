/**
 * Tests for the macro *playback* Zustand slice (#1675).
 *
 * Pins `playMacro` / `cancelMacroPlayback`: steps are injected in order through
 * the registered terminal-input injector, timing modes change observable
 * behaviour, playback can be cancelled mid-run, and the guards (missing macro,
 * empty macro, no connected terminal) surface a recoverable toast instead of
 * injecting. The injector and terminal are mocked so no real session is needed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { Macro } from "@/types/macro";

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

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(() => vi.fn()),
}));

vi.mock("@/services/macroApi", () => ({
  listMacros: vi.fn(() => Promise.resolve([])),
  getMacro: vi.fn(),
  saveMacro: vi.fn((m) => Promise.resolve(m)),
  deleteMacro: vi.fn(() => Promise.resolve()),
}));

import { useAppStore } from "./appStore";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import { registerTerminalInputInjector } from "@/services/macroPlayback";
import { toast } from "@/components/ui";

const macro = (id: string, steps: Macro["steps"]): Macro => ({
  id,
  name: `Macro ${id}`,
  description: "",
  tags: [],
  steps,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

/** Seed an active, connected terminal tab so playback has a valid target. */
function seedConnectedTerminal(tabId = "tab-active", sessionId: string | null = "sess-1") {
  const tab: TerminalTab = {
    id: tabId,
    sessionId,
    title: "term",
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "leaf-1",
    isActive: true,
  };
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs: [tab], activeTabId: tabId };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
  useAppStore.setState({ terminalExitedTabs: {} });
}

describe("appStore — macro playback slice (#1675)", () => {
  let injected: string[];

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    injected = [];
    registerTerminalInputInjector(async (_tabId, data) => {
      injected.push(data);
      return true;
    });
    vi.spyOn(toast, "error");
    vi.spyOn(toast, "info");
    vi.spyOn(toast, "success");
    vi.spyOn(toast, "loading");
  });

  afterEach(() => {
    registerTerminalInputInjector(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("injects every step in order into the active terminal (instant)", async () => {
    seedConnectedTerminal();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "l", delayMs: 0 },
          { data: "s", delayMs: 300 },
          { data: "\r", delayMs: 50 },
        ]),
      ],
    });

    await useAppStore.getState().playMacro("m1", { timingMode: "instant" });

    expect(injected).toEqual(["l", "s", "\r"]);
    // Playback state is cleared once the run finishes.
    expect(useAppStore.getState().macroPlayback).toBeNull();
    expect(toast.success).toHaveBeenCalled();
  });

  it("defaults the target to the active terminal tab", async () => {
    const tabIds: string[] = [];
    registerTerminalInputInjector(async (tabId, data) => {
      tabIds.push(tabId);
      injected.push(data);
      return true;
    });
    seedConnectedTerminal("tab-xyz", "sess-xyz");
    useAppStore.setState({ macros: [macro("m1", [{ data: "hi", delayMs: 0 }])] });

    await useAppStore.getState().playMacro("m1", { timingMode: "instant" });

    expect(tabIds).toEqual(["tab-xyz"]);
  });

  it("honours real-time delays between steps", async () => {
    vi.useFakeTimers();
    seedConnectedTerminal();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "a", delayMs: 0 },
          { data: "b", delayMs: 500 },
        ]),
      ],
    });

    const done = layoutState().playMacro("m1", { timingMode: "real-time" });

    await vi.advanceTimersByTimeAsync(0);
    expect(injected).toEqual(["a"]);

    await vi.advanceTimersByTimeAsync(499);
    expect(injected).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(injected).toEqual(["a", "b"]);

    await done;
    expect(useAppStore.getState().macroPlayback).toBeNull();
  });

  it("can be cancelled mid-run and stops promptly", async () => {
    vi.useFakeTimers();
    seedConnectedTerminal();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "a", delayMs: 0 },
          { data: "b", delayMs: 10_000 },
        ]),
      ],
    });

    const done = layoutState().playMacro("m1", { timingMode: "real-time" });
    await vi.advanceTimersByTimeAsync(0);
    expect(injected).toEqual(["a"]);
    expect(useAppStore.getState().macroPlayback).not.toBeNull();

    useAppStore.getState().cancelMacroPlayback();
    await done;

    expect(injected).toEqual(["a"]);
    expect(useAppStore.getState().macroPlayback).toBeNull();
    expect(toast.info).toHaveBeenCalled();
  });

  it("errors when the macro does not exist", async () => {
    seedConnectedTerminal();
    await useAppStore.getState().playMacro("missing");

    expect(injected).toEqual([]);
    expect(toast.error).toHaveBeenCalled();
  });

  it("errors when there is no connected terminal", async () => {
    seedConnectedTerminal("tab-active", null); // no session → not connected
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore.getState().playMacro("m1");

    expect(injected).toEqual([]);
    expect(toast.error).toHaveBeenCalled();
  });

  it("errors when the target terminal has exited", async () => {
    seedConnectedTerminal();
    useAppStore.setState({
      macros: [macro("m1", [{ data: "x", delayMs: 0 }])],
      terminalExitedTabs: { "tab-active": true },
    });

    await useAppStore.getState().playMacro("m1");

    expect(injected).toEqual([]);
    expect(toast.error).toHaveBeenCalled();
  });

  it("does nothing but inform the user for an empty macro", async () => {
    seedConnectedTerminal();
    useAppStore.setState({ macros: [macro("m1", [])] });

    await useAppStore.getState().playMacro("m1");

    expect(injected).toEqual([]);
    expect(toast.info).toHaveBeenCalled();
    expect(useAppStore.getState().macroPlayback).toBeNull();
  });

  it("cancelMacroPlayback is a no-op when nothing is playing", () => {
    expect(() => useAppStore.getState().cancelMacroPlayback()).not.toThrow();
  });
});
