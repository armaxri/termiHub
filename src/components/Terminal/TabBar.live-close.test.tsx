import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TabBar } from "./TabBar";
import { useAppStore } from "@/store/appStore";
import { TerminalTab } from "@/types/terminal";
import { setupSettingsRegion, seedSettings } from "@/test/settingsRegionTestHarness";

const toastSuccess = vi.fn();
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: { ...actual.toast, success: (m: string, o?: unknown) => toastSuccess(m, o) },
  };
});

vi.mock("./TerminalRegistry", () => ({
  useTerminalRegistry: () => ({
    clearTerminal: vi.fn(),
    saveTerminalToFile: vi.fn().mockResolvedValue(undefined),
    copyTerminalToClipboard: vi.fn().mockResolvedValue(undefined),
    openTerminalInEditor: vi.fn(),
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

vi.mock("./ColorPickerDialog", () => ({ ColorPickerDialog: () => null }));
vi.mock("./RenameDialog", () => ({ RenameDialog: () => null }));

const PANEL_ID = "panel-1";
const TAB_ID = "tab-live-1";

function liveTerminalTab(): TerminalTab {
  return {
    id: TAB_ID,
    sessionId: "sess-1",
    title: "prod-ssh",
    connectionType: "ssh",
    contentType: "terminal",
    config: { type: "ssh", config: { host: "prod" } },
    panelId: PANEL_ID,
    isActive: true,
  };
}

let container: HTMLDivElement;
let root: Root;

setupSettingsRegion();

function render(tabs: TerminalTab[]) {
  act(() => root.render(<TabBar panelId={PANEL_ID} tabs={tabs} />));
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  toastSuccess.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("TabBar — closing a live-session tab via the X", () => {
  it("opens the live-session confirmation instead of closing immediately", () => {
    const closeTab = vi.fn();
    useAppStore.setState({ closeTab });
    render([liveTerminalTab()]);

    act(() => {
      (container.querySelector(`[data-testid="tab-close-${TAB_ID}"]`) as HTMLElement).click();
    });

    expect(closeTab).not.toHaveBeenCalled();
    const req = useAppStore.getState().pendingSessionCloseConfirm;
    expect(req).toMatchObject({ kind: "tab", tabId: TAB_ID, panelId: PANEL_ID, label: "prod-ssh" });
    // The reopen payload is captured so the follow-up toast can offer Undo.
    expect(req?.kind === "tab" && req.reopen?.connectionType).toBe("ssh");
  });

  it("closes immediately with an Undo toast when the user opted out", () => {
    const closeTab = vi.fn();
    useAppStore.setState({ closeTab });
    seedSettings({ confirmCloseLiveSession: false });
    render([liveTerminalTab()]);

    act(() => {
      (container.querySelector(`[data-testid="tab-close-${TAB_ID}"]`) as HTMLElement).click();
    });

    expect(closeTab).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
    expect(useAppStore.getState().pendingSessionCloseConfirm).toBeNull();
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("does not confirm when the tab's session has already exited", () => {
    const closeTab = vi.fn();
    useAppStore.setState({ closeTab, terminalExitedTabs: { [TAB_ID]: true } });
    render([liveTerminalTab()]);

    act(() => {
      (container.querySelector(`[data-testid="tab-close-${TAB_ID}"]`) as HTMLElement).click();
    });

    expect(closeTab).toHaveBeenCalledWith(TAB_ID, PANEL_ID);
    expect(useAppStore.getState().pendingSessionCloseConfirm).toBeNull();
  });
});
