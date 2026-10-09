/**
 * Regression tests for UX-026 / UX2-002.
 *
 * Launching a workspace runs `teardownAllSessions` before it swaps the layout.
 * The live-session confirm now lives in the shared `requestLaunchWorkspace`
 * store entry point (covered with its dialog in
 * ConfirmWorkspaceLaunchDialog.test.tsx), so these tests pin that the sidebar's
 * Launch routes through that guarded entry point rather than calling
 * `launchWorkspace` directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import type { WorkspaceSummary } from "@/types/workspace";
import { TooltipProvider } from "@/components/ui";

const mockLaunchWorkspace = vi.fn(() => Promise.resolve());
const mockRequestLaunchWorkspace = vi.fn();

// Whole-store mock (mirrors the tunnel sidebar confirm tests) so the click →
// confirm → launch path is driven without seeding the real region layout.
vi.mock("@/store/appStore", () => {
  const state: Record<string, unknown> = {};
  const useAppStore = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useAppStore.setState = (patch: Record<string, unknown>) => Object.assign(state, patch);
  return { useAppStore };
});

vi.mock("@/store/layoutSelectors", () => ({
  useLayoutTabGroups: () => [],
  useActiveTabGroupId: () => "group-1",
}));

import { useAppStore } from "@/store/appStore";
import { WorkspaceSidebar } from "./WorkspaceSidebar";

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
    requestLaunchWorkspace: mockRequestLaunchWorkspace,
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
    seedStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("routes Launch through the guarded requestLaunchWorkspace entry point", async () => {
    await renderSidebar();

    const launchBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="workspace-launch-ws-1"]'
    );
    expect(launchBtn).not.toBeNull();
    await act(async () => launchBtn!.click());
    await flush();

    expect(mockRequestLaunchWorkspace).toHaveBeenCalledWith("ws-1");
    // The direct, unguarded launch is never called from the sidebar.
    expect(mockLaunchWorkspace).not.toHaveBeenCalled();
  });
});
