import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { NumberInput } from "./NumberInput";

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement) {
  act(() => {
    root.render(ui);
  });
}

/** Drive a controlled input the way a real keystroke would. */
function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function input(): HTMLInputElement {
  return document.querySelector('[data-testid="num"]') as HTMLInputElement;
}

describe("NumberInput", () => {
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

  it("renders a number input styled as the shared Input", () => {
    render(<NumberInput data-testid="num" value={5} onValueChange={() => {}} />);
    expect(input().tagName).toBe("INPUT");
    expect(input().type).toBe("number");
    expect(input().classList.contains("ui-input")).toBe(true);
    expect(input().value).toBe("5");
  });

  it("emits a parsed number when a value is typed", () => {
    const onValueChange = vi.fn();
    render(<NumberInput data-testid="num" value={5} onValueChange={onValueChange} />);
    act(() => setValue(input(), "42"));
    expect(onValueChange).toHaveBeenCalledWith(42);
  });

  it('emits "" (not 0) when the field is cleared', () => {
    const onValueChange = vi.fn();
    render(<NumberInput data-testid="num" value={5} onValueChange={onValueChange} />);
    act(() => setValue(input(), ""));
    expect(onValueChange).toHaveBeenCalledWith("");
  });

  it('renders an empty box for the "" value', () => {
    render(<NumberInput data-testid="num" value="" onValueChange={() => {}} />);
    expect(input().value).toBe("");
  });

  it("applies the error modifier and aria-invalid when error is set", () => {
    render(<NumberInput data-testid="num" value={1} onValueChange={() => {}} error />);
    expect(input().classList.contains("ui-input--error")).toBe(true);
    expect(input().getAttribute("aria-invalid")).toBe("true");
  });

  it("forwards a ref and native attributes (min, placeholder) to the input", () => {
    const ref = React.createRef<HTMLInputElement>();
    render(
      <NumberInput
        data-testid="num"
        ref={ref}
        value=""
        onValueChange={() => {}}
        min={1}
        placeholder="200"
      />
    );
    expect(ref.current).toBe(input());
    expect(input().getAttribute("min")).toBe("1");
    expect(input().placeholder).toBe("200");
  });
});
