/**
 * Regression tests for UX2-001 (#4306).
 *
 * Closing a tab group from its chip X (or the chip's "Close Group" item) used to
 * call `closeTabGroup` directly, ending every live session in the group and
 * dropping unsaved editors with no confirmation. These tests pin that the chip
 * close is routed through the live-session confirm (ConfirmSessionCloseDialog,
 * `kind: "group"`): it prompts when the group holds live sessions or unsaved
 * editors, closes directly when nothing would be lost, honours the
 * "Don't ask again" opt-out for live sessions, and that cancel keeps the group
 * while confirm closes it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { getLayoutTabGroups } from "@/store/layoutSelectors";
import { TooltipProvider } from "@/components/ui";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";
import { TabGroupChips } from "./TabGroupChips";
import { ConfirmSessionCloseDialog } from "./ConfirmSessionCloseDialog";

let container: HTMLDivElement;
let root: Root;

setupSettingsRegion();

/**
 * Seed two groups: the first holds a tab of `contentType` (a local shell terminal
 * is live by default), the second is empty and active. Returns the first group's id.
 */
function seedTwoGroups(contentType: "terminal" | "editor" = "terminal"): {
  groupId: string;
  tabId: string;
} {
  const tabId = useAppStore.getState().addTab("shell", "local", undefined, { contentType });
  const groupId = getLayoutTabGroups()[0].id;
  useAppStore.getState().addTabGroup();
  return { groupId, tabId };
}

async function render() {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <TabGroupChips />
        <ConfirmSessionCloseDialog />
      </TooltipProvider>
    );
  });
  await flushAsync();
}

function clickChipClose(groupId: string) {
  const chip = container.querySelector(`[data-tab-group-id="${groupId}"]`);
  const close = chip?.querySelector<HTMLElement>('[data-testid="tab-group-chip-close"]');
  expect(close).not.toBeNull();
  act(() => close!.click());
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

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

describe("TabGroupChips — closing a group with live sessions (UX2-001)", () => {
  it("opens the confirm instead of closing when the group holds a live session", async () => {
    const { groupId } = seedTwoGroups();
    const spy = vi.spyOn(useAppStore.getState(), "closeTabGroup");
    await render();

    clickChipClose(groupId);

    expect(spy).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingSessionCloseConfirm).toMatchObject({
      kind: "group",
      tabGroupId: groupId,
      liveCount: 1,
      dirtyCount: 0,
    });
    expect(q("confirm-session-close-dialog")?.textContent).toContain("1 live session");
  });

  it("cancel keeps the group and its tab", async () => {
    const { groupId } = seedTwoGroups();
    await render();

    clickChipClose(groupId);
    act(() => q("confirm-dialog-cancel")!.click());

    expect(useAppStore.getState().pendingSessionCloseConfirm).toBeNull();
    expect(getLayoutTabGroups().map((g) => g.id)).toContain(groupId);
  });

  it("confirm closes the group", async () => {
    const { groupId } = seedTwoGroups();
    await render();

    clickChipClose(groupId);
    act(() => q("confirm-dialog-confirm")!.click());

    expect(useAppStore.getState().pendingSessionCloseConfirm).toBeNull();
    expect(getLayoutTabGroups().map((g) => g.id)).not.toContain(groupId);
  });

  it("closes directly with no prompt when nothing live would end", async () => {
    const { groupId } = seedTwoGroups("editor");
    await render();

    clickChipClose(groupId);

    expect(useAppStore.getState().pendingSessionCloseConfirm).toBeNull();
    expect(getLayoutTabGroups().map((g) => g.id)).not.toContain(groupId);
  });

  it("closes directly when the user opted out of the live-session prompt", async () => {
    seedSettings({ confirmCloseLiveSession: false });
    const { groupId } = seedTwoGroups();
    await render();

    clickChipClose(groupId);

    expect(useAppStore.getState().pendingSessionCloseConfirm).toBeNull();
    expect(getLayoutTabGroups().map((g) => g.id)).not.toContain(groupId);
  });

  it("still prompts for unsaved editors even when live-session prompts are off", async () => {
    seedSettings({ confirmCloseLiveSession: false });
    const { groupId, tabId } = seedTwoGroups("editor");
    useAppStore.getState().setEditorDirty(tabId, true);
    await render();

    clickChipClose(groupId);

    expect(useAppStore.getState().pendingSessionCloseConfirm).toMatchObject({
      kind: "group",
      tabGroupId: groupId,
      liveCount: 0,
      dirtyCount: 1,
    });
    expect(q("confirm-session-close-dialog")?.textContent).toContain("1 unsaved editor");
    // The opt-out only covers live sessions, so it is not offered for unsaved work.
    expect(q("confirm-dialog-dont-ask-again")).toBeNull();
  });
});
