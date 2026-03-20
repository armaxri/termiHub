import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { LayoutDesigner } from "./LayoutDesigner";
import { WorkspaceLayoutNode, WorkspaceLeafNode, WorkspaceTabDef } from "@/types/workspace";
import { getWorkspaceLeaves } from "@/utils/workspaceLayout";

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

function tab(ref?: string): WorkspaceTabDef {
  return { connectionRef: ref };
}

function leaf(...tabs: WorkspaceTabDef[]): WorkspaceLeafNode {
  return { type: "leaf", tabs };
}

function hsplit(...children: WorkspaceLayoutNode[]): WorkspaceLayoutNode {
  return { type: "split", direction: "horizontal", children };
}

let container: HTMLDivElement;
let root: Root;

function query(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

describe("LayoutDesigner", () => {
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

  it("renders with a single leaf", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<LayoutDesigner layout={leaf(tab("a"))} onChange={onChange} />);
    });

    expect(query("layout-designer")).not.toBeNull();
    expect(query("layout-leaf-0")).not.toBeNull();
  });

  it("does not show X button when only one leaf exists", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<LayoutDesigner layout={leaf(tab("a"))} onChange={onChange} />);
    });

    expect(query("layout-remove-leaf-0")).toBeNull();
  });

  it("shows X button when multiple leaves exist", () => {
    const onChange = vi.fn();
    const layout = hsplit(leaf(tab("a")), leaf(tab("b")));
    act(() => {
      root.render(<LayoutDesigner layout={layout} onChange={onChange} />);
    });

    expect(query("layout-remove-leaf-0")).not.toBeNull();
    expect(query("layout-remove-leaf-1")).not.toBeNull();
  });

  it("inline split button creates a new panel", () => {
    let lastLayout: WorkspaceLayoutNode | null = null;
    const onChange = vi.fn((l: WorkspaceLayoutNode) => {
      lastLayout = l;
    });

    act(() => {
      root.render(<LayoutDesigner layout={leaf(tab("a"))} onChange={onChange} />);
    });

    act(() => {
      query("layout-leaf-split-h-0")?.click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastLayout).not.toBeNull();
    const leaves = getWorkspaceLeaves(lastLayout!);
    expect(leaves).toHaveLength(2);
  });

  it("auto-selects new panel after split", () => {
    let lastLayout: WorkspaceLayoutNode | null = null;
    const onChange = vi.fn((l: WorkspaceLayoutNode) => {
      lastLayout = l;
    });

    act(() => {
      root.render(<LayoutDesigner layout={leaf(tab("a"))} onChange={onChange} />);
    });

    act(() => {
      query("layout-leaf-split-h-0")?.click();
    });

    // Re-render with new layout — new leaf (index 1) should be selected
    act(() => {
      root.render(<LayoutDesigner layout={lastLayout!} onChange={onChange} />);
    });

    const leaf1 = query("layout-leaf-1");
    expect(leaf1?.classList.contains("layout-leaf--selected")).toBe(true);
  });

  it("splits the correct panel when using inline button", () => {
    let lastLayout: WorkspaceLayoutNode | null = null;
    const onChange = vi.fn((l: WorkspaceLayoutNode) => {
      lastLayout = l;
    });

    const layout = hsplit(leaf(tab("a")), leaf(tab("b")));
    act(() => {
      root.render(<LayoutDesigner layout={layout} onChange={onChange} />);
    });

    // Split the second panel using its inline button
    act(() => {
      query("layout-leaf-split-v-1")?.click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    const leaves = getWorkspaceLeaves(lastLayout!);
    expect(leaves).toHaveLength(3);
    expect(leaves[0].tabs[0]?.connectionRef).toBe("a");
    expect(leaves[1].tabs[0]?.connectionRef).toBe("b");
    expect(leaves[2].tabs).toHaveLength(0);
  });

  it("does not show 'Panel N' labels", () => {
    const onChange = vi.fn();
    const layout = hsplit(leaf(tab("a")), leaf(tab("b")));
    act(() => {
      root.render(<LayoutDesigner layout={layout} onChange={onChange} />);
    });

    const allText = container.textContent ?? "";
    expect(allText).not.toContain("Panel 1");
    expect(allText).not.toContain("Panel 2");
  });

  it("shows empty state prompt for empty leaf", () => {
    const onChange = vi.fn();
    act(() => {
      root.render(<LayoutDesigner layout={leaf()} onChange={onChange} />);
    });

    const emptyEl = container.querySelector(".layout-leaf__empty");
    expect(emptyEl?.textContent).toContain("Click + to add a connection");
  });

  it("shows inline split and add buttons on each leaf", () => {
    const onChange = vi.fn();
    const layout = hsplit(leaf(tab("a")), leaf(tab("b")));
    act(() => {
      root.render(<LayoutDesigner layout={layout} onChange={onChange} />);
    });

    expect(query("layout-leaf-split-h-0")).not.toBeNull();
    expect(query("layout-leaf-split-v-0")).not.toBeNull();
    expect(query("layout-leaf-add-tab-0")).not.toBeNull();
    expect(query("layout-leaf-split-h-1")).not.toBeNull();
    expect(query("layout-leaf-split-v-1")).not.toBeNull();
    expect(query("layout-leaf-add-tab-1")).not.toBeNull();
  });

  it("displays tab names in each leaf", () => {
    const onChange = vi.fn();
    const layout = leaf(
      { connectionRef: "my-connection", title: "Dev Server" },
      { connectionRef: "other-conn" }
    );
    act(() => {
      root.render(<LayoutDesigner layout={layout} onChange={onChange} />);
    });

    const tabNames = container.querySelectorAll(".layout-tab__name");
    expect(tabNames).toHaveLength(2);
    expect(tabNames[0].textContent).toBe("Dev Server");
    expect(tabNames[1].textContent).toBe("other-conn");
  });

  it("can remove a tab", () => {
    let lastLayout: WorkspaceLayoutNode | null = null;
    const onChange = vi.fn((l: WorkspaceLayoutNode) => {
      lastLayout = l;
    });

    act(() => {
      root.render(<LayoutDesigner layout={leaf(tab("a"), tab("b"))} onChange={onChange} />);
    });

    act(() => {
      query("layout-remove-tab-0-0")?.click();
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastLayout).not.toBeNull();
    expect(lastLayout!.type).toBe("leaf");
    const resultLeaf = lastLayout! as unknown as WorkspaceLeafNode;
    expect(resultLeaf.tabs).toHaveLength(1);
    expect(resultLeaf.tabs[0].connectionRef).toBe("b");
  });
});
