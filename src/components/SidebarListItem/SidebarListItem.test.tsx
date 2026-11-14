import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SidebarListItem, SidebarStatusDot } from "./SidebarListItem";
import { withTooltip } from "@/test/tooltip";

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

  it("keeps the actions visible without a hover when actionsVisible is set (#5612)", () => {
    act(() =>
      root.render(
        <SidebarListItem testId="item-1" name="X" actions={<button>Go</button>} actionsVisible />
      )
    );
    const el = container.querySelector('[data-testid="item-1"]') as HTMLElement;
    expect(el.classList.contains("sidebar-list-item--actions-visible")).toBe(true);
    expect(el.classList.contains("sidebar-list-item--stacked-actions")).toBe(false);
  });

  it("hides the actions behind a hover by default", () => {
    act(() =>
      root.render(<SidebarListItem testId="item-1" name="X" actions={<button>Go</button>} />)
    );
    const el = container.querySelector('[data-testid="item-1"]') as HTMLElement;
    expect(el.classList.contains("sidebar-list-item--actions-visible")).toBe(false);
  });

  it("maps status tones to modifier classes", () => {
    // SidebarStatusDot is now an alias of the shared StatusDot primitive
    // (UISF-003), so it renders the promoted `status-dot` classes.
    act(() => root.render(<SidebarStatusDot tone="error" testId="dot" />));
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.classList.contains("status-dot")).toBe(true);
    expect(dot.classList.contains("status-dot--error")).toBe(true);
  });

  it("exposes a non-colour accessible name when a label is given", () => {
    act(() => root.render(<SidebarStatusDot tone="success" label="Running" testId="dot" />));
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    // role=img + aria-label make the status perceivable without colour (A11Y-003).
    expect(dot.getAttribute("role")).toBe("img");
    expect(dot.getAttribute("aria-label")).toBe("Running");
  });

  it("stays a bare decorative span when no label is given", () => {
    act(() => root.render(<SidebarStatusDot tone="neutral" testId="dot" />));
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.getAttribute("role")).toBeNull();
    expect(dot.getAttribute("aria-label")).toBeNull();
  });

  describe("names and descriptions, settings in the tooltip (#5757)", () => {
    const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

    it("shows the description muted under the name only when set", () => {
      act(() =>
        root.render(
          <SidebarListItem
            testId="row"
            name="Prod"
            actions={null}
            description="  Main web box  "
            descriptionTestId="desc"
          />
        )
      );
      const desc = q("desc")!;
      expect(desc.textContent).toBe("Main web box");
      expect(desc.classList.contains("sidebar-list-item__description")).toBe(true);
      expect(q("row")!.textContent).toBe("ProdMain web box");

      act(() =>
        root.render(<SidebarListItem testId="row" name="Prod" actions={null} description="   " />)
      );
      expect(q("row")!.querySelector(".sidebar-list-item__details")).toBeNull();
    });

    it("keeps tooltip lines off the row and exposes them as its description", () => {
      act(() =>
        root.render(
          withTooltip(
            <SidebarListItem
              testId="row"
              nameTestId="name"
              name="Prod"
              actions={null}
              tooltip={["On connect · web-1", "", "Tags: ops"]}
              tooltipTestId="tip"
            />
          )
        )
      );
      expect(q("row")!.textContent).toBe("Prod");
      expect(q("row")!.getAttribute("aria-description")).toBe("On connect · web-1. Tags: ops");
      act(() => {
        q("name")!.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      });
      const tip = q("tip")!;
      expect(tip.querySelector(".sidebar-list-item__tooltip-name")?.textContent).toBe("Prod");
      const lines = Array.from(tip.querySelector(".sidebar-list-item__tooltip")!.children).map(
        (el) => el.textContent
      );
      expect(lines).toEqual(["Prod", "On connect · web-1", "Tags: ops"]);
    });

    it("has no description attribute without tooltip lines", () => {
      act(() => root.render(<SidebarListItem testId="row" name="Prod" actions={null} />));
      expect(q("row")!.hasAttribute("aria-description")).toBe(false);
    });
  });
});
