/**
 * One "+" on the toolbar (#5849, R-023): the tab-group strip no longer shows a
 * lone "Main" pill (it read as a tab above an empty tab row) and its add
 * control is a stack glyph named "New tab group", never a second "+".
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { getLayoutTabGroups } from "@/store/layoutSelectors";
import { TooltipProvider } from "@/components/ui";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";
import { checkA11y } from "@/test/axe";
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

const strip = () => container.querySelector<HTMLElement>('[data-testid="tab-group-chips"]')!;
const add = () => container.querySelector<HTMLElement>('[data-testid="tab-group-add"]')!;
const chips = () => container.querySelectorAll("[data-tab-group-id]");

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TabGroupChips — one plus on the toolbar (#5849)", () => {
  it("shows no chip for a single group and names the add control in words", async () => {
    expect(getLayoutTabGroups()).toHaveLength(1);
    await render();
    expect(chips()).toHaveLength(0);
    expect(add().textContent).toBe("New tab group");
    expect(add().getAttribute("aria-label")).toMatch(/^New tab group/);
    expect(add().classList.contains("tab-group-chips__add--labelled")).toBe(true);
  });

  it("never draws a plus, in either state", async () => {
    await render();
    expect(strip().querySelector("svg.lucide-plus")).toBeNull();
    expect(add().querySelector("svg")!.getAttribute("class")).toContain("lucide-layers");

    act(() => useAppStore.getState().addTabGroup());
    await flushAsync();
    expect(strip().querySelector("svg.lucide-plus")).toBeNull();
    expect(add().querySelector("svg")!.getAttribute("class")).toContain("lucide-layers");
  });

  it("shows the chips and an icon-only add control once a second group exists", async () => {
    useAppStore.getState().addTabGroup();
    await render();
    expect(chips()).toHaveLength(2);
    expect(add().textContent).toBe("");
    expect(add().getAttribute("aria-label")).toMatch(/^New tab group/);
    expect(add().classList.contains("tab-group-chips__add--labelled")).toBe(false);
  });

  it("keeps the add control a drop target for a dragged tab with one group", async () => {
    useAppStore.setState({ draggingTabId: "t1" });
    await render();
    expect(add().getAttribute("data-new-group-btn")).toBe("true");
    expect(add().classList.contains("tab-group-chips__add--drop-target")).toBe(true);
  });

  it("creates a group from the labelled control", async () => {
    await render();
    act(() => add().click());
    await flushAsync();
    expect(getLayoutTabGroups()).toHaveLength(2);
    expect(chips()).toHaveLength(2);
  });

  it("has no axe violations with a single group", async () => {
    await render();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
