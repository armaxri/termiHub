/**
 * Tests for the context-bound command registry (#1527).
 *
 * These commands act on the currently-focused panel/terminal, so each is
 * covered on two axes: `isAvailable()` reports whether a target applies in the
 * current context, and `run()` acts on that target (and is inert when none
 * applies). The same registry backs both the keyboard handler and the palette.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CONTEXT_COMMANDS } from "./contextCommands";
import { useAppStore, getActiveTab } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { layoutState } from "@/test/layoutState";

/** Add a tab of the given content type and make it the active tab/panel. */
function addActiveTab(contentType: "terminal" | "editor" = "terminal"): string {
  const id = useAppStore.getState().addTab("Tab", "local", undefined, { contentType });
  const panel = getAllLeaves(layoutState().rootPanel).find((p) => p.tabs.some((t) => t.id === id))!;
  useAppStore.getState().setActivePanel(panel.id);
  useAppStore.getState().setActiveTab(id, panel.id);
  return id;
}

/** The active leaf panel resolved from live store state. */
function activeLeaf() {
  const { rootPanel, activePanelId } = layoutState();
  return getAllLeaves(rootPanel).find((p) => p.id === activePanelId) ?? null;
}

setupSettingsRegion();

beforeEach(() => {
  useAppStore.setState({ ...useAppStore.getInitialState() });
  // focus-panel sets up panels via a synchronous splitPanel; pin to the local
  // reducer (retained resilience fallback) since the mutation cut (#2184) makes
  // the intent path async by default.
});

afterEach(() => {});

describe("CONTEXT_COMMANDS registry", () => {
  it("registers exactly the context-bound actions from the issue", () => {
    expect(Object.keys(CONTEXT_COMMANDS).sort()).toEqual(
      [
        "clear-terminal",
        "close-tab",
        "find-in-terminal",
        "focus-down",
        "focus-left",
        "focus-right",
        "focus-up",
        "move-tab-to-new-window",
        "next-tab",
        "prev-tab",
      ].sort()
    );
  });
});

