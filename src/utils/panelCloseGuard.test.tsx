/**
 * Regression tests for UX2-003 (#4314), split-panel half.
 *
 * Closing a split panel checked only for live sessions, so a panel whose tabs
 * were unsaved editors (which carry no session) was removed at once and the
 * edits were lost. The panel close now goes through the same guard as a group
 * close: unsaved editors always prompt (the live-session opt-out does not cover
 * them), the copy names the editors, and cancel keeps the panel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { layoutState } from "@/test/layoutState";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";
import { flushAsync } from "@/test/flushAsync";
import { ConfirmSessionCloseDialog } from "@/components/Terminal/ConfirmSessionCloseDialog";
import { getAllLeaves } from "./panelTree";
import { closePanelGuarded } from "./tabGroupCloseGuard";

let container: HTMLDivElement;
let root: Root;

setupSettingsRegion();

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** Split into two panels; the new (active) one holds a tab of `contentType`. */
function seedSplit(contentType: "terminal" | "editor"): { panelId: string; tabId: string } {
  useAppStore.getState().addTab("left", "local", undefined, { contentType: "editor" });
  act(() => useAppStore.getState().splitPanel("horizontal"));
  const panelId = layoutState().activePanelId!;
  const tabId = useAppStore
    .getState()
    .addTab("nginx.conf", "local", undefined, { contentType, panelId });
  return { panelId, tabId };
}

const panelIds = () => getAllLeaves(layoutState().rootPanel).map((p) => p.id);

async function render() {
  await act(async () => {
    root.render(<ConfirmSessionCloseDialog />);
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
  vi.restoreAllMocks();
});

describe("closePanelGuarded — unsaved editors (UX2-003)", () => {
  it("prompts instead of removing a panel that holds a dirty editor", async () => {
    const { panelId, tabId } = seedSplit("editor");
    useAppStore.getState().setEditorDirty(tabId, true);
    await render();

    act(() => closePanelGuarded(panelId));

    expect(panelIds()).toContain(panelId);
    expect(useAppStore.getState().pendingSessionCloseConfirm).toMatchObject({
      kind: "panel",
      panelId,
      liveCount: 0,
      dirtyCount: 1,
    });
    expect(q("confirm-session-close-dialog")?.textContent).toContain("discard 1 unsaved editor");
  });

  it("still prompts for a dirty editor when live-session prompts are off", async () => {
    seedSettings({ confirmCloseLiveSession: false });
    const { panelId, tabId } = seedSplit("editor");
    useAppStore.getState().setEditorDirty(tabId, true);
    await render();

    act(() => closePanelGuarded(panelId));

    expect(panelIds()).toContain(panelId);
    // The opt-out only covers live sessions, so it is not offered for unsaved work.
    expect(q("confirm-dialog-dont-ask-again")).toBeNull();
  });

  it("cancel keeps the panel; confirm removes it", async () => {
    const { panelId, tabId } = seedSplit("editor");
    useAppStore.getState().setEditorDirty(tabId, true);
    await render();

    act(() => closePanelGuarded(panelId));
    act(() => q("confirm-dialog-cancel")!.click());
    expect(panelIds()).toContain(panelId);

    act(() => closePanelGuarded(panelId));
    act(() => q("confirm-dialog-confirm")!.click());
    expect(panelIds()).not.toContain(panelId);
  });

  it("removes a panel of clean editors without asking", async () => {
    const { panelId } = seedSplit("editor");
    await render();

    act(() => closePanelGuarded(panelId));

    expect(useAppStore.getState().pendingSessionCloseConfirm).toBeNull();
    expect(panelIds()).not.toContain(panelId);
  });

  it("names both the live sessions and the unsaved editors", async () => {
    const { panelId, tabId } = seedSplit("editor");
    useAppStore.getState().setEditorDirty(tabId, true);
    useAppStore.getState().addTab("shell", "local", undefined, { panelId });
    await render();

    act(() => closePanelGuarded(panelId));

    const text = q("confirm-session-close-dialog")?.textContent ?? "";
    expect(text).toContain("end 1 live session");
    expect(text).toContain("discard 1 unsaved editor");
  });
});
