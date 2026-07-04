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
});
