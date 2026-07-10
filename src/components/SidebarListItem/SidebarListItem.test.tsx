import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SidebarListItem, SidebarStatusDot } from "./SidebarListItem";

let container: HTMLDivElement;
let root: Root;

describe("SidebarListItem", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the name, badge, status, actions and details slots", () => {
    act(() =>
      root.render(
        <SidebarListItem
          testId="item-1"
          nameTestId="name-1"
          name="My Item"
          status={<SidebarStatusDot tone="success" testId="dot-1" />}
          badge={<span data-testid="badge-1">HTTP</span>}
          actions={<button data-testid="action-1">Go</button>}
          details={<span data-testid="details-1">:8080</span>}
        />
      )
    );

    expect(container.querySelector('[data-testid="item-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="name-1"]')?.textContent).toBe("My Item");
    expect(container.querySelector('[data-testid="badge-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="dot-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="action-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="details-1"]')).not.toBeNull();
    // Actions live in the shared actions container.
    expect(
      container
        .querySelector(".sidebar-list-item__actions")
        ?.querySelector('[data-testid="action-1"]')
    ).not.toBeNull();
  });

  it("fires onDoubleClick", () => {
    const onDoubleClick = vi.fn();
    act(() =>
      root.render(
        <SidebarListItem testId="item-1" name="X" actions={null} onDoubleClick={onDoubleClick} />
      )
    );
    act(() => {
      (container.querySelector('[data-testid="item-1"]') as HTMLElement).dispatchEvent(
        new MouseEvent("dblclick", { bubbles: true })
      );
    });
    expect(onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it("applies the error modifier when error is set", () => {
    act(() => root.render(<SidebarListItem testId="item-1" name="X" actions={null} error />));
    const el = container.querySelector('[data-testid="item-1"]') as HTMLElement;
    expect(el.classList.contains("sidebar-list-item--error")).toBe(true);
  });

  it("maps status tones to modifier classes", () => {
    act(() => root.render(<SidebarStatusDot tone="error" testId="dot" />));
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.classList.contains("sidebar-list-item__status")).toBe(true);
    expect(dot.classList.contains("sidebar-list-item__status--error")).toBe(true);
  });
});
