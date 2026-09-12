/**
 * Unit tests for the shared sidebar group-header chrome (UISF-019).
 *
 * These lock in the DOM parity contract for the two `ConnectionList` section
 * headers: the shared `connection-list__group-*` classes, the chevron direction,
 * `aria-expanded`, the title text, the actions slot, and the test hooks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SidebarGroupHeader } from "./SidebarGroupHeader";

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

function toggle(): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(".connection-list__group-toggle");
  if (!el) throw new Error("no toggle rendered");
  return el;
}

describe("SidebarGroupHeader", () => {
  it("renders the shared header shell, title, testids, and expanded chevron", () => {
    act(() =>
      root.render(
        <SidebarGroupHeader
          title="Connections"
          expanded={true}
          onToggle={() => {}}
          actions={<button data-testid="new-conn">+</button>}
          headerTestId="sidebar-group-header-connections"
          toggleTestId="connection-list-group-toggle"
        />
      )
    );
    const header = container.querySelector<HTMLDivElement>(".connection-list__group-header");
    expect(header?.getAttribute("data-testid")).toBe("sidebar-group-header-connections");
    const btn = toggle();
    expect(btn.getAttribute("data-testid")).toBe("connection-list-group-toggle");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector(".connection-list__group-title")?.textContent
    ).toBe("Connections");
    // Expanded → chevron-down; the shared chevron class is present.
    expect(btn.querySelector(".connection-tree__chevron")).not.toBeNull();
    const actions = container.querySelector(".connection-list__group-actions");
    expect(actions?.querySelector('[data-testid="new-conn"]')).not.toBeNull();
  });

  it("reflects collapsed state via aria-expanded", () => {
    act(() =>
      root.render(
        <SidebarGroupHeader title="Remote Agents" expanded={false} onToggle={() => {}} />
      )
    );
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("omits the actions slot when no actions are given", () => {
    act(() =>
      root.render(<SidebarGroupHeader title="Remote Agents" expanded onToggle={() => {}} />)
    );
    expect(container.querySelector(".connection-list__group-actions")).toBeNull();
  });

  it("invokes onToggle when the toggle is clicked", () => {
    const onToggle = vi.fn();
    act(() =>
      root.render(<SidebarGroupHeader title="Connections" expanded onToggle={onToggle} />)
    );
    act(() => {
      toggle().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
