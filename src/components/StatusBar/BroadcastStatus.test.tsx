/**
 * Tests for the broadcast status-bar pill (#1957).
 *
 * While broadcast is active the pill shows the live target count and stops
 * broadcast on click; when every target is disconnected it becomes a warning.
 * Everything is driven off the broadcast store state from the foundation (#1955).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { currentBroadcastView, ensureBroadcastSubscribed } from "@/store/broadcastBridge";
import { installBroadcastHarness } from "@/test/broadcastHarness";
import { TooltipProvider } from "@/components/ui";
import { BroadcastStatus } from "./BroadcastStatus";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import { seedLayoutState } from "@/test/layoutState";

function makeTab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id,
    sessionId: `sess-${id}`,
    title: id,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "leaf-1",
    isActive: id === "src",
    ...overrides,
  };
}

/** Seed a single leaf panel holding the given tabs as the active group. */
function seedTabs(tabs: TerminalTab[]) {
  const leaf: LeafPanel = { type: "leaf", id: "leaf-1", tabs, activeTabId: tabs[0]?.id ?? null };
  seedLayoutState({ rootPanel: leaf, activePanelId: "leaf-1" });
}

describe("BroadcastStatus (#1957)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let harness: ReturnType<typeof installBroadcastHarness>;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useAppStore.setState(useAppStore.getInitialState());
    harness = installBroadcastHarness();
    // Subscribe up front so a `startBroadcast` before render lands in
    // `currentBroadcastView()` synchronously (region-authoritative, #2206).
    await ensureBroadcastSubscribed();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    harness.teardown();
  });

  const render = () =>
    act(() => {
      root.render(
        <TooltipProvider delayDuration={0}>
          <BroadcastStatus />
        </TooltipProvider>
      );
    });

  const pill = () => container.querySelector('[data-testid="broadcast-status"]');

  it("renders nothing when broadcast is inactive", () => {
    seedTabs([makeTab("src")]);
    render();
    expect(pill()).toBeNull();
  });

  it("shows the total participating count while active with connected targets", () => {
    seedTabs([makeTab("src"), makeTab("t2"), makeTab("t3")]);
    useAppStore.getState().startBroadcast("all", "src", ["t2", "t3"]);
    render();
    const el = pill();
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain("Broadcast (3 terminals)");
    expect(el?.className).not.toContain("status-bar__item--broadcast-warning");
  });

  it("shows the warning state (0/N connected) when every target is disconnected", () => {
    // No live session on any tab → getBroadcastTargetTabIds resolves to none.
    seedTabs([
      makeTab("src", { sessionId: null }),
      makeTab("t2", { sessionId: null }),
      makeTab("t3", { sessionId: null }),
    ]);
    useAppStore.getState().startBroadcast("all", "src", ["t2", "t3"]);
    render();
    const el = pill();
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain("Broadcast (0/3 connected)");
    expect(el?.className).toContain("status-bar__item--broadcast-warning");
  });

  it("stops broadcast when the pill is clicked", () => {
    seedTabs([makeTab("src"), makeTab("t2")]);
    useAppStore.getState().startBroadcast("all", "src", ["t2"]);
    render();
    expect(currentBroadcastView().active).toBe(true);

    act(() => {
      (pill() as HTMLButtonElement).click();
    });

    expect(currentBroadcastView().active).toBe(false);
    // Re-render reflects the stopped state: the pill disappears.
    render();
    expect(pill()).toBeNull();
  });
});
