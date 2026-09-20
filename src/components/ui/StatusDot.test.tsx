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
    for (const tone of [
      "neutral",
      "success",
      "warning",
      "error",
      "notice",
      "connected",
      "connecting",
      "disconnected",
      "disabled",
    ] as const) {
      render(<StatusDot tone={tone} testId="dot" />);
      const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
      expect(dot.classList.contains("status-dot")).toBe(true);
      expect(dot.classList.contains(`status-dot--${tone}`)).toBe(true);
    }
  });

  it("defaults to the md size (no sm/lg modifier)", () => {
    render(<StatusDot tone="success" testId="dot" />);
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.classList.contains("status-dot--sm")).toBe(false);
    expect(dot.classList.contains("status-dot--lg")).toBe(false);
  });

  it("adds the sm modifier for the small size", () => {
    render(<StatusDot tone="success" size="sm" testId="dot" />);
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.classList.contains("status-dot--sm")).toBe(true);
  });

  it("adds the lg modifier for the large size", () => {
    render(<StatusDot tone="success" size="lg" testId="dot" />);
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.classList.contains("status-dot--lg")).toBe(true);
  });

  it("adds the pulse and dimmed modifiers only when requested", () => {
    render(<StatusDot tone="connecting" pulse dimmed testId="dot" />);
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.classList.contains("status-dot--pulse")).toBe(true);
    expect(dot.classList.contains("status-dot--dimmed")).toBe(true);

    render(<StatusDot tone="connecting" testId="dot" />);
    const plain = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(plain.classList.contains("status-dot--pulse")).toBe(false);
    expect(plain.classList.contains("status-dot--dimmed")).toBe(false);
  });

  it("hides the dot from assistive tech when ariaHidden is set", () => {
    render(<StatusDot tone="disabled" ariaHidden testId="dot" />);
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.getAttribute("aria-hidden")).toBe("true");
  });

  it("forwards a native title tooltip", () => {
    render(<StatusDot tone="connected" title="Attached: shell, logs" testId="dot" />);
    const dot = container.querySelector('[data-testid="dot"]') as HTMLElement;
    expect(dot.getAttribute("title")).toBe("Attached: shell, logs");
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