describe("move-tab-to-new-window", () => {
  const cmd = CONTEXT_COMMANDS["move-tab-to-new-window"];

  it("is available only when the active tab is a terminal", () => {
    expect(cmd.isAvailable()).toBe(false);
    addActiveTab("editor");
    expect(cmd.isAvailable()).toBe(false);
    addActiveTab("terminal");
    expect(cmd.isAvailable()).toBe(true);
  });

  it("tears the active terminal tab out through moveTabToWindow with kind:new", () => {
    const tabId = addActiveTab("terminal");
    const panelId = activeLeaf()!.id;
    const spy = vi.spyOn(useAppStore.getState(), "moveTabToWindow").mockResolvedValue(undefined);
    cmd.run();
    expect(spy).toHaveBeenCalledWith(tabId, panelId, { kind: "new" });
  });

  it("run() is inert on a non-terminal tab", () => {
    addActiveTab("editor");
    const spy = vi.spyOn(useAppStore.getState(), "moveTabToWindow").mockResolvedValue(undefined);
    cmd.run();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("close-tab", () => {
  const cmd = CONTEXT_COMMANDS["close-tab"];

  it("is unavailable when the active panel has no tab", () => {
    // Fresh state: the initial panel is empty.
    expect(cmd.isAvailable()).toBe(false);
  });

  it("is available once a tab is focused", () => {
    addActiveTab();
    expect(cmd.isAvailable()).toBe(true);
  });

  it("closes the active tab immediately when the confirm setting is disabled", () => {
    addActiveTab();
    seedSettings({ confirmCloseTabOnShortcut: false });
    cmd.run();
    expect(activeLeaf()!.tabs).toHaveLength(0);
    expect(useAppStore.getState().pendingShortcutCloseConfirm).toBeNull();
  });

  it("opens the confirm dialog when the confirm setting is enabled (default)", () => {
    const tabId = addActiveTab();
    cmd.run();
    expect(activeLeaf()!.tabs).toHaveLength(1);
    const confirm = useAppStore.getState().pendingShortcutCloseConfirm;
    expect(confirm?.kind).toBe("tab");
    if (confirm?.kind === "tab") expect(confirm.tabId).toBe(tabId);
  });

  it("run() is inert when there is no target", () => {
    cmd.run();
    expect(useAppStore.getState().pendingShortcutCloseConfirm).toBeNull();
  });
});

describe("next-tab / prev-tab", () => {
  it("are unavailable with fewer than two tabs", () => {
    expect(CONTEXT_COMMANDS["next-tab"].isAvailable()).toBe(false);
    addActiveTab();
    expect(CONTEXT_COMMANDS["next-tab"].isAvailable()).toBe(false);
    expect(CONTEXT_COMMANDS["prev-tab"].isAvailable()).toBe(false);
  });

  it("cycle the active panel's selection", () => {
    const first = addActiveTab();
    const second = addActiveTab();
    const panel = activeLeaf()!;
    useAppStore.getState().setActiveTab(first, panel.id);

    expect(CONTEXT_COMMANDS["next-tab"].isAvailable()).toBe(true);
    CONTEXT_COMMANDS["next-tab"].run();
    expect(activeLeaf()!.activeTabId).toBe(second);

    CONTEXT_COMMANDS["prev-tab"].run();
    expect(activeLeaf()!.activeTabId).toBe(first);
  });
});

describe("focus-panel", () => {
  it("all directions are unavailable with a single panel", () => {
    addActiveTab();
    for (const dir of ["focus-up", "focus-down", "focus-left", "focus-right"]) {
      expect(CONTEXT_COMMANDS[dir].isAvailable()).toBe(false);
    }
  });

  it("resolves the adjacent panel and moves focus to it", () => {
    addActiveTab();
    // Split horizontally: the new (right) panel becomes active, so the original
    // panel sits to its left.
    useAppStore.getState().splitPanel("horizontal");
    const rightPanelId = layoutState().activePanelId;

    expect(CONTEXT_COMMANDS["focus-left"].isAvailable()).toBe(true);
    expect(CONTEXT_COMMANDS["focus-right"].isAvailable()).toBe(false);

    CONTEXT_COMMANDS["focus-left"].run();
    expect(layoutState().activePanelId).not.toBe(rightPanelId);
  });
});

describe("clear-terminal / find-in-terminal", () => {
  it("are available only when the active tab is a terminal", () => {
    expect(CONTEXT_COMMANDS["clear-terminal"].isAvailable()).toBe(false);
    addActiveTab("editor");
    expect(CONTEXT_COMMANDS["clear-terminal"].isAvailable()).toBe(false);
    expect(CONTEXT_COMMANDS["find-in-terminal"].isAvailable()).toBe(false);
    addActiveTab("terminal");
    expect(CONTEXT_COMMANDS["clear-terminal"].isAvailable()).toBe(true);
    expect(CONTEXT_COMMANDS["find-in-terminal"].isAvailable()).toBe(true);
  });

  it("clear-terminal dispatches a clear event for the focused terminal", () => {
    const tabId = addActiveTab("terminal");
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("termihub:clear-terminal", listener);
    CONTEXT_COMMANDS["clear-terminal"].run();
    window.removeEventListener("termihub:clear-terminal", listener);
    expect(events).toHaveLength(1);
    expect(events[0].detail.tabId).toBe(tabId);
  });

  it("find-in-terminal toggles the terminal search for the focused terminal", () => {
    const tabId = addActiveTab("terminal");
    const toggleSpy = vi.spyOn(useAppStore.getState(), "toggleTerminalSearch");
    CONTEXT_COMMANDS["find-in-terminal"].run();
    expect(toggleSpy).toHaveBeenCalledWith(tabId);
  });

  it("run() is inert on a non-terminal tab", () => {
    addActiveTab("editor");
    const toggleSpy = vi.spyOn(useAppStore.getState(), "toggleTerminalSearch");
    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("termihub:clear-terminal", listener);
    CONTEXT_COMMANDS["clear-terminal"].run();
    CONTEXT_COMMANDS["find-in-terminal"].run();
    window.removeEventListener("termihub:clear-terminal", listener);
    expect(events).toHaveLength(0);
    expect(toggleSpy).not.toHaveBeenCalled();
  });
});

describe("getActiveTab integration", () => {
  // Guards the assumption find/clear availability relies on.
  it("returns the focused terminal tab", () => {
    const id = addActiveTab("terminal");
    expect(getActiveTab(useAppStore.getState())?.id).toBe(id);
  });
});
