import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Spinner } from "./Spinner";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("Spinner", () => {
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

  it("renders an accessible status role with a default label", () => {
    render(<Spinner />);
    const el = container.querySelector(".ui-spinner") as SVGElement;
    expect(el).toBeTruthy();
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-label")).toBe("Loading…");
  });

  it("uses a custom label when provided", () => {
    render(<Spinner label="Connecting" />);
    const el = container.querySelector(".ui-spinner") as SVGElement;
    expect(el.getAttribute("aria-label")).toBe("Connecting");
  });

  it("carries the essential-motion marker so reduced motion pulses instead of freezing", () => {
    render(<Spinner />);
    const el = container.querySelector(".ui-spinner") as SVGElement;
    expect(el.classList.contains("motion-essential-spinner")).toBe(true);
  });

  it("maps named sizes to a pixel diameter", () => {
    render(<Spinner size="lg" />);
    const el = container.querySelector(".ui-spinner") as SVGElement;
    expect(el.getAttribute("width")).toBe("30");
    expect(el.getAttribute("height")).toBe("30");
  });

  it("accepts an explicit numeric size", () => {
    render(<Spinner size={24} />);
    const el = container.querySelector(".ui-spinner") as SVGElement;
    expect(el.getAttribute("width")).toBe("24");
  });

  it("renders decoratively (no status role, hidden) when label is null", () => {
    render(<Spinner label={null} />);
    const el = container.querySelector(".ui-spinner") as SVGElement;
    expect(el.hasAttribute("role")).toBe(false);
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.hasAttribute("aria-label")).toBe(false);
  });

  it("forwards className and data-testid", () => {
    render(<Spinner className="my-spin" data-testid="spin" />);
    const el = container.querySelector('[data-testid="spin"]') as SVGElement;
    expect(el).toBeTruthy();
    expect(el.classList.contains("my-spin")).toBe(true);
    expect(el.classList.contains("ui-spinner")).toBe(true);
  });
});
