/**
 * The shell's run control (#5852): a `primaryAction` sits in the header's flow,
 * always visible; `actions` become a labelled hover group; the row never
 * stacks its actions onto a second line.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SidebarListItem } from "./SidebarListItem";

let container: HTMLDivElement;
let root: Root;

describe("SidebarListItem — primaryAction (#5852)", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the run control first, then a labelled hover group", () => {
    act(() => {
      root.render(
        <SidebarListItem
          name="Row"
          testId="row"
          primaryAction={<button aria-label="Start">S</button>}
          primaryActionTestId="row-primary"
          moreActionsLabel="More actions for Row"
          actions={<button aria-label="Edit">E</button>}
        />
      );
    });
    const row = container.querySelector('[data-testid="row"]')!;
    expect(row.classList.contains("sidebar-list-item--actions-visible")).toBe(true);
    expect(row.classList.contains("sidebar-list-item--primary-action")).toBe(true);
    const actions = row.querySelector(".sidebar-list-item__actions")!;
    const [first, second] = Array.from(actions.children);
    expect(first.getAttribute("data-testid")).toBe("row-primary");
    expect(first.querySelector("button")!.getAttribute("aria-label")).toBe("Start");
    expect(second.classList.contains("sidebar-list-item__more")).toBe(true);
    expect(second.getAttribute("role")).toBe("group");
    expect(second.getAttribute("aria-label")).toBe("More actions for Row");
  });

  it("without a run control keeps the plain hover-revealed actions", () => {
    act(() => {
      root.render(
        <SidebarListItem name="Row" testId="row" actions={<button aria-label="Edit">E</button>} />
      );
    });
    const row = container.querySelector('[data-testid="row"]')!;
    expect(row.classList.contains("sidebar-list-item--primary-action")).toBe(false);
    expect(row.querySelector(".sidebar-list-item__more")).toBeNull();
    expect(row.querySelector(".sidebar-list-item__primary")).toBeNull();
  });
});
