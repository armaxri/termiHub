/**
 * Regression tests for UX-026.
 *
 * Launching a workspace runs `teardownAllSessions` unconditionally before it
 * swaps the layout, destroying every live terminal/SSH/serial session on a
 * single click / Enter with no confirmation — while the reversible Delete was
 * already guarded. These tests pin that the sidebar prompts before a launch
 * that would close live sessions, launches only on confirm, aborts on cancel,
 * and launches directly (no prompt) when nothing is running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { TerminalTab } from "@/types/terminal";
import type { WorkspaceSummary } from "@/types/workspace";
import { TooltipProvider } from "@/components/ui";

const mockLaunchWorkspace = vi.fn(() => Promise.resolve());

// Whole-store mock (mirrors the tunnel sidebar confirm tests) so the click →
// confirm → launch path is driven without seeding the real region layout.
vi.mock("@/store/appStore", () => {
  const state: Record<string, unknown> = {};
  const useAppStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useAppStore.setState = (patch: Record<string, unknown>) => Object.assign(state, patch);
  return { useAppStore };
});

// Control the live-session count the sidebar reads at click time, plus the
// layout hooks it renders with.
let mockLiveTabs: TerminalTab[] = [];
vi.mock("@/store/layoutSelectors", () => ({
  getAllTabsAcrossGroupTrees: () => mockLiveTabs,
  useLayoutTabGroups: () => [],
  useActiveTabGroupId: () => "group-1",
}));

import { useAppStore } from "@/store/appStore";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

function liveTab(id: string): TerminalTab {
  // Only `sessionId` matters to the guard; cast the rest of the shape.
  return { id, sessionId: `sess-${id}` } as unknown as TerminalTab;
}

const sampleWorkspaces: WorkspaceSummary[] = [
  { id: "ws-1", name: "Dev Setup", connectionCount: 3 },
];

let container: HTMLDivElement;
let root: Root;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function seedStore() {
  (useAppStore as unknown as { setState: (p: Record<string, unknown>) => void }).setState({
    workspaces: sampleWorkspaces,
    deleteWorkspaceFromBackend: vi.fn(() => Promise.resolve()),
    duplicateWorkspaceInBackend: vi.fn(),
    openWorkspaceEditorTab: vi.fn(),
    launchWorkspace: mockLaunchWorkspace,
    launchingWorkspaceId: null,
    saveCurrentAsWorkspace: vi.fn(),
    loadWorkspaces: vi.fn(),
  });
}

async function renderSidebar() {
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceSidebar />
      </TooltipProvider>
    );
  });
  await flush();
}

describe("WorkspaceSidebar — launch confirmation (UX-026)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mockLiveTabs = [];
    seedStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("prompts before launching when live sessions would be closed, launches on confirm", async () => {
    mockLiveTabs = [liveTab("a"), liveTab("b")];
    await renderSidebar();

    const launchBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-launch-ws-1"]'
    );
    expect(launchBtn).not.toBeNull();
    await act(async () => launchBtn!.click());
    await flush();

    // Dialog shows, launch has NOT fired yet.
    expect(
      document.querySelector('[data-testid="confirm-launch-workspace-dialog"]')
    ).not.toBeNull();
    expect(mockLaunchWorkspace).not.toHaveBeenCalled();

    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-launch-workspace-confirm"]'
    );
    await act(async () => confirm!.click());
    await flush();
    expect(mockLaunchWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("aborts the launch when the dialog is cancelled", async () => {
    mockLiveTabs = [liveTab("a")];
    await renderSidebar();

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="workspace-launch-ws-1"]')!.click()
    );
    await flush();

    const cancel = document.querySelector<HTMLButtonElement>(
      '[data-testid="confirm-launch-workspace-cancel"]'
    );
    await act(async () => cancel!.click());
    await flush();

    expect(document.querySelector('[data-testid="confirm-launch-workspace-dialog"]')).toBeNull();
    expect(mockLaunchWorkspace).not.toHaveBeenCalled();
  });

  it("launches directly without a prompt when there are no live sessions", async () => {
    mockLiveTabs = [];
    await renderSidebar();

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="workspace-launch-ws-1"]')!.click()
    );
    await flush();

    expect(document.querySelector('[data-testid="confirm-launch-workspace-dialog"]')).toBeNull();
    expect(mockLaunchWorkspace).toHaveBeenCalledWith("ws-1");
  });
});
