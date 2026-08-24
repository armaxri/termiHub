import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import { getAllLeaves } from "@/utils/panelTree";
import { ConfirmSessionCloseDialog } from "./ConfirmSessionCloseDialog";

const toastSuccess = vi.fn();
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    toast: { ...actual.toast, success: (m: string, o?: unknown) => toastSuccess(m, o) },
  };
});

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => root.render(<ConfirmSessionCloseDialog />));
}

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;

describe("ConfirmSessionCloseDialog", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    // The panel-kind spec splits synchronously before rendering; pin to the local
    // reducer (retained resilience fallback) since the mutation cut (#2184) makes
    // the intent path async by default.
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

  it("renders nothing when no request is pending", () => {
    render();
    expect(q("confirm-session-close-dialog")).toBeNull();
  });

  it("tab kind: confirm closes the tab and fires an Undo/Reopen toast", () => {
    useAppStore.getState().addTab("my-server", "ssh", { type: "ssh", config: { host: "h" } });
    const panel = getAllLeaves(useAppStore.getState().rootPanel)[0];
    const tabId = panel.tabs[0].id;
    render();

    act(() =>
      useAppStore.getState().setPendingSessionCloseConfirm({
        kind: "tab",
        tabId,
        panelId: panel.id,
        label: "my-server",
        reopen: { title: "my-server", connectionType: "ssh", config: { type: "ssh", config: {} } },
      })
    );

    expect(q("confirm-session-close-dialog")?.textContent).toContain("my-server");

    act(() => q("confirm-dialog-confirm").click());

    expect(getAllLeaves(useAppStore.getState().rootPanel)[0].tabs).toHaveLength(0);
    expect(useAppStore.getState().pendingSessionCloseConfirm).toBeNull();
    expect(toastSuccess).toHaveBeenCalled();
    // The toast carries a Reopen action.
    expect(toastSuccess.mock.calls[0][1]).toMatchObject({ action: { label: "Reopen" } });
  });

  it("tab kind: cancel leaves the tab open and shows no toast", () => {
    useAppStore.getState().addTab("keep", "local");
    const panel = getAllLeaves(useAppStore.getState().rootPanel)[0];
    render();

    act(() =>
      useAppStore.getState().setPendingSessionCloseConfirm({
        kind: "tab",
        tabId: panel.tabs[0].id,
        panelId: panel.id,
        label: "keep",
        reopen: null,
      })
    );

    act(() => q("confirm-dialog-cancel").click());

    expect(getAllLeaves(useAppStore.getState().rootPanel)[0].tabs).toHaveLength(1);
    expect(useAppStore.getState().pendingSessionCloseConfirm).toBeNull();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("panel kind: shows a count-aware message and removes the panel on confirm", () => {
    useAppStore.getState().addTab("A", "local");
    act(() => useAppStore.getState().splitPanel("horizontal"));
    const leavesBefore = getAllLeaves(useAppStore.getState().rootPanel);
    expect(leavesBefore.length).toBe(2);
    const target = useAppStore.getState().activePanelId!;
    render();

    act(() =>
      useAppStore.getState().setPendingSessionCloseConfirm({
        kind: "panel",
        panelId: target,
        liveCount: 1,
        tabCount: 1,
      })
    );

    const dialog = q("confirm-session-close-dialog");
    expect(dialog?.textContent).toContain("1 tab");
    expect(dialog?.textContent).toContain("1 live session");

    act(() => q("confirm-dialog-confirm").click());

    expect(getAllLeaves(useAppStore.getState().rootPanel).length).toBe(1);
    expect(useAppStore.getState().pendingSessionCloseConfirm).toBeNull();
  });

  it("Don't ask again then Confirm persists confirmCloseLiveSession=false", () => {
    const updateSettings = vi.fn(() => Promise.resolve());
    useAppStore.setState({ updateSettings });
    useAppStore.getState().addTab("x", "local");
    const panel = getAllLeaves(useAppStore.getState().rootPanel)[0];
    render();

    act(() =>
      useAppStore.getState().setPendingSessionCloseConfirm({
        kind: "tab",
        tabId: panel.tabs[0].id,
        panelId: panel.id,
        label: "x",
        reopen: null,
      })
    );

    // Ticking alone must not write — the preference is deferred to confirm.
    act(() => q("confirm-dialog-dont-ask-again").click());
    expect(updateSettings).not.toHaveBeenCalled();

    // Confirming commits the deferred preference.
    act(() => q("confirm-dialog-confirm").click());
    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ confirmCloseLiveSession: false })
    );
  });

  it("Don't ask again then Cancel does NOT persist the preference", () => {
    const updateSettings = vi.fn(() => Promise.resolve());
    useAppStore.setState({ updateSettings });
    useAppStore.getState().addTab("y", "local");
    const panel = getAllLeaves(useAppStore.getState().rootPanel)[0];
    render();

    act(() =>
      useAppStore.getState().setPendingSessionCloseConfirm({
        kind: "tab",
        tabId: panel.tabs[0].id,
        panelId: panel.id,
        label: "y",
        reopen: null,
      })
    );

    act(() => q("confirm-dialog-dont-ask-again").click());
    act(() => q("confirm-dialog-cancel").click());

    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("Confirm without ticking leaves the preference untouched", () => {
    const updateSettings = vi.fn(() => Promise.resolve());
    useAppStore.setState({ updateSettings });
    useAppStore.getState().addTab("z", "local");
    const panel = getAllLeaves(useAppStore.getState().rootPanel)[0];
    render();

    act(() =>
      useAppStore.getState().setPendingSessionCloseConfirm({
        kind: "tab",
        tabId: panel.tabs[0].id,
        panelId: panel.id,
        label: "z",
        reopen: null,
      })
    );

    act(() => q("confirm-dialog-confirm").click());

    expect(updateSettings).not.toHaveBeenCalled();
  });
});
