import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
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

  it("restores all tabs (without remember) when Restore is clicked", () => {
    storeState.restorePrompt = { tabCount: 1, tabs: [{ title: "Shell", typeLabel: "Local" }] };
    render();

    act(() => (byTestId("session-restore-confirm") as HTMLElement).click());

    expect(confirmRestorePrompt).toHaveBeenCalledTimes(1);
    expect(confirmRestorePrompt).toHaveBeenCalledWith(false, [0]);
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

    expect(confirmRestorePrompt).toHaveBeenCalledWith(true, [0]);
  });

  it("renders a checkbox per tab", () => {
    storeState.restorePrompt = {
      tabCount: 2,
      tabs: [
        { title: "one", typeLabel: "SSH" },
        { title: "two", typeLabel: "Local" },
      ],
    };
    render();
    expect(byTestId("session-restore-tab-checkbox-0")).not.toBeNull();
    expect(byTestId("session-restore-tab-checkbox-1")).not.toBeNull();
  });

  it("restores only the checked tabs", () => {
    storeState.restorePrompt = {
      tabCount: 2,
      tabs: [
        { title: "one", typeLabel: "SSH" },
        { title: "two", typeLabel: "Local" },
      ],
    };
    render();

    // Uncheck the first tab, then confirm.
    act(() => (byTestId("session-restore-tab-checkbox-0") as HTMLElement).click());
    act(() => (byTestId("session-restore-confirm") as HTMLElement).click());

    expect(confirmRestorePrompt).toHaveBeenCalledWith(false, [1]);
  });

  it("shows a warning icon and starts unchecked for an unreachable tab", () => {
    storeState.restorePrompt = {
      tabCount: 2,
      tabs: [
        { title: "reachable", typeLabel: "SSH", reachability: "reachable" },
        {
          title: "/dev/ttyUSB0",
          typeLabel: "Serial",
          reachability: "unreachable",
          unreachableReason: "device offline",
        },
      ],
    };
    render();

    const warning = byTestId("session-restore-tab-warning-1");
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain("device offline");
    // No warning on the reachable tab.
    expect(byTestId("session-restore-tab-warning-0")).toBeNull();

    // The unreachable tab starts unchecked, so restore excludes it by default.
    act(() => (byTestId("session-restore-confirm") as HTMLElement).click());
    expect(confirmRestorePrompt).toHaveBeenCalledWith(false, [0]);
  });

  it("disables the confirm button when every tab is unchecked", () => {
    storeState.restorePrompt = { tabCount: 1, tabs: [{ title: "Shell", typeLabel: "Local" }] };
    render();

    act(() => (byTestId("session-restore-tab-checkbox-0") as HTMLElement).click());

    const confirm = byTestId("session-restore-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it("passes remember=true to dismiss after ticking 'Remember my choice'", () => {
    storeState.restorePrompt = { tabCount: 1, tabs: [{ title: "Shell", typeLabel: "Local" }] };
    render();

    act(() => (byTestId("session-restore-remember") as HTMLElement).click());
    act(() => (byTestId("session-restore-cancel") as HTMLElement).click());

    expect(dismissRestorePrompt).toHaveBeenCalledWith(true);
  });
});
