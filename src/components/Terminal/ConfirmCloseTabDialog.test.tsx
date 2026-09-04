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

  it("shows the tab label in the description when kind is 'tab'", () => {
    render(<ConfirmCloseTabDialog />);

    act(() => {
      useAppStore.getState().setPendingShortcutCloseConfirm({
        kind: "tab",
        tabId: "tab-1",
        panelId: "panel-1",
        label: "my-server",
      });
    });

    const dialog = document.querySelector('[data-testid="confirm-close-tab-dialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain("my-server");
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
      });
    });

    act(() => {
      (document.querySelector('[data-testid="confirm-close-tab-cancel"]') as HTMLElement).click();
    });

    expect(useAppStore.getState().pendingShortcutCloseConfirm).toBeNull();
    expect(getAllLeaves(layoutState().rootPanel)[0].tabs).toHaveLength(1);
  });

  it("Confirm button closes the tab and clears the request", () => {
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
      });
    });

    act(() => {
      (document.querySelector('[data-testid="confirm-close-tab-confirm"]') as HTMLElement).click();
    });

    expect(useAppStore.getState().pendingShortcutCloseConfirm).toBeNull();
    expect(getAllLeaves(layoutState().rootPanel)[0].tabs).toHaveLength(0);
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
});
