import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Button } from "./Button";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("Button", () => {
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

  it("renders with the base class and default primary/md variant", () => {
    render(<Button data-testid="btn">Click</Button>);
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.classList.contains("ui-btn")).toBe(true);
    expect(btn.classList.contains("ui-btn--primary")).toBe(true);
    expect(btn.textContent).toContain("Click");
    expect(btn.type).toBe("button");
  });

  it.each([
    ["primary", "ui-btn--primary"],
    ["secondary", "ui-btn--secondary"],
    ["ghost", "ui-btn--ghost"],
    ["danger", "ui-btn--danger"],
  ] as const)("applies the %s variant class", (variant, expectedClass) => {
    render(
      <Button data-testid="btn" variant={variant}>
        X
      </Button>
    );
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;
    expect(btn.classList.contains(expectedClass)).toBe(true);
  });

  it("applies the sm size modifier and omits it for md", () => {
    render(
      <Button data-testid="sm" size="sm">
        S
      </Button>
    );
    expect(document.querySelector('[data-testid="sm"]')!.classList.contains("ui-btn--sm")).toBe(
      true
    );

    render(
      <Button data-testid="md" size="md">
        M
      </Button>
    );
    expect(document.querySelector('[data-testid="md"]')!.classList.contains("ui-btn--sm")).toBe(
      false
    );
  });

  it("applies the full-width modifier when fullWidth is set", () => {
    render(
      <Button data-testid="btn" fullWidth>
        Wide
      </Button>
    );
    expect(document.querySelector('[data-testid="btn"]')!.classList.contains("ui-btn--full")).toBe(
      true
    );
  });

  it("is disabled and does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    render(
      <Button data-testid="btn" disabled onClick={onClick}>
        No
      </Button>
    );
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    act(() => btn.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it("fires onClick when clicked", () => {
    const onClick = vi.fn();
    render(
      <Button data-testid="btn" onClick={onClick}>
        Go
      </Button>
    );
    act(() => (document.querySelector('[data-testid="btn"]') as HTMLElement).click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("forwards a ref to the underlying button element", () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <Button data-testid="btn" ref={ref}>
        Ref
      </Button>
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current).toBe(document.querySelector('[data-testid="btn"]'));
  });

  it("spreads native button props such as type and aria-label", () => {
    render(
      <Button data-testid="btn" type="submit" aria-label="Submit form">
        S
      </Button>
    );
    const btn = document.querySelector('[data-testid="btn"]') as HTMLButtonElement;
    expect(btn.type).toBe("submit");
    expect(btn.getAttribute("aria-label")).toBe("Submit form");
  });
});
