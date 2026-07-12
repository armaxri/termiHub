import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Input } from "./Input";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("Input", () => {
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

  it("renders a text input with the base class", () => {
    render(<Input data-testid="in" />);
    const input = document.querySelector('[data-testid="in"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.tagName).toBe("INPUT");
    expect(input.classList.contains("ui-input")).toBe(true);
    expect(input.classList.contains("ui-input--error")).toBe(false);
  });

  it("applies the error modifier and aria-invalid when error is set", () => {
    render(<Input data-testid="in" error />);
    const input = document.querySelector('[data-testid="in"]') as HTMLInputElement;
    expect(input.classList.contains("ui-input--error")).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("forwards a ref to the underlying input element", () => {
    const ref = React.createRef<HTMLInputElement>();
    render(<Input data-testid="in" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current).toBe(document.querySelector('[data-testid="in"]'));
  });

  it("spreads native input props (value, placeholder, onChange)", () => {
    const onChange = vi.fn();
    render(<Input data-testid="in" defaultValue="hello" placeholder="host" onChange={onChange} />);
    const input = document.querySelector('[data-testid="in"]') as HTMLInputElement;
    expect(input.value).toBe("hello");
    expect(input.placeholder).toBe("host");
  });

  it("does not apply the inline modifier by default", () => {
    render(<Input data-testid="in" />);
    const input = document.querySelector('[data-testid="in"]') as HTMLInputElement;
    expect(input.classList.contains("ui-input--inline")).toBe(false);
  });

  it("applies the inline modifier when inline is set", () => {
    render(<Input data-testid="in" inline />);
    const input = document.querySelector('[data-testid="in"]') as HTMLInputElement;
    expect(input.classList.contains("ui-input")).toBe(true);
    expect(input.classList.contains("ui-input--inline")).toBe(true);
  });

  it("keeps the error modifier alongside the inline modifier", () => {
    render(<Input data-testid="in" inline error />);
    const input = document.querySelector('[data-testid="in"]') as HTMLInputElement;
    expect(input.classList.contains("ui-input--inline")).toBe(true);
    expect(input.classList.contains("ui-input--error")).toBe(true);
  });

  it("does not apply the compact size modifier by default", () => {
    render(<Input data-testid="in" />);
    const input = document.querySelector('[data-testid="in"]') as HTMLInputElement;
    expect(input.classList.contains("ui-input--sm")).toBe(false);
  });

  it("applies the compact size modifier when size is sm", () => {
    render(<Input data-testid="in" size="sm" />);
    const input = document.querySelector('[data-testid="in"]') as HTMLInputElement;
    expect(input.classList.contains("ui-input")).toBe(true);
    expect(input.classList.contains("ui-input--sm")).toBe(true);
  });

  it("keeps the error modifier alongside the compact size modifier", () => {
    render(<Input data-testid="in" size="sm" error />);
    const input = document.querySelector('[data-testid="in"]') as HTMLInputElement;
    expect(input.classList.contains("ui-input--sm")).toBe(true);
    expect(input.classList.contains("ui-input--error")).toBe(true);
  });
});
