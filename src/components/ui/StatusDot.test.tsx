import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { StatusDot } from "./StatusDot";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("StatusDot", () => {
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

  it("maps each tone to its modifier class", () => {
    for (const tone of ["neutral", "success", "warning", "error", "notice"] as const) {
      render(<StatusDot tone={tone} testId="dot" />);
      const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
      expect(dot.classList.contains("status-dot")).toBe(true);
      expect(dot.classList.contains(`status-dot--${tone}`)).toBe(true);
    }
  });

  it("defaults to the md size (no sm modifier)", () => {
    render(<StatusDot tone="success" testId="dot" />);
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.classList.contains("status-dot--sm")).toBe(false);
  });

  it("adds the sm modifier for the small size", () => {
    render(<StatusDot tone="success" size="sm" testId="dot" />);
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.classList.contains("status-dot--sm")).toBe(true);
  });

  it("exposes a non-colour accessible name when a label is given", () => {
    render(<StatusDot tone="notice" label="Update available" testId="dot" />);
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    // role=img + aria-label make the status perceivable without colour (A11Y-003).
    expect(dot.getAttribute("role")).toBe("img");
    expect(dot.getAttribute("aria-label")).toBe("Update available");
  });

  it("stays a bare decorative span when no label is given", () => {
    render(<StatusDot tone="neutral" testId="dot" />);
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.getAttribute("role")).toBeNull();
    expect(dot.getAttribute("aria-label")).toBeNull();
  });

  it("forwards an extra className for call-site layout tweaks", () => {
    render(<StatusDot tone="error" className="my-margin" testId="dot" />);
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.classList.contains("my-margin")).toBe(true);
    expect(dot.classList.contains("status-dot")).toBe(true);
  });
});
