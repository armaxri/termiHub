import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SidebarSectionHeader } from "./SidebarSectionHeader";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SidebarSectionHeader — the shared section label (#6156)", () => {
  it("draws a plain title as the section label", () => {
    act(() => root.render(<SidebarSectionHeader title="History" />));
    const title = container.querySelector(".sidebar-section-header__title");
    expect(title?.textContent).toContain("History");
    expect(title?.classList.contains("ui-section-label")).toBe(true);
  });

  it("draws a collapsible title the same way", () => {
    act(() =>
      root.render(
        <SidebarSectionHeader
          title="Schedules"
          collapse={{ expanded: true, onToggle: () => {}, controls: "list" }}
        />
      )
    );
    const title = container.querySelector(".sidebar-section-header__toggle");
    expect(title?.classList.contains("ui-section-label")).toBe(true);
  });
});
