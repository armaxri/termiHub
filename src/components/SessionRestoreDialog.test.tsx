import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { RestorePrompt } from "@/utils/restoreMode";

const confirmRestorePrompt = vi.fn(() => Promise.resolve());
const dismissRestorePrompt = vi.fn(() => Promise.resolve());

/** Mutable slice the mocked store selector reads from. */
const storeState: {
  restorePrompt: RestorePrompt | null;
  confirmRestorePrompt: typeof confirmRestorePrompt;
  dismissRestorePrompt: typeof dismissRestorePrompt;
} = {
  restorePrompt: null,
  confirmRestorePrompt,
  dismissRestorePrompt,
};

vi.mock("@/store/appStore", () => ({
  useAppStore: <T,>(selector: (s: typeof storeState) => T): T => selector(storeState),
}));

import { SessionRestoreDialog } from "./SessionRestoreDialog";

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => {
    root.render(<SessionRestoreDialog />);
  });
}

function byTestId(id: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${id}"]`);
}

describe("SessionRestoreDialog", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    storeState.restorePrompt = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing when there is no pending prompt", () => {
    render();
    expect(byTestId("session-restore-dialog")).toBeNull();
  });

  it("shows the tab count and lists each tab with its type", () => {
    storeState.restorePrompt = {
      tabCount: 2,
      tabs: [
        { title: "admin@prod-db", typeLabel: "SSH" },
        { title: "Local", typeLabel: "Local" },
      ],
    };
    render();

    const dialog = byTestId("session-restore-dialog");
    expect(dialog?.textContent).toContain("You had 2 tabs open");
    const list = byTestId("session-restore-tabs");
    expect(list?.textContent).toContain("admin@prod-db");
    expect(list?.textContent).toContain("SSH");
    expect(list?.textContent).toContain("Local");
  });

  it("uses the singular 'tab' for a single stored tab", () => {
    storeState.restorePrompt = { tabCount: 1, tabs: [{ title: "Shell", typeLabel: "Local" }] };
    render();
    expect(byTestId("session-restore-dialog")?.textContent).toContain("You had 1 tab open");
  });

  it("restores (without remember) when Restore is clicked", () => {
    storeState.restorePrompt = { tabCount: 1, tabs: [{ title: "Shell", typeLabel: "Local" }] };
    render();

    act(() => (byTestId("session-restore-confirm") as HTMLElement).click());

    expect(confirmRestorePrompt).toHaveBeenCalledTimes(1);
    expect(confirmRestorePrompt).toHaveBeenCalledWith(false);
    expect(dismissRestorePrompt).not.toHaveBeenCalled();
  });

  it("starts fresh (without remember) when Start Fresh is clicked", () => {
    storeState.restorePrompt = { tabCount: 1, tabs: [{ title: "Shell", typeLabel: "Local" }] };
    render();

    act(() => (byTestId("session-restore-cancel") as HTMLElement).click());

    expect(dismissRestorePrompt).toHaveBeenCalledTimes(1);
    expect(dismissRestorePrompt).toHaveBeenCalledWith(false);
    expect(confirmRestorePrompt).not.toHaveBeenCalled();
  });

  it("passes remember=true to confirm after ticking 'Remember my choice'", () => {
    storeState.restorePrompt = { tabCount: 1, tabs: [{ title: "Shell", typeLabel: "Local" }] };
    render();

    act(() => (byTestId("session-restore-remember") as HTMLElement).click());
    act(() => (byTestId("session-restore-confirm") as HTMLElement).click());

    expect(confirmRestorePrompt).toHaveBeenCalledWith(true);
  });

  it("passes remember=true to dismiss after ticking 'Remember my choice'", () => {
    storeState.restorePrompt = { tabCount: 1, tabs: [{ title: "Shell", typeLabel: "Local" }] };
    render();

    act(() => (byTestId("session-restore-remember") as HTMLElement).click());
    act(() => (byTestId("session-restore-cancel") as HTMLElement).click());

    expect(dismissRestorePrompt).toHaveBeenCalledWith(true);
  });
});
