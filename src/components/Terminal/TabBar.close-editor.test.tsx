import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TabBar } from "./TabBar";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { layoutState } from "@/test/layoutState";

vi.mock("./TerminalRegistry", () => ({
  useTerminalRegistry: () => ({
    clearTerminal: vi.fn(),
    saveTerminalToFile: vi.fn().mockResolvedValue(undefined),
    copyTerminalToClipboard: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  horizontalListSortingStrategy: {},
}));

vi.mock("./Tab", () => ({
  Tab: ({ tab, onClose }: { tab: TerminalTab; onClose: () => void }) => (
    <button data-testid={`tab-close-${tab.id}`} onClick={onClose}>
      close
    </button>
  ),
}));

vi.mock("./ColorPickerDialog", () => ({
  ColorPickerDialog: () => null,
}));

vi.mock("./RenameDialog", () => ({
  RenameDialog: () => null,
}));

const PANEL_ID = "panel-1";
const TAB_ID = "tab-editor-1";

function makeEditorTab(id = TAB_ID): TerminalTab {
  return {
    id,
    sessionId: null,
    title: "test.txt",
    connectionType: "local",
    contentType: "editor",
    config: { type: "local", config: {} },
    panelId: PANEL_ID,
    isActive: true,
    editorMeta: { filePath: "/tmp/test.txt", isRemote: false },
  };
}

// A dirty tab whose contentType is NOT in the editor set
// (settings/editor/connection-editor). This is the fallback branch that used
// to trigger the native window.confirm and now surfaces the shared dialog.
function makeDirtyOtherTab(id = TAB_ID): TerminalTab {
  return {
    id,
    sessionId: null,
    title: "tunnel.json",
    connectionType: "local",
    contentType: "tunnel-editor",
    config: { type: "local", config: {} },
    panelId: PANEL_ID,
    isActive: true,
  };
}

let container: HTMLDivElement;
let root: Root;

function render(tabs: TerminalTab[]) {
  act(() => {
    root.render(<TabBar panelId={PANEL_ID} tabs={tabs} />);
  });
}

function resetStore() {
  useAppStore.setState({
    editorDirtyTabs: {},
    pendingCloseRequest: null,
    pendingSessionCloseConfirm: null,
    // Restore the real action so a per-test spy from a prior case cannot leak.
    closeTab: useAppStore.getInitialState().closeTab,
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  resetStore();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("TabBar — close file editor tab with unsaved changes", () => {
  it("routes close through setPendingCloseRequest for a dirty editor tab (no window.confirm)", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const tabs = [makeEditorTab()];
    render(tabs);

    useAppStore.setState({ editorDirtyTabs: { [TAB_ID]: true } });

    const closeBtn = container.querySelector(
      `[data-testid="tab-close-${TAB_ID}"]`
    ) as HTMLButtonElement;

    act(() => {
      closeBtn.click();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingCloseRequest).toEqual({
      tabId: TAB_ID,
      panelId: PANEL_ID,
    });
  });

  it("does not close the tab immediately when the editor tab is dirty", () => {
    const tabs = [makeEditorTab()];
    render(tabs);

    useAppStore.setState({ editorDirtyTabs: { [TAB_ID]: true } });

    // Record panels before close attempt
    const panelsBefore = layoutState().rootPanel;

    const closeBtn = container.querySelector(
      `[data-testid="tab-close-${TAB_ID}"]`
    ) as HTMLButtonElement;

    act(() => {
      closeBtn.click();
    });

    // Tab should still be present (panel tree unchanged)
    expect(layoutState().rootPanel).toEqual(panelsBefore);
  });

  it("closes a clean editor tab directly without dialog", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const tabs = [makeEditorTab()];
    render(tabs);

    // Tab is not dirty
    useAppStore.setState({ editorDirtyTabs: { [TAB_ID]: false } });

    const closeBtn = container.querySelector(
      `[data-testid="tab-close-${TAB_ID}"]`
    ) as HTMLButtonElement;

    act(() => {
      closeBtn.click();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingCloseRequest).toBeNull();
  });
});

describe("TabBar — unsaved-changes fallback dialog (shared Modal, no window.confirm)", () => {
  const DIALOG = '[data-testid="unsaved-editor-close-dialog"]';

  it("shows the shared confirm dialog instead of a native window.confirm", () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const closeTab = vi.fn();
    useAppStore.setState({ closeTab });
    render([makeDirtyOtherTab()]);

    useAppStore.setState({ editorDirtyTabs: { [TAB_ID]: true } });

    act(() => {
      (container.querySelector(`[data-testid="tab-close-${TAB_ID}"]`) as HTMLElement).click();
    });

    // Native confirm is never used; the in-app dialog is rendered instead.
    expect(confirmSpy).not.toHaveBeenCalled();
    const dialog = document.querySelector(DIALOG);
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain("unsaved changes");
    // Nothing closes until the user confirms.
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("confirming proceeds with the close", () => {
    const closeTab = vi.fn();
    useAppStore.setState({ closeTab });
    render([makeDirtyOtherTab()]);

    useAppStore.setState({ editorDirtyTabs: { [TAB_ID]: true } });

    act(() => {
      (container.querySelector(`[data-testid="tab-close-${TAB_ID}"]`) as HTMLElement).click();
    });

    act(() => {
      (document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement).click();
    });

    expect(closeTab).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
    expect(document.querySelector(DIALOG)).toBeNull();
  });

  it("cancelling keeps the tab open and closes the dialog", () => {
    const closeTab = vi.fn();
    useAppStore.setState({ closeTab });
    render([makeDirtyOtherTab()]);

    useAppStore.setState({ editorDirtyTabs: { [TAB_ID]: true } });

    act(() => {
      (container.querySelector(`[data-testid="tab-close-${TAB_ID}"]`) as HTMLElement).click();
    });

    act(() => {
      (document.querySelector('[data-testid="confirm-dialog-cancel"]') as HTMLElement).click();
    });

    expect(closeTab).not.toHaveBeenCalled();
    expect(document.querySelector(DIALOG)).toBeNull();
  });
});
