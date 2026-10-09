/**
 * Regression tests for UX2-002 (#4306).
 *
 * The UX-026 live-session confirm used to live only in the workspace sidebar, so
 * the command palette and a forwarded `--workspace` launched straight into
 * `teardownAllSessions`. The check now sits in one store entry point,
 * `requestLaunchWorkspace`, whose pending request is rendered by the app-level
 * ConfirmWorkspaceLaunchDialog. These tests pin that entry point and dialog:
 * prompt when sessions are live, launch directly when none are, cancel keeps
 * everything, confirm launches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { useAppStore } from "@/store/appStore";
import type { LeafPanel, TerminalTab } from "@/types/terminal";
import type { WorkspaceSummary } from "@/types/workspace";
import { seedLayoutState } from "@/test/layoutState";
import { ConfirmWorkspaceLaunchDialog } from "./ConfirmWorkspaceLaunchDialog";

let container: HTMLDivElement;
let root: Root;
let launch: ReturnType<typeof vi.fn>;

const workspaces: WorkspaceSummary[] = [{ id: "ws-1", name: "Dev Setup", connectionCount: 2 }];

/** Seed one group whose leaf holds tabs with the given session ids. */
function seedTabs(sessionIds: (string | null)[]) {
  const tabs: TerminalTab[] = sessionIds.map((sessionId, i) => ({
    id: `t${i}`,
    sessionId,
    title: `tab ${i}`,
    connectionType: "local",
    contentType: "terminal",
    config: { type: "local", config: {} },
    panelId: "p1",
    isActive: i === 0,
  })) as TerminalTab[];
  const leaf: LeafPanel = { type: "leaf", id: "p1", tabs, activeTabId: tabs[0]?.id ?? null };
  seedLayoutState({
    rootPanel: leaf,
    activePanelId: "p1",
    activeTabGroupId: "g1",
    tabGroups: [{ id: "g1", name: "Main", rootPanel: leaf, activePanelId: "p1" }],
  });
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function render() {
  act(() => root.render(<ConfirmWorkspaceLaunchDialog />));
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  launch = vi.fn(() => Promise.resolve());
  useAppStore.setState({
    workspaces,
    launchWorkspace: launch as unknown as (id: string) => Promise<void>,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe("requestLaunchWorkspace + ConfirmWorkspaceLaunchDialog (UX2-002)", () => {
  it("renders nothing when no launch is pending", () => {
    render();
    expect(q("confirm-launch-workspace-dialog")).toBeNull();
  });

  it("prompts instead of launching when sessions are live", () => {
    seedTabs(["sess-a", "sess-b"]);
    render();

    act(() => useAppStore.getState().requestLaunchWorkspace("ws-1"));

    expect(launch).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingWorkspaceLaunch).toEqual({
      id: "ws-1",
      name: "Dev Setup",
      count: 2,
    });
    expect(q("confirm-launch-workspace-dialog")?.textContent).toContain("2 open sessions");
  });

  it("launches directly with no prompt when nothing is live", () => {
    seedTabs([null]);
    render();

    act(() => useAppStore.getState().requestLaunchWorkspace("ws-1"));

    expect(launch).toHaveBeenCalledWith("ws-1");
    expect(useAppStore.getState().pendingWorkspaceLaunch).toBeNull();
    expect(q("confirm-launch-workspace-dialog")).toBeNull();
  });

  it("cancel keeps the current sessions and does not launch", () => {
    seedTabs(["sess-a"]);
    render();
    act(() => useAppStore.getState().requestLaunchWorkspace("ws-1"));

    act(() => q("confirm-launch-workspace-cancel")!.click());

    expect(launch).not.toHaveBeenCalled();
    expect(useAppStore.getState().pendingWorkspaceLaunch).toBeNull();
    expect(q("confirm-launch-workspace-dialog")).toBeNull();
  });

  it("confirm launches the workspace", () => {
    seedTabs(["sess-a"]);
    render();
    act(() => useAppStore.getState().requestLaunchWorkspace("ws-1"));

    act(() => q("confirm-launch-workspace-confirm")!.click());

    expect(launch).toHaveBeenCalledWith("ws-1");
    expect(useAppStore.getState().pendingWorkspaceLaunch).toBeNull();
  });
});
