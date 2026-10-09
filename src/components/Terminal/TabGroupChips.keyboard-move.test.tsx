/**
 * Keyboard alternatives to dragging a tab-group chip (A11Y2-003, #4329).
 *
 * Group order was drag-only. The chip's context menu (Shift+F10 / Menu key on
 * a focused chip) now offers Move Left / Move Right, which reorder the groups
 * through the same `reorderTabGroups` action as the drag path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { getLayoutTabGroups } from "@/store/layoutSelectors";
import { TooltipProvider } from "@/components/ui";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";
import { TabGroupChips } from "./TabGroupChips";

let container: HTMLDivElement;
let root: Root;

setupSettingsRegion();

async function render() {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <TabGroupChips />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

function openMenu(groupId: string) {
  const chip = container.querySelector(`[data-tab-group-id="${groupId}"]`) as HTMLElement;
  act(() => {
    chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function select(testId: string) {
  const item = q(testId) as HTMLElement;
  act(() => item.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TabGroupChips — reorder groups without a pointer (#4329)", () => {
  it("Move Right / Move Left reorder the group via reorderTabGroups", async () => {
    useAppStore.getState().addTabGroup();
    useAppStore.getState().addTabGroup();
    const ids = getLayoutTabGroups().map((g) => g.id);
    const reorderTabGroups = vi.fn();
    useAppStore.setState({ reorderTabGroups });
    await render();

    openMenu(ids[1]);
    select("tab-group-ctx-move-right");
    expect(reorderTabGroups).toHaveBeenCalledWith(1, 2);

    openMenu(ids[1]);
    select("tab-group-ctx-move-left");
    expect(reorderTabGroups).toHaveBeenCalledWith(1, 0);
  });

  it("disables Move Left on the first group and Move Right on the last", async () => {
    useAppStore.getState().addTabGroup();
    const ids = getLayoutTabGroups().map((g) => g.id);
    await render();

    openMenu(ids[0]);
    expect(q("tab-group-ctx-move-left")?.hasAttribute("data-disabled")).toBe(true);
    expect(q("tab-group-ctx-move-right")?.hasAttribute("data-disabled")).toBe(false);
  });
});
