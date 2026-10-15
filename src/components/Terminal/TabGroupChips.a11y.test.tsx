/**
 * Accessibility regressions for the tab-group chips (A11Y2-011, #4351).
 *
 * The chip is a <button>; it used to contain a `<span role="button">` close
 * control (nested buttons are invalid, and that span was neither focusable nor
 * keyboard-operable). The close glyph is now a pointer-only, aria-hidden
 * affordance and Delete/Backspace on the focused chip closes the group through
 * the same guarded path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { getLayoutTabGroups } from "@/store/layoutSelectors";
import { TooltipProvider } from "@/components/ui";
import { setupSettingsRegion } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";
import { checkA11y } from "@/test/axe";
import { getByRole, queryAllByRole } from "@/test/accessibleRoles";
import * as closeGuard from "@/utils/tabGroupCloseGuard";
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

function seedTwoGroups(): { first: string; firstName: string } {
  useAppStore.getState().addTabGroup();
  const [first] = getLayoutTabGroups();
  return { first: first.id, firstName: first.name };
}

const chipOf = (groupId: string) =>
  container.querySelector<HTMLElement>(`[data-tab-group-id="${groupId}"]`)!;

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("TabGroupChips — no nested interactive controls (A11Y2-011)", () => {
  it("names each chip by its group and nests no button inside it", async () => {
    const { first, firstName } = seedTwoGroups();
    await render();
    const chip = getByRole("button", firstName, container);
    expect(chip).toBe(chipOf(first));
    expect(queryAllByRole("button", undefined, chip)).toHaveLength(0);
    expect(chip.querySelector("[role='button'], button, [tabindex]")).toBeNull();
  });

  it("keeps the close glyph clickable but hidden from assistive tech", async () => {
    const spy = vi.spyOn(closeGuard, "closeTabGroupGuarded").mockImplementation(() => {});
    const { first } = seedTwoGroups();
    await render();
    const close = chipOf(first).querySelector<HTMLElement>('[data-testid="tab-group-chip-close"]')!;
    expect(close.getAttribute("aria-hidden")).toBe("true");
    act(() => close.click());
    expect(spy).toHaveBeenCalledWith(first);
  });

  it.each(["Delete", "Backspace"])("closes the focused chip's group with %s", async (key) => {
    const spy = vi.spyOn(closeGuard, "closeTabGroupGuarded").mockImplementation(() => {});
    const { first } = seedTwoGroups();
    await render();
    const chip = chipOf(first);
    expect(chip.getAttribute("aria-keyshortcuts")).toBe("Delete");
    act(() => {
      chip.focus();
      chip.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
    expect(spy).toHaveBeenCalledWith(first);
  });

  it("has no axe violations", async () => {
    seedTwoGroups();
    await render();
    expect(await checkA11y(container)).toHaveNoViolations();
  });
});
