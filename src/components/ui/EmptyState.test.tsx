import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { EmptyState } from "./EmptyState";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("EmptyState", () => {
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

  it("renders the title and defaults to the inline variant and status role", () => {
    render(<EmptyState title="No results" />);
    const root = container.querySelector(".ui-empty") as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.classList.contains("ui-empty--inline")).toBe(true);
    expect(root.getAttribute("role")).toBe("status");
    expect(root.querySelector(".ui-empty__title")?.textContent).toBe("No results");
  });

  it("renders description, icon, and an action slot", () => {
    render(
      <EmptyState
        title="Nothing here"
        description="Add one to get started"
        icon={<svg data-testid="icon" />}
        action={<button data-testid="cta">Add</button>}
      />
    );
    expect(container.querySelector(".ui-empty__description")?.textContent).toBe(
      "Add one to get started"
    );
    expect(container.querySelector('[data-testid="icon"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="cta"]')).toBeTruthy();
  });

  it("renders a spinner and defaults the title to Loading… when loading", () => {
    render(<EmptyState loading />);
    expect(container.querySelector(".ui-spinner")).toBeTruthy();
    expect(container.querySelector(".ui-empty__title")?.textContent).toBe("Loading…");
  });

  it("keeps an explicit title while loading and does not render a passed icon", () => {
    render(<EmptyState loading title="Fetching trust store" icon={<svg data-testid="icon" />} />);
    expect(container.querySelector(".ui-empty__title")?.textContent).toBe("Fetching trust store");
    expect(container.querySelector('[data-testid="icon"]')).toBeFalsy();
    expect(container.querySelector(".ui-spinner")).toBeTruthy();
  });

  it("applies the requested variant class", () => {
    render(<EmptyState title="Nothing configured" variant="panel" />);
    expect(container.querySelector(".ui-empty--panel")).toBeTruthy();
  });

  it("renders no role when role is null", () => {
    render(<EmptyState title="cta" role={null} data-testid="empty" />);
    const el = container.querySelector('[data-testid="empty"]') as HTMLElement;
    expect(el.hasAttribute("role")).toBe(false);
  });

  it("forwards className and data-testid and honours a custom role", () => {
    render(<EmptyState title="x" className="mine" data-testid="empty" role="note" />);
    const el = container.querySelector('[data-testid="empty"]') as HTMLElement;
    expect(el.classList.contains("mine")).toBe(true);
    expect(el.classList.contains("ui-empty")).toBe(true);
    expect(el.getAttribute("role")).toBe("note");
  });
});
