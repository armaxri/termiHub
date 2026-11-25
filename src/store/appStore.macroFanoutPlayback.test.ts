/**
 * Tests for multi-target ("broadcast") macro playback (PROD-042, #3443).
 *
 * Pins `playMacro(id, { targetTabIds })`: every connected target runs the
 * macro as its own run (#5818 slice 5, replacing the lock-step fan-out),
 * disconnected targets are skipped up front, a target that drops mid-run stops
 * receiving while the others go on, one target can be stopped on its own, and
 * the summary toast never reports a partial run as a clean success.
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

vi.mock("@/services/automationApi", () => ({
  listAutomations: vi.fn(() => Promise.resolve([])),
  saveAutomation: vi.fn((a: unknown) => Promise.resolve(a)),
  deleteAutomation: vi.fn(() => Promise.resolve()),
  listAutomationRuns: vi.fn(() => Promise.resolve([])),
  recordAutomationRun: vi.fn(() => Promise.resolve([])),
  clearAutomationRunHistory: vi.fn(() => Promise.resolve([])),
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

  it("plays every step into every connected target", async () => {
    seedFleet();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "l", delayMs: 0 },
          { data: "s\r", delayMs: 0 },
        ]),
      ],
    });

    await useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b"] });

    expect(injected.filter(([id]) => id === "a").map(([, d]) => d)).toEqual(["l", "s\r"]);
    expect(injected.filter(([id]) => id === "b").map(([, d]) => d)).toEqual(["l", "s\r"]);
    expect(toast.success).toHaveBeenCalledWith(
      "Ran automation “Macro m1” on 2 terminals",
      expect.anything()
    );
    expect(useAppStore.getState().macroPlayback).toBeNull();
  });

  it("skips targets that are not connected and reports the run as partial", async () => {
    seedFleet();
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b", "c"] });

    expect(injected.map(([id]) => id)).toEqual(["a", "b"]);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Ran automation “Macro m1” on 2 of 3 terminals",
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

    const done = useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b"] });
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
      "Ran automation “Macro m1” on 1 of 2 terminals",
      expect.objectContaining({ description: "1 stopped early (disconnected while it ran)" })
    );
  });

  it("errors without typing anything when no target is connected", async () => {
    seedFleet();
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore.getState().playMacro("m1", { targetTabIds: ["c", "zz"] });

    expect(injected).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith("None of the selected terminals are connected");
    expect(useAppStore.getState().macroPlayback).toBeNull();
  });

  it("informs instead of playing an empty macro on several targets (#2979)", async () => {
    seedFleet();
    useAppStore.setState({ macros: [macro("m0", [])] });

    const status = await useAppStore.getState().playMacro("m0", { targetTabIds: ["a", "b"] });

    expect(status).toBeNull();
    expect(injected).toEqual([]);
    expect(toast.info).toHaveBeenCalledWith("Automation “Macro m0” has no steps to run");
  });

  it("a newer fan-out supersedes an in-flight one without losing its own state (#2979)", async () => {
    vi.useFakeTimers();
    seedFleet();
    const slow = (id: string) =>
      macro(id, [
        { data: `${id}-1`, delayMs: 0 },
        { data: `${id}-2`, delayMs: 1000 },
      ]);
    useAppStore.setState({ macros: [slow("m1"), slow("m2")] });

    const first = useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b"] });
    await vi.advanceTimersByTimeAsync(0);
    const second = useAppStore.getState().playMacro("m2", { targetTabIds: ["a", "b"] });
    await vi.advanceTimersByTimeAsync(0);

    // The superseded run settles as cancelled and must not clear the new run's
    // playback indicator.
    await expect(first).resolves.toBe("cancelled");
    expect(useAppStore.getState().macroPlayback?.macroId).toBe("m2");
    expect(injected.map(([, data]) => data)).not.toContain("m1-2");

    await vi.advanceTimersByTimeAsync(1000);
    await expect(second).resolves.toBe("completed");
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

    const done = useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b"] });
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

    const done = useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b"] });
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

    const done = useAppStore.getState().playMacro("m1", { targetTabIds: ["b"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(useAppStore.getState().macroPlayback?.tabId).toBe("b");
    expect(useAppStore.getState().macroPlayback?.targetTabIds).toBeUndefined();

    // Not the terminal it types into: it goes on.
    useAppStore.getState().cancelMacroPlaybackOnTab("a");
    await vi.advanceTimersByTimeAsync(0);
    expect(useAppStore.getState().macroPlayback).not.toBeNull();
    useAppStore.getState().cancelMacroPlaybackOnTab("b");
    await vi.advanceTimersByTimeAsync(0);
    await expect(done).resolves.toBe("cancelled");
  });

  it("stops one terminal from its badge while the others keep typing (#5818)", async () => {
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

    const done = useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b"] });
    await vi.advanceTimersByTimeAsync(0);
    useAppStore.getState().cancelMacroPlaybackOnTab("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(useAppStore.getState().macroPlayback?.targetTabIds).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(100);
    await expect(done).resolves.toBe("cancelled");

    expect(injected.filter(([id]) => id === "a").map(([, d]) => d)).toEqual(["one", "two"]);
    expect(injected.filter(([id]) => id === "b").map(([, d]) => d)).toEqual(["one"]);
  });

  it("tracks each terminal's own progress (#5818)", async () => {
    vi.useFakeTimers();
    seedFleet();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "one", delayMs: 0 },
          { data: "two", delayMs: 1000 },
        ]),
      ],
    });

    const done = useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(useAppStore.getState().macroPlayback?.targetProgress).toEqual({ a: 1, b: 1 });
    useAppStore.getState().cancelMacroPlayback();
    await done;
  });

  it("runs the targets one after another when parallel is off (#5818)", async () => {
    seedFleet();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "1", delayMs: 0 },
          { data: "2", delayMs: 0 },
        ]),
      ],
    });

    await useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b"], parallel: false });

    expect(injected).toEqual([
      ["a", "1"],
      ["a", "2"],
      ["b", "1"],
      ["b", "2"],
    ]);
  });

  it("stopping a queued terminal keeps it from ever starting (#5818)", async () => {
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
      .playMacro("m1", { targetTabIds: ["a", "b"], parallel: false });
    await vi.advanceTimersByTimeAsync(0);
    useAppStore.getState().cancelMacroPlaybackOnTab("b");
    expect(useAppStore.getState().macroPlayback?.targetTabIds).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(500);
    await expect(done).resolves.toBe("cancelled");
    expect(injected.map(([id]) => id)).toEqual(["a", "a"]);
  });

  it("replaying the same macro keeps the new run's badges (#5818)", async () => {
    vi.useFakeTimers();
    seedFleet();
    useAppStore.setState({
      macros: [
        macro("m1", [
          { data: "one", delayMs: 0 },
          { data: "two", delayMs: 1000 },
        ]),
      ],
    });
    const play = () => useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b"] });
    const first = play();
    await vi.advanceTimersByTimeAsync(0);
    const second = play();
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(useAppStore.getState().macroPlayback?.targetTabIds).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(second).resolves.toBe("completed");
  });

  it("stopping where nothing types, or another terminal than the one that does, does nothing", async () => {
    useAppStore.getState().cancelMacroPlayback();
    useAppStore.getState().cancelMacroPlaybackOnTab("tab-a");
    expect(useAppStore.getState().macroPlayback).toBeNull();
  });

  it("treats a single-element targetTabIds as a normal single-terminal run", async () => {
    seedFleet();
    useAppStore.setState({ macros: [macro("m1", [{ data: "x", delayMs: 0 }])] });

    await useAppStore.getState().playMacro("m1", { targetTabIds: ["b"] });

    expect(injected).toEqual([["b", "x"]]);
    // One visible terminal: the typed output is the feedback (#5859).
    expect(toast.success).not.toHaveBeenCalled();
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

    const done = useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b"] });
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

    await useAppStore.getState().playMacro("m1", { targetTabIds: ["a", "b"] });

    expect(injected.filter(([id]) => id === "a").map(([, d]) => d)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(injected.filter(([id]) => id === "b").map(([, d]) => d)).toEqual(["one"]);
    expect(toast.error).toHaveBeenCalledWith(
      "Ran automation “Macro m1” on 1 of 2 terminals",
      expect.anything()
    );
  });
});
