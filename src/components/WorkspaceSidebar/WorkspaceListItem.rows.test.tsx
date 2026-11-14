/**
 * Names, not settings (#5770): a workspace row shows its name and its
 * description (muted, only when set); how many tabs it opens is in the
 * tooltip, which is also the row's accessible description.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { TooltipProvider } from "@/components/ui";
import { WorkspaceListItem, workspaceRowTooltip } from "./WorkspaceListItem";
import type { WorkspaceSummary } from "@/types/workspace";

let container: HTMLDivElement;
let root: Root;

function render(workspace: WorkspaceSummary) {
  act(() => {
    root.render(
      <TooltipProvider delayDuration={0}>
        <WorkspaceListItem
          workspace={workspace}
          onLaunch={vi.fn()}
          onEdit={vi.fn()}
          onDuplicate={vi.fn()}
          onDelete={vi.fn()}
        />
      </TooltipProvider>
    );
  });
}

describe("WorkspaceListItem — names, not settings (#5770)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows the name and the description; the tab count is in the tooltip", () => {
    render({ id: "ws-1", name: "Dev", description: "Daily layout", connectionCount: 3 });
    const row = container.querySelector('[data-testid="workspace-item-ws-1"]')!;
    expect(row.textContent).toContain("Dev");
    expect(row.textContent).not.toContain("3");
    expect(container.querySelector('[data-testid="workspace-description-ws-1"]')?.textContent).toBe(
      "Daily layout"
    );
    expect(row.getAttribute("aria-description")).toBe("Opens 3 tabs");
  });

  it("shows no description line without a description", () => {
    render({ id: "ws-1", name: "Dev", connectionCount: 1 });
    expect(container.querySelector('[data-testid="workspace-description-ws-1"]')).toBeNull();
  });
});

describe("workspaceRowTooltip", () => {
  it("counts tabs, and groups when there is more than one", () => {
    expect(workspaceRowTooltip({ id: "a", name: "A", connectionCount: 1 })).toEqual([
      "Opens 1 tab",
    ]);
    expect(workspaceRowTooltip({ id: "a", name: "A", connectionCount: 4, groupCount: 2 })).toEqual([
      "Opens 4 tabs in 2 groups",
    ]);
    expect(workspaceRowTooltip({ id: "a", name: "A", connectionCount: 0 })).toEqual([]);
  });
});
