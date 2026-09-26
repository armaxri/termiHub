/**
 * Tests for multi-target ("broadcast") macro playback (PROD-042, #3443).
 *
 * Pins `playMacro(id, { targetTabIds })`: every connected target receives every
 * step in lock-step, disconnected targets are skipped up front, a target that
 * drops mid-run stops receiving, and the summary toast never reports a partial
 * run as a clean success.
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
import { seedLayoutState } from "@/test/layoutState";
import { registerTerminalInputInjector } from "@/services/macroPlayback";
import { toast } from "@/components/ui";
import {
  disconnected,
  installSessionLifecycleHarness,
} from "@/test/sessionLifecycleRegionTestHarness";
import { ensureSessionSubscribed } from "./sessionBridge";

const macro = (id: string, steps: Macro["steps"]): Macro => ({
  id,
  name: `Macro ${id}`,
  description: "",
  tags: [],
  steps,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

function term(id: string, sessionId: string | null): TerminalTab {
  return {
    id,
    sessionId,
    title: `title-${id}`,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId: "leaf-1",
    isActive: id === "a",
  };
}

/** Seed one panel holding terminals a, b, c (c has no session → not connected). */
function seedFleet() {
  const tabs = [term("a", "sess-a"), term("b", "sess-b"), term("c", null)];
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs, activeTabId: "a" };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

describe("appStore — multi-target macro playback (PROD-042)", () => {
  let injected: Array<[string, string]>;
  const harness = installSessionLifecycleHarness();

  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    injected = [];
    registerTerminalInputInjector(async (tabId, data) => {
      injected.push([tabId, data]);
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

  it("plays every step into every connected target in lock-step", async () => {
    seedFleet();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "l", delayMs: 0 },
          { data: "s\r", delayMs: 0 },
        ]),
      ],
    });

    await useAppStore
      .getState()
      .playMacro("m1", { timingMode: "instant", targetTabIds: ["a", "b"] });

    expect(injected).toEqual([
      ["a", "l"],
      ["b", "l"],
      ["a", "s\r"],
      ["b", "s\r"],
    ]);
    expect(toast.success).toHaveBeenCalledWith(
      'Played macro "Macro m1" on 2 terminals',
      expect.anything()
    );
    expect(useAppStore.getState().macroPlayback).toBeNull();
  });

  it("skips targets that are not connected and reports the run as partial", async () => {
    seedFleet();
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore
      .getState()
      .playMacro("m1", { timingMode: "instant", targetTabIds: ["a", "b", "c"] });

    expect(injected.map(([id]) => id)).toEqual(["a", "b"]);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Played macro "Macro m1" on 2 of 3 terminals',
      expect.objectContaining({ description: "1 skipped (not connected)" })
    );
  });

  it("never types into a target that exited mid-run", async () => {
    await ensureSessionSubscribed();
    vi.useFakeTimers();
    seedFleet();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "one", delayMs: 0 },
          { data: "two", delayMs: 100 },
        ]),
      ],
    });

    const done = useAppStore
      .getState()
      .playMacro("m1", { timingMode: "real-time", targetTabIds: ["a", "b"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(injected).toEqual([
      ["a", "one"],
      ["b", "one"],
    ]);
    // b's session ends between steps.
    harness.transport.setSession("b", disconnected());
    await vi.advanceTimersByTimeAsync(100);
    await done;

    expect(injected).toEqual([
      ["a", "one"],
      ["b", "one"],
      ["a", "two"],
    ]);
    expect(toast.error).toHaveBeenCalledWith(
      'Played macro "Macro m1" on 1 of 2 terminals',
      expect.objectContaining({ description: "1 stopped early (disconnected mid-playback)" })
    );
  });

  it("errors without typing anything when no target is connected", async () => {
    seedFleet();
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore
      .getState()
      .playMacro("m1", { timingMode: "instant", targetTabIds: ["c", "zz"] });

    expect(injected).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith("None of the selected terminals are connected");
    expect(useAppStore.getState().macroPlayback).toBeNull();
  });

  it("exposes every receiving terminal in the playback state while running", async () => {
    vi.useFakeTimers();
    seedFleet();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "a", delayMs: 0 },
          { data: "b", delayMs: 1000 },
        ]),
      ],
    });

    const done = useAppStore
      .getState()
      .playMacro("m1", { timingMode: "real-time", targetTabIds: ["a", "b"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(useAppStore.getState().macroPlayback?.targetTabIds).toEqual(["a", "b"]);

    useAppStore.getState().cancelMacroPlayback();
    await done;
    expect(toast.info).toHaveBeenCalled();
    expect(useAppStore.getState().macroPlayback).toBeNull();
  });

  it("narrows the receiving set when a target drops mid-run, clearing its tab marker (#3446)", async () => {
    await ensureSessionSubscribed();
    vi.useFakeTimers();
    seedFleet();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "one", delayMs: 0 },
          { data: "two", delayMs: 100 },
          { data: "three", delayMs: 1000 },
        ]),
      ],
    });

    const done = useAppStore
      .getState()
      .playMacro("m1", { timingMode: "real-time", targetTabIds: ["a", "b"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(useAppStore.getState().macroPlayback?.targetTabIds).toEqual(["a", "b"]);

    harness.transport.setSession("b", disconnected());
    await vi.advanceTimersByTimeAsync(100);
    // Step two went to `a` only — `b` is no longer marked as receiving.
    expect(useAppStore.getState().macroPlayback?.targetTabIds).toEqual(["a"]);

    await vi.advanceTimersByTimeAsync(1000);
    await done;
    expect(useAppStore.getState().macroPlayback).toBeNull();
  });

  it("does not mark a single-terminal run with a receiving set (#3446)", async () => {
    vi.useFakeTimers();
    seedFleet();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "a", delayMs: 0 },
          { data: "b", delayMs: 1000 },
        ]),
      ],
    });

    const done = useAppStore
      .getState()
      .playMacro("m1", { timingMode: "real-time", targetTabIds: ["b"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(useAppStore.getState().macroPlayback?.tabId).toBe("b");
    expect(useAppStore.getState().macroPlayback?.targetTabIds).toBeUndefined();

    useAppStore.getState().cancelMacroPlayback();
    await done;
  });

  it("treats a single-element targetTabIds as a normal single-terminal run", async () => {
    seedFleet();
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore.getState().playMacro("m1", { timingMode: "instant", targetTabIds: ["b"] });

    expect(injected).toEqual([["b", "x"]]);
    expect(toast.success).toHaveBeenCalledWith('Played macro "Macro m1"', expect.anything());
  });
});

