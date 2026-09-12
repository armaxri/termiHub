/**
 * Unit tests for the shared sidebar toolbar chrome (UISF-019).
 *
 * These lock in the DOM parity contract the extraction relies on: the toolbar
 * renders the shared `sidebar-toolbar` wrapper, its alignment modifiers, and its
 * children verbatim, matching the per-file `X-sidebar__actions` strips it
 * replaces.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { SidebarToolbar } from "./SidebarToolbar";

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

function toolbar(): HTMLDivElement {
  const el = container.querySelector<HTMLDivElement>(".sidebar-toolbar");
  if (!el) throw new Error("no toolbar rendered");
  return el;
}

describe("SidebarToolbar", () => {
  it("renders the shared wrapper class, testid, and children verbatim", () => {
    act(() =>
      root.render(
        <SidebarToolbar data-testid="macro-sidebar-actions">
          <button data-testid="child-btn">New</button>
        </SidebarToolbar>
      )
    );
    const el = toolbar();
    expect(el.className).toBe("sidebar-toolbar");
    expect(el.getAttribute("data-testid")).toBe("macro-sidebar-actions");
    expect(el.querySelector('[data-testid="child-btn"]')?.textContent).toBe("New");
  });

  it("applies the align-center modifier", () => {
    act(() =>
      root.render(
        <SidebarToolbar align="center">
          <span>x</span>
        </SidebarToolbar>
      )
    );
    expect(toolbar().className).toBe("sidebar-toolbar sidebar-toolbar--align-center");
  });

  it("applies the justify-end modifier", () => {
    act(() =>
      root.render(
        <SidebarToolbar justify="end">
          <span>x</span>
        </SidebarToolbar>
      )
    );
    expect(toolbar().className).toBe("sidebar-toolbar sidebar-toolbar--justify-end");
  });

  it("appends caller-supplied className", () => {
    act(() =>
      root.render(
        <SidebarToolbar className="extra">
          <span>x</span>
        </SidebarToolbar>
      )
    );
    expect(toolbar().className).toBe("sidebar-toolbar extra");
  });
});
