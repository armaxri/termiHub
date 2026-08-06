/**
 * Closing a persistent-session-attached tab via the X shows a one-time detach
 * notice rather than the destructive live-session warning (#1930): the session
 * keeps running in the background, so the tab close only detaches it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TabBar } from "./TabBar";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";

vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: { ...actual.toast, success: vi.fn() },
  };
});

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

vi.mock("./TerminalRegistry", () => ({
  useTerminalRegistry: () => ({
    clearTerminal: vi.fn(),
    saveTerminalToFile: vi.fn().mockResolvedValue(undefined),
    copyTerminalToClipboard: vi.fn().mockResolvedValue(undefined),
    openTerminalInEditor: vi.fn(),
  }),
}));

vi.mock("./ColorPickerDialog", () => ({ ColorPickerDialog: () => null }));
vi.mock("./RenameDialog", () => ({ RenameDialog: () => null }));

const PANEL_ID = "panel-1";
const TAB_ID = "tab-persistent-1";

function persistentTab(): TerminalTab {
  return {
    id: TAB_ID,
    sessionId: "sess-1",
    title: "bg-shell",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "prod" } },
    panelId: PANEL_ID,
    isActive: true,
    persistentConnectionId: "ssh-1",
  };
}

let container: HTMLDivElement;
let root: Root;

setupSettingsRegion();

function render(tabs: TerminalTab[]) {
  act(() => root.render(<TabBar panelId={PANEL_ID} tabs={tabs} />));
}

function clickClose() {
  act(() => {
    (container.querySelector(`[data-testid="tab-close-${TAB_ID}"]`) as HTMLElement).click();
  });
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

describe("TabBar — closing a persistent-attached tab via the X", () => {
  it("opens the detach notice instead of closing immediately", () => {
    const closeTab = vi.fn();
    useAppStore.setState({ closeTab });
    render([persistentTab()]);

    clickClose();

    expect(closeTab).not.toHaveBeenCalled();
    // The destructive live-session warning must NOT fire for a persistent tab.
    expect(useAppStore.getState().pendingSessionCloseConfirm).toBeNull();
    expect(useAppStore.getState().pendingAttachedTabCloseConfirm).toMatchObject({
      tabId: TAB_ID,
      panelId: PANEL_ID,
      label: "bg-shell",
    });
  });

  it("closes immediately without a notice when the user opted out", () => {
    const closeTab = vi.fn();
    useAppStore.setState({ closeTab });
    seedSettings({ confirmCloseAttachedTab: false });
    render([persistentTab()]);

    clickClose();

    expect(closeTab).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
    expect(useAppStore.getState().pendingAttachedTabCloseConfirm).toBeNull();
  });
});
