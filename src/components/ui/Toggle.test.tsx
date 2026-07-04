import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Toggle } from "./Toggle";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("Toggle", () => {
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

  it("renders a switch with the base class and reflects checked state", () => {
    render(<Toggle data-testid="tg" checked onCheckedChange={() => {}} />);
    const tg = document.querySelector('[data-testid="tg"]') as HTMLButtonElement;
    expect(tg).toBeTruthy();
    expect(tg.classList.contains("ui-toggle")).toBe(true);
    // Radix Switch exposes role="switch" + aria-checked for accessibility.
    expect(tg.getAttribute("role")).toBe("switch");
    expect(tg.getAttribute("aria-checked")).toBe("true");
  });

  it("reflects the unchecked state", () => {
    render(<Toggle data-testid="tg" checked={false} onCheckedChange={() => {}} />);
    const tg = document.querySelector('[data-testid="tg"]') as HTMLButtonElement;
    expect(tg.getAttribute("aria-checked")).toBe("false");
  });

  it("calls onCheckedChange with the new value when clicked", () => {
    const onCheckedChange = vi.fn();
    render(<Toggle data-testid="tg" checked={false} onCheckedChange={onCheckedChange} />);
    act(() => (document.querySelector('[data-testid="tg"]') as HTMLElement).click());
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("is disabled and does not fire onCheckedChange when disabled", () => {
    const onCheckedChange = vi.fn();
    render(<Toggle data-testid="tg" checked={false} disabled onCheckedChange={onCheckedChange} />);
    const tg = document.querySelector('[data-testid="tg"]') as HTMLButtonElement;
    expect(tg.hasAttribute("disabled")).toBe(true);
    act(() => tg.click());
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
