import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { ColorInput } from "./ColorInput";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("ColorInput", () => {
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

  it("renders a color input with the base class", () => {
    render(<ColorInput data-testid="c" />);
    const input = document.querySelector('[data-testid="c"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.tagName).toBe("INPUT");
    expect(input.type).toBe("color");
    expect(input.classList.contains("ui-color-input")).toBe(true);
  });

  it("merges an extra className after the base class", () => {
    render(<ColorInput data-testid="c" className="theme-editor__swatch" />);
    const input = document.querySelector('[data-testid="c"]') as HTMLInputElement;
    expect(input.classList.contains("ui-color-input")).toBe(true);
    expect(input.classList.contains("theme-editor__swatch")).toBe(true);
  });

  it("forwards a ref to the underlying input element", () => {
    const ref = React.createRef<HTMLInputElement>();
    render(<ColorInput data-testid="c" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current).toBe(document.querySelector('[data-testid="c"]'));
  });

  it("spreads native input props (value, aria-label, data-testid)", () => {
    render(<ColorInput data-testid="c" value="#ff0000" aria-label="Pick" onChange={() => {}} />);
    const input = document.querySelector('[data-testid="c"]') as HTMLInputElement;
    expect(input.value).toBe("#ff0000");
    expect(input.getAttribute("aria-label")).toBe("Pick");
  });
});
