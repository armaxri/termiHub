import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Textarea } from "./Textarea";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

describe("Textarea", () => {
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

  it("renders a textarea with the base class", () => {
    render(<Textarea data-testid="ta" />);
    const el = document.querySelector('[data-testid="ta"]') as HTMLTextAreaElement;
    expect(el).toBeTruthy();
    expect(el.tagName).toBe("TEXTAREA");
    expect(el.classList.contains("ui-textarea")).toBe(true);
    expect(el.classList.contains("ui-textarea--error")).toBe(false);
  });

  it("applies the error modifier and aria-invalid when error is set", () => {
    render(<Textarea data-testid="ta" error />);
    const el = document.querySelector('[data-testid="ta"]') as HTMLTextAreaElement;
    expect(el.classList.contains("ui-textarea--error")).toBe(true);
    expect(el.getAttribute("aria-invalid")).toBe("true");
  });

  it("forwards a ref to the underlying textarea element", () => {
    const ref = React.createRef<HTMLTextAreaElement>();
    render(<Textarea data-testid="ta" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
    expect(ref.current).toBe(document.querySelector('[data-testid="ta"]'));
  });

  it("spreads native textarea props (value, placeholder, rows)", () => {
    const onChange = vi.fn();
    render(
      <Textarea data-testid="ta" defaultValue="line1\nline2" placeholder="script" rows={8} onChange={onChange} />
    );
    const el = document.querySelector('[data-testid="ta"]') as HTMLTextAreaElement;
    expect(el.placeholder).toBe("script");
    expect(el.rows).toBe(8);
  });

  it("defaults to four rows", () => {
    render(<Textarea data-testid="ta" />);
    const el = document.querySelector('[data-testid="ta"]') as HTMLTextAreaElement;
    expect(el.rows).toBe(4);
  });
});
