import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";
import { ConfirmCloseTabDialog } from "./ConfirmCloseTabDialog";
import { layoutState } from "@/test/layoutState";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("ConfirmCloseTabDialog", () => {
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

  it("renders nothing when no pending request", () => {
    render(<ConfirmCloseTabDialog />);
    expect(document.querySelector('[data-testid="confirm-close-tab-dialog"]')).toBeNull();
  });

  it("shows the unsaved-changes copy with the tab label when kind is 'tab'", () => {
    render(<ConfirmCloseTabDialog />);

    act(() => {
      useAppStore.getState().setPendingShortcutCloseConfirm({
        kind: "tab",
        tabId: "tab-1",
        panelId: "panel-1",
        label: "my-server",
        unsaved: true,
      });
    });

    const dialog = document.querySelector('[data-testid="confirm-close-tab-dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain("my-server");
    expect(dialog?.textContent).toContain("unsaved changes");
    // Never the old blanket "work will be lost" copy (#5189).
    expect(dialog?.textContent).not.toContain("will be lost");
  });

  it("Cancel button clears the request and does not close the tab", () => {
    useAppStore.getState().addTab("Tab A", "local");
    const panel = getAllLeaves(layoutState().rootPanel)[0];
    const tabId = panel.tabs[0].id;

    render(<ConfirmCloseTabDialog />);

    act(() => {
      useAppStore.getState().setPendingShortcutCloseConfirm({
        kind: "tab",
        tabId,
        panelId: panel.id,
        label: "Tab A",
        unsaved: true,
      });
    });

    act(() => {
      (document.querySelector('[data-testid="confirm-close-tab-cancel"]') as HTMLElement).click();
    });

    expect(useAppStore.getState().pendingShortcutCloseConfirm).toBeNull();
    expect(getAllLeaves(layoutState().rootPanel)[0].tabs).toHaveLength(1);
  });

  it("Confirm closes a non-session tab and clears the request", () => {
    useAppStore.getState().addTab("Tab A", "local", undefined, { contentType: "editor" });
    const panel = getAllLeaves(layoutState().rootPanel)[0];
    const tabId = panel.tabs[0].id;

    render(<ConfirmCloseTabDialog />);

    act(() => {
      useAppStore.getState().setPendingShortcutCloseConfirm({
        kind: "tab",
        tabId,
        panelId: panel.id,
        label: "Tab A",
        unsaved: true,
      });
    });

    act(() => {
      (document.querySelector('[data-testid="confirm-close-tab-confirm"]') as HTMLElement).click();
    });

    expect(useAppStore.getState().pendingShortcutCloseConfirm).toBeNull();
    expect(getAllLeaves(layoutState().rootPanel)[0].tabs).toHaveLength(0);
  });

  it("Confirm on a dirty live terminal continues to the live-session confirm (#5189)", () => {
    useAppStore.getState().addTab("Shell", "local");
    const panel = getAllLeaves(layoutState().rootPanel)[0];
    const tabId = panel.tabs[0].id;

    render(<ConfirmCloseTabDialog />);
    act(() => {
      useAppStore.getState().setPendingShortcutCloseConfirm({
        kind: "tab",
        tabId,
        panelId: panel.id,
        label: "Shell",
        unsaved: true,
      });
    });
    act(() => {
      (document.querySelector('[data-testid="confirm-close-tab-confirm"]') as HTMLElement).click();
    });

    expect(useAppStore.getState().pendingShortcutCloseConfirm).toBeNull();
    expect(getAllLeaves(layoutState().rootPanel)[0].tabs).toHaveLength(1);
    expect(useAppStore.getState().pendingSessionCloseConfirm).toMatchObject({
      kind: "tab",
      tabId,
      optOutSetting: "confirmCloseTabOnShortcut",
    });
  });

  it("for tab-group kind, confirm closes the tab group", () => {
    useAppStore.getState().addTabGroup("Group Beta");
    const groupsBefore = layoutState().tabGroups.length;
    const targetId = layoutState().activeTabGroupId;

    render(<ConfirmCloseTabDialog />);

    act(() => {
      useAppStore.getState().setPendingShortcutCloseConfirm({
        kind: "tab-group",
        tabGroupId: targetId,
        label: "Group Beta",
      });
    });

    const dialog = document.querySelector('[data-testid="confirm-close-tab-dialog"]');
    expect(dialog?.textContent).toContain("Group Beta");

    act(() => {
      (
        document.querySelector('[data-testid="confirm-close-tab-group-confirm"]') as HTMLElement
      ).click();
    });

    expect(layoutState().tabGroups).toHaveLength(groupsBefore - 1);
    expect(useAppStore.getState().pendingShortcutCloseConfirm).toBeNull();
  });

  it("shows the unsaved-changes copy and closes on confirm for an unsaved request (#4410)", () => {
    useAppStore.getState().addTab("Diag", "local", undefined, { contentType: "log-viewer" });
    const panel = getAllLeaves(layoutState().rootPanel)[0];
    const tabId = panel.tabs[0].id;

    render(<ConfirmCloseTabDialog />);
    act(() => {
      useAppStore.getState().setPendingShortcutCloseConfirm({
        kind: "tab",
        tabId,
        panelId: panel.id,
        label: "Diag",
        unsaved: true,
      });
    });

    const dialog = document.querySelector('[data-testid="confirm-close-tab-dialog"]');
    expect(dialog?.textContent).toContain("Unsaved changes");
    expect(dialog?.textContent).toContain('"Diag" has unsaved changes');
    expect(dialog?.textContent).not.toContain("Any work in this tab will be lost");

    act(() => {
      (document.querySelector('[data-testid="confirm-close-tab-confirm"]') as HTMLElement).click();
    });

    expect(getAllLeaves(layoutState().rootPanel)[0].tabs).toHaveLength(0);
    expect(useAppStore.getState().pendingShortcutCloseConfirm).toBeNull();
  });
});
