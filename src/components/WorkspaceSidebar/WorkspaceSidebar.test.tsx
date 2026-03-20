import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { WorkspaceSummary } from "@/types/workspace";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@/themes", () => ({
  applyTheme: vi.fn(),
  onThemeChange: vi.fn(),
}));

import { useAppStore } from "@/store/appStore";

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

const sampleWorkspaces: WorkspaceSummary[] = [
  { id: "ws-1", name: "Dev Setup", description: "Daily dev layout", connectionCount: 3 },
  { id: "ws-2", name: "Production", connectionCount: 1 },
];

describe("WorkspaceSidebar", () => {
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

  it("shows empty message when no workspaces", () => {
    useAppStore.setState({ workspaces: [] });

    act(() => {
      root.render(<WorkspaceSidebar />);
    });

    expect(query("workspace-empty-message")).not.toBeNull();
    expect(query("workspace-list")).toBeNull();
  });

  it("renders workspace list when workspaces exist", () => {
    useAppStore.setState({ workspaces: sampleWorkspaces });

    act(() => {
      root.render(<WorkspaceSidebar />);
    });

    expect(query("workspace-empty-message")).toBeNull();
    expect(query("workspace-list")).not.toBeNull();
    expect(query("workspace-item-ws-1")).not.toBeNull();
    expect(query("workspace-item-ws-2")).not.toBeNull();
  });

  it("shows workspace names", () => {
    useAppStore.setState({ workspaces: sampleWorkspaces });

    act(() => {
      root.render(<WorkspaceSidebar />);
    });

    expect(query("workspace-name-ws-1")?.textContent).toBe("Dev Setup");
    expect(query("workspace-name-ws-2")?.textContent).toBe("Production");
  });

  it("shows connection count badges", () => {
    useAppStore.setState({ workspaces: sampleWorkspaces });

    act(() => {
      root.render(<WorkspaceSidebar />);
    });

    expect(query("workspace-count-ws-1")?.textContent).toBe("3 tabs");
    expect(query("workspace-count-ws-2")?.textContent).toBe("1 tab");
  });

  it("has a New Workspace button", () => {
    useAppStore.setState({ workspaces: [] });

    act(() => {
      root.render(<WorkspaceSidebar />);
    });

    expect(query("workspace-new-btn")).not.toBeNull();
  });

  it("renders action buttons for each workspace", () => {
    useAppStore.setState({ workspaces: [sampleWorkspaces[0]] });

    act(() => {
      root.render(<WorkspaceSidebar />);
    });

    expect(query("workspace-edit-ws-1")).not.toBeNull();
    expect(query("workspace-duplicate-ws-1")).not.toBeNull();
    expect(query("workspace-delete-ws-1")).not.toBeNull();
  });
});
