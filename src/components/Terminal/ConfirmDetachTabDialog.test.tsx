/**
 * The one-time detach notice (#1930): shown when a persistent-session tab is
 * closed, it reassures the user the session keeps running and lets them opt out
 * of future notices via "Don't show again".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ConfirmDetachTabDialog } from "./ConfirmDetachTabDialog";
import { useAppStore } from "@/store/appStore";
import { TooltipProvider } from "@/components/ui";

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(
      React.createElement(TooltipProvider, {
        delayDuration: 0,
        children: React.createElement(ConfirmDetachTabDialog),
      })
    );
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
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
  vi.clearAllMocks();
});

describe("ConfirmDetachTabDialog", () => {
  it("renders nothing when no request is pending", () => {
    render();
    expect(byTestId("confirm-detach-tab-dialog")).toBeNull();
  });

  it("shows the keep-running notice for a pending request", () => {
    useAppStore.setState({
      pendingAttachedTabCloseConfirm: { tabId: "t1", panelId: "p1", label: "bg-shell" },
    });
    render();
    const dialog = byTestId("confirm-detach-tab-dialog");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("bg-shell");
    expect(dialog!.textContent).toContain("running in the background");
  });

  it("closes the tab and clears the request on confirm", () => {
    const closeTab = vi.fn();
    const updateSettings = vi.fn();
    useAppStore.setState({
      closeTab,
      updateSettings,
      pendingAttachedTabCloseConfirm: { tabId: "t1", panelId: "p1", label: "bg-shell" },
    });
    render();

    act(() => {
      (byTestId("confirm-detach-tab-confirm") as HTMLElement).click();
    });

    expect(closeTab).toHaveBeenCalledWith("t1", "p1");
    expect(useAppStore.getState().pendingAttachedTabCloseConfirm).toBeNull();
    // Preference untouched unless "Don't show again" was ticked.
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("persists the opt-out only when 'Don't show again' is ticked on confirm", () => {
    const closeTab = vi.fn();
    const updateSettings = vi.fn();
    useAppStore.setState({
      closeTab,
      updateSettings,
      pendingAttachedTabCloseConfirm: { tabId: "t1", panelId: "p1", label: "bg-shell" },
    });
    render();

    act(() => {
      (byTestId("confirm-detach-tab-dont-ask-again") as HTMLElement).click();
    });
    act(() => {
      (byTestId("confirm-detach-tab-confirm") as HTMLElement).click();
    });

    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ confirmCloseAttachedTab: false })
    );
    expect(closeTab).toHaveBeenCalledWith("t1", "p1");
  });

  it("does not close or persist on cancel", () => {
    const closeTab = vi.fn();
    const updateSettings = vi.fn();
    useAppStore.setState({
      closeTab,
      updateSettings,
      pendingAttachedTabCloseConfirm: { tabId: "t1", panelId: "p1", label: "bg-shell" },
    });
    render();

    act(() => {
      (byTestId("confirm-detach-tab-cancel") as HTMLElement).click();
    });

    expect(closeTab).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingAttachedTabCloseConfirm).toBeNull();
  });
});
