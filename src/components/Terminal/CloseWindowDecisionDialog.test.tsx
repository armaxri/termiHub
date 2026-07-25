import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { WindowCloseRequest } from "@/types/window";
import { CloseWindowDecisionDialog } from "./CloseWindowDecisionDialog";

const destroy = vi.fn(() => Promise.resolve());
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ destroy, label: "win-2" }),
}));

const endWindowSessions = vi.fn(() => Promise.resolve());
const moveWindowSessionsToWindow = vi.fn(() => Promise.resolve());

let container: HTMLDivElement;
let root: Root;

function render() {
  act(() => root.render(<CloseWindowDecisionDialog />));
}

const q = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) as HTMLElement;
const qa = (testId: string) =>
  Array.from(document.querySelectorAll(`[data-testid="${testId}"]`)) as HTMLElement[];

function request(overrides: Partial<WindowCloseRequest> = {}): WindowCloseRequest {
  return {
    sessions: [
      {
        tabId: "t1",
        sessionId: "s1",
        title: "server-1",
        connectionType: "ssh",
        contentType: "terminal",
        outcome: "detach",
      },
      {
        tabId: "t2",
        sessionId: "s2",
        title: "build",
        connectionType: "local",
        contentType: "terminal",
        outcome: "terminate",
      },
    ],
    otherWindows: [{ label: "win-1" }],
    ...overrides,
  };
}

describe("CloseWindowDecisionDialog (#1903)", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState());
    useAppStore.setState({ endWindowSessions, moveWindowSessionsToWindow });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders nothing when no close is pending", () => {
    render();
    expect(q("close-window-decision-dialog")).toBeNull();
  });

  it("lists per-session outcomes (detach vs terminate)", () => {
    render();
    act(() => useAppStore.getState().setPendingWindowClose(request()));

    expect(qa("close-window-decision-row")).toHaveLength(2);
    expect(q("close-window-decision-outcome-detach")).not.toBeNull();
    expect(q("close-window-decision-outcome-terminate")).not.toBeNull();
  });

  it("shows Move-to-window as the primary action when another window exists", () => {
    render();
    act(() => useAppStore.getState().setPendingWindowClose(request()));

    const move = q("close-window-decision-move");
    expect(move).not.toBeNull();
    // Single other window → the button names it directly.
    expect(move.textContent).toContain("Move tabs to Window 1");
  });

  it("hides the Move action when there is no other window to move to", () => {
    render();
    act(() => useAppStore.getState().setPendingWindowClose(request({ otherWindows: [] })));

    expect(q("close-window-decision-move")).toBeNull();
    // The destructive action is still available.
    expect(q("close-window-decision-end")).not.toBeNull();
  });

  it("Close & end sessions ends sessions and destroys the window", async () => {
    render();
    act(() => useAppStore.getState().setPendingWindowClose(request()));

    await act(async () => {
      q("close-window-decision-end").click();
    });

    expect(endWindowSessions).toHaveBeenCalledTimes(1);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().pendingWindowClose).toBeNull();
  });

  it("Move tabs re-parents sessions to the chosen window and destroys this one", async () => {
    render();
    act(() => useAppStore.getState().setPendingWindowClose(request()));

    await act(async () => {
      q("close-window-decision-move").click();
    });

    expect(moveWindowSessionsToWindow).toHaveBeenCalledWith({ kind: "existing", label: "win-1" });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().pendingWindowClose).toBeNull();
  });

  it("Cancel keeps the window open (no destroy, no session teardown)", () => {
    render();
    act(() => useAppStore.getState().setPendingWindowClose(request()));

    act(() => q("close-window-decision-cancel").click());

    expect(destroy).not.toHaveBeenCalled();
    expect(endWindowSessions).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingWindowClose).toBeNull();
  });
});
