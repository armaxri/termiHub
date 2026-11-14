/**
 * TerminalView toolbar actions (#5172, COV-013): broadcast stop/start, the
 * split and close-panel handlers, macro playback cancel, and the wiring of the
 * three toolbar dialogs.
 *
 * Runs against the real store and the real broadcast bridge (fed by the
 * in-memory {@link installBroadcastHarness} region double), so an "active"
 * broadcast is a genuinely projected view and a Stop click must round-trip a
 * `broadcast.stop` intent. Only xterm, the Tauri API and the dialog bodies are
 * stubbed; the dialogs are replaced by probes that expose the props
 * TerminalView passes, so the callbacks can be driven without Radix in jsdom.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { toast } from "@/components/ui";
import { closePanelGuarded } from "@/utils/tabGroupCloseGuard";
import { clearOverrides, setOverride } from "@/services/keybindings";
import { sessionLoggingStart } from "@/services/api";
import {
  OPEN_MACRO_PLAYBACK_EVENT,
  TOGGLE_SESSION_LOGGING_EVENT,
} from "@/services/contextCommands";
import { getAllLeaves } from "@/utils/panelTree";
import { installBroadcastHarness } from "@/test/broadcastHarness";
import { layoutState, seedLayoutState } from "@/test/layoutState";
import type { LeafPanel, PanelNode, TerminalTab } from "@/types/terminal";
import type { MacroPlaybackDialogProps } from "./MacroPlaybackDialog";
import type { MacroRecordSaveDialogProps } from "./MacroRecordSaveDialog";
import type { BroadcastScopeDialogProps } from "./BroadcastScopeDialog";

const probes = vi.hoisted(() => ({
  playback: null as MacroPlaybackDialogProps | null,
  save: null as MacroRecordSaveDialogProps | null,
  scope: null as BroadcastScopeDialogProps | null,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("./TerminalRegistry", () => ({
  TerminalPortalProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("./TerminalCommandBridge", () => ({ TerminalCommandBridge: () => null }));
vi.mock("@/testbridge/TestBridge", () => ({ TestBridge: () => null }));
vi.mock("./Terminal", () => ({ Terminal: () => null }));
vi.mock("@/components/ui", async () =>
  (await import("@/test/terminalViewUiMock")).terminalViewUiMock()
);
vi.mock("./TabGroupChips", () => ({ TabGroupChips: () => null }));
vi.mock("./MacroRecordSaveDialog", () => ({
  MacroRecordSaveDialog: (p: MacroRecordSaveDialogProps) => {
    probes.save = p;
    return null;
  },
}));
vi.mock("./MacroPlaybackDialog", () => ({
  MacroPlaybackDialog: (p: MacroPlaybackDialogProps) => {
    probes.playback = p;
    return null;
  },
}));
vi.mock("./BroadcastScopeDialog", () => ({
  BroadcastScopeDialog: (p: BroadcastScopeDialogProps) => {
    probes.scope = p;
    return null;
  },
}));
vi.mock("@/components/SplitView", () => ({ SplitView: () => null }));
vi.mock("@/services/events", () => ({ terminalDispatcher: { init: vi.fn() } }));
vi.mock("@/services/api", () => ({
  listAgentSessions: vi.fn(() => Promise.resolve([])),
  sessionGetCapabilities: vi.fn(() => Promise.resolve(null)),
  sessionLoggingStart: vi.fn(() => Promise.resolve("/tmp/session.log")),
  sessionLoggingStop: vi.fn(() => Promise.resolve(null)),
  sessionLoggingStatus: vi.fn(() => Promise.resolve(null)),
}));
vi.mock("@/utils/frontendLog", () => ({ frontendLog: vi.fn(), frontendWarn: vi.fn() }));
// The guard's confirm flow is covered by its own suite; here we only assert
// TerminalView routes the close through it (never a raw removePanel).
vi.mock("@/utils/tabGroupCloseGuard", () => ({ closePanelGuarded: vi.fn() }));

import { TerminalView } from "./TerminalView";

let container: HTMLDivElement;
let root: Root;
let harness: ReturnType<typeof installBroadcastHarness>;

function tab(id: string, panelId: string, contentType = "terminal"): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: `Tab ${id}`,
    connectionType: "local",
    contentType,
    config: {} as TerminalTab["config"],
    panelId,
    isActive: true,
  } as TerminalTab;
}

function leaf(id: string, tabs: TerminalTab[]): LeafPanel {
  return { type: "leaf", id, tabs, activeTabId: tabs[0]?.id ?? null };
}

function seed(rootPanel: PanelNode, activePanelId: string): void {
  seedLayoutState({
    rootPanel,
    activePanelId,
    tabGroups: [{ id: "g1", name: "G1", rootPanel, activePanelId }],
    activeTabGroupId: "g1",
  });
}

function button(testId: string): HTMLButtonElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function click(testId: string): void {
  act(() => button(testId)!.click());
}

async function renderView(): Promise<void> {
  await act(async () => {
    root.render(<TerminalView />);
    await Promise.resolve();
  });
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  harness = installBroadcastHarness();
  probes.playback = probes.save = probes.scope = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  harness.teardown();
  clearOverrides();
  vi.clearAllMocks();
});

describe("TerminalView — broadcast toggle (#5172)", () => {
  it("stops an active broadcast through a broadcast.stop intent", async () => {
    seed(leaf("a", [tab("t1", "a")]), "a");
    harness.transport.seed({
      active: true,
      sourceTabId: "t1",
      scope: "all",
      targetTabIds: ["t1"],
    });
    await renderView();
    const btn = button("terminal-view-broadcast")!;
    expect(btn.getAttribute("data-active")).toBe("true");
    expect(btn.textContent).toContain("Stop broadcast");

    await act(async () => {
      btn.click();
      await Promise.resolve();
    });

    expect(harness.transport.dispatched.map((i) => i.kind)).toEqual(["broadcast.stop"]);
    expect(probes.scope?.open).toBe(false);
  });

  it("opens the scope dialog for the active terminal when idle", async () => {
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();

    click("terminal-view-broadcast");

    expect(probes.scope).toMatchObject({ open: true, sourceTabId: "t1" });
    expect(harness.transport.dispatched).toEqual([]);
    act(() => probes.scope!.onOpenChange(false));
    expect(probes.scope?.open).toBe(false);
  });

  it("guides the user when no terminal is focused", async () => {
    seed(leaf("a", [tab("e1", "a", "settings")]), "a");
    await renderView();

    click("terminal-view-broadcast");

    expect(toast.info).toHaveBeenCalledWith("Focus a terminal to start broadcasting input");
    expect(probes.scope?.open).toBe(false);
  });
});

describe("TerminalView — split and close panel (#5172)", () => {
  it.each([
    ["terminal-view-split-horizontal", "horizontal"],
    ["terminal-view-split-vertical", "vertical"],
  ] as const)("%s splits the active panel %s", async (testId, direction) => {
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();
    expect(button("terminal-view-close-panel")).toBeNull();

    click(testId);

    const { rootPanel } = layoutState();
    expect(rootPanel.type).toBe("split");
    expect(rootPanel.type === "split" && rootPanel.direction).toBe(direction);
    expect(getAllLeaves(rootPanel)).toHaveLength(2);
    // With two panels the Close Panel action appears.
    expect(button("terminal-view-close-panel")).not.toBeNull();
  });

  it("closes the active panel through the unsaved-work guard", async () => {
    const tree: PanelNode = {
      type: "split",
      id: "s",
      direction: "horizontal",
      children: [leaf("a", [tab("t1", "a")]), leaf("b", [tab("t2", "b")])],
    };
    seed(tree, "b");
    await renderView();

    click("terminal-view-close-panel");

    expect(closePanelGuarded).toHaveBeenCalledTimes(1);
    expect(closePanelGuarded).toHaveBeenCalledWith("b");
  });

  it("names the close-panel shortcut in its tooltip label (#5779)", async () => {
    setOverride("close-panel", { key: "F10", alt: true });
    const tree: PanelNode = {
      type: "split",
      id: "s",
      direction: "horizontal",
      children: [leaf("a", [tab("t1", "a")]), leaf("b", [tab("t2", "b")])],
    };
    seed(tree, "b");
    await renderView();
    expect(button("terminal-view-close-panel")!.getAttribute("aria-label")).toBe(
      "Close panel (Alt+F10)"
    );
  });
});

describe("TerminalView — logging and play shortcuts (#5779)", () => {
  it("toggles the active session's logging on the shortcut event", async () => {
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();
    await act(async () => {
      window.dispatchEvent(new CustomEvent(TOGGLE_SESSION_LOGGING_EVENT));
      await Promise.resolve();
    });
    expect(sessionLoggingStart).toHaveBeenCalledWith("sess-t1", undefined, true);
  });

  it("opens the macro picker on the play shortcut event", async () => {
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();
    expect(probes.playback?.open).toBe(false);
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_MACRO_PLAYBACK_EVENT));
    });
    expect(probes.playback?.open).toBe(true);
  });
});

describe("TerminalView — macro playback and dialogs (#5172)", () => {
  it("opens the playback dialog and forwards a play request to the store", async () => {
    const playMacro = vi.fn(() => Promise.resolve(null));
    useAppStore.setState({ playMacro });
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();
    expect(probes.playback?.open).toBe(false);

    click("terminal-view-play-macro");
    expect(probes.playback?.open).toBe(true);

    act(() => probes.playback!.onPlay("m1", "fixed", ["t1"]));
    expect(playMacro).toHaveBeenCalledWith("m1", { timingMode: "fixed", targetTabIds: ["t1"] });
    act(() => probes.playback!.onOpenChange(false));
    expect(probes.playback?.open).toBe(false);
  });

  it("cancels a running playback instead of opening the dialog", async () => {
    const cancelMacroPlayback = vi.fn();
    useAppStore.setState({
      cancelMacroPlayback,
      macroPlayback: {
        macroId: "m1",
        macroName: "Deploy",
        tabId: "t1",
        timingMode: "fixed",
        played: 2,
        total: 5,
      },
    });
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();
    const btn = button("terminal-view-play-macro")!;
    expect(btn.textContent).toBe("Stop macro playback (2/5)");
    expect(btn.getAttribute("data-active")).toBe("true");

    click("terminal-view-play-macro");

    expect(cancelMacroPlayback).toHaveBeenCalledTimes(1);
    expect(probes.playback?.open).toBe(false);
  });

  it("wires the record-save dialog to save and discard the recording", async () => {
    const saveRecordedMacro = vi.fn(() => Promise.resolve());
    const discardRecordedMacro = vi.fn();
    useAppStore.setState({ saveRecordedMacro, discardRecordedMacro, macroSaveDialogOpen: true });
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();
    expect(probes.save?.open).toBe(true);

    const meta = { name: "deploy" } as Parameters<MacroRecordSaveDialogProps["onSave"]>[0];
    act(() => probes.save!.onSave(meta));
    expect(saveRecordedMacro).toHaveBeenCalledWith(meta);
    act(() => probes.save!.onDiscard());
    expect(discardRecordedMacro).toHaveBeenCalledTimes(1);
  });

  it("opens a new local terminal from the toolbar", async () => {
    const addTab = vi.fn();
    useAppStore.setState({ addTab });
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();

    click("terminal-view-new-terminal");

    expect(addTab).toHaveBeenCalledWith("Terminal", "local");
  });
});

describe("TerminalView — toolbar layout icons and the … menu (#5559, #5756)", () => {
  function ids(selector: string): string[] {
    const el = container.querySelector(selector);
    expect(el, selector).not.toBeNull();
    return Array.from(el!.querySelectorAll("button")).map(
      (b) => b.getAttribute("data-testid") ?? ""
    );
  }

  it("keeps the layout icons visible and moves session and macro actions into the menu", async () => {
    seed(
      {
        type: "split",
        id: "s",
        direction: "horizontal",
        children: [leaf("a", [tab("t1", "a")]), leaf("b", [])],
        sizes: [50, 50],
      } as PanelNode,
      "a"
    );
    await renderView();

    expect(ids('[data-testid="terminal-view-toolbar-layout"]')).toEqual([
      "terminal-view-new-terminal",
      "terminal-view-split-horizontal",
      "terminal-view-split-vertical",
      "terminal-view-close-panel",
      "terminal-view-toggle-sidebar",
    ]);
    expect(button("terminal-view-more-actions")).not.toBeNull();
    expect(ids('[data-testid="terminal-view-more-menu"]')).toEqual([
      "terminal-view-broadcast",
      "terminal-view-toggle-logging",
      "terminal-view-record-macro",
      "terminal-view-play-macro",
    ]);
    // The old session and macro groups are gone from the toolbar.
    expect(container.querySelector('[data-testid="terminal-view-toolbar-session"]')).toBeNull();
    expect(container.querySelector('[data-testid="terminal-view-toolbar-macros"]')).toBeNull();
  });

  it("names the registry shortcut in each layout icon's tooltip label", async () => {
    setOverride("new-terminal", { key: "F7" });
    setOverride("split-right", { key: "F8" });
    setOverride("split-down", { key: "F9" });
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();
    expect(button("terminal-view-new-terminal")!.getAttribute("aria-label")).toBe(
      "New terminal (F7)"
    );
    expect(button("terminal-view-split-horizontal")!.getAttribute("aria-label")).toBe(
      "Split terminal right (F8)"
    );
    expect(button("terminal-view-split-vertical")!.getAttribute("aria-label")).toBe(
      "Split terminal down (F9)"
    );
  });

  it("right-aligns the broadcast shortcut in its menu row", async () => {
    setOverride("toggle-broadcast", { key: "F6" });
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();
    const row = button("terminal-view-broadcast")!;
    expect(row.querySelector(".ui-menu__shortcut")?.textContent).toBe("F6");
    expect(row.textContent).toContain("Broadcast input…");
  });

  it("draws record macro as a record glyph, not a plain circle", async () => {
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();
    const svg = button("terminal-view-record-macro")!.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("lucide-circle-dot");
  });

  it("keeps every icon-only action named for tooltips and assistive tech", async () => {
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();
    const buttons = container.querySelectorAll(
      ".terminal-view__toolbar-actions button:not([role='menuitem'])"
    );
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    for (const b of buttons) expect(b.getAttribute("aria-label")).toBeTruthy();
  });
});

describe("TerminalView — running actions stay visible as chips (#5756)", () => {
  it("shows no chip while nothing runs", async () => {
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();
    expect(container.querySelector('[data-testid="terminal-view-active-states"]')).toBeNull();
    expect(button("terminal-view-more-actions")!.getAttribute("data-active-count")).toBe("0");
  });

  it("names an active broadcast and stops it from the chip", async () => {
    seed(leaf("a", [tab("t1", "a")]), "a");
    harness.transport.seed({
      active: true,
      sourceTabId: "t1",
      scope: "all",
      targetTabIds: ["t1"],
    });
    await renderView();
    const chip = button("terminal-view-active-broadcast")!;
    expect(chip.textContent).toBe("Broadcasting");
    expect(chip.getAttribute("aria-label")).toMatch(/^Stop broadcast/);
    expect(button("terminal-view-more-actions")!.getAttribute("data-active-count")).toBe("1");

    await act(async () => {
      chip.click();
      await Promise.resolve();
    });
    expect(harness.transport.dispatched.map((i) => i.kind)).toEqual(["broadcast.stop"]);
  });

  it("names a running recording and playback, each stoppable from its chip", async () => {
    const cancelMacroPlayback = vi.fn();
    const toggleMacroRecording = vi.fn();
    useAppStore.setState({
      cancelMacroPlayback,
      toggleMacroRecording,
      macroRecording: true,
      macroPlayback: {
        macroId: "m1",
        macroName: "Deploy",
        tabId: "t1",
        timingMode: "fixed",
        played: 1,
        total: 3,
      },
    } as unknown as Parameters<typeof useAppStore.setState>[0]);
    seed(leaf("a", [tab("t1", "a")]), "a");
    await renderView();
    expect(button("terminal-view-active-recording")!.textContent).toBe("Recording");
    expect(button("terminal-view-active-playback")!.textContent).toBe("Playing 1/3");

    click("terminal-view-active-recording");
    click("terminal-view-active-playback");
    expect(toggleMacroRecording).toHaveBeenCalledTimes(1);
    expect(cancelMacroPlayback).toHaveBeenCalledTimes(1);
  });
});