describe("appStore — multi-target playback drops a target whose injection fails", () => {
  installSessionLifecycleHarness();

  afterEach(() => {
    registerTerminalInputInjector(null);
    vi.restoreAllMocks();
  });

  it("clears the failed target from the receiving set (#3446)", async () => {
    vi.useFakeTimers();
    useAppStore.setState(useAppStore.getInitialState());
    registerTerminalInputInjector(async (tabId, data) => !(tabId === "b" && data === "two"));
    seedFleet();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "one", delayMs: 0 },
          { data: "two", delayMs: 100 },
          { data: "three", delayMs: 1000 },
        ]),
      ],
    });

    const done = useAppStore
      .getState()
      .playMacro("m1", { timingMode: "real-time", targetTabIds: ["a", "b"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(useAppStore.getState().macroPlayback?.targetTabIds).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(useAppStore.getState().macroPlayback?.targetTabIds).toEqual(["a"]);

    useAppStore.getState().cancelMacroPlayback();
    await done;
    expect(useAppStore.getState().macroPlayback).toBeNull();
    vi.useRealTimers();
  });

  it("stops typing into the failed target and keeps the others going", async () => {
    useAppStore.setState(useAppStore.getInitialState());
    const injected: Array<[string, string]> = [];
    registerTerminalInputInjector(async (tabId, data) => {
      if (tabId === "b" && data === "two") return false;
      injected.push([tabId, data]);
      return true;
    });
    vi.spyOn(toast, "error");
    seedFleet();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "one", delayMs: 0 },
          { data: "two", delayMs: 0 },
          { data: "three", delayMs: 0 },
        ]),
      ],
    });

    await useAppStore
      .getState()
      .playMacro("m1", { timingMode: "instant", targetTabIds: ["a", "b"] });

    expect(injected).toEqual([
      ["a", "one"],
      ["b", "one"],
      ["a", "two"],
      ["a", "three"],
    ]);
    expect(toast.error).toHaveBeenCalledWith(
      'Played macro "Macro m1" on 1 of 2 terminals',
      expect.anything()
    );
  });
});
