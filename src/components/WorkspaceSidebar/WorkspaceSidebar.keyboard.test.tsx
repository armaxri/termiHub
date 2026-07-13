/**
 * Keyboard-navigation + ARIA tree semantics for the Workspaces sidebar (#1379).
 *
 * The Workspaces list adopts the same roving-tabindex arrow-key model + tree
 * ARIA roles as the Connections tree: one row is tabbable at a time, arrows move
 * the roving focus, and Enter activates (launches) the focused workspace.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { withTooltip } from "@/test/tooltip";
import { WorkspaceSummary } from "@/types/workspace";
import { useAppStore } from "@/store/appStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(vi.fn()) }));
vi.mock("@/themes", () => ({ applyTheme: vi.fn(), onThemeChange: vi.fn() }));

const sampleWorkspaces: WorkspaceSummary[] = [
  { id: "ws-1", name: "Alpha", connectionCount: 3 },
  { id: "ws-2", name: "Bravo", connectionCount: 1 },
];

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function press(key: string) {
  const list = query("workspace-list")!;
  act(() => {
    list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("WorkspaceSidebar — keyboard navigation (#1379)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("marks the list as a tree and rows as treeitems", () => {
    useAppStore.setState({ workspaces: sampleWorkspaces });
    act(() => root.render(withTooltip(<WorkspaceSidebar />)));

    expect(query("workspace-list")!.getAttribute("role")).toBe("tree");
    const first = query("workspace-item-ws-1")!;
    expect(first.getAttribute("role")).toBe("treeitem");
    expect(first.getAttribute("aria-level")).toBe("1");
  });

  it("keeps a single roving-tabindex row (first row tabbable)", () => {
    useAppStore.setState({ workspaces: sampleWorkspaces });
    act(() => root.render(withTooltip(<WorkspaceSidebar />)));

    expect(query("workspace-item-ws-1")!.getAttribute("tabindex")).toBe("0");
    expect(query("workspace-item-ws-2")!.getAttribute("tabindex")).toBe("-1");
  });

  it("moves the roving focus down with ArrowDown", () => {
    useAppStore.setState({ workspaces: sampleWorkspaces });
    act(() => root.render(withTooltip(<WorkspaceSidebar />)));

    press("ArrowDown");
    expect(document.activeElement).toBe(query("workspace-item-ws-2"));
    expect(query("workspace-item-ws-2")!.getAttribute("tabindex")).toBe("0");
  });

  it("activates (launches) the focused workspace on Enter", () => {
    const launchWorkspace = vi.fn();
    useAppStore.setState({
      workspaces: sampleWorkspaces,
      launchWorkspace,
      launchingWorkspaceId: null,
    });
    act(() => root.render(withTooltip(<WorkspaceSidebar />)));

    press("ArrowDown");
    press("Enter");
    expect(launchWorkspace).toHaveBeenCalledWith("ws-2");
  });
});
