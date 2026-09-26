/**
 * Tests for the macro-playback target picker (PROD-042, #3443): multi-terminal
 * targets reuse the broadcast membership machinery and saved broadcast groups,
 * show a live connected count, and never play without an explicit confirmation
 * step that lists every receiving terminal and ignores Enter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";

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

import { MacroPlaybackDialog } from "./MacroPlaybackDialog";
import { useAppStore } from "@/store/appStore";
import { seedLayoutState } from "@/test/layoutState";
import { seedSettings, setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { Macro } from "@/types/macro";

setupSettingsRegion();

let container: HTMLDivElement;
let root: Root;

const macro: Macro = {
  id: "m1",
  name: "Deploy",
  description: "",
  tags: [],
  steps: [
    { data: "a", delayMs: 0 },
    { data: "b", delayMs: 0 },
  ],
  createdAt: "",
  updatedAt: "",
};

function term(id: string, sessionId: string | null, connectionId?: string): TerminalTab {
  return {
    id,
    sessionId,
    title: `host-${id}`,
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: {} },
    panelId: "leaf-1",
    isActive: id === "a",
    connectionId,
  };
}

function seedTabs(tabs: TerminalTab[]) {
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs, activeTabId: tabs[0].id };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const click = (el: Element | null) => act(() => (el as HTMLElement).click());

function openSelect(testId: string) {
  const trigger = q(`[data-testid="${testId}"]`) as HTMLButtonElement;
  act(() => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

function pick(testId: string, label: string) {
  openSelect(testId);
  const option = Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
    o.textContent?.includes(label)
  ) as HTMLElement | undefined;
  expect(option).toBeTruthy();
  act(() => {
    option?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function render(onPlay: ReturnType<typeof vi.fn>) {
  act(() => {
    root.render(
      <MacroPlaybackDialog open macros={[macro]} onOpenChange={() => {}} onPlay={onPlay} />
    );
  });
}

describe("MacroPlaybackDialog — targets (PROD-042)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("defaults to the active terminal and plays without a confirmation", () => {
    seedTabs([term("a", "s-a"), term("b", "s-b")]);
    const onPlay = vi.fn();
    render(onPlay);

    expect(q('[data-testid="macro-playback-target"]')?.textContent).toContain("host-a");
    click(q('[data-testid="macro-playback-confirm"]'));
    expect(onPlay).toHaveBeenCalledWith("m1", "real-time");
  });

  it("lists broadcast scopes with live connected counts", () => {
    seedTabs([term("a", "s-a"), term("b", "s-b"), term("c", null)]);
    render(vi.fn());
    openSelect("macro-playback-target");
    const labels = Array.from(document.querySelectorAll('[role="option"]')).map(
      (o) => o.textContent
    );
    expect(labels).toContain("All terminals (2 connected)");
    expect(labels).toContain("All in current panel (2 connected)");
  });

  it("requires an explicit confirmation listing every target before playing on many", () => {
    seedTabs([term("a", "s-a"), term("b", "s-b")]);
    const onPlay = vi.fn();
    render(onPlay);

    pick("macro-playback-target", "All terminals");
    const confirm = q('[data-testid="macro-playback-confirm"]') as HTMLButtonElement;
    expect(confirm.textContent).toBe("Play on 2 terminals…");
    click(confirm);
    expect(onPlay).not.toHaveBeenCalled();

    const list = q('[data-testid="macro-playback-target-list"]');
    expect(list?.textContent).toContain("host-a");
    expect(list?.textContent).toContain("host-b");
    expect(q('[data-testid="macro-playback-multi-confirm"]')?.textContent).toContain(
      "will be typed into 2 terminals at once"
    );

    // Enter never sends from the confirmation step.
    act(() => {
      q('[data-testid="macro-playback-dialog"]')?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(onPlay).not.toHaveBeenCalled();

    expect(q('[data-testid="macro-playback-confirm"]')?.textContent).toBe("Send to 2 terminals");
    click(q('[data-testid="macro-playback-confirm"]'));
    expect(onPlay).toHaveBeenCalledWith("m1", "real-time", ["a", "b"]);
  });

  it("Back leaves the confirmation without playing", () => {
    seedTabs([term("a", "s-a"), term("b", "s-b")]);
    const onPlay = vi.fn();
    render(onPlay);
    pick("macro-playback-target", "All terminals");
    click(q('[data-testid="macro-playback-confirm"]'));
    click(q('[data-testid="macro-playback-cancel"]'));
    expect(q('[data-testid="macro-playback-multi-confirm"]')).toBeNull();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("opening a picker with Enter does not play", () => {
    seedTabs([term("a", "s-a")]);
    const onPlay = vi.fn();
    render(onPlay);
    openSelect("macro-playback-target");
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("offers saved broadcast groups and plays into their connected members", () => {
    seedTabs([term("a", "s-a", "c1"), term("b", "s-b", "c2"), term("c", "s-c", "c3")]);
    seedSettings({ broadcastGroups: [{ id: "g1", name: "web", connectionIds: ["c1", "c3"] }] });
    const onPlay = vi.fn();
    render(onPlay);

    pick("macro-playback-target", 'Group "web"');
    click(q('[data-testid="macro-playback-confirm"]'));
    click(q('[data-testid="macro-playback-confirm"]'));
    expect(onPlay).toHaveBeenCalledWith("m1", "real-time", ["a", "c"]);
  });

  it("disables Play when a multi-terminal target has no connected terminal", () => {
    seedTabs([term("a", "s-a", "c1")]);
    seedSettings({ broadcastGroups: [{ id: "g1", name: "db", connectionIds: ["c9"] }] });
    render(vi.fn());
    pick("macro-playback-target", 'Group "db"');
    expect((q('[data-testid="macro-playback-confirm"]') as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain("No connected terminals in this target");
  });
});
