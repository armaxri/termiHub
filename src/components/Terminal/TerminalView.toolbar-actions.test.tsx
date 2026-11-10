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
vi.mock("@/components/ui", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  Button: ({
    icon,
    children,
    className,
    variant: _variant,
    size: _size,
    iconOnly: _iconOnly,
    ...rest
  }: {
    icon?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
    [key: string]: unknown;
  }) => (
    <button className={className} {...rest}>
      {icon}
      {children}
    </button>
  ),
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));
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
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Stop Broadcast");

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
    expect(btn.getAttribute("aria-label")).toBe("Stop Macro Playback");
    expect(btn.getAttribute("aria-pressed")).toBe("true");

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
