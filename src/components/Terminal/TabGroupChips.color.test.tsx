/**
 * A tab group's accent colour from its chip menu (tab-groups concept, #6164).
 *
 * The concept's chip menu offers Set Color; the store had `setTabGroupColor`
 * and the chip draws the dot, but nothing let the user pick a colour.
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

async function openMenu(groupId: string) {
  const chip = container.querySelector(`[data-tab-group-id="${groupId}"]`) as HTMLElement;
  await act(async () => {
    chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
  });
  await flushAsync();
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

async function select(testId: string) {
  const item = q(testId) as HTMLElement;
  await act(async () => {
    item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushAsync();
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

describe("TabGroupChips — Set color (#6164)", () => {
  it("opens the colour picker from the chip menu and sets the group's colour", async () => {
    useAppStore.getState().addTabGroup();
    const ids = getLayoutTabGroups().map((g) => g.id);
    const setTabGroupColor = vi.fn();
    useAppStore.setState({ setTabGroupColor });
    await render();

    await openMenu(ids[1]);
    await select("tab-group-ctx-color");
    expect(q("color-picker-apply")).not.toBeNull();
    await select("color-picker-swatch-ef4444");
    await select("color-picker-apply");
    expect(setTabGroupColor).toHaveBeenCalledWith(ids[1], "#ef4444");
  });

  it("clears the colour", async () => {
    useAppStore.getState().addTabGroup();
    const ids = getLayoutTabGroups().map((g) => g.id);
    const setTabGroupColor = vi.fn();
    useAppStore.setState({ setTabGroupColor });
    await render();

    await openMenu(ids[1]);
    await select("tab-group-ctx-color");
    await select("color-picker-clear");
    expect(setTabGroupColor).toHaveBeenCalledWith(ids[1], null);
  });
});
